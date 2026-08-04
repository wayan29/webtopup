import jwt, { SignOptions } from 'jsonwebtoken';

let hasWarnedWeakJwtSecret = false;

export const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET?.trim();

    if (!secret) {
        throw new Error('JWT_SECRET_MISSING');
    }

    if (!hasWarnedWeakJwtSecret && secret.length < 16) {
        hasWarnedWeakJwtSecret = true;
        console.warn('JWT_SECRET is shorter than the recommended 16 characters.');
    }

    return secret;
};

export const assertJwtSecretConfigured = () => {
    getJwtSecret();
};

export const signJwtToken = (payload: string | Buffer | object, options?: SignOptions) => (
    jwt.sign(payload, getJwtSecret(), options)
);

export const verifyJwtToken = <T = unknown>(token: string) => (
    jwt.verify(token, getJwtSecret()) as T
);

export type AccessJwtClaims = {
    sub: string;
    sid: string;
    sessionVersion: number;
    role: string;
    iat: number;
    exp: number;
    jti: string;
    tokenType: string;
};

export type LegacyJwtClaims = {
    id: string;
    email?: string;
    role?: string;
    sessionVersion?: number;
    exp?: number;
    iat?: number;
};

export const isAccessJwtClaims = (decoded: Record<string, unknown>): decoded is AccessJwtClaims => (
    decoded.tokenType === 'access'
    && typeof decoded.sid === 'string'
    && typeof decoded.sub === 'string'
);

export const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        return null;
    }
    return decoded as Record<string, unknown>;
};