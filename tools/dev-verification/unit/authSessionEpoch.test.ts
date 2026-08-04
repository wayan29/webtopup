import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasSurvivingAuthenticatedSession,
  nextAuthSessionEpoch,
  shouldApplyBootstrapResult,
} from '../../../client/src/store/useAuthStore.ts';

test('authoritative credential installation advances an opaque finite epoch', () => {
  assert.equal(nextAuthSessionEpoch(0), 1);
  assert.equal(nextAuthSessionEpoch(41), 42);
  assert.equal(nextAuthSessionEpoch(Number.MAX_SAFE_INTEGER), 0);
  assert.equal(nextAuthSessionEpoch(Number.NaN), 0);
});

test('bootstrap completion is stale after authoritative credential installation', () => {
  assert.equal(shouldApplyBootstrapResult(0, 0), true);
  assert.equal(shouldApplyBootstrapResult(0, 1), false);
});

const survivingSnapshot = (authPhase: string, overrides: Record<string, unknown> = {}) => ({
  authPhase,
  authSessionEpoch: 7,
  isAuthenticated: true,
  token: 'matching-access-token',
  user: { id: 'member-1', role: 'member' },
  ...overrides,
});

test('matching token and user survive public throttling across recoverable and in-flight phases', () => {
  for (const phase of ['offline-stale', 'refreshing', 'initializing']) {
    assert.equal(
      hasSurvivingAuthenticatedSession(survivingSnapshot(phase), 'matching-access-token', 7),
      true,
      phase,
    );
  }
});

test('survival fails closed for tokenless, userless, inconsistent, or superseded snapshots', () => {
  assert.equal(hasSurvivingAuthenticatedSession(survivingSnapshot('initializing', { token: null }), 'matching-access-token', 7), false);
  assert.equal(hasSurvivingAuthenticatedSession(survivingSnapshot('initializing', { user: null }), 'matching-access-token', 7), false);
  assert.equal(hasSurvivingAuthenticatedSession(survivingSnapshot('initializing'), 'different-access-token', 7), false);
  assert.equal(hasSurvivingAuthenticatedSession(survivingSnapshot('initializing', { isAuthenticated: false }), 'matching-access-token', 7), false);
  // A concurrent login/multitab credential install advances the epoch; the stale bootstrap must
  // not classify or mutate the replacement session.
  assert.equal(hasSurvivingAuthenticatedSession(survivingSnapshot('authenticated', { authSessionEpoch: 8 }), 'matching-access-token', 7), false);
});
