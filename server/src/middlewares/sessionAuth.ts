import { FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { AccessSessionProjection, lookupAccessSession } from '../repositories/authSessionRepository';
import { User } from '../models';
import { AuthRequest } from './authMiddleware';
import { sendAuthError } from '../utils/authErrors';
import { RECOVERY_COOKIE, REFRESH_COOKIE } from '../utils/authCookies';
import { scheduleLegacyMigrationAcknowledgment } from '../services/legacyMigrationAcknowledgment';
import {
    decodeJwtPayload,
    isAccessJwtClaims,
    LegacyJwtClaims,
    verifyJwtToken,
} from '../utils/jwt';
import {
    isLegacyAccessTokenCutoffPassed,
    isSessionRefreshEnabled,
    memberInRefreshCohort,
    roleInRefreshCohort,
    forcedLoginReasonFromAuthCode,
    recordForcedLoginMetric,
} from '../utils/sessionConfig';

const STAFF_ROLES = new Set(['owner', 'admin', 'cs', 'staff']);

const isStaffRole = (role: string) => STAFF_ROLES.has(role);

const sessionRevokedOrExpired = (status: string, absoluteExpiresAt: Date, now: Date) => {
    if (status === 'revoked' || status === 'expired') {
        return true;
    }
    return absoluteExpiresAt.getTime() <= now.getTime();
};

const staffSessionLocked = (
    role: string,
    status: string,
    idleExpiresAt: Date | undefined,
    now: Date
) => {
    if (!isStaffRole(role)) {
        return false;
    }
    if (status === 'locked') {
        return true;
    }
    if (idleExpiresAt && idleExpiresAt.getTime() <= now.getTime()) {
        return true;
    }
    return false;
};

type RecoveryUser = Readonly<{ id: string; role: string; sessionVersion: number }>;
type RecoveryClaims = Readonly<{
    sub: string;
    sid: string;
    role: string;
    sessionVersion: number;
}>;

/**
 * Narrow projection of the private user.securityChange record used solely for gateway admission.
 * Rust remains responsible for recovery-cookie proof verification.
 */
export type SecurityChangeAdmissionRecord = Readonly<{
    operationId: string;
    initiatingSid: string;
    targetUserId: string;
    kind: string;
    method: string;
    path: string;
    previousEpoch: number;
    resultEpoch: number;
    /** Exact role bound into the private security-change record at initiation. */
    authenticatedRole: string;
    /** Predecessor session refresh generation bound into the private record at initiation. */
    sourceRecoveryGeneration: number;
    recoveryExpiresAt: Date;
}>;

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

const isCanonicalObjectIdHex = (value: unknown): value is string => (
    typeof value === 'string'
    && OBJECT_ID_HEX.test(value)
    && Types.ObjectId.isValid(value)
    && new Types.ObjectId(value).toHexString() === value
);

const securityChangeKindForRoute = (method: string, routeUrl: string): string | null => {
    if (method === 'POST' && routeUrl === '/auth/2fa/confirm') {
        return 'two_factor_confirm';
    }
    if (method === 'POST' && routeUrl === '/auth/2fa/disable') {
        return 'two_factor_disable';
    }
    return null;
};

const expectedSecurityChangePath = (method: string, routeUrl: string): string | null => {
    if (method === 'POST' && routeUrl === '/auth/2fa/confirm') {
        return '/api/v2/auth/2fa/confirm';
    }
    if (method === 'POST' && routeUrl === '/auth/2fa/disable') {
        return '/api/v2/auth/2fa/disable';
    }
    return null;
};

/**
 * Admits a session created by a *fresh login* after a security-change operation completed.
 *
 * The successor path only admits the exact session the operation issued. Enabling 2FA and then
 * logging in again mints a different sid on the same epoch, which matched neither the successor
 * nor the retry path, so the admin panel returned 401 until the recovery window lapsed. That is
 * the most natural thing to do right after enrolling, not an edge case.
 *
 * Reaching this state proves the operation finished: the caller completed a full credential flow
 * (password plus OTP) on the resulting epoch, so there is no lost response left to replay.
 *
 * Requires the operation to be `issued`, the account to already sit on its result epoch, and the
 * live session to be active on that same epoch with a *different* sid than the result. Identity
 * and role must agree across the claims, the live user, the live session, and the stored record.
 */
export const isSecurityChangeReauthenticated = ({
    securityChange,
    claims,
    user,
    session,
}: Readonly<{
    securityChange: unknown;
    claims: RecoveryClaims;
    user: RecoveryUser;
    session: AccessSessionProjection | null;
}>): boolean => {
    if (!securityChange || typeof securityChange !== 'object' || !session) {
        return false;
    }
    const doc = securityChange as Record<string, unknown>;
    if (doc.phase !== 'issued') {
        return false;
    }
    const resultSid = doc.resultSid instanceof Types.ObjectId
        ? doc.resultSid.toHexString()
        : doc.resultSid;
    const targetUserId = doc.targetUserId instanceof Types.ObjectId
        ? doc.targetUserId.toHexString()
        : doc.targetUserId;
    const { previousEpoch, resultEpoch, authenticatedRole } = doc;

    if (!isCanonicalObjectIdHex(resultSid)
        || !isCanonicalObjectIdHex(targetUserId)
        || typeof previousEpoch !== 'number'
        || typeof resultEpoch !== 'number'
        || !Number.isInteger(previousEpoch)
        || !Number.isInteger(resultEpoch)
        || previousEpoch < 0
        || resultEpoch !== previousEpoch + 1
        || typeof authenticatedRole !== 'string'
        || authenticatedRole.length === 0) {
        return false;
    }

    // A different live session on the result epoch: only a completed re-login can produce this.
    return session.status === 'active'
        && claims.sid !== resultSid
        && session.sessionId !== resultSid
        && claims.sid === session.sessionId
        && targetUserId === user.id
        && claims.sub === user.id
        && session.userId === user.id
        && claims.sessionVersion === resultEpoch
        && session.sessionVersionAtIssue === resultEpoch
        && user.sessionVersion === resultEpoch
        && authenticatedRole === user.role
        && claims.role === user.role
        && session.role === user.role;
};

/**
 * Admits the credential a completed security-change operation just issued.
 *
 * `securityChangeRecoveryAllowed` binds to the *predecessor* epoch, because its job is to let an
 * interrupted operation retry with the credential it started from. The successor token that
 * confirm/disable hands back carries the *new* epoch, so it matches nothing until the record is
 * cleared. That is the sub-minute admin outage right after a 2FA change.
 *
 * This path closes that gap without widening the retry path: it admits exactly the session the
 * operation declared as its result, on the epoch the operation declared as its result, and only
 * once the account has actually reached that epoch. Every identity field must agree across the
 * token claims, the live user, the live session, and the stored record.
 */
export const isSecurityChangeSuccessorSession = ({
    securityChange,
    claims,
    user,
    session,
}: Readonly<{
    securityChange: unknown;
    claims: RecoveryClaims;
    user: RecoveryUser;
    session: AccessSessionProjection | null;
}>): boolean => {
    if (!securityChange || typeof securityChange !== 'object' || !session) {
        return false;
    }
    const doc = securityChange as Record<string, unknown>;
    if (doc.phase !== 'issued') {
        return false;
    }
    const resultSid = doc.resultSid instanceof Types.ObjectId
        ? doc.resultSid.toHexString()
        : doc.resultSid;
    const targetUserId = doc.targetUserId instanceof Types.ObjectId
        ? doc.targetUserId.toHexString()
        : doc.targetUserId;
    const { previousEpoch, resultEpoch, authenticatedRole } = doc;

    if (!isCanonicalObjectIdHex(resultSid)
        || !isCanonicalObjectIdHex(targetUserId)
        || typeof previousEpoch !== 'number'
        || typeof resultEpoch !== 'number'
        || !Number.isInteger(previousEpoch)
        || !Number.isInteger(resultEpoch)
        || previousEpoch < 0
        || resultEpoch !== previousEpoch + 1
        || typeof authenticatedRole !== 'string'
        || authenticatedRole.length === 0) {
        return false;
    }

    // The successor session, on the successor epoch, for the same principal throughout.
    return session.status === 'active'
        && claims.sid === resultSid
        && session.sessionId === resultSid
        && targetUserId === user.id
        && claims.sub === user.id
        && session.userId === user.id
        && claims.sessionVersion === resultEpoch
        && session.sessionVersionAtIssue === resultEpoch
        && user.sessionVersion === resultEpoch
        && authenticatedRole === user.role
        && claims.role === user.role
        && session.role === user.role;
};

/**
 * A security-change operation that reached `issued` has already handed credentials to the
 * client, and once its recovery window closes no retry can continue it. API v2 is supposed to
 * clear the record at that point but currently leaves it behind, and every request fails closed
 * while it exists, locking the account out. Treat that exact state as settled so the stale
 * record can be cleared instead of denying the session.
 *
 * Deliberately narrow: only `issued` past an expired window qualifies. Earlier phases and any
 * malformed or unparsable record keep failing closed, and the boundary is exclusive so a record
 * expiring exactly now still gets its final retry.
 */
export const isSettledSecurityChange = ({
    securityChange,
    now,
}: Readonly<{ securityChange: unknown; now: Date }>): boolean => {
    if (!securityChange || typeof securityChange !== 'object') {
        return false;
    }
    const doc = securityChange as Record<string, unknown>;
    if (doc.phase !== 'issued') {
        return false;
    }
    const raw = doc.recoveryExpiresAt;
    const expiresAt = raw instanceof Date
        ? raw
        : (typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null);
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        return false;
    }
    return now.getTime() > expiresAt.getTime();
};

