import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthCoordinator } from './coordinator.ts';
import type { AuthChannel } from './channel.ts';

function token(iat: number, jti: string): string {
    const payload = Buffer.from(JSON.stringify({ iat, jti })).toString('base64url');
    return `header.${payload}.signature`;
}

test('locking a session cancels its scheduled proactive refresh', async () => {
    let refreshCalls = 0;
    let storedToken: string | null = null;
    const channel: AuthChannel = {
        post() {},
        subscribe() { return () => {}; },
        close() {},
    };
    const coordinator = createAuthCoordinator({
        refresh: async () => {
            refreshCalls += 1;
            throw new Error('proactive refresh must not run while locked');
        },
        migrate: async () => { throw new Error('unused'); },
        tokenStore: {
            get: () => storedToken,
            set: (value) => { storedToken = value; },
            clear: () => { storedToken = null; },
        },
        channel,
        setPhase() {},
        onAuthenticated() {},
        onTerminal() {},
        delay: async () => {},
        now: () => 1_000,
        // Proactive delay becomes 10ms: expiresAt - now - 30s.
        scheduleTimer: (fn, ms) => setTimeout(fn, ms),
    });

    coordinator.installLocalCredential({
        accessToken: token(1, 'first'),
        policy: {
            sid: '0123456789abcdef01234567',
            roleClass: 'staff',
            accessExpiresAt: new Date(31_010).toISOString(),
        },
    });
    coordinator.lockSession();

    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(refreshCalls, 0);
    coordinator.dispose();
});
