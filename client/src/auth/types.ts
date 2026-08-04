export type AuthPhase =
    | 'initializing'
    | 'authenticated'
    | 'refreshing'
    | 'locked'
    | 'offline-stale'
    | 'unauthenticated'
    | 'revoked';

export type SessionPolicy = {
    sid: string;
    roleClass: 'member' | 'staff';
    accessExpiresAt: string;
};

export type RefreshResponse = {
    accessToken: string;
    policy: SessionPolicy;
    user?: unknown;
};

export type AccessOrder = {
    issuedAt: number;
    tokenId: string;
};

export type AuthChannelMessage =
    | { type: 'ACCESS_UPDATED'; accessToken: string; policy: SessionPolicy; order: AccessOrder }
    | { type: 'LOCKED'; reason: 'idle'; sid: string }
    | { type: 'LOGGED_OUT'; reason: string; sid?: string }
    | { type: 'SESSION_REVOKED'; reason: string; sid?: string }
    | { type: 'REFRESH_REQUIRED' };

export type RetryableRequest = {
    method?: string;
    url?: string;
    headers?: Record<string, unknown>;
    _authRetried?: boolean;
    authRetrySafe?: boolean;
};