const parseSecurityChangeAdmissionRecord = (raw: unknown): SecurityChangeAdmissionRecord | null => {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const doc = raw as Record<string, unknown>;
    const operationId = doc.operationId instanceof Types.ObjectId
        ? doc.operationId.toHexString()
        : doc.operationId;
    const initiatingSid = doc.initiatingSid instanceof Types.ObjectId
        ? doc.initiatingSid.toHexString()
        : doc.initiatingSid;
    const targetUserId = doc.targetUserId instanceof Types.ObjectId
        ? doc.targetUserId.toHexString()
        : doc.targetUserId;
    const kind = doc.kind;
    const method = doc.method;
    const path = doc.path;
    const previousEpoch = doc.previousEpoch;
    const resultEpoch = doc.resultEpoch;
    const authenticatedRole = doc.authenticatedRole;
    const sourceRecoveryGeneration = doc.sourceRecoveryGeneration;
    const recoveryExpiresAtRaw = doc.recoveryExpiresAt;
    const recoveryExpiresAt = recoveryExpiresAtRaw instanceof Date
        ? recoveryExpiresAtRaw
        : (typeof recoveryExpiresAtRaw === 'string' || typeof recoveryExpiresAtRaw === 'number'
            ? new Date(recoveryExpiresAtRaw)
            : null);

    if (!isCanonicalObjectIdHex(operationId)
        || !isCanonicalObjectIdHex(initiatingSid)
        || !isCanonicalObjectIdHex(targetUserId)
        || typeof kind !== 'string'
        || (kind !== 'two_factor_confirm' && kind !== 'two_factor_disable')
        || typeof method !== 'string'
        || typeof path !== 'string'
        || typeof previousEpoch !== 'number'
        || typeof resultEpoch !== 'number'
        || !Number.isInteger(previousEpoch)
        || !Number.isInteger(resultEpoch)
        || previousEpoch < 0
        || resultEpoch !== previousEpoch + 1
        || typeof authenticatedRole !== 'string'
        || authenticatedRole.length === 0
        || typeof sourceRecoveryGeneration !== 'number'
        || !Number.isInteger(sourceRecoveryGeneration)
        || sourceRecoveryGeneration < 0
        || !recoveryExpiresAt
        || Number.isNaN(recoveryExpiresAt.getTime())) {
        return null;
    }

    return Object.freeze({
        operationId,
        initiatingSid,
        targetUserId,
        kind,
        method,
        path,
        previousEpoch,
        resultEpoch,
        authenticatedRole,
        sourceRecoveryGeneration,
        recoveryExpiresAt,
    });
};

