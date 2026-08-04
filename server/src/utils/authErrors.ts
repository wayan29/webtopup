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

const PRESERVE_SESSION_CODES = new Set<AuthErrorCode>([
    'REAUTH_PASSWORD_INVALID',
    'REAUTH_OTP_INVALID',
    'PERMISSION_DENIED',
]);

const AUTH_ERROR_CODES = new Set<AuthErrorCode>([
    ...REFRESHABLE_AUTH_CODES,
    ...TERMINAL_AUTH_CODES,
    ...PRESERVE_SESSION_CODES,
    'AUTH_DEVICE_LIMIT_REACHED',
    'AUTH_2FA_ENROLLMENT_REQUIRED',
    'AUTH_IDLE_LOCKED',
    'AUTH_STEP_UP_REQUIRED',
    'AUTH_REFRESH_RACE',
    'AUTH_REFRESH_RECOVERY_UNAVAILABLE',
    'AUTH_REFRESH_RECOVERY_EXPIRED',
]);

export type CookieDisposition = 'clear' | 'preserve' | 'unchanged';

// Security-change codes are a separate upstream protocol and must not become base auth codes.
const TERMINAL_COOKIE_CODES = new Set<string>([
    ...TERMINAL_AUTH_CODES,
    'AUTH_SECURITY_CHANGE_RECOVERY_EXPIRED',
]);

/** Cookie changes are driven only by explicit stable codes, never status alone. */
export function authCookieDisposition(code: unknown): CookieDisposition {
    if (typeof code !== 'string') {
        return 'preserve';
    }
    return TERMINAL_COOKIE_CODES.has(code) ? 'clear' : 'preserve';
}

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

const readResponsePayload = (error: unknown): { status?: number; data?: unknown } | undefined => {
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    const response = (error as { response?: { status?: number; data?: unknown } }).response;
    return response;
};

const readMessage = (data: unknown): string | undefined => {
    if (!data || typeof data !== 'object') {
        return undefined;
    }
    const record = data as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
        return record.message;
    }
    const nested = record.error;
    if (nested && typeof nested === 'object' && typeof (nested as { message?: string }).message === 'string') {
        return (nested as { message: string }).message;
    }
    return undefined;
};

const inferCodeFromLegacyMessage = (message: string, status?: number): AuthErrorCode | undefined => {
    for (const entry of LEGACY_MESSAGE_CODE_MAP) {
        if (entry.pattern.test(message)) {
            return entry.code;
        }
    }
    if (status === 403 && /forbidden/i.test(message)) {
        return 'PERMISSION_DENIED';
    }
    return undefined;
};

export function parseAuthError(error: unknown): ParsedAuthError {
    const response = readResponsePayload(error);
    if (!response) {
        return {
            message: error instanceof Error ? error.message : 'Network Error',
        };
    }

    const data = response.data;
    const message = readMessage(data) ?? 'Request failed';
    let code: AuthErrorCode | undefined;

    if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        const nested = record.error;
        if (nested && typeof nested === 'object') {
            const nestedCode = (nested as { code?: unknown }).code;
            if (isAuthErrorCode(nestedCode)) {
                code = nestedCode;
            }
        }
        if (!code && isAuthErrorCode(record.code)) {
            code = record.code;
        }
    }

    if (!code) {
        code = inferCodeFromLegacyMessage(message, response.status);
    }

    return {
        code,
        message,
        status: response.status,
    };
}

export function shouldTerminateSession(code?: AuthErrorCode): boolean {
    if (!code) {
        return false;
    }
    return TERMINAL_AUTH_CODES.has(code);
}

export function shouldPreserveSessionOnBootstrapFailure(parsed: ParsedAuthError): boolean {
    if (parsed.code && shouldTerminateSession(parsed.code)) {
        return false;
    }
    if (parsed.code && PRESERVE_SESSION_CODES.has(parsed.code)) {
        return true;
    }
    if (!parsed.status) {
        return true;
    }
    return [500, 502, 503].includes(parsed.status);
}

export function sendAuthError(
    reply: { status: (code: number) => { send: (body: unknown) => unknown }; log?: { info: (obj: object, msg?: string) => void } },
    status: number,
    code: AuthErrorCode,
    message: string
) {
    // Bounded forced-login metric for terminal auth codes only (no credentials).
    try {
        // Lazy require avoids circular import with sessionConfig consumers during module init.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { forcedLoginReasonFromAuthCode, recordForcedLoginMetric } = require('./sessionConfig') as typeof import('./sessionConfig');
        const reason = forcedLoginReasonFromAuthCode(code);
        if (reason && (status === 401 || status === 403)) {
            recordForcedLoginMetric(reason, reply.log);
        }
    } catch {
        // metrics are best-effort
    }
    return reply.status(status).send({
        error: {
            code,
            message,
        },
    });
}

/**
 * Gateway-local step-up rejection envelope.
 * Always includes the server-selected actionGroup so the client can open the
 * correct dialog. Never accept or echo a browser-supplied group here.
 * Non-step-up callers must keep using sendAuthError (no fabricated group).
 */
export function sendStepUpRequiredError(
    reply: { status: (code: number) => { send: (body: unknown) => unknown } },
    actionGroup: string,
    message: string = 'Verifikasi ulang diperlukan untuk aksi sensitif',
) {
    return reply.status(403).send({
        error: {
            code: 'AUTH_STEP_UP_REQUIRED' as const satisfies AuthErrorCode,
            message,
            actionGroup,
        },
    });
}
