import assert from 'node:assert/strict';
import test from 'node:test';

// Pure contract for Site Config step-up provenance classification.
function classifyGatewayRejectedBeforeUpstream(headers: Record<string, unknown>): boolean {
  const hasStableIdempotencyKey = Object.entries(headers).some(([name, value]) => {
    if (name.toLowerCase() !== 'idempotency-key') return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && item.trim().length > 0);
    return false;
  });
  return !hasStableIdempotencyKey;
}

test('stable Idempotency-Key marks AUTH_STEP_UP_REQUIRED as possibly Rust-originated', () => {
  assert.equal(
    classifyGatewayRejectedBeforeUpstream({ 'Idempotency-Key': 'sitecfg_stable_key_01' }),
    false,
  );
});

test('legacy no-key closed routes remain gateway-local', () => {
  assert.equal(classifyGatewayRejectedBeforeUpstream({}), true);
  assert.equal(classifyGatewayRejectedBeforeUpstream({ 'idempotency-key': '   ' }), true);
});
