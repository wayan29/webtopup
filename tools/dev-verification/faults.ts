import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SITE_CONFIG_RUST_FAULT_SCENARIOS = [
  'site_config_transaction_probe_unavailable',
  'site_config_transaction_start_unavailable',
  'site_config_claim_undo_mismatch',
  'site_config_commit_unknown_unresolved',
] as const;
export const MANAGED_ASSET_RUST_FAULT_SCENARIOS = ['managed_asset_unlink_failure'] as const;
export const FAULT_SCENARIOS = ['offline', 'timeout', 'refresh_response_loss_after_commit', 'finance_balance_response_loss_after_commit', 'finance_refund_response_loss_after_commit', 'guest_checkout_response_loss_after_commit', 'site_config_response_loss_after_commit', ...SITE_CONFIG_RUST_FAULT_SCENARIOS, ...MANAGED_ASSET_RUST_FAULT_SCENARIOS, 'status_400', 'status_401', 'status_403', 'status_409', 'status_429', 'status_500', 'status_502', 'status_503', 'refresh_two_request_barrier'] as const;
export type FaultScenario = typeof FAULT_SCENARIOS[number];
export type SiteConfigRustFaultScenario = typeof SITE_CONFIG_RUST_FAULT_SCENARIOS[number];
export type ManagedAssetRustFaultScenario = typeof MANAGED_ASSET_RUST_FAULT_SCENARIOS[number];
export type FaultRequest = { stateDir: string; capability: string; scenario: FaultScenario; ttlMs: number };
export type FaultEvidence =
  | { activationId: string; scenario: 'refresh_response_loss_after_commit' | 'finance_balance_response_loss_after_commit' | 'finance_refund_response_loss_after_commit' | 'site_config_response_loss_after_commit'; upstreamComplete: true; downstreamDestroyed: true; consumed: true }
  | { activationId: string; scenario: 'guest_checkout_response_loss_after_commit'; mongoTransactionCommitted: true; guestMarkerDurable: true; idempotencyCompleteSkipped: true; consumed: true }
  | { activationId: string; scenario: SiteConfigRustFaultScenario | ManagedAssetRustFaultScenario; rustOnly: true; consumed: true }
  | { activationId: string; scenario: 'refresh_two_request_barrier'; queued: 2; released: 2 };

type FaultLease = { version: 1; activationId: string; scenario: FaultScenario; capabilityDigest: string; expiresAt: number };

const leasePath = (stateDir: string): string => path.join(stateDir, 'fault-lease.json');
const evidencePath = (stateDir: string): string => path.join(stateDir, 'fault-evidence.json');
const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
async function processStartTime(pid: number): Promise<string | null> {
  try { const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; }
}
async function withLeaseLock<T>(stateDir: string, run: () => Promise<T>, wait = false): Promise<T> {
  const lockPath = `${leasePath(stateDir)}.activation.lock`;
  let lock: fs.FileHandle | null = null;
  const owner = { pid: process.pid, startTime: await processStartTime(process.pid) };
  for (let attempt = 0; attempt < (wait ? 100 : 2); attempt += 1) {
    try { lock = await fs.open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify(owner)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { const observed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: unknown; startTime?: unknown }; const liveStart = typeof observed.pid === 'number' ? await processStartTime(observed.pid) : null; if (!liveStart || liveStart !== observed.startTime) { await fs.rm(lockPath, { force: true }); continue; } } catch { /* transient/invalid live lock is not reclaimed */ }
      if (!wait) throw new Error('fault activation is already active');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  if (!lock) throw new Error('fault lease lock timeout');
  try { return await run(); } finally { await lock.close(); try { const observed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: unknown; startTime?: unknown }; if (observed.pid === owner.pid && observed.startTime === owner.startTime) await fs.rm(lockPath, { force: true }); } catch { /* ownership changed or already removed */ } }
}
const readEnv = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
  const separator = line.indexOf('=');
  return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : ['', ''];
}).filter(([name]) => name));

