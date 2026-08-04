export type AuthErrorCode =
    | 'AUTH_ACCESS_EXPIRED'
    | 'AUTH_TOKEN_INVALID'
    | 'AUTH_SESSION_EXPIRED'
    | 'AUTH_SESSION_REVOKED'
    | 'AUTH_SESSION_POLICY_CHANGED'
    | 'AUTH_REFRESH_REUSED'
    | 'AUTH_ACCOUNT_DISABLED'
    | 'AUTH_DEVICE_LIMIT_REACHED'
    | 'AUTH_2FA_ENROLLMENT_REQUIRED'
    | 'AUTH_IDLE_LOCKED'
    | 'AUTH_STEP_UP_REQUIRED'
    | 'AUTH_REFRESH_RACE'
    | 'AUTH_REFRESH_RECOVERY_UNAVAILABLE'
    | 'AUTH_REFRESH_RECOVERY_EXPIRED'
    | 'REAUTH_PASSWORD_INVALID'
    | 'REAUTH_OTP_INVALID'
    | 'PERMISSION_DENIED';

export const REFRESHABLE_AUTH_CODES = new Set<AuthErrorCode>(['AUTH_ACCESS_EXPIRED']);

export const TERMINAL_AUTH_CODES = new Set<AuthErrorCode>([
    'AUTH_SESSION_EXPIRED',
    'AUTH_SESSION_REVOKED',
    'AUTH_SESSION_POLICY_CHANGED',
    'AUTH_REFRESH_REUSED',
    'AUTH_REFRESH_RECOVERY_EXPIRED',
    'AUTH_ACCOUNT_DISABLED',
    'AUTH_TOKEN_INVALID',
]);

const AUTH_ERROR_CODES = new Set<AuthErrorCode>([
    ...REFRESHABLE_AUTH_CODES,
    ...TERMINAL_AUTH_CODES,
    'REAUTH_PASSWORD_INVALID',
    'REAUTH_OTP_INVALID',
    'PERMISSION_DENIED',
    'AUTH_DEVICE_LIMIT_REACHED',
    'AUTH_2FA_ENROLLMENT_REQUIRED',
    'AUTH_IDLE_LOCKED',
    'AUTH_STEP_UP_REQUIRED',
    'AUTH_REFRESH_RACE',
    'AUTH_REFRESH_RECOVERY_UNAVAILABLE',
    'AUTH_REFRESH_RECOVERY_EXPIRED',
]);

export type ParsedAuthError = {
    code?: AuthErrorCode;
    message: string;
    status?: number;
};

const LEGACY_MESSAGE_CODE_MAP: Array<{ pattern: RegExp; code: AuthErrorCode }> = [
    { pattern: /session revoked/i, code: 'AUTH_SESSION_REVOKED' },
    { pattern: /invalid token/i, code: 'AUTH_TOKEN_INVALID' },
    { pattern: /no token provided/i, code: 'AUTH_TOKEN_INVALID' },
    { pattern: /user not found/i, code: 'AUTH_TOKEN_INVALID' },
    { pattern: /account inactive|forbidden: account inactive/i, code: 'AUTH_ACCOUNT_DISABLED' },
    { pattern: /permission denied/i, code: 'PERMISSION_DENIED' },
    { pattern: /otp tidak valid/i, code: 'REAUTH_OTP_INVALID' },
    { pattern: /password.*tidak valid|invalid password/i, code: 'REAUTH_PASSWORD_INVALID' },
];

const isAuthErrorCode = (value: unknown): value is AuthErrorCode =>
    typeof value === 'string' && AUTH_ERROR_CODES.has(value as AuthErrorCode);

export function parseAuthError(error: unknown): ParsedAuthError {
    if (!error || typeof error !== 'object') {
        return { message: error instanceof Error ? error.message : 'Network Error' };
    }

    const response = (error as { response?: { status?: number; data?: unknown } }).response;
    if (!response) {
        return { message: error instanceof Error ? error.message : 'Network Error' };
    }

    const data = response.data;
    let message = 'Request failed';
    if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        if (typeof record.message === 'string' && record.message.trim()) {
            message = record.message;
        } else if (record.error && typeof record.error === 'object' && typeof (record.error as { message?: string }).message === 'string') {
            message = (record.error as { message: string }).message;
        }
    }

    let code: AuthErrorCode | undefined;
    if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        const nested = record.error;
        if (nested && typeof nested === 'object' && isAuthErrorCode((nested as { code?: unknown }).code)) {
            code = (nested as { code: AuthErrorCode }).code;
        } else if (isAuthErrorCode(record.code)) {
            code = record.code;
        }
    }

    if (!code) {
        for (const entry of LEGACY_MESSAGE_CODE_MAP) {
            if (entry.pattern.test(message)) {
                code = entry.code;
                break;
            }
        }
        if (!code && response.status === 403 && /forbidden/i.test(message)) {
            code = 'PERMISSION_DENIED';
        }
    }

    return { code, message, status: response.status };
}

export function shouldTerminateSession(code?: AuthErrorCode): boolean {
    return !!code && TERMINAL_AUTH_CODES.has(code);
}

/** Unlock credential failures stay on the form; a server throttle must remove every retry control. */
export function resolveUnlockFailurePhase(parsed: ParsedAuthError): 'locked' | 'rate-limited' {
    return parsed.status === 429 ? 'rate-limited' : 'locked';
}

/**
 * These outcomes cannot prove whether Rust committed the unlock and only the response was lost.
 * A single refresh uses the existing predecessor/recovery protocol to settle that ambiguity.
 */
export function shouldAttemptUnlockResponseRecovery(parsed: ParsedAuthError): boolean {
    return parsed.status === undefined || [500, 502, 503, 504].includes(parsed.status);
}

/** True only for no HTTP response (network) or temporary upstream 500/502/503. */
export function shouldPreserveSessionOnBootstrapFailure(parsed: ParsedAuthError): boolean {
    if (parsed.status === undefined) {
        return true;
    }
    return [500, 502, 503].includes(parsed.status);
}

/** Mirrors checkAuth catch routing for harness assertions. */
export function resolveBootstrapFailurePhase(
    parsed: ParsedAuthError
): 'revoked' | 'locked' | 'rate-limited' | 'offline-stale' | 'bootstrap-retry' {
    if (parsed.code && shouldTerminateSession(parsed.code)) {
        return 'revoked';
    }
    // A locked session is recoverable by the user, but only through the password/OTP unlock form.
    // Any other phase hides that form, so this must be checked before the preserve/retry split.
    if (parsed.code === 'AUTH_IDLE_LOCKED') {
        return 'locked';
    }
    // Do not reuse offline-stale: that phase intentionally retries on visibility/online and offers
    // a Coba lagi button, both of which extend the server's rate-limit block.
    if (parsed.status === 429) {
        return 'rate-limited';
    }
    if (shouldPreserveSessionOnBootstrapFailure(parsed)) {
        return 'offline-stale';
    }
    return 'bootstrap-retry';
}

export function sanitizeInternalReturnTo(pathname: string, search = '', hash = ''): string {
    const candidate = `${pathname}${search}${hash}`;
    if (!candidate.startsWith('/') || candidate.startsWith('//')) {
        return '/';
    }
    if (/^https?:/i.test(candidate)) {
        return '/';
    }
    return candidate;
}
