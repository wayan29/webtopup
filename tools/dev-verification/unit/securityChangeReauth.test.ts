import assert from 'node:assert/strict';
import test from 'node:test';
import { isSecurityChangeReauthenticated } from '../../../server/src/middlewares/sessionAuth.ts';

const USER = '507f1f77bcf86cd799439011';
const RESULT_SID = '607f1f77bcf86cd799439022';
const NEW_SID = '607f1f77bcf86cd799439044';
const OTHER_USER = '507f1f77bcf86cd799439099';

// A completed operation bumped the account epoch 4 -> 5 and issued a session on RESULT_SID.
// The user then logged in again, which minted NEW_SID on the same epoch.
const record = (overrides: Record<string, unknown> = {}) => ({
    phase: 'issued',
    resultSid: RESULT_SID,
    previousEpoch: 4,
    resultEpoch: 5,
    targetUserId: USER,
    authenticatedRole: 'owner',
    ...overrides,
});
const claims = (overrides: Record<string, unknown> = {}) => ({
    sub: USER,
    sid: NEW_SID,
    sessionVersion: 5,
    role: 'owner',
    ...overrides,
});
const session = (overrides: Record<string, unknown> = {}) => ({
    sessionId: NEW_SID,
    userId: USER,
    role: 'owner',
    status: 'active',
    sessionVersionAtIssue: 5,
    ...overrides,
});
const user = (overrides: Record<string, unknown> = {}) => ({
    id: USER,
    role: 'owner',
    sessionVersion: 5,
    ...overrides,
});

const check = (o: Record<string, unknown> = {}) => isSecurityChangeReauthenticated({
    securityChange: record(),
    claims: claims(),
    user: user(),
    session: session(),
    ...o,
} as never);

test('a fresh login after the operation proves it completed', () => {
    // Logging in again required the full credential flow, so no lost response needs replaying.
    assert.equal(check(), true);
});

test('the operation result session itself is not this path', () => {
    // That is the successor path; keep the two admissions distinct.
    assert.equal(check({
        claims: claims({ sid: RESULT_SID }),
        session: session({ sessionId: RESULT_SID }),
    }), false);
});

test('a session minted before the operation is never admitted', () => {
    // Predecessor-epoch sessions belong to the retry path.
    assert.equal(check({
        claims: claims({ sessionVersion: 4 }),
        session: session({ sessionVersionAtIssue: 4 }),
        user: user({ sessionVersion: 4 }),
    }), false);
});

test('the account epoch must already match the operation result', () => {
    assert.equal(check({ user: user({ sessionVersion: 4 }) }), false);
    assert.equal(check({ user: user({ sessionVersion: 6 }) }), false);
});

test('non-active sessions fail closed', () => {
    for (const status of ['revoked', 'locked', 'expired']) {
        assert.equal(check({ session: session({ status }) }), false);
    }
});

test('identity and role must agree across claims, user, session, and record', () => {
    assert.equal(check({ claims: claims({ sub: OTHER_USER }) }), false);
    assert.equal(check({ session: session({ userId: OTHER_USER }) }), false);
    assert.equal(check({ securityChange: record({ targetUserId: OTHER_USER }) }), false);
    assert.equal(check({ claims: claims({ role: 'admin' }) }), false);
    assert.equal(check({ session: session({ role: 'admin' }) }), false);
    assert.equal(check({ securityChange: record({ authenticatedRole: 'admin' }) }), false);
});

test('the claim sid must match the live session', () => {
    assert.equal(check({ session: session({ sessionId: RESULT_SID }) }), false);
});

test('phases before issuance are not complete', () => {
    for (const phase of ['prepared', 'sessions_revoked', 'finalized']) {
        assert.equal(check({ securityChange: record({ phase }) }), false);
    }
});

test('malformed records fail closed', () => {
    assert.equal(check({ securityChange: null }), false);
    assert.equal(check({ securityChange: 'issued' }), false);
    assert.equal(check({ securityChange: record({ resultSid: 'not-an-oid' }) }), false);
    assert.equal(check({ securityChange: record({ resultEpoch: 9 }) }), false);
    assert.equal(check({ securityChange: record({ resultEpoch: '5' }) }), false);
    assert.equal(check({ session: null }), false);
});
