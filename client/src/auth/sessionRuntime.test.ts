import assert from 'node:assert/strict';
import test from 'node:test';
import { parseValidatedRefreshResponse, parseValidatedUnlockResponse } from './sessionRuntime.ts';

const sid = '12345678-1234-4234-8234-123456789abc';
const id = '12345678-1234-4234-8234-123456789abd';
const exp = 4102444800;
function envelope(overrides: Record<string, unknown> = {}) {
    const payload = { tokenType: 'access', sid, sub: id, role: 'cs', iat: exp - 300, exp, jti: 'test-token', ...overrides };
    return {
        accessToken: `header.${btoa(JSON.stringify(payload))}.signature`,
        user: { id, name: 'Staff', email: 'staff@example.invalid', role: 'cs' },
        session: { sid, roleClass: 'staff', accessExpiresAt: new Date(exp * 1000).toISOString() },
    };
}

test('login/refresh/unlock preserve full canonical UUID identities', () => {
    assert.equal(parseValidatedRefreshResponse(envelope()).policy.sid, sid);
    assert.equal(parseValidatedUnlockResponse(envelope()).user.id, id);
});

test('auth envelopes reject truncated, uppercase and mismatched UUID bindings', () => {
    for (const invalid of [sid.replaceAll('-', '').slice(0, 24), sid.toUpperCase(), 'other-session']) {
        assert.throws(() => parseValidatedRefreshResponse(envelope({ sid: invalid })), /binding/);
    }
    assert.throws(() => parseValidatedRefreshResponse(envelope({ sub: sid })), /binding/);
    assert.throws(() => parseValidatedRefreshResponse(envelope({ role: 'owner' })), /binding/);
});

test('auth envelopes never manufacture expiry or substitute missing session policy', () => {
    assert.throws(() => parseValidatedRefreshResponse(envelope({ exp: undefined })), /expiry/);
    const missingPolicy = envelope();
    assert.throws(() => parseValidatedRefreshResponse({ ...missingPolicy, session: undefined }), /session/);
    assert.throws(() => parseValidatedRefreshResponse({ ...missingPolicy, session: { ...missingPolicy.session, accessExpiresAt: '2098-01-01T00:00:00.000Z' } }), /expiry mismatch/);
    assert.throws(() => parseValidatedRefreshResponse({ ...missingPolicy, session: { ...missingPolicy.session, roleClass: 'member' } }), /role class mismatch/);
});