/**
 * Exact security-change recovery admission for confirm/disable.
 * Permits the initiating session when still active, or when revoked specifically by the same
 * security-change operation id. All competitors and malformed records fail closed.
 */
export const securityChangeRecoveryAllowed = ({
    method,
    routeUrl,
    now,
    claims,
    user,
    session,
    securityChange,
}: Readonly<{
    method: string;
    routeUrl: string;
    now: Date;
    claims: RecoveryClaims;
    user: RecoveryUser;
    session: AccessSessionProjection | null;
    securityChange?: SecurityChangeAdmissionRecord | null | unknown;
    routeParams?: Readonly<Record<string, string>>;
}>): boolean => {
    const expectedKind = securityChangeKindForRoute(method, routeUrl);
    const expectedPath = expectedSecurityChangePath(method, routeUrl);
    if (!expectedKind || !expectedPath) {
        return false;
    }

    const typedCandidate = securityChange && typeof securityChange === 'object'
        ? securityChange as Partial<SecurityChangeAdmissionRecord>
        : null;
    const record = typedCandidate
        && typeof typedCandidate.operationId === 'string'
        && typeof typedCandidate.initiatingSid === 'string'
        && typeof typedCandidate.targetUserId === 'string'
        && typeof typedCandidate.kind === 'string'
        && typeof typedCandidate.method === 'string'
        && typeof typedCandidate.path === 'string'
        && typeof typedCandidate.previousEpoch === 'number'
        && typeof typedCandidate.resultEpoch === 'number'
        && typeof typedCandidate.authenticatedRole === 'string'
        && typedCandidate.authenticatedRole.length > 0
        && typeof typedCandidate.sourceRecoveryGeneration === 'number'
        && Number.isInteger(typedCandidate.sourceRecoveryGeneration)
        && typedCandidate.sourceRecoveryGeneration >= 0
        && typedCandidate.recoveryExpiresAt instanceof Date
        && !Number.isNaN(typedCandidate.recoveryExpiresAt.getTime())
        ? typedCandidate as SecurityChangeAdmissionRecord
        : parseSecurityChangeAdmissionRecord(securityChange);
    if (!record) {
        return false;
    }

    if (record.kind !== expectedKind
        || record.method !== method
        || record.path !== expectedPath
        || record.targetUserId !== user.id
        || record.initiatingSid !== claims.sid
        || !isCanonicalObjectIdHex(record.operationId)
        || !isCanonicalObjectIdHex(record.initiatingSid)
        || !isCanonicalObjectIdHex(record.targetUserId)
        || (record.kind !== 'two_factor_confirm' && record.kind !== 'two_factor_disable')
        || !Number.isInteger(record.previousEpoch)
        || !Number.isInteger(record.resultEpoch)
        || record.previousEpoch < 0
        || record.resultEpoch !== record.previousEpoch + 1
        || typeof record.authenticatedRole !== 'string'
        || record.authenticatedRole.length === 0
        || typeof record.sourceRecoveryGeneration !== 'number'
        || !Number.isInteger(record.sourceRecoveryGeneration)
        || record.sourceRecoveryGeneration < 0
        || Number.isNaN(record.recoveryExpiresAt.getTime())
        || now.getTime() > record.recoveryExpiresAt.getTime()) {
        return false;
    }

    if (!session
        || session.userId !== user.id
        || session.sessionId !== claims.sid
        || session.sessionId !== record.initiatingSid
        || claims.sub !== user.id
        || session.role !== user.role
        || claims.role !== user.role
        || record.authenticatedRole !== user.role
        || record.authenticatedRole !== claims.role
        || record.authenticatedRole !== session.role
        || typeof session.refreshGeneration !== 'number'
        || !Number.isInteger(session.refreshGeneration)
        || session.refreshGeneration < 0
        || session.refreshGeneration !== record.sourceRecoveryGeneration
        || session.sessionVersionAtIssue !== claims.sessionVersion
        || claims.sessionVersion !== record.previousEpoch
        || user.sessionVersion !== record.resultEpoch) {
        return false;
    }

    // Recovery deadline is min(startedAt+60s, absoluteExpiresAt) and inclusive at equality.
    // Only this recovery path uses exclusive-after absolute expiry so a truncated deadline
    // is admitted at the exact absolute boundary; ordinary session auth remains <= now.
    if (session.absoluteExpiresAt.getTime() < now.getTime()) {
        return false;
    }

    if (session.status === 'active') {
        // Fresh initiation (or pre-revoke retry) requires a non-idle staff session.
        if (staffSessionLocked(session.role, session.status, session.idleExpiresAt, now)) {
            return false;
        }
        return true;
    }

    if (session.status === 'revoked') {
        // Only the exact same security-change operation may continue after revocation.
        return session.securityChangeOperationId === record.operationId
            && isCanonicalObjectIdHex(session.securityChangeOperationId);
    }

    return false;
};

