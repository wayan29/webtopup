import type { AuthChannelMessage } from './types.ts';

const CHANNEL_NAME = 'webtopup-auth-v2';
const STORAGE_EVENT_KEY = 'webtopup-auth-v2-event';

type Listener = (message: AuthChannelMessage) => void;

export type ChannelPort = {
    postMessage(message: AuthChannelMessage): void;
    subscribe(listener: Listener): () => void;
    close(): void;
};

export type StorageFallback = {
    write(key: string, value: string): void;
    subscribe(listener: (key: string, value: string | null) => void): () => void;
};

export type AuthChannel = {
    post(message: AuthChannelMessage): void;
    subscribe(listener: Listener): () => void;
    close(): void;
};

export function createAuthChannel(deps: {
    broadcast: ChannelPort | null;
    storage: StorageFallback | null;
    nonce: () => string;
}): AuthChannel {
    const listeners = new Set<Listener>();
    const emit = (message: AuthChannelMessage) => listeners.forEach((listener) => listener(message));
    const unsubscribe = deps.broadcast
        ? deps.broadcast.subscribe(emit)
        : deps.storage?.subscribe((key, value) => {
            if (key === STORAGE_EVENT_KEY && value) emit({ type: 'REFRESH_REQUIRED' });
        }) ?? (() => undefined);

    return {
        post(message) {
            if (deps.broadcast) {
                deps.broadcast.postMessage(message);
            } else if (deps.storage) {
                // Persistent fallback deliberately carries coordination only, never credentials.
                deps.storage.write(STORAGE_EVENT_KEY, deps.nonce());
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close() {
            unsubscribe();
            deps.broadcast?.close();
            listeners.clear();
        },
    };
}

function browserBroadcast(): ChannelPort | null {
    if (typeof BroadcastChannel === 'undefined') return null;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    return {
        postMessage: (message) => channel.postMessage(message),
        subscribe(listener) {
            const handler = (event: MessageEvent<AuthChannelMessage>) => listener(event.data);
            channel.addEventListener('message', handler);
            return () => channel.removeEventListener('message', handler);
        },
        close: () => channel.close(),
    };
}

function browserStorage(): StorageFallback | null {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return {
        write: (key, value) => window.localStorage.setItem(key, value),
        subscribe(listener) {
            const handler = (event: StorageEvent) => listener(event.key ?? '', event.newValue);
            window.addEventListener('storage', handler);
            return () => window.removeEventListener('storage', handler);
        },
    };
}

export function createBrowserAuthChannel(): AuthChannel {
    return createAuthChannel({
        broadcast: browserBroadcast(),
        storage: browserStorage(),
        nonce: () => crypto.randomUUID(),
    });
}
