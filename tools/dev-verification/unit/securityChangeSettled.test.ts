import assert from 'node:assert/strict';
import test from 'node:test';
import { isSettledSecurityChange } from '../../../server/src/middlewares/sessionAuth.ts';

const now = new Date('2026-07-29T12:00:00.000Z');
const past = new Date('2026-07-29T11:59:00.000Z');
const future = new Date('2026-07-29T12:01:00.000Z');

const record = (overrides: Record<string, unknown> = {}) => ({
    phase: 'issued',
    recoveryExpiresAt: past,
    ...overrides,
});

test('an issued operation past its recovery window is settled', () => {
    // Phase "issued" means credentials were already handed to the client, and an expired
    // recovery window means no retry can ever continue it. The record is dead weight.
    assert.equal(isSettledSecurityChange({ securityChange: record(), now }), true);
});

test('an issued operation still inside its recovery window is not settled', () => {
    // A retry may still legitimately continue this operation, so keep failing closed.
    assert.equal(isSettledSecurityChange({ securityChange: record({ recoveryExpiresAt: future }), now }), false);
});

test('phases before issuance are never settled regardless of the window', () => {
    for (const phase of ['prepared', 'sessions_revoked', 'finalized']) {
        assert.equal(isSettledSecurityChange({ securityChange: record({ phase }), now }), false);
    }
});

test('malformed, missing, or unparsable records are never settled', () => {
    assert.equal(isSettledSecurityChange({ securityChange: undefined, now }), false);
    assert.equal(isSettledSecurityChange({ securityChange: null, now }), false);
    assert.equal(isSettledSecurityChange({ securityChange: 'issued', now }), false);
    assert.equal(isSettledSecurityChange({ securityChange: record({ phase: 42 }), now }), false);
    assert.equal(isSettledSecurityChange({ securityChange: record({ recoveryExpiresAt: 'not-a-date' }), now }), false);
    assert.equal(isSettledSecurityChange({ securityChange: record({ recoveryExpiresAt: undefined }), now }), false);
});

test('the boundary is exclusive: equality still allows one last retry', () => {
    assert.equal(isSettledSecurityChange({ securityChange: record({ recoveryExpiresAt: now }), now }), false);
});

test('date-like string and epoch timestamps are accepted from raw BSON reads', () => {
    assert.equal(isSettledSecurityChange({ securityChange: record({ recoveryExpiresAt: past.toISOString() }), now }), true);
    assert.equal(isSettledSecurityChange({ securityChange: record({ recoveryExpiresAt: past.getTime() }), now }), true);
});
