const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const stripApiSuffix = (value: string) =>
    value
        .replace(/\/api\/v\d+\/?$/, '')
        .replace(/\/v\d+\/?$/, '');

const resolveAssetBaseUrl = () => {
    const explicit = import.meta.env.VITE_ASSET_BASE_URL as string | undefined;
    if (explicit) {
        return stripTrailingSlash(explicit);
    }

    const apiV2 = import.meta.env.VITE_API_V2_URL as string | undefined;
    if (apiV2) {
        return stripTrailingSlash(stripApiSuffix(apiV2));
    }

    const legacy = import.meta.env.VITE_API_URL as string | undefined;
    if (legacy) {
        return stripTrailingSlash(stripApiSuffix(legacy));
    }

    return '';
};

export const getAssetUrl = (path?: string | null) => {
    if (!path) {
        return '';
    }
    if (/^https?:\/\//i.test(path)) {
        return path;
    }
    const base = resolveAssetBaseUrl();
    if (!base) {
        return path;
    }
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};
