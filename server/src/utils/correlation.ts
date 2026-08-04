import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { trace } from '@opentelemetry/api';
import { randomBytes } from 'node:crypto';

export const TRACE_RESPONSE_HEADER = 'x-trace-id';
export const GATEWAY_CORRELATION_HEADER = 'x-webtopup-correlation-id';
export const API_V2_PROXY_SECRET_HEADER = 'x-api-v2-proxy-secret';

const ALL_ZERO_TRACE_ID = '00000000000000000000000000000000';
const ALL_ZERO_SPAN_ID = '0000000000000000';
const CORRELATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const OTEL_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

const STRIP_HEADER_NAMES = new Set([
    'x-trace-id',
    'traceparent',
    'tracestate',
    'baggage',
    API_V2_PROXY_SECRET_HEADER,
]);

const UPSTREAM_RESPONSE_DENY_HEADER_NAMES = new Set([
    'set-cookie',
    'set-cookie2',
    'x-trace-id',
    'traceparent',
    'tracestate',
    'baggage',
    API_V2_PROXY_SECRET_HEADER,
    GATEWAY_CORRELATION_HEADER,
]);

export const isWbtopupUserHeader = (name: string) => name.toLowerCase().startsWith('x-webtopup-user-');

export function isUpstreamResponseHeaderDenied(name: string): boolean {
    const normalized = name.toLowerCase();
    return UPSTREAM_RESPONSE_DENY_HEADER_NAMES.has(normalized) || isWbtopupUserHeader(normalized);
}

export function isValidOtelSpanId(value: unknown): value is string {
    return typeof value === 'string'
        && OTEL_SPAN_ID_PATTERN.test(value)
        && value !== ALL_ZERO_SPAN_ID;
}

export function generateCorrelationId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const id = randomBytes(16).toString('hex');
        if (id !== ALL_ZERO_TRACE_ID && CORRELATION_ID_PATTERN.test(id)) {
            return id;
        }
    }

    const fallback = randomBytes(16).toString('hex');
    return fallback === ALL_ZERO_TRACE_ID ? '00000000000000000000000000000001' : fallback;
}

export function isValidCorrelationId(value: unknown): value is string {
    return typeof value === 'string'
        && CORRELATION_ID_PATTERN.test(value)
        && value !== ALL_ZERO_TRACE_ID;
}

export function stripUntrustedCorrelationHeaders(
    headers: Record<string, string | string[] | undefined>
): void {
    for (const name of Object.keys(headers)) {
        const normalized = name.toLowerCase();
        if (STRIP_HEADER_NAMES.has(normalized) || isWbtopupUserHeader(normalized)) {
            delete headers[name];
        }
    }
}

declare module 'fastify' {
    interface FastifyRequest {
        gatewayCorrelationId: string;
        authoritativeCorrelationId?: string;
        authoritativeCorrelationSource?: AuditCorrelationSource;
    }
}

export function getRequestCorrelation(request: FastifyRequest): string {
    if (!request.gatewayCorrelationId) {
        request.gatewayCorrelationId = generateCorrelationId();
    }
    return request.gatewayCorrelationId;
}

export type AuditCorrelationSource = 'otel_span' | 'gateway_header' | 'absent';

export type AuditCorrelationResolution = {
    traceId?: string;
    correlationSource: AuditCorrelationSource;
};

export function resolveAuditCorrelation(input: {
    gatewayCorrelationId?: string;
    headers?: Record<string, string | string[] | undefined>;
}): AuditCorrelationResolution {
    void input.headers;
    const span = trace.getActiveSpan();
    const spanTraceId = span?.spanContext().traceId;
    if (spanTraceId && isValidCorrelationId(spanTraceId)) {
        return {
            traceId: spanTraceId,
            correlationSource: 'otel_span',
        };
    }
    if (input.gatewayCorrelationId && isValidCorrelationId(input.gatewayCorrelationId)) {
        return {
            traceId: input.gatewayCorrelationId,
            correlationSource: 'gateway_header',
        };
    }
    return {
        correlationSource: 'absent',
    };
}

export function persistAuthoritativeResponseCorrelation(
    request: FastifyRequest,
    traceId: string,
    source: Exclude<AuditCorrelationSource, 'absent'>
): void {
    if (!isValidCorrelationId(traceId)) {
        return;
    }
    request.authoritativeCorrelationId = traceId;
    request.authoritativeCorrelationSource = source;
}

export function getAuthoritativeAuditCorrelation(request: FastifyRequest): AuditCorrelationResolution {
    const id = request.authoritativeCorrelationId;
    if (id && isValidCorrelationId(id)) {
        return {
            traceId: id,
            correlationSource: request.authoritativeCorrelationSource ?? 'gateway_header',
        };
    }
    return resolveAuditCorrelation({
        gatewayCorrelationId: request.gatewayCorrelationId,
    });
}

export function selectResponseTraceId(request: FastifyRequest): string {
    const span = trace.getActiveSpan();
    const spanTraceId = span?.spanContext().traceId;
    if (spanTraceId && isValidCorrelationId(spanTraceId)) {
        return spanTraceId;
    }
    return getRequestCorrelation(request);
}

export function gatewayFastifyServerOptions(): {
    genReqId: (req: import('node:http').IncomingMessage) => string;
    requestIdLogLabel: string;
} {
    return {
        genReqId() {
            return generateCorrelationId();
        },
        requestIdLogLabel: 'trace_id',
    };
}

export function registerGatewayCorrelationLifecycle(app: FastifyInstance): void {
    app.decorateRequest('gatewayCorrelationId', '');
    app.decorateRequest('authoritativeCorrelationId', undefined);
    app.decorateRequest('authoritativeCorrelationSource', undefined);

    app.addHook('onRequest', async (request) => {
        stripUntrustedCorrelationHeaders(request.headers);
        const gatewayId = isValidCorrelationId(request.id) ? request.id : generateCorrelationId();
        request.gatewayCorrelationId = gatewayId;
    });

    const applyTraceResponseHeader = async (request: FastifyRequest, reply: FastifyReply) => {
        if (reply.raw.headersSent) {
            return;
        }
        const existing = reply.getHeader(TRACE_RESPONSE_HEADER);
        if (existing !== undefined && existing !== null && String(existing).length > 0) {
            const existingTraceId = String(existing);
            if (isValidCorrelationId(existingTraceId)) {
                if (!request.authoritativeCorrelationId) {
                    const source: Exclude<AuditCorrelationSource, 'absent'> =
                        request.authoritativeCorrelationSource === 'otel_span'
                            ? 'otel_span'
                            : 'gateway_header';
                    persistAuthoritativeResponseCorrelation(request, existingTraceId, source);
                }
                return;
            }
        }
        const traceId = selectResponseTraceId(request);
        reply.header(TRACE_RESPONSE_HEADER, traceId);
        const span = trace.getActiveSpan();
        const spanTraceId = span?.spanContext().traceId;
        const source: Exclude<AuditCorrelationSource, 'absent'> =
            spanTraceId && isValidCorrelationId(spanTraceId) && spanTraceId === traceId
                ? 'otel_span'
                : 'gateway_header';
        persistAuthoritativeResponseCorrelation(request, traceId, source);
    };

    app.addHook('onSend', applyTraceResponseHeader);
    app.addHook('onError', async (request, reply) => {
        await applyTraceResponseHeader(request, reply);
    });

    app.addHook('preSerialization', async (request, reply) => {
        await applyTraceResponseHeader(request, reply);
    });
}