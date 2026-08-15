import assert from 'node:assert/strict';
import test from 'node:test';
import { createStepUpOrchestrator } from '../../../client/src/auth/withStepUp.ts';

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

test('slider key remains stable across AUTH_STEP_UP_REQUIRED and grant retry', async () => {
  const attempts: Array<Record<string, unknown>> = [];
  let call = 0;
  const orchestrator = createStepUpOrchestrator({
    getSid: () => 'sid-step-up-test',
    requestGrant: async () => undefined,
  });
  const execution = async (config: { headers?: unknown }) => {
    attempts.push({ ...((config.headers as Record<string, unknown> | undefined) ?? {}) });
    call += 1;
    if (call === 1) {
      throw {
        response: {
          status: 403,
          data: { error: { code: 'AUTH_STEP_UP_REQUIRED', actionGroup: 'settings.sensitive' } },
        },
      };
    }
    return { ok: true };
  };
  const resultPromise = orchestrator.run(
    'settings.sensitive',
    execution,
    { method: 'post', headers: { 'Idempotency-Key': 'slider_stable_test_key' } } as never,
  );
  for (let i = 0; i < 20 && !orchestrator.getPending(); i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(orchestrator.getPending()?.headers['Idempotency-Key'], 'slider_stable_test_key');
  await orchestrator.completeWithCredentials('password', '123456');
  assert.deepEqual(await resultPromise, { ok: true });
  assert.equal(attempts[0]?.['Idempotency-Key'], 'slider_stable_test_key');
  assert.equal(attempts[1]?.['Idempotency-Key'], 'slider_stable_test_key');
  assert.equal(attempts[0]?.['Idempotency-Key'], attempts[1]?.['Idempotency-Key']);
});

test('reached-Rust/no-key step-up outcome never auto-retries as an ambiguous mutation', () => {
  const orchestrator = createStepUpOrchestrator({
    getSid: () => 'sid-step-up-no-key',
    requestGrant: async () => undefined,
  });
  assert.equal(orchestrator.canAutoRetry({ gatewayRejectedBeforeUpstream: false, headers: {} }), false);
  assert.equal(orchestrator.canAutoRetry({ gatewayRejectedBeforeUpstream: false, headers: { 'Idempotency-Key': '   ' } }), false);
});