/**
 * @deprecated Fail-closed alias. Use securityChangeRecoveryAllowed with the complete record.
 */
export const pendingSecurityChangeRecoveryAllowed = ({
    method,
    routeUrl,
    claims,
    user,
    session,
    pending,
}: Readonly<{
    method: string;
    routeUrl: string;
    claims: RecoveryClaims;
    user: RecoveryUser;
    session: AccessSessionProjection | null;
    pending?: Readonly<{ sessionVersion: number; kind: string }>;
}>) => {
    void method;
    void routeUrl;
    void claims;
    void user;
    void session;
    void pending;
    return false;
};

const staffSessionLockEligible = (
    session: AccessSessionProjection,
    now: Date
) => session.status === 'locked'
    || (session.status === 'active'
        && Boolean(session.idleExpiresAt && session.idleExpiresAt.getTime() <= now.getTime()));

export const staffUnlockRouteAllowed = (
    method: string,
    routeUrl: string,
    role: string,
    session: AccessSessionProjection,
    now: Date
) => method === 'POST'
    && (routeUrl === '/auth/unlock' || routeUrl === '/api/v2/auth/unlock')
    && isStaffRole(role)
    && staffSessionLockEligible(session, now);

type AuthenticatedRequestUser = NonNullable<AuthRequest['user']>;

