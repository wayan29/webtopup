import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthCoordinator } from '../../../client/src/auth/coordinator.ts';

test('session policy change is a terminal refresh outcome', async () => {
  let token: string | null = 'synthetic-memory-token';
  const phases: string[] = [];
  const terminal: string[] = [];
  const coordinator = createAuthCoordinator({
    refresh: async () => { throw { response: { status: 401, data: { error: { code: 'AUTH_SESSION_POLICY_CHANGED' } } } }; },
    migrate: async () => { throw new Error('not used'); },
    tokenStore: { get: () => token, set: (value) => { token = value; }, clear: () => { token = null; } },
    channel: { post: () => undefined, subscribe: () => () => undefined, close: () => undefined },
    setPhase: (phase) => phases.push(phase),
    onAuthenticated: () => undefined,
    onTerminal: (code) => terminal.push(code),
    delay: async () => undefined,
    now: () => 0,
  });
  await assert.rejects(coordinator.refreshOnce('test'));
  assert.equal(token, null);
  assert.equal(phases.at(-1), 'revoked');
  assert.deepEqual(terminal, ['AUTH_SESSION_POLICY_CHANGED']);
  coordinator.dispose();
});
