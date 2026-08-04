import assert from 'node:assert/strict';
import test from 'node:test';
import { isSecurityChangeSuccessorSession } from '../../../server/src/middlewares/sessionAuth.ts';

const USER = '507f1f77bcf86cd799439011';
const RESULT_SID = '607f1f77bcf86cd799439022';
const OTHER_SID = '607f1f77bcf86cd799439033';

// A completed operation bumped the account epoch from 4 to 5 and issued a session on the new epoch.
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
    sid: RESULT_SID,
    sessionVersion: 5,
    role: 'owner',
    ...overrides,
});
const session = (overrides: Record<string, unknown> = {}) => ({
    sessionId: RESULT_SID,
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

const check = (o: Record<string, unknown> = {}) => isSecurityChangeSuccessorSession({
    securityChange: record(),
    claims: claims(),
    user: user(),
    session: session(),
    ...o,
} as never);

test('the credential the operation just issued is admitted', () => {
    // Without this the successor token is rejected until the recovery window lapses, which
    // is exactly the sub-minute admin outage after enabling 2FA.
    assert.equal(check(), true);
});

test('the predecessor credential is still not admitted by this path', () => {
    // Old-epoch tokens belong to the retry path, not the successor path.
    assert.equal(check({ claims: claims({ sessionVersion: 4 }) }), false);
});

test('a different session id is never admitted', () => {
    assert.equal(check({ claims: claims({ sid: OTHER_SID }) }), false);
    assert.equal(check({ session: session({ sessionId: OTHER_SID }) }), false);
});

test('the account epoch must already match the operation result', () => {
    assert.equal(check({ user: user({ sessionVersion: 4 }) }), false);
});

test('non-active or non-matching sessions fail closed', () => {
    for (const status of ['revoked', 'locked', 'expired']) {
        assert.equal(check({ session: session({ status }) }), false);
    }
    assert.equal(check({ session: session({ userId: OTHER_SID }) }), false);
    assert.equal(check({ session: session({ sessionVersionAtIssue: 4 }) }), false);
});

test('identity and role must agree across claims, user, session, and record', () => {
    assert.equal(check({ claims: claims({ sub: OTHER_SID }) }), false);
    assert.equal(check({ claims: claims({ role: 'admin' }) }), false);
    assert.equal(check({ session: session({ role: 'admin' }) }), false);
    assert.equal(check({ securityChange: record({ authenticatedRole: 'admin' }) }), false);
    assert.equal(check({ securityChange: record({ targetUserId: OTHER_SID }) }), false);
});

test('phases before issuance are not successors', () => {
    for (const phase of ['prepared', 'sessions_revoked', 'finalized']) {
        assert.equal(check({ securityChange: record({ phase }) }), false);
    }
});

test('malformed records fail closed', () => {
    assert.equal(check({ securityChange: null }), false);
    assert.equal(check({ securityChange: 'issued' }), false);
    assert.equal(check({ securityChange: record({ resultSid: 'not-an-oid' }) }), false);
    assert.equal(check({ securityChange: record({ resultEpoch: 6 }) }), false);
    assert.equal(check({ securityChange: record({ resultEpoch: '5' }) }), false);
    assert.equal(check({ session: null }), false);
});