type CookieUnlockUser = Readonly<{
    id: string;
    email: string;
    role: string;
    permissions?: AuthenticatedRequestUser['permissions'];
    active?: boolean;
    sessionVersion: number;
}>;

export const credentialSid = (token: string): string | null => {
    const [sid, encoded, extra] = token.split('.');
    if (extra !== undefined || !isCanonicalObjectIdHex(sid) || !/^[A-Za-z0-9_-]{43}$/.test(encoded || '')) {
        return null;
    }
    try {
        const secret = Buffer.from(encoded!, 'base64url');
        if (
            secret.length !== 32
            || secret.every((byte) => byte === 0)
            || secret.toString('base64url') !== encoded
        ) return null;
    } catch {
        return null;
    }
    return sid;
};

/**
 * Build the same trusted identity normally derived from an access JWT, but only for cold-bootstrap
 * unlock. Cookie secrets are deliberately not authenticated here: Rust verifies both refresh and
 * recovery proofs before touching the session. The gateway only binds their shared canonical SID
 * to a live database row so browser-supplied identity headers/body fields can never choose it.
 */
export const matchingCredentialSid = (refreshToken: string, recoveryToken: string): string | null => {
    const refreshSid = credentialSid(refreshToken);
    const recoverySid = credentialSid(recoveryToken);
    return refreshSid && refreshSid === recoverySid ? refreshSid : null;
};

export const cookieLockedSessionIdentity = (
    refreshToken: string,
    recoveryToken: string,
    session: AccessSessionProjection,
    user: CookieUnlockUser,
    now: Date
): AuthenticatedRequestUser | null => {
    const refreshSid = matchingCredentialSid(refreshToken, recoveryToken);
    if (!refreshSid || session.sessionId !== refreshSid) return null;
    if (user.active === false || !isStaffRole(user.role)) return null;
    if (session.userId !== user.id || session.role !== user.role) return null;
    if (session.sessionVersionAtIssue !== user.sessionVersion) return null;
    if (session.absoluteExpiresAt.getTime() <= now.getTime()) return null;
    if (!staffSessionLockEligible(session, now)) return null;
    return {
        id: user.id,
        email: user.email,
        role: user.role as AuthenticatedRequestUser['role'],
        permissions: user.permissions,
        sessionId: session.sessionId,
        authMode: 'refresh-session',
    };
};

const hasAuthoritativeLiveBinding = (
    claims: RecoveryClaims,
    user: RecoveryUser,
    session: AccessSessionProjection | null,
    now: Date
): session is AccessSessionProjection => Boolean(
    session
    && session.userId === user.id
    && claims.sub === user.id
    && session.sessionId === claims.sid
    && session.status === 'active'
    && !sessionRevokedOrExpired(session.status, session.absoluteExpiresAt, now)
    && !staffSessionLocked(session.role, session.status, session.idleExpiresAt, now)
    && session.role === user.role
    && claims.role === user.role
);

