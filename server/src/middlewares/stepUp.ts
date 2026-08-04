import { FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { AuthRequest } from './authMiddleware';
import { sendStepUpRequiredError } from '../utils/authErrors';
import { getJwtSecret } from '../utils/jwt';

/**
 * Closed action-group inventory (Task 11). Browser never controls the trusted group;
 * Node selects the group from the route registration and stamps it after validation.
 */
export const STEP_UP_ACTION_GROUPS = [
    'finance.adjust_balance',
    'finance.refund',
    'finance.deposit_approval',
    'transactions.manual',
    'integrations.credentials',
    'team.manage_privileged',
    'team.reset_2fa',
    'security.sessions_all',
    'exports.sensitive',
    // Staff self-service credential changes (email/password).
    'security.password',
] as const;

export type StepUpActionGroup = (typeof STEP_UP_ACTION_GROUPS)[number];

export const STEP_UP_PURPOSE = 'step-up';
export const STEP_UP_GRANT_HEADER = 'x-step-up-token';
export const TRUSTED_STEP_UP_GROUP_HEADER = 'x-webtopup-step-up-group';
/** Browser-supplied spoof variants that must never cross the trust boundary. */
export const UNTRUSTED_STEP_UP_HEADER_NAMES = new Set([
    'x-step-up-token',
    'x-step-up-group',
    'x-webtopup-step-up-group',
    'x-webtopup-step-up-token',
]);

export type StepUpGrantClaims = {
    sub: string;
    sid: string;
    actionGroup: string;
    purpose: string;
    iat: number;
    exp: number;
    jti: string;
};

export function isStepUpActionGroup(value: unknown): value is StepUpActionGroup {
    return typeof value === 'string' && (STEP_UP_ACTION_GROUPS as readonly string[]).includes(value);
}

/**
 * Cryptographically verify a grant and bind it to the current trusted request user/SID
 * plus the server-selected action group. Never trusts a browser-provided group.
 */
export function verifyStepUpGrant(
    token: string,
    expected: { sub: string; sid: string; actionGroup: StepUpActionGroup },
    nowSeconds: number = Math.floor(Date.now() / 1000),
): StepUpGrantClaims {
    let claims: StepUpGrantClaims;
    try {
        claims = jwt.verify(token, getJwtSecret(), {
            algorithms: ['HS256'],
            clockTolerance: 0,
        }) as StepUpGrantClaims;
    } catch {
        throw new Error('AUTH_STEP_UP_REQUIRED');
    }
    if (
        !claims
        || claims.purpose !== STEP_UP_PURPOSE
        || typeof claims.sub !== 'string'
        || typeof claims.sid !== 'string'
        || typeof claims.actionGroup !== 'string'
        || typeof claims.jti !== 'string'
        || typeof claims.iat !== 'number'
        || typeof claims.exp !== 'number'
    ) {
        throw new Error('AUTH_STEP_UP_REQUIRED');
    }
    if (claims.sub !== expected.sub || claims.sid !== expected.sid) {
        throw new Error('AUTH_STEP_UP_REQUIRED');
    }
    if (claims.actionGroup !== expected.actionGroup || !isStepUpActionGroup(claims.actionGroup)) {
        throw new Error('AUTH_STEP_UP_REQUIRED');
    }
    // Exact boundary: exp == now is expired.
    if (claims.exp <= nowSeconds) {
        throw new Error('AUTH_STEP_UP_REQUIRED');
    }
    if (claims.iat > nowSeconds) {
        throw new Error('AUTH_STEP_UP_REQUIRED');
    }
    return claims;
}

/**
 * Factory middleware: validates the browser grant against the server-selected group,
 * binds sub/sid to request.user, and exposes the validated group on the request for
 * trusted upstream stamping. Rejection never reaches the proxy.
 */
export function requireStepUp(actionGroup: StepUpActionGroup) {
    if (!isStepUpActionGroup(actionGroup)) {
        throw new Error(`Unknown step-up action group: ${actionGroup}`);
    }
    return async function stepUpMiddleware(request: AuthRequest, reply: FastifyReply) {
        const user = request.user;
        if (!user?.id || user.authMode !== 'refresh-session' || !user.sessionId) {
            // Server-selected group from route registration — never a browser value.
            return sendStepUpRequiredError(reply, actionGroup);
        }
        const headerValue = request.headers[STEP_UP_GRANT_HEADER];
        const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
        if (!token || typeof token !== 'string' || !token.trim()) {
            return sendStepUpRequiredError(reply, actionGroup);
        }
        try {
            const claims = verifyStepUpGrant(token.trim(), {
                sub: user.id,
                sid: user.sessionId,
                actionGroup,
            });
            (request as AuthRequest & { stepUpActionGroup?: StepUpActionGroup }).stepUpActionGroup =
                claims.actionGroup as StepUpActionGroup;
        } catch {
            return sendStepUpRequiredError(reply, actionGroup);
        }
    };
}

/** Strip every browser-controlled step-up header name before generic forwarding. */
export function stripBrowserStepUpHeaders(headers: Headers): void {
    for (const name of UNTRUSTED_STEP_UP_HEADER_NAMES) {
        headers.delete(name);
    }
    // Casing variants are normalized by the Headers API to lowercase.
    headers.delete('X-Step-Up-Token');
    headers.delete('X-Webtopup-Step-Up-Group');
}

/** Stamp only the trusted group after requireStepUp succeeded. */
export function stampTrustedStepUpGroup(headers: Headers, request: AuthRequest): void {
    const group = (request as AuthRequest & { stepUpActionGroup?: string }).stepUpActionGroup;
    if (group && isStepUpActionGroup(group)) {
        headers.set(TRUSTED_STEP_UP_GROUP_HEADER, group);
    }
}
