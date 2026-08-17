import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateFault,
  consumeFault,
  FAULT_SCENARIOS,
  MANAGED_ASSET_RUST_FAULT_SCENARIOS,
  readFaultEvidence,
  SLIDER_RUST_FAULT_SCENARIOS,
  withFault,
} from '../faults.ts';

const capability = 'synthetic-local-capability';

 test('fault scenario inventory is closed and covers every slider transaction seam', () => {
  assert.deepEqual(SLIDER_RUST_FAULT_SCENARIOS, [
    'slider_transaction_probe_unavailable',
    'slider_before_transaction_start',
    'slider_after_claim_fence_before_write',
    'slider_after_registry_write',
    'slider_after_domain_write',
    'slider_audit_failure',
    'slider_commit_unknown_unresolved',
    'slider_complete_during_commit_unknown_mark',
    'slider_frozen_response_oversize',
    'slider_reference_count_mismatch',
    'slider_unlink_failure',
    'slider_revision_conflict',
    'slider_create_contention',
    'slider_order_contention',
    'slider_limit_contention',
  ]);
  for (const scenario of SLIDER_RUST_FAULT_SCENARIOS) assert.ok(FAULT_SCENARIOS.includes(scenario));
  assert.ok(FAULT_SCENARIOS.includes('slider_response_loss_after_commit'));
  assert.equal(new Set(FAULT_SCENARIOS).size, FAULT_SCENARIOS.length);
});

test('managed deletion race fault is Rust-only and pauses after the first scan', async () => {
  assert.deepEqual(MANAGED_ASSET_RUST_FAULT_SCENARIOS, [
    'managed_asset_unlink_failure',
    'managed_asset_delete_after_first_scan',
  ]);
  assert.ok(FAULT_SCENARIOS.includes('managed_asset_delete_after_first_scan'));
  const localFault = await fs.readFile(path.resolve(import.meta.dirname, '..', '..', '..', 'rust-api', 'src', 'services', 'local_fault.rs'), 'utf8');
  const handlers = await fs.readFile(path.resolve(import.meta.dirname, '..', '..', '..', 'rust-api', 'src', 'routes', 'uploads', 'handlers.rs'), 'utf8');
  assert.match(localFault, /managed_asset_delete_after_first_scan/);
  assert.match(localFault, /sleep\(Duration::from_millis\(500\)\)/);
  assert.match(handlers, /consume_managed_asset_delete_after_first_scan_fault/);
});

test('post-fence crash is consumed at the real slider write boundary', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', '..', '..', 'rust-api', 'src', 'routes', 'content', 'slider_mutation.rs'), 'utf8');
  const fence = source.indexOf('verify_slider_claim_fence_in_session');
  const crash = source.indexOf('consume_slider_after_claim_fence_fault');
  assert.ok(fence >= 0 && crash > fence);
  assert.match(source.slice(crash, crash + 500), /return Err/);
});

test('slider Rust-only faults and gateway response-loss have an explicit ownership split', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', '..', '..', 'rust-api', 'src', 'services', 'local_fault.rs'), 'utf8');
  for (const scenario of SLIDER_RUST_FAULT_SCENARIOS) assert.match(source, new RegExp(scenario));
  assert.match(source, /SLIDER_RESPONSE_LOSS_SCENARIO/);
  assert.match(source, /gateway-owned/);
  assert.match(source, /LOCAL_DEV_VERIFICATION/);
  assert.match(source, /MONGO_DB/);
  assert.match(source, /127\.0\.0\.1:27018\/webtopup_task14_dev/);
  assert.doesNotMatch(source, /slider_response_loss_after_commit[\s\S]{0,600}faultProxy/);
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

test('every slider fault lease is one-shot and production marker rejection is preserved', async () => {
  const stateDir = await fixture();
  try {
    for (const scenario of [...SLIDER_RUST_FAULT_SCENARIOS, 'slider_response_loss_after_commit'] as const) {
      const activationId = await activateFault({ stateDir, capability, scenario, ttlMs: 1_000 });
      assert.equal(await consumeFault(stateDir, scenario, activationId), activationId, scenario);
      assert.equal(await consumeFault(stateDir, scenario, activationId), null, scenario);
    }
    await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=false\n');
    await assert.rejects(activateFault({ stateDir, capability, scenario: 'slider_revision_conflict', ttlMs: 1_000 }), /marker/);
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
