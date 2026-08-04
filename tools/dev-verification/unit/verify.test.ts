import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateVerdict, beginVerificationReport, executeVerificationMatrix, runVerificationSteps } from '../verify.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('new aggregate run invalidates a retained success before executing checks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-run-'));
  const report = path.join(directory, 'aggregate.json');
  await fs.writeFile(report, JSON.stringify({ result: 'LOCAL DEV VERIFIED' }));
  const run = await beginVerificationReport(report);
  const current = JSON.parse(await fs.readFile(report, 'utf8'));
  assert.equal(current.result, 'NOT RUN'); assert.equal(current.runId, run.runId); assert.equal(typeof current.startedAt, 'string');
});

test('aggregate success requires every required check to be locally verified', () => {
  assert.equal(aggregateVerdict([{ name: 'unit', required: true, result: 'LOCAL DEV VERIFIED' }]), 'LOCAL DEV VERIFIED');
  for (const result of ['NOT RUN', 'NOT APPLICABLE', 'LOCAL DEV FAILED'] as const) {
    assert.equal(aggregateVerdict([{ name: 'required', required: true, result }]), 'LOCAL DEV FAILED');
  }
  assert.equal(aggregateVerdict([{ name: 'optional', required: false, result: 'NOT APPLICABLE' }]), 'LOCAL DEV VERIFIED');
});

test('runner stops after primary failure but always runs cleanup and preserves both failures', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runVerificationSteps([
      { name: 'first', required: true, run: async () => { calls.push('first'); return 'LOCAL DEV FAILED'; } },
      { name: 'never', required: true, run: async () => { calls.push('never'); return 'LOCAL DEV VERIFIED'; } },
    ], async () => { calls.push('cleanup'); throw new Error('cleanup failed'); }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(calls, ['first', 'cleanup']);
});

test('matrix executor switches profiles, stops before self-managed checks, and verifies stopped state last', async () => {
  const calls: string[] = [];
  const checks = await executeVerificationMatrix([
    { name: 'unit', required: true, profile: 'none', command: 'unit', args: [] },
    { name: 'session', required: true, profile: 'session-cs', command: 'session', args: [] },
    { name: 'rollout', required: true, profile: 'self-managed', command: 'rollout', args: [] },
    { name: 'stopped-state', required: true, profile: 'stopped', command: 'status', args: [] },
  ], {
    prepareDatabase: async () => { calls.push('db'); },
    resetDatabase: async () => { calls.push('reset'); },
    startProfile: async (profile) => { calls.push(`up:${profile}`); },
    stopHost: async () => { calls.push('down'); },
    runCommand: async (command) => { calls.push(`run:${command}`); return; },
    verifyStopped: async () => { calls.push('verify-stopped'); },
  });
  assert.equal(aggregateVerdict(checks), 'LOCAL DEV VERIFIED');
  assert.deepEqual(calls, ['run:unit', 'db', 'up:session-cs', 'run:session', 'down', 'run:rollout', 'verify-stopped']);
});

test('isolated checks reset and restart even when the bounded profile is unchanged', async () => {
  const calls: string[] = [];
  await executeVerificationMatrix([
    { name: 'one', required: true, profile: 'session-cs', isolated: true, command: 'one', args: [] },
    { name: 'two', required: true, profile: 'session-cs', isolated: true, command: 'two', args: [] },
  ], { prepareDatabase: async () => { calls.push('db'); }, resetDatabase: async () => { calls.push('reset'); }, startProfile: async () => { calls.push('up'); }, stopHost: async () => { calls.push('down'); }, runCommand: async (command) => { calls.push(command); }, verifyStopped: async () => undefined });
  assert.deepEqual(calls, ['db', 'up', 'one', 'down', 'reset', 'db', 'up', 'two', 'down', 'reset']);
});

test('matrix executor marks failure and caller can always stop active host', async () => {
  const calls: string[] = [];
  const checks = await executeVerificationMatrix([
    { name: 'session', required: true, profile: 'session-cs', command: 'fail', args: [] },
  ], {
    prepareDatabase: async () => { calls.push('db'); }, resetDatabase: async () => { calls.push('reset'); }, startProfile: async () => { calls.push('up'); }, stopHost: async () => { calls.push('down'); },
    runCommand: async () => { calls.push('run'); throw new Error('failed'); }, verifyStopped: async () => undefined,
  });
  assert.deepEqual(checks, [{ name: 'session', required: true, result: 'LOCAL DEV FAILED', phase: 'run' }]);
  assert.deepEqual(calls, ['db', 'up', 'run']);
});

test('isolated check failure always stops its profile and resets the marked database', async () => {
  const calls: string[] = [];
  const checks = await executeVerificationMatrix([
    { name: 'isolated', required: true, profile: 'session-finance-fault', isolated: true, command: 'fail', args: [] },
  ], {
    prepareDatabase: async () => { calls.push('db'); }, resetDatabase: async () => { calls.push('reset'); },
    startProfile: async () => { calls.push('up'); }, stopHost: async () => { calls.push('down'); },
    runCommand: async () => { calls.push('run'); throw new Error('failed'); }, verifyStopped: async () => undefined,
  });
  assert.deepEqual(checks, [{ name: 'isolated', required: true, result: 'LOCAL DEV FAILED', phase: 'run' }]);
  assert.deepEqual(calls, ['db', 'up', 'run', 'down', 'reset']);
});
