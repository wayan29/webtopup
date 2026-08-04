import { FastifyRequest } from 'fastify';

const splitList = (value: string | undefined) => (
    typeof value === 'string'
        ? value
            .split(/[\n,;]+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
        : []
);

const configuredCandidates = () => [
    ...splitList(process.env.CORS_ORIGINS),
    process.env.PUBLIC_APP_URL,
    process.env.FRONTEND_URL,
    process.env.APP_URL
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

const normalizeConfiguredOrigin = (candidate: string): string => {
    const value = candidate.trim();
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid configured public origin: ${value}`);
    }

    if (
        value === '*'
        || (url.protocol !== 'http:' && url.protocol !== 'https:')
        || url.username !== ''
        || url.password !== ''
        || url.pathname !== '/'
        || url.search !== ''
        || url.hash !== ''
    ) {
        throw new Error(`Invalid configured public origin: ${value}`);
    }

    return url.origin.toLowerCase();
};

export const getConfiguredCorsOrigins = () => {
    const candidates = configuredCandidates();
    if (candidates.length === 0) {
        throw new Error('Missing configured public origin');
    }

    return new Set(candidates.map(normalizeConfiguredOrigin));
};

export const isAllowedCorsOrigin = (origin: string, configuredOrigins: ReadonlySet<string>) => {
    try {
        const url = new URL(origin);
        return url.username === ''
            && url.password === ''
            && url.pathname === '/'
            && url.search === ''
            && url.hash === ''
            && configuredOrigins.has(url.origin.toLowerCase());
    } catch {
        return false;
    }
};

type DelegatedCorsOptions = { origin: boolean; credentials?: boolean };

export const createCorsDelegator = (configuredOrigins: ReadonlySet<string>) => (
    request: FastifyRequest,
    callback: (error: Error | null, corsOptions?: DelegatedCorsOptions) => void
) => {
    const originHeader = request.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;

    if (!origin || !isAllowedCorsOrigin(origin, configuredOrigins)) {
        callback(null, { origin: false });
        return;
    }

    callback(null, { origin: true, credentials: true });
};
