export type AccessTokenStore = {
    get(): string | null;
    set(token: string): void;
    clear(): void;
};

export function createAccessTokenStore(): AccessTokenStore {
    let accessToken: string | null = null;
    return {
        get: () => accessToken,
        set: (token) => { accessToken = token; },
        clear: () => { accessToken = null; },
    };
}

export const accessTokenStore = createAccessTokenStore();