export const pendingGlobalRevocationRecoveryAllowed = ({
    method,
    routeUrl,
    now,
    claims,
    user,
    session,
    pending,
}: Readonly<{
    method: string;
    routeUrl: string;
    now: Date;
    claims: RecoveryClaims;
    user: RecoveryUser;
    session: AccessSessionProjection | null;
    pending?: Readonly<{ sessionVersion: number }>;
}>) => Boolean(
    pending
    && method === 'POST'
    && routeUrl === '/auth/sessions/revoke-all'
    && hasAuthoritativeLiveBinding(claims, user, session, now)
    && session.sessionVersionAtIssue === claims.sessionVersion
    && claims.sessionVersion + 1 === pending.sessionVersion
    && user.sessionVersion === pending.sessionVersion
);

export const stripUntrustedSessionHeader = (request: AuthRequest) => {
    delete request.headers['x-webtopup-session-id'];
};

export const resolveBearerToken = (request: AuthRequest): string | null => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    return authHeader.split(' ')[1]?.trim() || null;
};

const enforceRefreshSession = async (
    request: AuthRequest,
    reply: FastifyReply,
    _token: string,
    claims: import('../utils/jwt').AccessJwtClaims
) => {
    if (!/^[0-9a-f]{24}$/.test(claims.sid)
        || !Types.ObjectId.isValid(claims.sid)
        || new Types.ObjectId(claims.sid).toHexString() !== claims.sid) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid token');
    }

    const [user, session] = await Promise.all([
        User.findById(claims.sub).select('_id email role permissions active sessionVersion +globalRevocationPending +securityChange +securityChangePending +completedSecurityChange'),
        lookupAccessSession(claims.sid),
    ]);

    if (!user) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: User not found');
    }

    if (user.active === false) {
        return sendAuthError(reply, 403, 'AUTH_ACCOUNT_DISABLED', 'Forbidden: Account inactive');
    }

    const pendingState = user as unknown as {
        globalRevocationPending?: { operationId: Types.ObjectId; sessionVersion: number };
        securityChange?: unknown;
        securityChangePending?: unknown;
        completedSecurityChange?: unknown;
    };
    const pending = pendingState.globalRevocationPending;
    // Legacy pending/completed security-change fields are a competing protocol and fail closed.
    if (pendingState.securityChangePending || pendingState.completedSecurityChange) {
        return sendAuthError(reply, 401, 'AUTH_SESSION_REVOKED', 'Unauthorized: Session revoked');
    }
    if (pendingState.securityChange) {
        const now = new Date();
        // API v2 leaves a settled record behind instead of clearing it. Clear it here rather
        // than denying every request, which would lock the account out until manual repair.
        if (isSettledSecurityChange({ securityChange: pendingState.securityChange, now })) {
            await mongoose.connection.collection('users').updateOne(
                { _id: user._id, 'securityChange.phase': 'issued' },
                { $unset: { securityChange: '' } }
            );
        } else if (isSecurityChangeReauthenticated({
            securityChange: pendingState.securityChange,
            claims,
            user: { id: user._id.toString(), role: user.role, sessionVersion: user.sessionVersion || 0 },
            session,
        })) {
            // A completed re-login proves the operation finished, so retire the record now instead
            // of stranding the caller until its recovery window lapses.
            await mongoose.connection.collection('users').updateOne(
                { _id: user._id, 'securityChange.phase': 'issued' },
                { $unset: { securityChange: '' } }
            );
        } else if (isSecurityChangeSuccessorSession({
            securityChange: pendingState.securityChange,
            claims,
            user: { id: user._id.toString(), role: user.role, sessionVersion: user.sessionVersion || 0 },
            session,
        })) {
            // The operation already issued this exact credential; admit it instead of waiting
            // for the record to lapse, which would strand the caller for up to a minute.
            request.user = {
                id: user._id.toString(), email: user.email, role: user.role,
                permissions: user.permissions, sessionId: claims.sid, authMode: 'refresh-session',
            };
            return;
        } else if (!securityChangeRecoveryAllowed({
            method: request.method,
            routeUrl: request.routeOptions.url || '',
            now,
            claims,
            user: { id: user._id.toString(), role: user.role, sessionVersion: user.sessionVersion || 0 },
            session,
            securityChange: pendingState.securityChange,
        })) {
            return sendAuthError(reply, 401, 'AUTH_SESSION_REVOKED', 'Unauthorized: Session revoked');
        } else {
            request.user = {
                id: user._id.toString(), email: user.email, role: user.role,
                permissions: user.permissions, sessionId: claims.sid, authMode: 'refresh-session',
            };
            return;
        }
    }
    if (pending) {
        const now = new Date();
        if (!pendingGlobalRevocationRecoveryAllowed({
            method: request.method,
            routeUrl: request.routeOptions.url || '',
            now,
            claims,
            user: {
                id: user._id.toString(),
                role: user.role,
                sessionVersion: user.sessionVersion || 0,
            },
            session,
            pending,
        })) {
            return sendAuthError(reply, 401, 'AUTH_SESSION_REVOKED', 'Unauthorized: Session revoked');
        }
        request.user = {
            id: user._id.toString(), email: user.email, role: user.role,
            permissions: user.permissions, sessionId: claims.sid, authMode: 'refresh-session',
        };
        return;
    }

    const now = new Date();
    if (!session || session.userId !== user._id.toString() || claims.sub !== user._id.toString()) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
    }

    if (session.absoluteExpiresAt.getTime() <= now.getTime()) {
        return sendAuthError(reply, 401, 'AUTH_SESSION_EXPIRED', 'Unauthorized: Session expired');
    }

    const unlockRoute = staffUnlockRouteAllowed(
        request.method,
        request.url.split('?')[0] || '',
        session.role,
        session,
        now
    );

    if (unlockRoute) {
        const userSessionVersion = user.sessionVersion || 0;
        if (claims.sessionVersion !== userSessionVersion
            || claims.sessionVersion !== session.sessionVersionAtIssue
            || session.role !== user.role
            || claims.role !== user.role
            || claims.sub !== user._id.toString()) {
            return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid token');
        }
        request.user = {
            id: user._id.toString(),
            email: user.email,
            role: user.role,
            permissions: user.permissions,
            sessionId: session.sessionId,
            authMode: 'refresh-session',
        };
        return;
    }

    if (session.status === 'locked' && isStaffRole(session.role)) {
        return sendAuthError(reply, 401, 'AUTH_IDLE_LOCKED', 'Sesi terkunci karena idle');
    }

    if (session.status !== 'active' || sessionRevokedOrExpired(session.status, session.absoluteExpiresAt, now)) {
        return sendAuthError(reply, 401, 'AUTH_SESSION_REVOKED', 'Unauthorized: Session revoked');
    }

    if (staffSessionLocked(session.role, session.status, session.idleExpiresAt, now)) {
        if (session.status === 'active' && session.idleExpiresAt && session.idleExpiresAt.getTime() <= now.getTime()) {
            await mongoose.connection.collection('authsessions').updateOne(
                { sessionId: new Types.ObjectId(claims.sid), status: 'active', absoluteExpiresAt: { $gt: now }, idleExpiresAt: { $lte: now } },
                { $set: { status: 'locked', lockedAt: now } }
            );
        }
        return sendAuthError(reply, 401, 'AUTH_IDLE_LOCKED', 'Sesi terkunci karena idle');
    }

    const userSessionVersion = user.sessionVersion || 0;
    if (claims.sessionVersion !== userSessionVersion) {
        return sendAuthError(reply, 401, 'AUTH_SESSION_REVOKED', 'Unauthorized: Session revoked');
    }

    if (claims.sessionVersion !== session.sessionVersionAtIssue) {
        return sendAuthError(reply, 401, 'AUTH_SESSION_REVOKED', 'Unauthorized: Session revoked');
    }

    if (!hasAuthoritativeLiveBinding(
        claims,
        { id: user._id.toString(), role: user.role, sessionVersion: userSessionVersion },
        session,
        now
    )) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid token');
    }

    request.user = {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        sessionId: session.sessionId,
        authMode: 'refresh-session',
    };
    scheduleLegacyMigrationAcknowledgment(
        { userId: request.user.id, sessionId: session.sessionId },
        request.log
    );
};

