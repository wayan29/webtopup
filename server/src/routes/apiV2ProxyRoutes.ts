import { createHash } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
    API_V2_PROXY_SECRET_HEADER,
    GATEWAY_CORRELATION_HEADER,
    getRequestCorrelation,
    isUpstreamResponseHeaderDenied,
    isValidCorrelationId,
    isValidOtelSpanId,
    persistAuthoritativeResponseCorrelation,
    selectResponseTraceId,
    TRACE_RESPONSE_HEADER as GATEWAY_TRACE_RESPONSE_HEADER,
} from '../utils/correlation';
import { AuthRequest, authenticate, authenticateUnlock, hasPermission, isTeamMember } from '../middlewares/authMiddleware';
import { resolveBearerToken } from '../middlewares/sessionAuth';
import { authRateLimit } from '../middlewares/authRateLimit';
import { adminFinancialMutationRateLimit } from '../middlewares/adminMutationRateLimit';
import {
    requireStepUp,
    stampTrustedStepUpGroup,
    stripBrowserStepUpHeaders,
    type StepUpActionGroup,
} from '../middlewares/stepUp';
import { guestTransactionRateLimit, publicGameValidateRateLimit, publicValidateRateLimit, voucherRedeemRateLimit, webhookRateLimit } from '../middlewares/publicRateLimit';
import { ApiKeyRequest, authenticateOpenApiSignature } from '../controllers/openApiController';
import { handleDigiflazzWebhook, handleTokovoucherWebhook } from '../controllers/webhookController';
import {
    CSRF_COOKIE,
    CSRF_COOKIE_PATH,
    ensureCsrfCookie,
    REFRESH_COOKIE,
    RECOVERY_COOKIE,
    clearAuthCookies,
    requireTrustedAuthMutation,
    requireTrustedAuthRequest,
    setRefreshCookie,
    setRecoveryCookie,
} from '../utils/authCookies';
import {
    forcedLoginReasonFromAuthCode,
    getLegacyAccessTokenAcceptUntilMs,
    isLegacyAccessTokenCutoffPassed,
    recordForcedLoginMetric,
} from '../utils/sessionConfig';
import { authCookieDisposition } from '../utils/authErrors';
import { decodeJwtPayload } from '../utils/jwt';
import qrcode from 'qrcode';

type UploadFolder = 'icons' | 'covers' | 'popups' | 'instructions';
type UploadPermission = 'manageProducts' | 'managePayment' | 'manageSettings';

const DEFAULT_API_V2_UPSTREAM = 'http://127.0.0.1:9010';
const TRACE_RESPONSE_HEADER = GATEWAY_TRACE_RESPONSE_HEADER;
const DEFAULT_PROXY_TRACER_NAME = 'webtopup-api-v2-proxy';

type ProxySpan = ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>;

export type PublicSettingsCacheEntry = { expiresAt: number; status: number; headers: Record<string, string>; body: Buffer };

export type ApiV2ProxyRouteOptions = {
    proxyTracer?: ReturnType<typeof trace.getTracer>;
    startProxySpan?: (name: string, options: Parameters<ReturnType<typeof trace.getTracer>['startSpan']>[1]) => ProxySpan;
    onProxyWorkActive?: () => void;
    publicSettingsCacheRef?: { current: PublicSettingsCacheEntry | null };
    resetPublicSettingsCache?: () => void;
    getPublicSettingsCacheSnapshot?: () => PublicSettingsCacheEntry | null;
};

type ResolvedApiV2ProxyDeps = {
    proxyTracer: ReturnType<typeof trace.getTracer>;
    startProxySpan: (name: string, options: Parameters<ReturnType<typeof trace.getTracer>['startSpan']>[1]) => ProxySpan;
    onProxyWorkActive?: () => void;
    resetPublicSettingsCache: () => void;
    getPublicSettingsCacheSnapshot: () => PublicSettingsCacheEntry | null;
};

/**
 * Roles each fixed login route is allowed to return a session for.
 *
 * Rust is the enforcement authority, but the gateway owns cookie installation. Since the route
 * already fixes the audience, refuse a mismatched envelope here so HttpOnly refresh/recovery
 * cookies are never written for the wrong channel and cannot survive a failed browser cleanup.
 */
const LOGIN_ROUTE_ROLES: Record<string, ReadonlySet<string>> = {
    '/v2/auth/member/login': new Set(['member']),
    '/v2/auth/staff/login': new Set(['owner', 'admin', 'cs']),
};

const loginEnvelopeAudienceMatches = (upstreamPath: string, payload: Record<string, unknown>) => {
    const allowed = LOGIN_ROUTE_ROLES[upstreamPath];
    if (!allowed) return true;
    const user = payload.user as Record<string, unknown> | undefined;
    const role = typeof user?.role === 'string' ? user.role : undefined;
    // A credential envelope with no readable role fails closed.
    return Boolean(role && allowed.has(role));
};

const UNTRUSTED_UPSTREAM_HEADER_NAMES = new Set([
    'x-trace-id',
    'traceparent',
    'tracestate',
    'baggage',
    API_V2_PROXY_SECRET_HEADER,
    GATEWAY_CORRELATION_HEADER,
    'cookie',
    'x-csrf-token',
    'x-refresh-token',
    'x-webtopup-session-id',
    'x-step-up-token',
    'x-step-up-group',
    'x-webtopup-step-up-group',
    'x-webtopup-step-up-token',
    'x-webtopup-parallel-waiters',
    // Login audience is selected only by the fixed gateway/Rust route pair.
    // A browser-provided value must never cross the proxy trust boundary.
    'x-webtopup-login-audience',
]);

const isWbtopupUserHeader = (name: string) => name.toLowerCase().startsWith('x-webtopup-user-');

const isOtelPropagationEnabled = () => {
    const raw = process.env.OTEL_ENABLED?.trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
};
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

const headersSetter = {
    set(carrier: Headers, key: string, value: string) {
        carrier.set(key, value);
    }
};

const getApiV2UpstreamUrl = () => {
    const rawUrl = process.env.API_V2_UPSTREAM_URL?.trim() || DEFAULT_API_V2_UPSTREAM;
    return rawUrl.replace(/\/+$/, '');
};

const getRequiredApiV2ProxySecret = () => {
    const proxySecret = process.env.API_V2_PROXY_SECRET?.trim();
    if (!proxySecret || proxySecret.length < 32) {
        throw new Error('API_V2_PROXY_SECRET must be configured with at least 32 characters');
    }
    return proxySecret;
};

const getRoutePattern = (request: FastifyRequest) => {
    const routeOptions = request.routeOptions as { url?: string } | undefined;
    return routeOptions?.url || request.url.split('?')[0] || 'unknown';
};

export const CRITICAL_IDEMPOTENT_ROUTE_PATTERNS = new Set([
    '/users/:id/balance',
    '/api/v2/users/:id/balance',
    '/transactions/:id/refund',
    '/api/v2/transactions/:id/refund',
    '/guest-transactions',
    '/api/v2/guest-transactions',
    '/vouchers/giveaways',
    '/api/v2/vouchers/giveaways',
]);

export const isCriticalIdempotentMutation = (request: FastifyRequest) => {
    if ((request.method || '').toUpperCase() !== 'POST') {
        return false;
    }
    return CRITICAL_IDEMPOTENT_ROUTE_PATTERNS.has(getRoutePattern(request));
};

const criticalIdempotencyEnforced = () => {
    const raw = process.env.CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED?.trim().toLowerCase();
    if (!raw) {
        return true;
    }
    return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
};

export const normalizeGatewayIdempotencyKey = (raw: unknown): string | null => {
    if (typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length < 8 || trimmed.length > 128) {
        return null;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        return null;
    }
    return trimmed;
};

const readIdempotencyKeyHeader = (request: FastifyRequest): string | undefined => {
    // Node joins duplicate HTTP field-lines with a comma. Commas are not valid key characters,
    // so the normalizer below rejects duplicates (including case variants) fail-closed.
    const value = request.headers['idempotency-key'];
    if (Array.isArray(value)) {
        return value.length === 1 ? value[0] : undefined;
    }
    return typeof value === 'string' ? value : undefined;
};

