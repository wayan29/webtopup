import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activateFault, consumeFault, FAULT_SCENARIOS, readFaultEvidence, withFault } from '../faults.ts';

const capability = 'synthetic-local-capability';

 test('fault scenario inventory covers bounded transport, status, response-loss, and ordering cases', () => {
  assert.deepEqual(FAULT_SCENARIOS, ['offline', 'timeout', 'refresh_response_loss_after_commit', 'finance_balance_response_loss_after_commit', 'finance_refund_response_loss_after_commit', 'guest_checkout_response_loss_after_commit', 'status_400', 'status_401', 'status_403', 'status_409', 'status_429', 'status_500', 'status_502', 'status_503', 'refresh_two_request_barrier']);
});

const fixture = async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-'));
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
  await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`, { mode: 0o600 });
  return stateDir;
};

test('fault lease requires exact local marker, capability, known scenario, and bounded TTL', async () => {
  const stateDir = await fixture();
  try {
    await assert.rejects(activateFault({ stateDir, capability: 'wrong', scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 }), /capability/);
    await assert.rejects(activateFault({ stateDir, capability, scenario: 'unknown' as never, ttlMs: 1_000 }), /scenario/);
    await assert.rejects(activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 60_001 }), /TTL/);
    await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=false\n');
    await assert.rejects(activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 }), /marker/);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('fault lease is one-shot and expired leases are rejected', async () => {
  const stateDir = await fixture();
  try {
    await activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 });
    await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=false\n');
    assert.equal(await consumeFault(stateDir, 'refresh_response_loss_after_commit'), null);
    await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
    const activationId = await activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 });
    assert.equal(await consumeFault(stateDir, 'refresh_response_loss_after_commit'), activationId);
    assert.equal(await consumeFault(stateDir, 'refresh_response_loss_after_commit'), null);
    await activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await consumeFault(stateDir, 'refresh_response_loss_after_commit'), null);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('orphaned lock ownership is reclaimed without removing a live lock', async () => {
  const stateDir = await fixture(); const lock = path.join(stateDir, 'fault-lease.json.activation.lock');
  try {
    await fs.writeFile(lock, JSON.stringify({ pid: 99999999, startTime: 'dead' }));
    assert.ok(await activateFault({ stateDir, capability, scenario: 'offline', ttlMs: 1_000 }));
    await fs.rm(path.join(stateDir, 'fault-lease.json'), { force: true });
    const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8'); const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startTime }));
    await assert.rejects(activateFault({ stateDir, capability, scenario: 'offline', ttlMs: 1_000 }), /already active/);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('activation rejects an existing live lease', async () => {
  const stateDir = await fixture();
  try {
    await activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 });
    await assert.rejects(activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 }), /already active/);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('guest post-commit evidence proves marker durability and skipped completion', async () => {
  const stateDir = await fixture();
  try {
    const evidence = {
      activationId: 'guest-activation',
      scenario: 'guest_checkout_response_loss_after_commit',
      mongoTransactionCommitted: true,
      guestMarkerDurable: true,
      idempotencyCompleteSkipped: true,
      consumed: true,
    };
    await fs.writeFile(path.join(stateDir, 'fault-evidence.json'), JSON.stringify(evidence));
    assert.deepEqual(await readFaultEvidence(stateDir), evidence);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('malformed fault evidence is rejected', async () => {
  const stateDir = await fixture();
  try {
    await fs.writeFile(path.join(stateDir, 'fault-evidence.json'), JSON.stringify({ consumed: true }));
    await assert.rejects(readFaultEvidence(stateDir), /evidence/);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('withFault cleanup cannot delete a newer activation', async () => {
  const stateDir = await fixture();
  try {
    let newer = '';
    await withFault({ stateDir, capability, scenario: 'offline', ttlMs: 1_000 }, async () => {
      assert.ok(await consumeFault(stateDir, 'offline'));
      newer = await activateFault({ stateDir, capability, scenario: 'status_503', ttlMs: 1_000 });
    });
    assert.equal(await consumeFault(stateDir, 'status_503'), newer);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('withFault always removes its lease', async () => {
  const stateDir = await fixture();
  try {
    await assert.rejects(withFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 }, async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
    assert.equal(await consumeFault(stateDir, 'refresh_response_loss_after_commit'), null);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});
