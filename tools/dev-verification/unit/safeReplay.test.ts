import assert from 'node:assert/strict';
import test from 'node:test';
import { isReplayEligible } from '../../../client/src/auth/coordinator.ts';

test('automatic auth replay is limited to safe methods or explicit stable retry contracts', () => {
  assert.equal(isReplayEligible({ method: 'GET', url: '/auth/sessions' }), true);
  assert.equal(isReplayEligible({ method: 'HEAD', url: '/health' }), true);
  assert.equal(isReplayEligible({ method: 'OPTIONS', url: '/health' }), true);
  assert.equal(isReplayEligible({ method: 'POST', url: '/transactions' }), false);
  assert.equal(isReplayEligible({ method: 'POST', url: '/transactions', authRetrySafe: true }), true);
  assert.equal(isReplayEligible({ method: 'PATCH', url: '/transactions/1', authRetrySafe: true }), true);
  assert.equal(isReplayEligible({ method: 'POST', url: '/transactions', headers: { 'Idempotency-Key': 'synthetic-stable-key' } }), true);
  assert.equal(isReplayEligible({ method: 'POST', url: '/transactions', headers: { 'Idempotency-Key': '   ' } }), false);
});
