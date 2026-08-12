import { FastifyRequest } from 'fastify';
import { AdminAuditLog, User } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';
import { getRequestClientIp } from '../utils/requestIp';
import { getAuthoritativeAuditCorrelation } from '../utils/correlation';

type AuditAction = 'create' | 'update' | 'delete' | 'execute';

export const ADMIN_AUDIT_REDACTION = '[redacted]';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EXACT_SENSITIVE_AUDIT_KEYS = new Set([
    'password',
    'currentpassword',
    'newpassword',
    'confirmpassword',
    'pin',
    'merchantpin',
    'transactionpin',
    'securitypin',
    'apikey',
    'secret',
    'vendorsecret',
    'twofactorsecret',
    'twofactorpendingsecret',
    'otp',
    'code',
    'token',
    'authorization',
    'cookie',
    'csrftoken',
    'xcsrftoken',
    'accesstoken',
    'refreshtoken',
    'recoverytoken',
    'ciphertext',
    'nonce',
    'digest',
    'sessiontokenhashsecret',
]);

const ACTION_BY_METHOD: Record<string, AuditAction> = {
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete'
};

const RESOURCE_LABELS: Record<string, string> = {
    auth: 'Auth',
    products: 'Products',
    transactions: 'Transactions',
    deposits: 'Deposits',
    users: 'Users',
    reports: 'Reports',
    vendors: 'Vendors',
    points: 'Points',
    rewards: 'Rewards',
    vouchers: 'Vouchers',
    teams: 'Teams',
    categories: 'Product Categories',
    operators: 'Product Operators',
    'product-types': 'Product Types',
    'payment-methods': 'Payment Methods',
    'payment-categories': 'Payment Categories',
    validate: 'Validation',
    'guest-transactions': 'Guest Transactions',
    margins: 'Margins',
    sliders: 'Sliders',
    settings: 'Settings',
    api: 'Open API',
    'flash-sales': 'Flash Sales',
    leaderboard: 'Leaderboard',
    articles: 'Articles',
    webhook: 'Webhooks',
    'digiflazz-seller': 'Digiflazz Seller',
    upload: 'Uploads'
};

const MAX_AUDIT_DEPTH = 8;

export const normalizeAuditMetadataKey = (key: string) =>
    key.replace(/[^a-z0-9]/gi, '').toLowerCase();

export const isSensitiveAuditMetadataKey = (key: string) => {
    const normalized = normalizeAuditMetadataKey(key);
    return EXACT_SENSITIVE_AUDIT_KEYS.has(normalized)
        || /(token|password|secret|apikey|authorization|cookie|ciphertext|otp|csrf|nonce|digest)/i.test(normalized);
};

const sanitizeValue = (value: unknown, depth = 0): unknown => {
    if (depth >= MAX_AUDIT_DEPTH) return '[depth-limited]';
    if (Array.isArray(value)) return value.slice(0, 50).map(entry => sanitizeValue(entry, depth + 1));
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).slice(0, 100).reduce((acc, [key, entry]) => {
            acc[key] = isSensitiveAuditMetadataKey(key)
                ? ADMIN_AUDIT_REDACTION
                : sanitizeValue(entry, depth + 1);
            return acc;
        }, {} as Record<string, unknown>);
    }
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}...`;
    return value;
};

const getPathname = (request: FastifyRequest) => request.url.split('?')[0];

const getResourceFromPath = (path: string) => {
    const segments = path.split('/').filter(Boolean);
    const resourceKey = segments[0] === 'v1'
        ? segments[1]
        : segments[0] === 'api' && segments[1] === 'v2'
            ? segments[2]
            : segments[0];
    return RESOURCE_LABELS[resourceKey] || resourceKey || 'Unknown';
};

const shouldAuditRequest = (request: AuthRequest) => {
    const method = request.method.toUpperCase();
    const path = getPathname(request);
    const user = request.user;

    if (!user) {
        return false;
    }

    const isAuditableV1 = path.startsWith('/v1/')
        && !path.startsWith('/v1/auth/login')
        && !path.startsWith('/v1/auth/register')
        && !path.startsWith('/v1/audit-logs');
    const isAuditableV2 = path.startsWith('/api/v2/')
        // Login bodies carry credentials. The generic endpoint is gone, so both audience
        // endpoints must be excluded by name; a stale single-path exclusion would start
        // writing staff credentials into the audit log.
        && !path.startsWith('/api/v2/auth/member/login')
        && !path.startsWith('/api/v2/auth/staff/login')
        && !path.startsWith('/api/v2/auth/register')
        && !path.startsWith('/api/v2/audit-logs');

    return ['owner', 'admin', 'cs'].includes(user.role)
        && WRITE_METHODS.has(method)
        && (isAuditableV1 || isAuditableV2);
};

export type AdminAuditWriterDependencies = {
    findActor(id: string): Promise<{ _id: unknown; name?: string; email: string; role: string } | null>;
    createAuditLog(document: Record<string, unknown>): Promise<unknown>;
};

const defaultAdminAuditWriterDependencies: AdminAuditWriterDependencies = {
    findActor: async (id) => User.findById(id).select('name email role').lean() as Promise<{
        _id: unknown;
        name?: string;
        email: string;
        role: string;
    } | null>,
    createAuditLog: async (document) => AdminAuditLog.create(document),
};

export const recordAdminAuditLog = async (
    request: AuthRequest,
    statusCode: number,
    dependencies: AdminAuditWriterDependencies = defaultAdminAuditWriterDependencies,
) => {
    if (!shouldAuditRequest(request)) {
        return;
    }

    const correlation = getAuthoritativeAuditCorrelation(request);

    try {
        const actor = await dependencies.findActor(request.user!.id);
        if (!actor) {
            return;
        }

        const method = request.method.toUpperCase();
        const path = getPathname(request);
        const resource = getResourceFromPath(path);
        const action = ACTION_BY_METHOD[method] || 'execute';
        const params = request.params && Object.keys(request.params as Record<string, unknown>).length > 0
            ? sanitizeValue(request.params)
            : undefined;
        const body = request.body && Object.keys(request.body as Record<string, unknown>).length > 0
            ? sanitizeValue(request.body)
            : undefined;

        await dependencies.createAuditLog({
            actor: actor._id,
            actorName: actor.name || actor.email,
            actorEmail: actor.email,
            actorRole: actor.role,
            action,
            resource,
            method,
            path,
            statusCode,
            ip: getRequestClientIp(request),
            userAgent: String(request.headers['user-agent'] || ''),
            summary: `${method} ${path}`,
            metadata: {
                auditSource: 'node_gateway',
                ...(correlation.traceId ? { traceId: correlation.traceId } : {}),
                correlationSource: correlation.correlationSource,
                ...(params !== undefined ? { params } : {}),
                ...(body !== undefined ? { body } : {}),
            }
        });
    } catch (error) {
        request.log.error({
            error,
            trace_id: correlation.traceId,
            correlationSource: correlation.correlationSource,
        }, 'Failed to record admin audit log');
    }
};

/** @internal Exported for behavioral audit metadata tests */
export const sanitizeAuditMetadataValue = sanitizeValue;