const enforceLegacySession = async (
    request: AuthRequest,
    reply: FastifyReply,
    token: string,
    decoded: LegacyJwtClaims
) => {
    if (isLegacyAccessTokenCutoffPassed()) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Legacy token no longer accepted');
    }

    const user = await User.findById(decoded.id).select('_id email role permissions active sessionVersion');
    if (!user) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: User not found');
    }

    if (user.active === false) {
        return sendAuthError(reply, 403, 'AUTH_ACCOUNT_DISABLED', 'Forbidden: Account inactive');
    }

    const tokenSessionVersion = Number.isFinite(decoded.sessionVersion) ? Number(decoded.sessionVersion) : 0;
    if (tokenSessionVersion !== (user.sessionVersion || 0)) {
        return sendAuthError(reply, 401, 'AUTH_SESSION_REVOKED', 'Unauthorized: Session revoked');
    }

    request.user = {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        authMode: 'legacy',
    };
};

/**
 * Gateway access enforcement: access JWT + live session, or bounded legacy JWT.
 */
export const authenticateUnlockSession = async (request: AuthRequest, reply: FastifyReply) => {
    stripUntrustedSessionHeader(request);

    // A live in-memory access token follows the normal, stronger bearer path unchanged.
    if (resolveBearerToken(request)) {
        return authenticateSession(request, reply);
    }

    // Cold page loads lose the memory-only access token. The HttpOnly credential pair survives,
    // but may only identify a candidate SID here; Rust still authenticates both secrets plus the
    // submitted password/OTP before rotating or unlocking anything.
    const refreshToken = request.cookies?.[REFRESH_COOKIE];
    const recoveryToken = request.cookies?.[RECOVERY_COOKIE];
    if (!refreshToken || !recoveryToken) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
    }
    const sid = matchingCredentialSid(refreshToken, recoveryToken);
    if (!sid) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
    }

    try {
        const session = await lookupAccessSession(sid);
        if (!session) {
            return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
        }
        const user = await User.findById(session.userId)
            .select('_id email role permissions active sessionVersion')
            .lean()
            .exec() as {
                _id: Types.ObjectId;
                email: string;
                role: string;
                permissions?: NonNullable<AuthRequest['user']>['permissions'];
                active?: boolean;
                sessionVersion?: number;
            } | null;
        if (!user) {
            return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
        }
        const identity = cookieLockedSessionIdentity(
            refreshToken,
            recoveryToken,
            session,
            {
                id: user._id.toString(),
                email: user.email,
                role: user.role,
                permissions: user.permissions,
                active: user.active,
                sessionVersion: user.sessionVersion || 0,
            },
            new Date()
        );
        if (!identity) {
            return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
        }
        request.user = identity;
    } catch (error) {
        request.log.error({ error }, 'Cookie-bound unlock authentication failed');
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const authenticateSession = async (request: AuthRequest, reply: FastifyReply) => {
    stripUntrustedSessionHeader(request);

    const token = resolveBearerToken(request);
    if (!token) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: No token provided');
    }

    const payload = decodeJwtPayload(token);

    try {
        if (payload && isAccessJwtClaims(payload)) {
            let verified: import('../utils/jwt').AccessJwtClaims;
            try {
                verified = verifyJwtToken<import('../utils/jwt').AccessJwtClaims>(token);
            } catch (error) {
                if (error instanceof jwt.TokenExpiredError) {
                    return sendAuthError(reply, 401, 'AUTH_ACCESS_EXPIRED', 'Access token telah kedaluwarsa');
                }
                return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid token');
            }
            return enforceRefreshSession(request, reply, token, verified);
        }

        let decoded: LegacyJwtClaims;
        try {
            decoded = verifyJwtToken<LegacyJwtClaims>(token);
        } catch (error) {
            if (error instanceof jwt.TokenExpiredError) {
                return sendAuthError(reply, 401, 'AUTH_ACCESS_EXPIRED', 'Access token telah kedaluwarsa');
            }
            return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid token');
        }
        return await enforceLegacySession(request, reply, token, decoded);
    } catch (error) {
        request.log.error({ error }, 'refresh session enforcement unavailable');
        return reply.status(503).send({
            error: {
                code: 'AUTH_REFRESH_RECOVERY_UNAVAILABLE',
                message: 'Authentication service unavailable',
            },
        });
    }
};