/** Fail closed at the gateway for critical financial mutations missing a bounded key. */
export const requireCriticalIdempotencyKey = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCriticalIdempotentMutation(request) || !criticalIdempotencyEnforced()) {
        return;
    }
    const normalized = normalizeGatewayIdempotencyKey(readIdempotencyKeyHeader(request));
    if (!normalized) {
        return reply.status(400).send({
            message: 'Header Idempotency-Key wajib untuk mutasi finansial ini',
            error: {
                code: 'IDEMPOTENCY_KEY_REQUIRED',
                message: 'Header Idempotency-Key wajib untuk mutasi finansial ini',
            },
        });
    }
    // Normalize once so upstream always sees a validated key.
    (request.headers as Record<string, unknown>)['idempotency-key'] = normalized;
};

const getUrlPath = (url: string) => {
    try {
        return new URL(url).pathname;
    } catch {
        return url.split('?')[0];
    }
};

const toUpstreamPath = (requestUrl: string) => {
    if (requestUrl === '/api/v2/health' || requestUrl === '/health') {
        return '/health';
    }

    if (requestUrl.startsWith('/api/v2/')) {
        return requestUrl.replace('/api/v2', '/v2');
    }

    if (requestUrl === '/api/v2') {
        return '/v2';
    }

    if (requestUrl.startsWith('/v2/')) {
        return requestUrl;
    }

    if (requestUrl === '/v2') {
        return requestUrl;
    }

    return `/v2${requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`}`;
};

const isActivityStatusProxyRequest = (request: FastifyRequest) => {
    const routePattern = getRoutePattern(request);
    if (routePattern === '/auth/activity-status' || routePattern === '/api/v2/auth/activity-status') {
        return true;
    }

    const requestPath = getUrlPath(request.url);
    return requestPath === '/auth/activity-status' || requestPath === '/api/v2/auth/activity-status';
};

const resolveProxyUpstreamPath = (request: FastifyRequest) => {
    if (isActivityStatusProxyRequest(request)) {
        return '/v2/auth/activity-status';
    }

    return toUpstreamPath(request.url);
};

const toProxyBody = (request: FastifyRequest): BodyInit | undefined => {
    if (request.method === 'GET' || request.method === 'HEAD') {
        return undefined;
    }

    if (request.body === undefined || request.body === null) {
        return undefined;
    }

    if (typeof request.body === 'string') {
        return request.body;
    }

    if (Buffer.isBuffer(request.body)) {
        return new Uint8Array(request.body);
    }

    return JSON.stringify(request.body);
};

const forwardHeaders = (request: AuthRequest, proxySecret: string, gatewayCorrelationId: string) => {
    const headers = new Headers();

    for (const [name, value] of Object.entries(request.headers)) {
        const normalizedName = name.toLowerCase();
        if (
            HOP_BY_HOP_HEADERS.has(normalizedName)
            || normalizedName === 'host'
            // toProxyBody re-serializes the parsed body, so the browser's declared length can
            // no longer be trusted. Forwarding a stale value makes the upstream block waiting
            // for bytes that already ended, and the request hangs until the edge times out.
            || normalizedName === 'content-length'
            || UNTRUSTED_UPSTREAM_HEADER_NAMES.has(normalizedName)
            || isWbtopupUserHeader(normalizedName)
        ) {
            continue;
        }

        if (Array.isArray(value)) {
            headers.set(name, value.join(','));
        } else if (value !== undefined) {
            headers.set(name, String(value));
        }
    }

    const remoteAddress = request.ip;
    // Do not trust or forward client-supplied X-Forwarded-For into the Rust trust boundary.
    // Rust public seller endpoints enforce IP allowlists from this header.
    headers.set('x-forwarded-for', remoteAddress);
    headers.set('x-real-ip', remoteAddress);
    headers.set('x-forwarded-host', request.hostname);
    headers.set('x-forwarded-proto', request.protocol);

    headers.set(API_V2_PROXY_SECRET_HEADER, proxySecret);
    headers.set(GATEWAY_CORRELATION_HEADER, gatewayCorrelationId);

    if (request.user) {
        headers.set('x-webtopup-user-id', request.user.id);
        headers.set('x-webtopup-user-role', request.user.role);
        headers.set('x-webtopup-user-email', request.user.email);
        headers.set('x-webtopup-user-permissions', JSON.stringify(request.user.permissions || {}));
        if (request.user.authMode === 'refresh-session' && request.user.sessionId) {
            headers.set('x-webtopup-session-id', request.user.sessionId);
        }
    }

    // Defense: always strip browser grant/group headers, then stamp only a
    // server-validated group when requireStepUp has already succeeded.
    stripBrowserStepUpHeaders(headers);
    stampTrustedStepUpGroup(headers, request);

    return headers;
};

export const credentialResponseRequiresCookies = (payload: Record<string, unknown>, legacyAllowed = false): boolean => {
    const keys = Object.keys(payload).sort();
    const exactChallenge = keys.length === 3
        && keys[0] === 'challengeToken'
        && keys[1] === 'message'
        && keys[2] === 'requiresTwoFactor'
        && payload.message === 'Two-factor verification required'
        && payload.requiresTwoFactor === true
        && typeof payload.challengeToken === 'string'
        && payload.challengeToken.trim().length > 0
        && payload.challengeToken.length <= 4096;
    const exactLegacy = legacyAllowed
        && keys.length === 2
        && keys[0] === 'accessToken'
        && keys[1] === 'user'
        && typeof payload.accessToken === 'string'
        && payload.accessToken.trim().length > 0
        && payload.accessToken.length <= 8192
        && payload.user !== null
        && typeof payload.user === 'object'
        && !Array.isArray(payload.user);
    return !exactChallenge && !exactLegacy;
};

export const requireRefreshCookies = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.cookies?.[REFRESH_COOKIE] && request.cookies?.[RECOVERY_COOKIE]) return;
    return reply.status(401).send({
        error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' },
    });
};

export const prepareRewrittenJsonHeaders = (source: Headers): Headers => {
    const headers = new Headers(source);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    return headers;
};

const forwardHeadersWithTrace = (request: AuthRequest, proxySecret: string, gatewayCorrelationId: string) => {
    const headers = forwardHeaders(request, proxySecret, gatewayCorrelationId);
    if (!isOtelPropagationEnabled()) {
        return headers;
    }
    const activeContext = context.active();
    const activeSpan = trace.getSpan(activeContext);
    if (!activeSpan) {
        return headers;
    }
    const spanContext = activeSpan.spanContext();
    const spanTraceId = spanContext.traceId;
    const spanId = spanContext.spanId;
    if (!isValidCorrelationId(spanTraceId) || !isValidOtelSpanId(spanId)) {
        return headers;
    }
    propagation.inject(activeContext, headers, headersSetter);
    return headers;
};

const PUBLIC_SETTINGS_CACHE_MS = 30_000;

const filterUpstreamResponseHeaders = (upstreamResponse: Response): Record<string, string> => {
    const headers: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
        const normalizedName = name.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(normalizedName) || isUpstreamResponseHeaderDenied(normalizedName)) {
            return;
        }
        headers[name] = value;
    });
    return headers;
};

const applyFilteredUpstreamHeadersToReply = (
    filtered: Record<string, string>,
    reply: FastifyReply
) => {
    for (const [name, value] of Object.entries(filtered)) {
        reply.header(name, value);
    }
};

const sendUpstreamResponse = async (
    upstreamResponse: Response,
    reply: FastifyReply,
    traceId?: string
) => {
    applyFilteredUpstreamHeadersToReply(filterUpstreamResponseHeaders(upstreamResponse), reply);

    if (traceId) {
        reply.header(TRACE_RESPONSE_HEADER, traceId);
    }

    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    return reply.status(upstreamResponse.status).send(body);
};

const resolveUploadFolder = (request: AuthRequest): UploadFolder => {
    const { type } = request.query as { type?: string };
    const validTypes: UploadFolder[] = ['icons', 'covers', 'popups', 'instructions'];
    return validTypes.includes((type || '') as UploadFolder) ? (type as UploadFolder) : 'icons';
};

const hasUploadPermission = (request: AuthRequest, permission: UploadPermission) => {
    if (request.user?.role === 'owner') {
        return true;
    }

    return Boolean(request.user?.permissions?.[permission]);
};

const uploadFolderPermissions: Record<UploadFolder, UploadPermission[]> = {
    icons: ['manageProducts', 'managePayment', 'manageSettings'],
    covers: ['manageProducts', 'manageSettings'],
    popups: ['manageProducts', 'manageSettings'],
    instructions: ['manageProducts']
};

const authorizeUploadFolder = async (request: AuthRequest, reply: FastifyReply) => {
    const folder = resolveUploadFolder(request);
    const allowedPermissions = uploadFolderPermissions[folder];

    if (allowedPermissions.some((permission) => hasUploadPermission(request, permission))) {
        return;
    }

    return reply.status(403).send({ message: 'Forbidden: Permission denied' });
};

const resolveProxyResponseTraceId = (request: AuthRequest, span: ProxySpan) => {
    const spanTraceId = span.spanContext().traceId;
    if (isOtelPropagationEnabled() && spanTraceId && isValidCorrelationId(spanTraceId)) {
        return spanTraceId;
    }
    return selectResponseTraceId(request);
};

const runWithProxySpan = async <T>(
    deps: ResolvedApiV2ProxyDeps,
    request: AuthRequest,
    reply: FastifyReply,
    upstreamUrl: string,
    work: (upstreamCorrelationId: string) => Promise<T>
): Promise<{ result: T; responseTraceId: string }> => {
    const route = getRoutePattern(request);
    const upstreamPath = getUrlPath(upstreamUrl);
    getRequestCorrelation(request);
    const span = deps.startProxySpan(`api.v2.proxy ${request.method} ${route}`, {
        kind: SpanKind.CLIENT,
        attributes: {
            'http.request.method': request.method,
            'server.address': new URL(getApiV2UpstreamUrl()).hostname,
            'url.path': request.url.split('?')[0],
            'webtopup.api_version': 'v2',
            'webtopup.proxy.route': route,
            'webtopup.proxy.upstream_path': upstreamPath,
        },
    });
    const responseTraceId = resolveProxyResponseTraceId(request, span);
    reply.header(TRACE_RESPONSE_HEADER, responseTraceId);
    const spanTraceId = span.spanContext().traceId;
    const correlationSource: 'otel_span' | 'gateway_header' =
        isOtelPropagationEnabled() && spanTraceId && isValidCorrelationId(spanTraceId) && spanTraceId === responseTraceId
            ? 'otel_span'
            : 'gateway_header';
    persistAuthoritativeResponseCorrelation(request, responseTraceId, correlationSource);

    const activeContext = trace.setSpan(context.active(), span);
    return context.with(activeContext, async () => {
        try {
            deps.onProxyWorkActive?.();
            const result = await work(responseTraceId);
            if (result && typeof result === 'object' && 'status' in result && typeof (result as unknown as Response).status === 'number') {
                const upstreamResponse = result as unknown as Response;
                span.setAttribute('http.response.status_code', upstreamResponse.status);
                if (upstreamResponse.status >= 500) {
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: `API v2 upstream returned ${upstreamResponse.status}`,
                    });
                }
            }
            return { result, responseTraceId };
        } catch (error) {
            if (error instanceof Error) {
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            } else {
                span.setStatus({ code: SpanStatusCode.ERROR });
            }
            throw error;
        } finally {
            span.end();
        }
    });
};

const resolveApiV2ProxyDeps = (
    opts: ApiV2ProxyRouteOptions | undefined,
    publicSettingsCacheRef: { current: PublicSettingsCacheEntry | null }
): ResolvedApiV2ProxyDeps => {
    const proxyTracer = opts?.proxyTracer ?? trace.getTracer(DEFAULT_PROXY_TRACER_NAME);
    const startProxySpan = opts?.startProxySpan
        ?? ((name: string, options: Parameters<typeof proxyTracer.startSpan>[1]) => proxyTracer.startSpan(name, options));
    const resetPublicSettingsCache = opts?.resetPublicSettingsCache
        ?? (() => { publicSettingsCacheRef.current = null; });
    const getPublicSettingsCacheSnapshot = opts?.getPublicSettingsCacheSnapshot
        ?? (() => {
            const entry = publicSettingsCacheRef.current;
            if (!entry) {
                return null;
            }
            return {
                expiresAt: entry.expiresAt,
                status: entry.status,
                headers: { ...entry.headers },
                body: entry.body,
            };
        });
    return {
        proxyTracer,
        startProxySpan,
        onProxyWorkActive: opts?.onProxyWorkActive,
        resetPublicSettingsCache,
        getPublicSettingsCacheSnapshot,
    };
};

export default async function apiV2ProxyRoutes(app: FastifyInstance, opts?: ApiV2ProxyRouteOptions) {
    const proxySecret = getRequiredApiV2ProxySecret();
    const publicSettingsCacheRef = opts?.publicSettingsCacheRef ?? { current: null as PublicSettingsCacheEntry | null };
    const deps = resolveApiV2ProxyDeps(opts, publicSettingsCacheRef);

    const proxyRequest = async (request: AuthRequest, reply: FastifyReply) => {
        const upstreamUrl = `${getApiV2UpstreamUrl()}${resolveProxyUpstreamPath(request)}`;

        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => fetch(upstreamUrl, {
                    method: request.method,
                    headers: forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId),
                    body: toProxyBody(request),
                    redirect: 'manual',
                })
            );

            return sendUpstreamResponse(upstreamResponse, reply, responseTraceId);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 upstream request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    const stripCredentialIssuanceFields = (payload: Record<string, unknown>) => {
        delete payload.refreshToken;
        delete payload.recoveryToken;
        delete payload.refreshCookieMaxAgeSeconds;
        delete payload.recoveryCookieMaxAgeSeconds;
        delete payload.csrfToken;
    };

    const installCredentialCookies = (reply: FastifyReply, payload: Record<string, unknown>) => {
        const refreshToken = payload.refreshToken;
        const recoveryToken = payload.recoveryToken;
        if (typeof refreshToken !== 'string' || typeof recoveryToken !== 'string') {
            return false;
        }
        setRefreshCookie(
            reply,
            refreshToken,
            typeof payload.refreshCookieMaxAgeSeconds === 'number' ? payload.refreshCookieMaxAgeSeconds : undefined
        );
        setRecoveryCookie(
            reply,
            recoveryToken,
            typeof payload.recoveryCookieMaxAgeSeconds === 'number' ? payload.recoveryCookieMaxAgeSeconds : undefined
        );
        ensureCsrfCookie(reply);
        return true;
    };

    const securityChangeErrorCode = (payload: Record<string, unknown>) => {
        const nested = payload.error as Record<string, unknown> | undefined;
        if (typeof nested?.code === 'string') {
            return nested.code;
        }
        if (typeof payload.code === 'string') {
            return payload.code;
        }
        return undefined;
    };

    const applySecurityChangeTerminalCookiePolicy = (
        reply: FastifyReply,
        status: number,
        payload: Record<string, unknown>
    ) => {
        const code = securityChangeErrorCode(payload);
        if (status === 401 && authCookieDisposition(code) === 'clear') {
            clearAuthCookies(reply);
        }
    };

    const buildBodyWithRecoveryProof = (request: AuthRequest, recoveryToken: string) => {
        const base = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
            ? { ...(request.body as Record<string, unknown>) }
            : {};
        // Always overwrite any client-supplied recoveryToken with the HttpOnly cookie proof.
        base.recoveryToken = recoveryToken;
        return JSON.stringify(base);
    };

    const proxyCredentialRequest = async (
        request: AuthRequest,
        reply: FastifyReply,
        fixedUpstreamPath?: '/v2/auth/member/login' | '/v2/auth/staff/login'
    ) => {
        const upstreamPath = fixedUpstreamPath ?? toUpstreamPath(request.url);
        const upstreamUrl = `${getApiV2UpstreamUrl()}${upstreamPath}`;

        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => fetch(upstreamUrl, {
                    method: request.method,
                    headers: forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId),
                    body: toProxyBody(request),
                    redirect: 'manual',
                })
            );
            applyFilteredUpstreamHeadersToReply(filterUpstreamResponseHeaders(upstreamResponse), reply);
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);

            const contentType = upstreamResponse.headers.get('content-type') || '';
            if (!contentType.toLowerCase().startsWith('application/json')) {
                reply.type('application/json');
                return reply.status(502).send(JSON.stringify({ message: 'Invalid auth upstream response' }));
            }
            const payload = await upstreamResponse.json() as Record<string, unknown>;
            const legacyAllowed = !isLegacyAccessTokenCutoffPassed();
            if (upstreamResponse.ok && credentialResponseRequiresCookies(payload, legacyAllowed)) {
                // Vet the audience before any cookie is written; a mismatch is an upstream fault.
                if (!loginEnvelopeAudienceMatches(upstreamPath, payload)) {
                    request.log.error({ upstreamPath }, 'API v2 login envelope role does not match the route audience');
                    return reply.status(502).send(JSON.stringify({ message: 'Invalid auth upstream response' }));
                }
                if (!installCredentialCookies(reply, payload)) {
                    return reply.status(502).send(JSON.stringify({ message: 'Invalid auth upstream response' }));
                }
            } else if (!upstreamResponse.ok && payload.code === 'AUTH_DEVICE_LIMIT_REACHED') {
                ensureCsrfCookie(reply);
            }
            stripCredentialIssuanceFields(payload);
            reply.type('application/json');
            return reply.status(upstreamResponse.status).send(JSON.stringify(payload));
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 auth upstream request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    /**
     * Confirm/disable security-change proxy: requires HttpOnly recovery cookie, forwards it only in
     * the internal JSON envelope (never logs it), installs exact refresh/recovery/CSRF cookies on
     * validated success, preserves cookies on conflict/unavailable, and clears only terminal expiry.
     */
    const proxySecurityChangeCredentialRequest = async (request: AuthRequest, reply: FastifyReply) => {
        const recoveryToken = request.cookies[RECOVERY_COOKIE];
        if (!recoveryToken) {
            return reply.status(401).send({
                error: { code: 'AUTH_TOKEN_INVALID', message: 'Recovery proof required' },
            });
        }
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => {
                    // Body is rewritten to inject the recovery proof, so the client's
                    // content-length must not survive or the upstream stalls on a short read.
                    const headers = prepareRewrittenJsonHeaders(forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId));
                    return fetch(upstreamUrl, {
                        method: request.method,
                        headers,
                        body: buildBodyWithRecoveryProof(request, recoveryToken),
                        redirect: 'manual',
                    });
                }
            );
            applyFilteredUpstreamHeadersToReply(filterUpstreamResponseHeaders(upstreamResponse), reply);
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);

            const contentType = upstreamResponse.headers.get('content-type') || '';
            if (!contentType.toLowerCase().startsWith('application/json')) {
                // Preserve cookies on non-JSON upstream so response-loss recovery remains possible.
                return reply.status(502).send({ message: 'Invalid auth upstream response' });
            }
            let payload: Record<string, unknown>;
            try {
                payload = await upstreamResponse.json() as Record<string, unknown>;
            } catch {
                return reply.status(502).send({ message: 'Invalid auth upstream response' });
            }

            if (upstreamResponse.ok) {
                // Fail closed without partial cookie installation on malformed success envelopes.
                if (!installCredentialCookies(reply, payload)) {
                    return reply.status(502).send({ message: 'Invalid auth upstream response' });
                }
            } else {
                applySecurityChangeTerminalCookiePolicy(reply, upstreamResponse.status, payload);
            }
            stripCredentialIssuanceFields(payload);
            return reply.status(upstreamResponse.status).send(payload);
        } catch (error) {
            // Preserve cookies on transport loss so the browser can retry with the predecessor proof.
            request.log.error({ error, upstreamUrl }, 'API v2 security-change upstream request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    /**
     * Owner-reset actor path: forward HttpOnly recovery cookie as internal proof only.
     * Never enter credential cookie installation even if upstream incorrectly returns secrets.
     */
    const proxyOwnerSecurityChangeRequest = async (request: AuthRequest, reply: FastifyReply) => {
        const recoveryToken = request.cookies[RECOVERY_COOKIE];
        if (!recoveryToken) {
            return reply.status(401).send({
                error: { code: 'AUTH_TOKEN_INVALID', message: 'Recovery proof required' },
            });
        }
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => {
                    // Same rewrite as the self path: drop the stale declared length.
                    const headers = prepareRewrittenJsonHeaders(forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId));
                    return fetch(upstreamUrl, {
                        method: request.method,
                        headers,
                        body: buildBodyWithRecoveryProof(request, recoveryToken),
                        redirect: 'manual',
                    });
                }
            );
            applyFilteredUpstreamHeadersToReply(filterUpstreamResponseHeaders(upstreamResponse), reply);
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);

            const contentType = upstreamResponse.headers.get('content-type') || '';
            if (!contentType.toLowerCase().startsWith('application/json')) {
                return reply.status(502).send({ message: 'Invalid auth upstream response' });
            }
            let payload: Record<string, unknown>;
            try {
                payload = await upstreamResponse.json() as Record<string, unknown>;
            } catch {
                return reply.status(502).send({ message: 'Invalid auth upstream response' });
            }

            // Owner reset never issues target credentials. Strip any hostile issuance fields.
            if (!upstreamResponse.ok) {
                applySecurityChangeTerminalCookiePolicy(reply, upstreamResponse.status, payload);
            }
            stripCredentialIssuanceFields(payload);
            delete payload.accessToken;
            return reply.status(upstreamResponse.status).send(payload);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 owner security-change upstream request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    const proxyRefreshOrLogout = async (request: AuthRequest, reply: FastifyReply, logout: boolean) => {
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        const refreshToken = request.cookies[REFRESH_COOKIE];
        const recoveryToken = request.cookies[RECOVERY_COOKIE];
        if (logout) clearAuthCookies(reply);
        if (!refreshToken || (!logout && !recoveryToken)) {
            return reply.status(401).send({ error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' } });
        }
        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps, request, reply, upstreamUrl,
                async (gatewayCorrelationId) => {
                    const headers = prepareRewrittenJsonHeaders(forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId));
                    return fetch(upstreamUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(logout ? { refreshToken } : { refreshToken, recoveryToken }),
                        redirect: 'manual',
                    });
                }
            );
            applyFilteredUpstreamHeadersToReply(filterUpstreamResponseHeaders(upstreamResponse), reply);
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);
            const contentType = upstreamResponse.headers.get('content-type') || '';
            if (!contentType.toLowerCase().startsWith('application/json')) {
                return reply.status(502).send({ message: 'Invalid auth upstream response' });
            }
            const payload = await upstreamResponse.json() as Record<string, unknown>;
            const error = payload.error as Record<string, unknown> | undefined;
            const code = error?.code;
            if (!logout && upstreamResponse.ok) {
                if (typeof payload.refreshToken !== 'string' || typeof payload.recoveryToken !== 'string') {
                    return reply.status(502).send({ message: 'Invalid auth upstream response' });
                }
                setRefreshCookie(reply, payload.refreshToken, typeof payload.refreshCookieMaxAgeSeconds === 'number' ? payload.refreshCookieMaxAgeSeconds : undefined);
                setRecoveryCookie(reply, payload.recoveryToken, typeof payload.recoveryCookieMaxAgeSeconds === 'number' ? payload.recoveryCookieMaxAgeSeconds : undefined);
                ensureCsrfCookie(reply);
            }
            if (!logout && upstreamResponse.status === 401 && authCookieDisposition(code) === 'clear') {
                clearAuthCookies(reply);
            }
            // Bounded refresh/forced-login metrics (no tokens/cookies/digests in labels).
            if (!logout) {
                // Rust is authoritative for refresh outcomes. Node only records the
                // gateway boundary and must never inflate rotation/recovery rates.
                request.log.info(
                    { metric: 'auth_refresh_gateway_boundary', outcome: upstreamResponse.ok ? 'success_unspecified' : 'failure_unspecified' },
                    'security metric',
                );
                if (typeof code === 'string') {
                    const forced = forcedLoginReasonFromAuthCode(code);
                    if (forced) recordForcedLoginMetric(forced, request.log);
                }
            }
            delete payload.refreshToken;
            delete payload.recoveryToken;
            delete payload.refreshCookieMaxAgeSeconds;
            delete payload.recoveryCookieMaxAgeSeconds;
            return reply.status(upstreamResponse.status).send(payload);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 refresh/logout upstream request failed');
            if (logout) clearAuthCookies(reply);
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    const proxyStepUp = async (request: AuthRequest, reply: FastifyReply) => {
        // Issue a five-minute action-group grant. Grant token returns only in the memory
        // response body — never cookies, Set-Cookie, or durable storage. Do not log secrets.
        const body = (request.body ?? {}) as { password?: unknown; otp?: unknown; actionGroup?: unknown };
        const actionGroup = typeof body.actionGroup === 'string' ? body.actionGroup.trim() : '';
        if (!actionGroup) {
            return reply.status(400).send({
                error: { code: 'AUTH_STEP_UP_REQUIRED', message: 'Kelompok aksi tidak valid' },
            });
        }
        let proxySecret: string;
        try {
            proxySecret = getRequiredApiV2ProxySecret();
        } catch {
            return reply.status(503).send({ message: 'Upstream proxy is not configured' });
        }
        const upstreamUrl = `${getApiV2UpstreamUrl()}/v2/auth/step-up`;
        try {
            const { result: upstreamResponse } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (upstreamCorrelationId) => {
                    const headers = prepareRewrittenJsonHeaders(forwardHeadersWithTrace(request, proxySecret, upstreamCorrelationId));
                    stripBrowserStepUpHeaders(headers);
                    return fetch(upstreamUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            password: body.password,
                            otp: body.otp,
                            actionGroup,
                        }),
                        redirect: 'manual',
                    });
                }
            );
            const raw = Buffer.from(await upstreamResponse.arrayBuffer());
            let payload: Record<string, unknown> = {};
            try {
                payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            } catch {
                payload = { message: 'Invalid upstream response' };
            }
            // Never persist grant; never set cookies from this endpoint.
            if (typeof payload.grantToken === 'string') {
                // Secrecy: do not log grantToken / password / otp.
            }
            return reply.status(upstreamResponse.status).send(payload);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 step-up upstream request failed');
            return reply.status(502).send({ message: 'Upstream service unavailable' });
        }
    };

const proxyUnlock = async (request: AuthRequest, reply: FastifyReply) => {
        const refreshToken = request.cookies[REFRESH_COOKIE];
        const recoveryToken = request.cookies[RECOVERY_COOKIE];
        if (!refreshToken || !recoveryToken) {
            return reply.status(401).send({ error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' } });
        }
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        const body = request.body && typeof request.body === 'object'
            ? request.body as Record<string, unknown>
            : {};
        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps, request, reply, upstreamUrl,
                async (gatewayCorrelationId) => {
                    const headers = prepareRewrittenJsonHeaders(forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId));
                    return fetch(upstreamUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ ...body, refreshToken, recoveryToken }),
                        redirect: 'manual',
                    });
                }
            );
            applyFilteredUpstreamHeadersToReply(filterUpstreamResponseHeaders(upstreamResponse), reply);
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);
            const contentType = upstreamResponse.headers.get('content-type') || '';
            if (!contentType.toLowerCase().startsWith('application/json')) {
                return reply.status(502).send({ message: 'Invalid auth upstream response' });
            }
            const payload = await upstreamResponse.json() as Record<string, unknown>;
            const error = payload.error as Record<string, unknown> | undefined;
            const code = error?.code;
            if (upstreamResponse.ok) {
                if (typeof payload.refreshToken !== 'string' || typeof payload.recoveryToken !== 'string') {
                    return reply.status(502).send({ message: 'Invalid auth upstream response' });
                }
                setRefreshCookie(reply, payload.refreshToken, typeof payload.refreshCookieMaxAgeSeconds === 'number' ? payload.refreshCookieMaxAgeSeconds : undefined);
                setRecoveryCookie(reply, payload.recoveryToken, typeof payload.recoveryCookieMaxAgeSeconds === 'number' ? payload.recoveryCookieMaxAgeSeconds : undefined);
                ensureCsrfCookie(reply);
            } else if (upstreamResponse.status === 401 && authCookieDisposition(code) === 'clear') {
                clearAuthCookies(reply);
            }
            delete payload.refreshToken;
            delete payload.recoveryToken;
            delete payload.refreshCookieMaxAgeSeconds;
            delete payload.recoveryCookieMaxAgeSeconds;
            return reply.status(upstreamResponse.status).send(payload);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 unlock upstream request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    const proxyLegacyMigration = async (request: AuthRequest, reply: FastifyReply) => {
        if (isLegacyAccessTokenCutoffPassed() || request.user?.authMode !== 'legacy') {
            return reply.status(401).send({ error: { code: 'AUTH_TOKEN_INVALID', message: 'Legacy token cannot be migrated' } });
        }
        const legacyToken = resolveBearerToken(request);
        if (!legacyToken) {
            return reply.status(401).send({ error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid legacy token' } });
        }
        const decoded = decodeJwtPayload(legacyToken);
        const legacyExpiresAt = typeof decoded?.exp === 'number' ? decoded.exp : null;
        const cutoffMs = getLegacyAccessTokenAcceptUntilMs();
        if (!legacyExpiresAt || cutoffMs === null) {
            clearAuthCookies(reply);
            return reply.status(401).send({ error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid legacy token' } });
        }
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps, request, reply, upstreamUrl,
                async (gatewayCorrelationId) => {
                    const headers = prepareRewrittenJsonHeaders(forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId));
                    headers.delete('authorization');
                    return fetch(upstreamUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            migrationOperationMarker: createHash('sha256').update(legacyToken).digest('hex'),
                            userId: request.user!.id,
                            legacyExpiresAt,
                            migrationCutoffAt: Math.floor(cutoffMs / 1000),
                        }),
                        redirect: 'manual',
                    });
                }
            );
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);
            const contentType = upstreamResponse.headers.get('content-type') || '';
            if (!contentType.toLowerCase().startsWith('application/json')) {
                return reply.status(503).send({ error: { code: 'AUTH_REFRESH_RECOVERY_UNAVAILABLE', message: 'Invalid auth upstream response' } });
            }
            const payload = await upstreamResponse.json() as Record<string, unknown>;
            if (upstreamResponse.ok) {
                if (typeof payload.refreshToken !== 'string' || typeof payload.recoveryToken !== 'string' || typeof payload.csrfToken !== 'string') {
                    return reply.status(503).send({ error: { code: 'AUTH_REFRESH_RECOVERY_UNAVAILABLE', message: 'Invalid auth upstream response' } });
                }
                setRefreshCookie(reply, payload.refreshToken, typeof payload.refreshCookieMaxAgeSeconds === 'number' ? payload.refreshCookieMaxAgeSeconds : undefined);
                setRecoveryCookie(reply, payload.recoveryToken, typeof payload.recoveryCookieMaxAgeSeconds === 'number' ? payload.recoveryCookieMaxAgeSeconds : undefined);
                reply.setCookie(CSRF_COOKIE, payload.csrfToken, { httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: CSRF_COOKIE_PATH });
            } else if (upstreamResponse.status === 401 && payload.code === 'AUTH_TOKEN_INVALID') {
                clearAuthCookies(reply);
            }
            delete payload.refreshToken;
            delete payload.recoveryToken;
            delete payload.refreshCookieMaxAgeSeconds;
            delete payload.recoveryCookieMaxAgeSeconds;
            delete payload.csrfToken;
            return reply.status(upstreamResponse.status).send(payload);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 legacy migration upstream request failed');
            return reply.status(503).send({ error: { code: 'AUTH_REFRESH_RECOVERY_UNAVAILABLE', message: 'API v2 upstream unavailable' } });
        }
    };

    const proxyPublicSettingsRequest = async (request: AuthRequest, reply: FastifyReply) => {
        const now = Date.now();
        const publicSettingsCache = publicSettingsCacheRef.current;
        if (publicSettingsCache && publicSettingsCache.expiresAt > now) {
            applyFilteredUpstreamHeadersToReply(publicSettingsCache.headers, reply);
            reply.header('x-cache', 'HIT');
            const cacheHitTraceId = selectResponseTraceId(request);
            reply.header(TRACE_RESPONSE_HEADER, cacheHitTraceId);
            persistAuthoritativeResponseCorrelation(request, cacheHitTraceId, 'gateway_header');
            return reply.status(publicSettingsCache.status).send(publicSettingsCache.body);
        }

        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => fetch(upstreamUrl, {
                    method: request.method,
                    headers: forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId),
                    redirect: 'manual',
                })
            );
            const headers = filterUpstreamResponseHeaders(upstreamResponse);
            applyFilteredUpstreamHeadersToReply(headers, reply);
            const body = Buffer.from(await upstreamResponse.arrayBuffer());
            if (upstreamResponse.ok) {
                publicSettingsCacheRef.current = {
                    expiresAt: now + PUBLIC_SETTINGS_CACHE_MS,
                    status: upstreamResponse.status,
                    headers: { ...headers, 'cache-control': 'public, max-age=30' },
                    body,
                };
            }
            reply.header('cache-control', 'public, max-age=30');
            reply.header('x-cache', 'MISS');
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);
            return reply.status(upstreamResponse.status).send(body);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 public settings request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    const proxyUploadRequest = async (request: AuthRequest, reply: FastifyReply) => {
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        const multipartRequest = request as AuthRequest & FastifyRequest;

        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => {
                    const file = await multipartRequest.file().catch(() => null);
                    if (!file) {
                        throw new Error('Failed to upload file');
                    }

                    const formData = new FormData();
                    const chunks: Buffer[] = [];
                    for await (const chunk of file.file) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    }
                    const buffer = Buffer.concat(chunks);
                    deps.onProxyWorkActive?.();
                    const arrayBuffer = buffer.buffer.slice(
                        buffer.byteOffset,
                        buffer.byteOffset + buffer.byteLength
                    ) as ArrayBuffer;
                    const blob = new Blob([arrayBuffer], { type: file.mimetype });
                    formData.append('file', blob, file.filename);
                    const headers = forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId);
                    headers.delete('content-type');
                    headers.delete('content-length');

                    return fetch(upstreamUrl, {
                        method: request.method,
                        headers,
                        body: formData,
                        redirect: 'manual',
                    });
                }
            );

            return sendUpstreamResponse(upstreamResponse, reply, responseTraceId);
        } catch (error) {
            if (error instanceof Error && error.message === 'Failed to upload file') {
                return reply.status(500).send({ message: 'Failed to upload file' });
            }
            request.log.error({ error, upstreamUrl }, 'API v2 upload proxy request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    const proxyUploadMultipleRequest = async (request: AuthRequest, reply: FastifyReply) => {
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        const multipartRequest = request as AuthRequest & FastifyRequest;

        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => {
                    const formData = new FormData();
                    const parts = multipartRequest.files();
                    for await (const file of parts) {
                        const chunks: Buffer[] = [];
                        for await (const chunk of file.file) {
                            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        }
                        const buffer = Buffer.concat(chunks);
                        deps.onProxyWorkActive?.();
                        const arrayBuffer = buffer.buffer.slice(
                            buffer.byteOffset,
                            buffer.byteOffset + buffer.byteLength
                        ) as ArrayBuffer;
                        const blob = new Blob([arrayBuffer], { type: file.mimetype });
                        formData.append('file', blob, file.filename);
                    }
                    const headers = forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId);
                    headers.delete('content-type');
                    headers.delete('content-length');

                    return fetch(upstreamUrl, {
                        method: request.method,
                        headers,
                        body: formData,
                        redirect: 'manual',
                    });
                }
            );

            return sendUpstreamResponse(upstreamResponse, reply, responseTraceId);
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 multiple upload proxy request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };

    app.get('/health', proxyRequest);
    app.get('/ping', proxyRequest);
    app.post(
        '/auth/member/login',
        { preHandler: [requireTrustedAuthRequest, authRateLimit] },
        (request, reply) => proxyCredentialRequest(request, reply, '/v2/auth/member/login')
    );
    app.post(
        '/auth/staff/login',
        { preHandler: [requireTrustedAuthRequest, authRateLimit] },
        (request, reply) => proxyCredentialRequest(request, reply, '/v2/auth/staff/login')
    );
    app.post('/auth/register', { preHandler: [requireTrustedAuthRequest, authRateLimit] }, proxyCredentialRequest);
    app.post('/auth/2fa/login-verify', { preHandler: [requireTrustedAuthRequest, authRateLimit] }, proxyCredentialRequest);
    app.post('/auth/device-selection', { preHandler: [requireTrustedAuthMutation, authRateLimit] }, proxyCredentialRequest);
    app.post('/auth/refresh', { preHandler: [requireTrustedAuthMutation, requireRefreshCookies, authRateLimit] }, (request, reply) => proxyRefreshOrLogout(request, reply, false));
    app.post('/auth/logout', { preHandler: [requireTrustedAuthMutation, authRateLimit] }, (request, reply) => proxyRefreshOrLogout(request, reply, true));
    app.post('/auth/activity', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate] }, proxyRequest);
    app.get('/auth/activity-status', { preHandler: [authenticate] }, proxyRequest);
    app.post('/auth/unlock', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticateUnlock] }, proxyUnlock);
    app.post('/auth/step-up', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate] }, proxyStepUp);
    const proxyCurrentSessionLogout = async (request: AuthRequest, reply: FastifyReply) => {
        // Keep the Task 5 cookie policy singular: this endpoint always clears all auth cookies,
        // while Rust authorizes and revokes only the trusted Node-stamped current SID.
        clearAuthCookies(reply);
        return proxyRequest(request, reply);
    };
    app.get('/auth/sessions', { preHandler: [authenticate] }, proxyRequest);
    app.post('/auth/sessions/revoke-current', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate] }, proxyCurrentSessionLogout);
    app.post('/auth/sessions/revoke-device', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate] }, proxyRequest);
    app.post('/auth/sessions/revoke-all', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate, requireStepUp('security.sessions_all')] }, proxyCurrentSessionLogout);
    app.post('/auth/session/migrate', { preHandler: [requireTrustedAuthRequest, authRateLimit, authenticate] }, proxyLegacyMigration);
    app.get('/auth/me', { preHandler: [authenticate] }, proxyRequest);
    app.get('/auth/2fa/status', { preHandler: [authenticate] }, proxyRequest);
    /**
     * API v2 returns `otpauthUrl` but hardcodes `qrCodeDataUrl` to null, while the admin UI
     * renders that field straight into an <img src>. Derive the image here from the upstream
     * otpauth URL so enrollment does not depend on reading the manual secret. The shared
     * secret is never logged and the upstream payload is otherwise passed through untouched.
     */
    const proxyTwoFactorSetup = async (request: AuthRequest, reply: FastifyReply) => {
        const upstreamUrl = `${getApiV2UpstreamUrl()}${toUpstreamPath(request.url)}`;
        try {
            const { result: upstreamResponse, responseTraceId } = await runWithProxySpan(
                deps,
                request,
                reply,
                upstreamUrl,
                async (gatewayCorrelationId) => fetch(upstreamUrl, {
                    method: request.method,
                    headers: prepareRewrittenJsonHeaders(forwardHeadersWithTrace(request, proxySecret, gatewayCorrelationId)),
                    body: toProxyBody(request),
                    redirect: 'manual',
                })
            );
            const contentType = upstreamResponse.headers.get('content-type') || '';
            if (!upstreamResponse.ok || !contentType.toLowerCase().startsWith('application/json')) {
                return sendUpstreamResponse(upstreamResponse, reply, responseTraceId);
            }
            applyFilteredUpstreamHeadersToReply(filterUpstreamResponseHeaders(upstreamResponse), reply);
            reply.header(TRACE_RESPONSE_HEADER, responseTraceId);
            const payload = await upstreamResponse.json() as Record<string, unknown>;
            const otpauthUrl = payload.otpauthUrl;
            if (typeof payload.qrCodeDataUrl !== 'string' && typeof otpauthUrl === 'string' && otpauthUrl.startsWith('otpauth://')) {
                try {
                    payload.qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);
                } catch (error) {
                    // Never fail enrollment on rendering: the manual secret path still works.
                    request.log.error({ error }, 'API v2 2FA setup QR rendering failed');
                }
            }
            reply.type('application/json');
            return reply.status(upstreamResponse.status).send(JSON.stringify(payload));
        } catch (error) {
            request.log.error({ error, upstreamUrl }, 'API v2 2FA setup upstream request failed');
            return reply.status(502).send({ message: 'API v2 upstream unavailable' });
        }
    };
    app.post('/auth/2fa/setup', { preHandler: [authRateLimit, authenticate] }, proxyTwoFactorSetup);
    app.post('/auth/2fa/confirm', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate] }, proxySecurityChangeCredentialRequest);
    app.post('/auth/2fa/disable', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate] }, proxySecurityChangeCredentialRequest);
    app.post('/auth/sessions/revoke', { preHandler: [authRateLimit, authenticate] }, async (request, reply) => {
        await requireTrustedAuthMutation(request, reply);
        if (reply.sent) return reply;
        return proxyRequest(request, reply);
    });
    app.get('/api/key', { preHandler: [authenticate] }, proxyRequest);
    app.post('/api/key/generate', { preHandler: [authenticate] }, proxyRequest);
    app.delete('/api/key/revoke', { preHandler: [authenticate] }, proxyRequest);
    app.get('/api/profile', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.get('/api/categories', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.get('/api/operators', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.get('/api/product-types', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.get('/api/products', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.post('/api/transaction', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.post('/api/order', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.get('/api/transaction/check', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.get('/api/transactions', { preHandler: [authenticateOpenApiSignature] }, proxyRequest as unknown as (request: ApiKeyRequest, reply: FastifyReply) => Promise<unknown>);
    app.get('/articles', proxyRequest);
    app.get('/articles/:slug', proxyRequest);
    app.post('/articles', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.put('/articles/:slug', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.delete('/articles/:slug', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.get('/categories', proxyRequest);
    app.get('/categories/:id', proxyRequest);
    app.get('/operators', proxyRequest);
    app.get('/operators/:id', proxyRequest);
    app.get('/product-types', proxyRequest);
    app.get('/product-types/:id', proxyRequest);
    app.get('/products', proxyRequest);
    app.get('/products/:id', proxyRequest);
    app.post('/validate/freefire', { preHandler: [publicGameValidateRateLimit] }, proxyRequest);
    app.post('/validate/mobilelegends', { preHandler: [publicGameValidateRateLimit] }, proxyRequest);
    app.post('/validate/operator', { preHandler: [publicValidateRateLimit] }, proxyRequest);
    app.get('/validation-products', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.post('/validation-products', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.put('/validation-products/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.delete('/validation-products/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.get('/validation-products/taxonomy/categories', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.get('/validation-products/taxonomy/operators', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.get('/validation-products/taxonomy/product-types', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.post('/products', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.put('/products/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.delete('/products/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.get('/payment-methods', proxyRequest);
    app.get('/payment-methods/active', { preHandler: [authenticate] }, proxyRequest);
    app.get('/payment-categories', proxyRequest);
    app.get('/payment-categories/active', { preHandler: [authenticate] }, proxyRequest);
    app.get('/settings/public', proxyPublicSettingsRequest);
    app.get('/sliders', proxyRequest);
    app.get('/flash-sales/active', proxyRequest);
    app.get('/flash-sales/price/:productId', proxyRequest);
    app.get('/guest-transactions/check/:invoiceNumber', { preHandler: [guestTransactionRateLimit] }, proxyRequest);
    app.get('/guest-transactions', { preHandler: [authenticate, hasPermission('viewTransactions')] }, proxyRequest);
    app.post('/guest-transactions', { preHandler: [requireCriticalIdempotencyKey, guestTransactionRateLimit] }, proxyRequest);
    app.post('/guest-transactions/:id/confirm', { preHandler: [authenticate, hasPermission('processManualTransaction'), requireStepUp('transactions.manual')] }, proxyRequest);
    app.post('/guest-transactions/:id/cancel', { preHandler: [authenticate, hasPermission('processManualTransaction'), requireStepUp('transactions.manual')] }, proxyRequest);
    app.put('/guest-transactions/:id/status', { preHandler: [authenticate, hasPermission('processManualTransaction'), requireStepUp('transactions.manual')] }, proxyRequest);
    app.get('/leaderboard', proxyRequest);
    app.get('/rewards', proxyRequest);
    app.get('/rewards/:id', proxyRequest);
    app.post('/upload', { preHandler: [authenticate, authorizeUploadFolder] }, proxyUploadRequest);
    app.post('/upload/multiple', { preHandler: [authenticate, authorizeUploadFolder] }, proxyUploadMultipleRequest);
    app.get('/upload/list', { preHandler: [authenticate, authorizeUploadFolder] }, proxyRequest);
    app.delete('/upload', { preHandler: [authenticate, authorizeUploadFolder] }, proxyRequest);
    app.get('/system/status', { preHandler: [authenticate, isTeamMember] }, proxyRequest);
    app.get('/audit-logs', { preHandler: [authenticate, hasPermission('viewTeam')] }, proxyRequest);
    app.get('/audit-logs/export', { preHandler: [authenticate, hasPermission('manageTeam'), requireStepUp('exports.sensitive')] }, proxyRequest);
    app.all('/dashboard/*', { preHandler: [authenticate, hasPermission('viewDashboard')] }, proxyRequest);
    app.all('/deposits', { preHandler: [authenticate] }, proxyRequest);
    app.post('/deposits/:id/claim', { preHandler: [authenticate, hasPermission('approveDeposits')] }, proxyRequest);
    app.post('/deposits/:id/release-claim', { preHandler: [authenticate, hasPermission('approveDeposits')] }, proxyRequest);
    app.put('/deposits/:id/approve', { preHandler: [authenticate, hasPermission('approveDeposits'), requireStepUp('finance.deposit_approval')] }, proxyRequest);
    app.put('/deposits/:id/reject', { preHandler: [authenticate, hasPermission('approveDeposits'), requireStepUp('finance.deposit_approval')] }, proxyRequest);
    app.all('/deposits/*', { preHandler: [authenticate, hasPermission('viewDeposits')] }, proxyRequest);
    app.post('/digiflazz-seller/prepaid', proxyRequest);
    app.get('/digiflazz-seller/orders/admin', { preHandler: [authenticate, hasPermission('viewTransactions')] }, proxyRequest);
    app.post('/digiflazz-seller/orders/process-callback-retries/scheduler', { preHandler: [webhookRateLimit] }, proxyRequest);
    app.post('/digiflazz-seller/settings', { preHandler: [authenticate, hasPermission('manageVendors'), requireStepUp('integrations.credentials')] }, proxyRequest);
    app.all('/digiflazz-seller/*', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.post('/irs-seller/prepaid', proxyRequest);
    app.get('/irs-seller/orders/admin', { preHandler: [authenticate, hasPermission('viewTransactions')] }, proxyRequest);
    app.post('/irs-seller/settings', { preHandler: [authenticate, hasPermission('manageVendors'), requireStepUp('integrations.credentials')] }, proxyRequest);
    app.all('/irs-seller/*', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/margins', { preHandler: [authenticate, hasPermission('viewProducts')] }, proxyRequest);
    app.put('/margins', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/notifications/*', { preHandler: [authenticate, hasPermission('viewDashboard')] }, proxyRequest);
    app.post('/categories/admin/create', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/categories/admin/sort-order', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.put('/categories/admin/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.delete('/categories/admin/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/categories/admin/*', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/flash-sales/admin/*', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/operators/admin/*', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/product-types/admin/*', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/products/admin/sort-order', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/products/admin/sort-by-price', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/products/admin/*', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/points/history', { preHandler: [authenticate] }, proxyRequest);
    app.all('/points/*', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.all('/rewards/admin/*', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
    app.put('/payment-categories/reorder', { preHandler: [authenticate, hasPermission('managePayment')] }, proxyRequest);
    app.post('/payment-categories', { preHandler: [authenticate, hasPermission('managePayment')] }, proxyRequest);
    app.put('/payment-categories/:id', { preHandler: [authenticate, hasPermission('managePayment')] }, proxyRequest);
    app.delete('/payment-categories/:id', { preHandler: [authenticate, hasPermission('managePayment')] }, proxyRequest);
    app.post('/payment-methods', { preHandler: [authenticate, hasPermission('managePayment'), requireStepUp('integrations.credentials')] }, proxyRequest);
    app.put('/payment-methods/:id', { preHandler: [authenticate, hasPermission('managePayment'), requireStepUp('integrations.credentials')] }, proxyRequest);
    app.delete('/payment-methods/:id', { preHandler: [authenticate, hasPermission('managePayment'), requireStepUp('integrations.credentials')] }, proxyRequest);
    app.all('/payment-methods/admin/*', { preHandler: [authenticate, hasPermission('viewPayment')] }, proxyRequest);
    app.all('/payment-categories/admin/*', { preHandler: [authenticate, hasPermission('viewPayment')] }, proxyRequest);
    app.all('/reports/dashboard', { preHandler: [authenticate, hasPermission('viewDashboard')] }, proxyRequest);
    app.all('/reports/*', { preHandler: [authenticate, hasPermission('viewReports')] }, proxyRequest);
    app.get('/settings/admin/all', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.put('/settings/admin/update', { preHandler: [authenticate, hasPermission('manageSettings')] }, async (request, reply) => {
        publicSettingsCacheRef.current = null;
        return proxyRequest(request, reply);
    });
    app.get('/settings/admin/:key', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.put('/settings/admin/:key', { preHandler: [authenticate, hasPermission('manageSettings')] }, async (request, reply) => {
        publicSettingsCacheRef.current = null;
        return proxyRequest(request, reply);
    });
    app.get('/sliders/admin/all', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.post('/sliders/admin/create', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.put('/sliders/admin/sort-order', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.put('/sliders/admin/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.delete('/sliders/admin/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, proxyRequest);
    app.all('/transactions/manual', { preHandler: [authenticate, hasPermission('processManualTransaction')] }, proxyRequest);
    app.post('/transactions/:id/refund', { preHandler: [authenticate, hasPermission('processManualTransaction'), requireStepUp('finance.refund'), requireCriticalIdempotencyKey] }, proxyRequest);
    app.post('/transactions/:id/recheck', { preHandler: [authenticate, hasPermission('processManualTransaction')] }, proxyRequest);
    app.put('/transactions/:id/status', { preHandler: [authenticate, hasPermission('processManualTransaction'), requireStepUp('transactions.manual')] }, proxyRequest);
    app.all('/transactions', { preHandler: [authenticate] }, proxyRequest);
    app.all('/transactions/*', { preHandler: [authenticate, hasPermission('viewTransactions')] }, proxyRequest);
    app.get('/teams/admin/audit-logs', { preHandler: [authenticate, hasPermission('manageTeam')] }, proxyRequest);
    app.get('/teams/audit-logs', { preHandler: [authenticate, hasPermission('manageTeam')] }, proxyRequest);
    app.get('/teams/login-logs/all', { preHandler: [authenticate, hasPermission('manageTeam')] }, proxyRequest);
    app.get('/teams/:id/login-logs', { preHandler: [authenticate, hasPermission('manageTeam')] }, proxyRequest);
    app.put('/teams/:id/reset-2fa', { preHandler: [requireTrustedAuthMutation, authRateLimit, authenticate, hasPermission('manageTeam'), requireStepUp('team.reset_2fa')] }, proxyOwnerSecurityChangeRequest);
    app.post('/teams', { preHandler: [authenticate, hasPermission('manageTeam'), requireStepUp('team.manage_privileged')] }, proxyRequest);
    app.put('/teams/:id/toggle', { preHandler: [authenticate, hasPermission('manageTeam'), requireStepUp('team.manage_privileged')] }, proxyRequest);
    app.put('/teams/:id', { preHandler: [authenticate, hasPermission('manageTeam'), requireStepUp('team.manage_privileged')] }, proxyRequest);
    app.delete('/teams/:id', { preHandler: [authenticate, hasPermission('manageTeam'), requireStepUp('team.manage_privileged')] }, proxyRequest);
    app.get('/teams/:id', { preHandler: [authenticate, hasPermission('viewTeam')] }, proxyRequest);
    app.all('/teams/admin/*', { preHandler: [authenticate, hasPermission('viewTeam')] }, proxyRequest);
    app.all('/users/me/profile', { preHandler: [authenticate] }, proxyRequest);
    app.put('/users/me/password', { preHandler: [authenticate] }, proxyRequest);
    // Staff self-service. Reading is plain authenticate; email and password changes are
    // account-takeover paths, so both require fresh step-up proof.
    app.get('/staff/me/profile', { preHandler: [authenticate] }, proxyRequest);
    app.put('/staff/me/profile', { preHandler: [authenticate, requireStepUp('security.password')] }, proxyRequest);
    app.put('/staff/me/password', { preHandler: [authenticate, requireStepUp('security.password')] }, proxyRequest);
    // No step-up: a photo is not an account-takeover path. No authorizeUploadFolder either;
    // that guard maps folders to manageProducts/managePayment/manageSettings, which CS lack.
    app.post('/staff/me/avatar', { preHandler: [authenticate] }, proxyUploadRequest);
    app.delete('/staff/me/avatar', { preHandler: [authenticate] }, proxyRequest);
    app.all('/users/me/login-activity', { preHandler: [authenticate] }, proxyRequest);
    app.all('/users/me/preferences', { preHandler: [authenticate] }, proxyRequest);
    app.all('/users/me/balance-history', { preHandler: [authenticate] }, proxyRequest);
    app.get('/users', { preHandler: [authenticate, hasPermission('viewUsers')] }, proxyRequest);
    app.all('/users/:id/balance-adjustments', { preHandler: [authenticate, hasPermission('viewUsers')] }, proxyRequest);
    app.post('/users/:id/balance', { preHandler: [authenticate, hasPermission('manageUsers'), requireStepUp('finance.adjust_balance'), requireCriticalIdempotencyKey, adminFinancialMutationRateLimit] }, proxyRequest);
    app.put('/users/:id', { preHandler: [authenticate, hasPermission('manageUsers')] }, proxyRequest);
    app.patch('/users/:id/status', { preHandler: [authenticate, hasPermission('manageUsers')] }, proxyRequest);
    app.delete('/users/:id/openapi-key', { preHandler: [authenticate, hasPermission('manageUsers')] }, proxyRequest);
    app.delete('/users/:id', { preHandler: [authenticate, hasPermission('manageUsers')] }, proxyRequest);
    app.all('/users/admin/*', { preHandler: [authenticate, hasPermission('viewUsers')] }, proxyRequest);
    app.get('/users/:id', { preHandler: [authenticate, hasPermission('viewUsers')] }, proxyRequest);
    app.get('/vendors/health', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/health-snapshot', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/health/export', { preHandler: [authenticate, hasPermission('manageVendors'), requireStepUp('exports.sensitive')] }, proxyRequest);
    app.all('/vendors/admin/*', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.all('/vendors', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.post('/vendors/digiflazz/settings', { preHandler: [authenticate, hasPermission('manageVendors'), requireStepUp('integrations.credentials')] }, proxyRequest);
    app.all('/vendors/digiflazz/balance', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.post('/vendors/digiflazz/pricelist/fetch', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/digiflazz/internal-purchases', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.post('/vendors/digiflazz/internal-purchases', { preHandler: [authenticate, hasPermission('manageVendors'), adminFinancialMutationRateLimit] }, proxyRequest);
    app.post('/vendors/tokovoucher/settings', { preHandler: [authenticate, hasPermission('manageVendors'), requireStepUp('integrations.credentials')] }, proxyRequest);
    app.all('/vendors/tokovoucher/balance', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/tokovoucher/categories', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/tokovoucher/operators', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/tokovoucher/jenis', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/tokovoucher/products', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/tokovoucher/search', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.get('/vendors/tokovoucher/internal-purchases', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.post('/vendors/tokovoucher/internal-purchases', { preHandler: [authenticate, hasPermission('manageVendors'), adminFinancialMutationRateLimit] }, proxyRequest);
    app.all('/vendors/:id/stats', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.post('/vendors/:id/test', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.post('/vendors/:id/sync', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.all('/vendors/:id', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
    app.all('/vendors/*', { preHandler: [authenticate, hasPermission('viewVendors')] }, proxyRequest);
    app.post('/vouchers/redeem', { preHandler: [voucherRedeemRateLimit, authenticate] }, proxyRequest);
    // Giveaway execution credits member balances, so it needs both a bounded idempotency key
    // and the same server-selected finance step-up as direct balance adjustments. Keep this
    // route before the generic voucher catch-all so the trusted group is stamped upstream.
    app.post('/vouchers/giveaways', {
        preHandler: [
            authenticate,
            hasPermission('manageVouchers'),
            requireStepUp('finance.adjust_balance'),
            requireCriticalIdempotencyKey,
        ],
    }, proxyRequest);
    // Checkout discount validation is public (guest checkout) with rate limit; optional auth enriches one-per-user checks.
    app.post('/vouchers/discount/validate', { preHandler: [guestTransactionRateLimit] }, proxyRequest);
    app.all('/vouchers*', { preHandler: [authenticate, hasPermission('manageVouchers')] }, proxyRequest);
    app.post('/webhook/digiflazz', { preHandler: [webhookRateLimit] }, handleDigiflazzWebhook);
    app.post('/webhook/tokovoucher', { preHandler: [webhookRateLimit] }, handleTokovoucherWebhook);
    app.all('/webhook/*', { preHandler: [authenticate, hasPermission('manageVendors')] }, proxyRequest);
}
