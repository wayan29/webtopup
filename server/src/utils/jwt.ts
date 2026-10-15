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

export const isCanonicalUuid = (value: unknown): value is string => (
    typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
);