export async function activateFault(request: FaultRequest): Promise<string> {
  if (!FAULT_SCENARIOS.includes(request.scenario)) throw new Error('unknown fault scenario');
  if (!Number.isInteger(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > 60_000) throw new Error('fault TTL must be between 1 and 60000 ms');
  const [shared, node] = await Promise.all([
    readEnv(path.join(request.stateDir, 'env', 'shared.env')),
    readEnv(path.join(request.stateDir, 'env', 'node.env')),
  ]);
  if (shared.LOCAL_DEV_VERIFICATION !== 'true') throw new Error('local verification marker is required');
  if (!request.capability || node.LOCAL_DESTRUCTIVE_CAPABILITY !== request.capability) throw new Error('fault capability mismatch');
  const activationId = crypto.randomUUID();
  const lease: FaultLease = { version: 1, activationId, scenario: request.scenario, capabilityDigest: digest(request.capability), expiresAt: Date.now() + request.ttlMs };
  const target = leasePath(request.stateDir);
  return withLeaseLock(request.stateDir, async () => {
    try {
      const existing = JSON.parse(await fs.readFile(target, 'utf8')) as FaultLease;
      if (typeof existing.expiresAt === 'number' && existing.expiresAt >= Date.now()) throw new Error('fault lease is already active');
      await fs.rm(target, { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof Error && error.message.includes('already active')) throw error; }
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(lease), { mode: 0o600 });
    await clearFaultEvidence(request.stateDir);
    await fs.rename(temporary, target);
    return activationId;
  });
}

export async function activeFault(stateDir: string): Promise<{ activationId: string; scenario: FaultScenario } | null> {
  try {
    const [lease, node, shared] = await Promise.all([
      fs.readFile(leasePath(stateDir), 'utf8').then((text) => JSON.parse(text) as FaultLease),
      readEnv(path.join(stateDir, 'env', 'node.env')),
      readEnv(path.join(stateDir, 'env', 'shared.env')),
    ]);
    return lease.version === 1 && typeof lease.activationId === 'string' && FAULT_SCENARIOS.includes(lease.scenario) && lease.expiresAt >= Date.now()
      && shared.LOCAL_DEV_VERIFICATION === 'true'
      && typeof node.LOCAL_DESTRUCTIVE_CAPABILITY === 'string'
      && lease.capabilityDigest === digest(node.LOCAL_DESTRUCTIVE_CAPABILITY) ? { activationId: lease.activationId, scenario: lease.scenario } : null;
  } catch { return null; }
}

export async function consumeFault(stateDir: string, scenario: FaultScenario, expectedActivationId?: string): Promise<string | null> {
  return withLeaseLock(stateDir, async () => {
    const target = leasePath(stateDir);
    try {
      const [lease, node, shared] = await Promise.all([
        fs.readFile(target, 'utf8').then((text) => JSON.parse(text) as FaultLease),
        readEnv(path.join(stateDir, 'env', 'node.env')),
        readEnv(path.join(stateDir, 'env', 'shared.env')),
      ]);
      const authorized = lease.version === 1 && typeof lease.activationId === 'string' && FAULT_SCENARIOS.includes(lease.scenario) && lease.expiresAt >= Date.now()
        && shared.LOCAL_DEV_VERIFICATION === 'true' && typeof node.LOCAL_DESTRUCTIVE_CAPABILITY === 'string'
        && lease.capabilityDigest === digest(node.LOCAL_DESTRUCTIVE_CAPABILITY);
      if (!authorized) { await fs.rm(target, { force: true }); return null; }
      if ((expectedActivationId && lease.activationId !== expectedActivationId) || lease.scenario !== scenario) return null;
      await fs.rm(target, { force: true });
      return lease.activationId;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return null; }
  }, true);
}

async function writeEvidence(stateDir: string, evidence: FaultEvidence): Promise<void> {
  const target = evidencePath(stateDir);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(evidence), { mode: 0o600 });
  await fs.rename(temporary, target);
}

export async function writeFaultEvidence(stateDir: string, activationId: string, scenario: 'refresh_response_loss_after_commit' | 'finance_balance_response_loss_after_commit' | 'finance_refund_response_loss_after_commit' | 'site_config_response_loss_after_commit' = 'refresh_response_loss_after_commit'): Promise<void> {
  await writeEvidence(stateDir, { activationId, scenario, upstreamComplete: true, downstreamDestroyed: true, consumed: true });
}

export async function writeBarrierEvidence(stateDir: string, activationId: string): Promise<void> {
  await writeEvidence(stateDir, { activationId, scenario: 'refresh_two_request_barrier', queued: 2, released: 2 });
}

export async function readFaultEvidence(stateDir: string): Promise<FaultEvidence | null> {
  try {
    const value = JSON.parse(await fs.readFile(evidencePath(stateDir), 'utf8')) as Partial<FaultEvidence>;
    const keys = Object.keys(value).sort().join(',');
    const responseLoss = keys === ['activationId', 'consumed', 'downstreamDestroyed', 'scenario', 'upstreamComplete'].sort().join(',')
      && typeof value.activationId === 'string' && ['refresh_response_loss_after_commit', 'finance_balance_response_loss_after_commit', 'finance_refund_response_loss_after_commit', 'site_config_response_loss_after_commit'].includes(value.scenario as string)
      && value.upstreamComplete === true && value.downstreamDestroyed === true && value.consumed === true;
    const rustOnly = keys === ['activationId', 'consumed', 'rustOnly', 'scenario'].sort().join(',')
      && typeof value.activationId === 'string'
      && ([...SITE_CONFIG_RUST_FAULT_SCENARIOS, ...MANAGED_ASSET_RUST_FAULT_SCENARIOS] as readonly string[]).includes(value.scenario as string)
      && value.rustOnly === true && value.consumed === true;
    const guestPostCommit = keys === ['activationId', 'consumed', 'guestMarkerDurable', 'idempotencyCompleteSkipped', 'mongoTransactionCommitted', 'scenario'].sort().join(',')
      && typeof value.activationId === 'string' && value.scenario === 'guest_checkout_response_loss_after_commit'
      && value.mongoTransactionCommitted === true && value.guestMarkerDurable === true
      && value.idempotencyCompleteSkipped === true && value.consumed === true;
    const barrier = keys === ['activationId', 'queued', 'released', 'scenario'].sort().join(',')
      && typeof value.activationId === 'string' && value.scenario === 'refresh_two_request_barrier'
      && value.queued === 2 && value.released === 2;
    if (!responseLoss && !guestPostCommit && !rustOnly && !barrier) throw new Error('invalid fault evidence');
    return value as FaultEvidence;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function clearFaultEvidence(stateDir: string): Promise<void> {
  await fs.rm(evidencePath(stateDir), { force: true });
}

export async function clearFault(stateDir: string, expectedActivationId?: string): Promise<void> {
  await withLeaseLock(stateDir, async () => {
    if (expectedActivationId) {
      try { const lease = JSON.parse(await fs.readFile(leasePath(stateDir), 'utf8')) as FaultLease; if (lease.activationId !== expectedActivationId) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
    await fs.rm(leasePath(stateDir), { force: true });
  }, true);
}

export async function withFault<T>(request: FaultRequest, run: () => Promise<T>): Promise<T> {
  const activationId = await activateFault(request);
  try { return await run(); }
  finally { await clearFault(request.stateDir, activationId); }
}
