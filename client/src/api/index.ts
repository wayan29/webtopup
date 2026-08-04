import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { accessTokenStore } from '../auth/accessToken.ts';
import { getAuthCoordinator, readCsrfCookie } from '../auth/sessionRuntime.ts';

const apiV2BaseUrl = import.meta.env?.VITE_API_V2_URL || '/api/v2';

const AUTH_MUTATION_PREFIX = '/auth/';

export type ApiV2RequestConfig = InternalAxiosRequestConfig & {
    _authRetried?: boolean;
    _skipAuthRefresh?: boolean;
    authRetrySafe?: boolean;
    /** Stable mutation key issued by the confirmation flow before first attempt. */
    idempotencyKey?: string;
};

export const CRITICAL_MUTATION_AMBIGUOUS_MESSAGE = 'Status belum dapat dipastikan';

export function createIdempotencyKey(): string {
    // Fail closed: crypto-only. Unpredictable mutation identifiers must not use non-crypto PRNG fallbacks.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('Web Crypto tidak tersedia untuk membuat Idempotency-Key');
}

function headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const record = headers as Record<string, unknown>;
    const entry = Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!entry) return undefined;
    const value = entry[1];
    return typeof value === 'string' ? value : undefined;
}

function setHeader(headers: Record<string, unknown>, name: string, value: string) {
    // Prefer exact canonical name; strip case variants first.
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name.toLowerCase() && key !== name) {
            delete headers[key];
        }
    }
    headers[name] = value;
}

export function attachIdempotencyKey(
    config: ApiV2RequestConfig = {} as ApiV2RequestConfig,
    key: string,
): ApiV2RequestConfig {
    const next: ApiV2RequestConfig = {
        ...config,
        headers: { ...((config.headers as Record<string, unknown> | undefined) ?? {}) } as never,
        idempotencyKey: key,
    };
    const headers = next.headers as unknown as Record<string, unknown>;
    // Never invent a different key when one is already present.
    const existing = headerValue(headers, 'Idempotency-Key')?.trim();
    if (existing) {
        next.idempotencyKey = existing;
        return next;
    }
    setHeader(headers, 'Idempotency-Key', key);
    return next;
}

/**
 * Locally possible post-commit ambiguity for critical financial mutations.
 * Includes network loss, gateway 502/504, upstream 503, and server 500 after a
 * durable domain write when the idempotency complete step fails.
 * Callers must not auto-retry; show reconciliation UX instead.
 */
export function mutationFailureCode(error: unknown): string | undefined {
    const data = (error as AxiosError | undefined)?.response?.data as Record<string, unknown> | undefined;
    const nested = data?.error as Record<string, unknown> | undefined;
    return typeof nested?.code === 'string'
        ? nested.code
        : typeof data?.code === 'string'
            ? data.code
            : undefined;
}

export function isIdempotencyInProgressFailure(error: unknown): boolean {
    return (error as AxiosError | undefined)?.response?.status === 409
        && mutationFailureCode(error) === 'IDEMPOTENCY_IN_PROGRESS';
}

export function isIdempotencyConflictFailure(error: unknown): boolean {
    return (error as AxiosError | undefined)?.response?.status === 409
        && mutationFailureCode(error) === 'IDEMPOTENCY_KEY_CONFLICT';
}

export function isAmbiguousMutationFailure(error: unknown): boolean {
    const axiosError = error as AxiosError | undefined;
    if (!axiosError || typeof axiosError !== 'object') return false;
    if (!axiosError.response) {
        // Network error / timeout / CORS — request may or may not have reached the server.
        return true;
    }
    const status = axiosError.response.status;
    return status === 500 || status === 502 || status === 503 || status === 504;
}

export const apiV2 = axios.create({
    baseURL: apiV2BaseUrl,
    withCredentials: true,
    headers: {
        'Content-Type': 'application/json',
    },
});

export function isCredentialedAuthMutation(config: ApiV2RequestConfig): boolean {
    const method = (config.method ?? 'get').toLowerCase();
    if (!['post', 'put', 'patch', 'delete'].includes(method)) return false;
    try {
        const base = new URL(config.baseURL ?? apiV2BaseUrl, 'http://browser.local');
        const basePath = base.pathname.replace(/\/$/, '');
        const rawUrl = config.url ?? '';
        const path = /^https?:\/\//i.test(rawUrl)
            ? new URL(rawUrl).pathname
            : new URL(`${basePath}/${rawUrl.replace(/^\//, '')}`, base.origin).pathname;
        return path.startsWith(`${basePath}${AUTH_MUTATION_PREFIX}`);
    } catch {
        return false;
    }
}

apiV2.interceptors.request.use((config) => {
    const cfg = config as ApiV2RequestConfig;
    const token = accessTokenStore.get();
    if (token) {
        cfg.headers.Authorization = `Bearer ${token}`;
    }
    if (isCredentialedAuthMutation(cfg)) {
        const csrf = readCsrfCookie();
        if (csrf) {
            cfg.headers['X-CSRF-Token'] = csrf;
        }
    }
    // Preserve caller-issued Idempotency-Key only; never invent one here (including retries).
    const existing = headerValue(cfg.headers, 'Idempotency-Key')?.trim();
    if (!existing && cfg.idempotencyKey?.trim()) {
        cfg.headers['Idempotency-Key'] = cfg.idempotencyKey.trim();
    }
    return cfg;
});

apiV2.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const config = error.config as ApiV2RequestConfig | undefined;
        if (!config || config._skipAuthRefresh) {
            return Promise.reject(error);
        }
        const coordinator = getAuthCoordinator();
        if (!coordinator) {
            return Promise.reject(error);
        }
        try {
            return await coordinator.handleAuthFailure(
                {
                    method: config.method,
                    url: config.url,
                    headers: config.headers as Record<string, unknown>,
                    _authRetried: config._authRetried,
                    authRetrySafe: config.authRetrySafe,
                },
                (retryConfig) => {
                    const next = { ...config } as ApiV2RequestConfig;
                    next._authRetried = retryConfig._authRetried;
                    if (retryConfig.headers) {
                        for (const [key, value] of Object.entries(retryConfig.headers)) {
                            if (typeof value === 'string') next.headers.set(key, value);
                        }
                    }
                    // Keep the same Idempotency-Key across access refresh retries.
                    const key =
                        headerValue(config.headers, 'Idempotency-Key')?.trim()
                        || config.idempotencyKey?.trim();
                    if (key) {
                        next.headers.set('Idempotency-Key', key);
                        next.idempotencyKey = key;
                    }
                    return apiV2.request(next);
                },
                error,
            );
        } catch {
            return Promise.reject(error);
        }
    },
);
