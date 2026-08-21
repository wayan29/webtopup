import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { EXPECTED_VOLUME, MARKER_COLLECTION, type DatabaseMarker, type MongoHello } from './database.ts';
import { inspectStackOwnership } from './docker.ts';
import { REQUIRED_DB } from './config.ts';
import type { VerificationConfig, VerificationPorts } from './types.ts';

export type OwnedProcess = { pid: number; startTime: string; executable: string; cwd: string; command: string[]; logPath: string };
export type ObservedProcess = { pid: number; startTime: string; executable: string; cwd: string; command: string[] };
export type ProcessProfile = 'disabled' | 'session-cs' | 'session-cs-fault' | 'session-device-policy' | 'session-finance-policy' | 'session-finance-fault' | 'session-rollout-pre-cutoff' | 'session-rollout-post-cutoff';
export type ProcessName = 'rust' | 'node' | 'vite' | 'faultProxy';
export type ProcessManifest = { createdAt: string; profile: ProcessProfile; processes: Partial<Record<ProcessName, OwnedProcess>> };
type HostCommand = { command: string; args: string[]; cwd: string };

export function faultProxyPort(ports: Pick<VerificationPorts, 'rust'>): number {
  if (ports.rust >= 65535) throw new Error('fault proxy port is unavailable');
  return ports.rust + 1;
}

export function faultProfilePorts(ports: Pick<VerificationPorts, 'node' | 'rust' | 'vite'>): number[] {
  return [ports.node, ports.rust, ports.vite, faultProxyPort(ports)];
}

export function disabledRolloutEnv(): Record<string, string> {
  return { SESSION_REFRESH_ENABLED: 'false', SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0', SESSION_REFRESH_CS_COHORT_PERCENT: '0', SESSION_REFRESH_ADMIN_COHORT_PERCENT: '0', SESSION_REFRESH_OWNER_COHORT_PERCENT: '0', LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL: '' };
}

export function sessionTestRolloutEnv(): Record<string, string> {
  return {
    SESSION_REFRESH_ENABLED: 'true',
    SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0',
    SESSION_REFRESH_CS_COHORT_PERCENT: '100',
    SESSION_REFRESH_ADMIN_COHORT_PERCENT: '0',
    SESSION_REFRESH_OWNER_COHORT_PERCENT: '0',
  };
}

export function devicePolicyRolloutEnv(): Record<string, string> {
  return {
    SESSION_REFRESH_ENABLED: 'true',
    SESSION_REFRESH_MEMBER_COHORT_PERCENT: '100',
    SESSION_REFRESH_CS_COHORT_PERCENT: '100',
    SESSION_REFRESH_ADMIN_COHORT_PERCENT: '0',
    SESSION_REFRESH_OWNER_COHORT_PERCENT: '0',
  };
}

export function rolloutTransitionEnv(cutoff: string): Record<string, string> {
  return { SESSION_REFRESH_ENABLED: 'true', SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0', SESSION_REFRESH_CS_COHORT_PERCENT: '100', SESSION_REFRESH_ADMIN_COHORT_PERCENT: '0', SESSION_REFRESH_OWNER_COHORT_PERCENT: '0', LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL: cutoff };
}

export function financePolicyRolloutEnv(): Record<string, string> {
  return {
    SESSION_REFRESH_ENABLED: 'true',
    SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0',
    SESSION_REFRESH_CS_COHORT_PERCENT: '0',
    SESSION_REFRESH_ADMIN_COHORT_PERCENT: '100',
    SESSION_REFRESH_OWNER_COHORT_PERCENT: '0',
  };
}

export function buildHostChildEnv(input: {
  inherited: NodeJS.ProcessEnv;
  shared: Record<string, string>;
  secrets: Record<string, string>;
  profile: ProcessManifest['profile'];
}): NodeJS.ProcessEnv {
  const rollout = input.profile === 'session-rollout-pre-cutoff'
    ? rolloutTransitionEnv('2099-01-01T00:00:00Z')
    : input.profile === 'session-rollout-post-cutoff'
      ? rolloutTransitionEnv('2000-01-01T00:00:00Z')
    : input.profile === 'session-device-policy'
    ? devicePolicyRolloutEnv()
    : input.profile === 'session-finance-policy' || input.profile === 'session-finance-fault'
      ? financePolicyRolloutEnv()
    : input.profile === 'session-cs' || input.profile === 'session-cs-fault'
      ? sessionTestRolloutEnv()
      : disabledRolloutEnv();
  return { ...input.inherited, ...input.shared, ...input.secrets, ...rollout, LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL: rollout.LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL ?? '', OTEL_ENABLED: 'false', MONGO_TRANSACTIONS_ENABLED: 'true' };
}

export function assertDevicePolicyTarget(
  ports: Pick<VerificationPorts, 'mongo'>,
  firstHello: MongoHello,
  firstMarker: DatabaseMarker | null,
  secondHello: MongoHello,
  secondMarker: DatabaseMarker | null,
): void {
  const peer = `127.0.0.1:${ports.mongo}`;
  const local = (hello: MongoHello) => hello.setName === 'rs0' && hello.isWritablePrimary === true
    && (hello.me === peer || hello.me === `localhost:${ports.mongo}`)
    && hello.hosts?.length === 1 && (hello.hosts[0] === peer || hello.hosts[0] === `localhost:${ports.mongo}`);
  const marked = (marker: DatabaseMarker | null) => marker?.kind === 'webtopup-local-dev-verification'
    && marker.databaseName === REQUIRED_DB && marker.volumeName === EXPECTED_VOLUME;
  if (!local(firstHello) || !marked(firstMarker) || !local(secondHello) || !marked(secondMarker)) throw new Error('device-policy profile requires exact disposable Mongo identity');
  const identity = (hello: MongoHello, marker: DatabaseMarker | null) => JSON.stringify({ setName: hello.setName, primary: hello.isWritablePrimary, me: hello.me, hosts: hello.hosts, marker });
  if (identity(firstHello, firstMarker) !== identity(secondHello, secondMarker)) throw new Error('device-policy Mongo identity changed before startup');
}

async function assertDevicePolicyDatabase(config: VerificationConfig): Promise<void> {
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const observe = async () => ({ hello: await client.db('admin').command<MongoHello>({ hello: 1 }), marker: await client.db(config.databaseName).collection<DatabaseMarker>(MARKER_COLLECTION).findOne({ kind: 'webtopup-local-dev-verification' }, { projection: { _id: 0 } }) });
    const firstStack = await inspectStackOwnership(); const first = await observe();
    const secondStack = await inspectStackOwnership(); const second = await observe();
    assertDevicePolicyTarget(config.ports, first.hello, first.marker, second.hello, second.marker);
    const endpoint = (stack: Awaited<ReturnType<typeof inspectStackOwnership>>) => ({ network: stack.container.HostConfig?.NetworkMode, command: stack.container.Config?.Cmd });
    const bound = (value: ReturnType<typeof endpoint>) => value.network === 'host' && JSON.stringify(value.command) === JSON.stringify(['mongod', '--replSet', 'rs0', '--port', String(config.ports.mongo), '--bind_ip', '127.0.0.1']);
    if (!bound(endpoint(firstStack)) || !bound(endpoint(secondStack))) throw new Error('device-policy Mongo endpoint is not bound to the owned stack container');
    if (firstStack.container.Id !== secondStack.container.Id || firstStack.volume.Name !== secondStack.volume.Name || firstStack.volume.Mountpoint !== secondStack.volume.Mountpoint || JSON.stringify(endpoint(firstStack)) !== JSON.stringify(endpoint(secondStack))) throw new Error('device-policy stack ownership changed before startup');
  } finally { await client.close(); }
}

export function identifierReadinessApplyPlan(input: {
  root: string;
  stateDir: string;
  databaseName: string;
  mongoUri: string;
  executable: string;
}): { command: string; args: string[]; cwd: string; envKeys: ['MONGO_URI', 'MONGO_DB'] } {
  if (input.databaseName !== REQUIRED_DB) throw new Error(`database must be ${REQUIRED_DB}`);
  const expected = path.join(input.root, 'rust-api', 'target', 'debug', 'site_config_identifier_readiness');
  if (path.resolve(input.executable) !== path.resolve(expected)) throw new Error('expected target binary');
  return {
    command: expected,
    args: ['--apply'],
    cwd: path.join(input.root, 'rust-api'),
    envKeys: ['MONGO_URI', 'MONGO_DB'],
  };
}

export function sliderReadinessApplyPlan(input: {
  root: string;
  stateDir: string;
  databaseName: string;
  mongoUri: string;
  executable: string;
}): { command: string; args: string[]; cwd: string; envKeys: ['MONGO_URI', 'MONGO_DB'] } {
  if (input.databaseName !== REQUIRED_DB) throw new Error(`database must be ${REQUIRED_DB}`);
  const expected = path.join(input.root, 'rust-api', 'target', 'release', 'slider_managed_asset_readiness');
  if (path.resolve(input.executable) !== path.resolve(expected)) throw new Error('expected release readiness binary');
  return {
    command: expected,
    args: ['--apply', '--json'],
    cwd: path.join(input.root, 'rust-api'),
    envKeys: ['MONGO_URI', 'MONGO_DB'],
  };
}

export function makeSellerOrderReadinessApplyPlan(input: {
  root: string;
  stateDir: string;
  databaseName: string;
  mongoUri: string;
  executable: string;
}): { command: string; args: string[]; cwd: string; envKeys: ['MONGO_URI', 'MONGO_DB'] } {
  if (input.databaseName !== REQUIRED_DB) throw new Error(`database must be ${REQUIRED_DB}`);
  const expected = path.join(input.root, 'rust-api', 'target', 'debug', 'seller_order_readiness');
  if (path.resolve(input.executable) !== path.resolve(expected)) throw new Error('expected seller readiness binary');
  return {
    command: expected,
    args: ['--apply', '--json'],
    cwd: path.join(input.root, 'rust-api'),
    envKeys: ['MONGO_URI', 'MONGO_DB'],
  };
}

export async function prepareDisposableSellerOrderIndexes(config: VerificationConfig): Promise<void> {
  const { assertMarkedVerificationDatabaseReady } = await import('./databaseWorkflow.ts');
  await assertMarkedVerificationDatabaseReady(config);
  const executable = path.join(config.root, 'rust-api', 'target', 'debug', 'seller_order_readiness');
  const plan = makeSellerOrderReadinessApplyPlan({
    root: config.root,
    stateDir: config.stateDir,
    databaseName: config.databaseName,
    mongoUri: config.mongoUri,
    executable,
  });
  await fs.access(plan.command);
  const shared = await readEnvFile(path.join(config.stateDir, 'env', 'shared.env'));
  if (shared.MONGO_DB !== REQUIRED_DB) throw new Error(`database must be ${REQUIRED_DB}`);
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MONGO_URI: shared.MONGO_URI,
      MONGO_DB: shared.MONGO_DB,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk) => { stderr.push(Buffer.from(chunk)); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status));
  });
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').replaceAll(shared.MONGO_URI ?? '', '[redacted]').slice(0, 400);
    throw new Error(`seller order readiness apply failed (${code ?? 'null'}): ${detail}`);
  }
}

export async function prepareDisposableSliderReadiness(config: VerificationConfig): Promise<void> {
  const { assertMarkedVerificationDatabaseReady } = await import('./databaseWorkflow.ts');
  await assertMarkedVerificationDatabaseReady(config);
  const executable = path.join(config.root, 'rust-api', 'target', 'release', 'slider_managed_asset_readiness');
  const plan = sliderReadinessApplyPlan({
    root: config.root,
    stateDir: config.stateDir,
    databaseName: config.databaseName,
    mongoUri: config.mongoUri,
    executable,
  });
  await fs.access(plan.command);
  const shared = await readEnvFile(path.join(config.stateDir, 'env', 'shared.env'));
  if (shared.MONGO_DB !== REQUIRED_DB) throw new Error(`database must be ${REQUIRED_DB}`);
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MONGO_URI: shared.MONGO_URI,
      MONGO_DB: shared.MONGO_DB,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk) => { stderr.push(Buffer.from(chunk)); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status));
  });
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').replaceAll(shared.MONGO_URI ?? '', '[redacted]').slice(0, 400);
    throw new Error(`slider readiness apply failed (${code ?? 'null'}): ${detail}`);
  }
}

export async function prepareDisposableIdentifierIndexes(config: VerificationConfig): Promise<void> {
  const { assertMarkedVerificationDatabaseReady } = await import('./databaseWorkflow.ts');
  await assertMarkedVerificationDatabaseReady(config);
  const executable = path.join(config.root, 'rust-api', 'target', 'debug', 'site_config_identifier_readiness');
  const plan = identifierReadinessApplyPlan({
    root: config.root,
    stateDir: config.stateDir,
    databaseName: config.databaseName,
    mongoUri: config.mongoUri,
    executable,
  });
  await fs.access(plan.command);
  const shared = await readEnvFile(path.join(config.stateDir, 'env', 'shared.env'));
  if (shared.MONGO_DB !== REQUIRED_DB) throw new Error(`database must be ${REQUIRED_DB}`);
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MONGO_URI: shared.MONGO_URI,
      MONGO_DB: shared.MONGO_DB,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk) => { stderr.push(Buffer.from(chunk)); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status));
  });
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').replaceAll(shared.MONGO_URI ?? '', '[redacted]').slice(0, 400);
    throw new Error(`identifier index apply failed (${code ?? 'null'}): ${detail}`);
  }
}

export function hostProcessCommands(root: string, ports: VerificationPorts): Record<'rust' | 'node' | 'vite', HostCommand> {
  return {
    rust: { command: path.join(root, 'rust-api', 'target', 'debug', 'webtopup-rust-api'), args: [], cwd: path.join(root, 'rust-api') },
    node: { command: process.execPath, args: [path.join(root, 'server', 'dist', 'index.js')], cwd: path.join(root, 'server') },
    vite: { command: process.execPath, args: [path.join(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(ports.vite)], cwd: path.join(root, 'client') },
  };
}

export function assertVerificationHostPortsFree(ports: Pick<VerificationPorts, 'node' | 'rust' | 'vite'>, listening: ReadonlySet<number>): void {
  for (const port of [ports.node, ports.rust, ports.vite]) if (listening.has(port)) throw new Error(`verification host port ${port} is already in use`);
}

export async function assertNoVerificationHostListeners(ports: Pick<VerificationPorts, 'node' | 'rust' | 'vite'>): Promise<void> {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(async (file) => {
    try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
  }));
  const listening = new Set<number>();
  for (const table of tables) for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[3] === '0A' && fields[1]?.includes(':')) listening.add(Number.parseInt(fields[1].split(':').at(-1)!, 16));
  }
  assertVerificationHostPortsFree(ports, listening);
}

export function assertProcessesExited(ownedPids: readonly number[], livePids: ReadonlySet<number>): void {
  const survivor = ownedPids.find((pid) => livePids.has(pid));
  if (survivor !== undefined) throw new Error(`owned PID ${survivor} did not exit`);
}

export function processIdentityMatches(owned: OwnedProcess, observed: ObservedProcess): boolean {
  return owned.pid === observed.pid
    && owned.startTime === observed.startTime
    && path.resolve(owned.executable) === path.resolve(observed.executable)
    && path.resolve(owned.cwd) === path.resolve(observed.cwd)
    && owned.command.length === observed.command.length
    && owned.command.every((part, index) => part === observed.command[index]);
}

const readEnvFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('invalid generated environment line');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

async function observedProcess(pid: number): Promise<ObservedProcess> {
  const proc = `/proc/${pid}`;
  const [stat, executable, cwd, rawCommand] = await Promise.all([
    fs.readFile(path.join(proc, 'stat'), 'utf8'), fs.readlink(path.join(proc, 'exe')), fs.readlink(path.join(proc, 'cwd')), fs.readFile(path.join(proc, 'cmdline')),
  ]);
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).split(' ');
  return { pid, startTime: fields[19], executable, cwd, command: rawCommand.toString('utf8').split('\0').filter(Boolean) };
}

async function spawnOwned(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stateDir: string): Promise<OwnedProcess> {
  const logPath = path.join(stateDir, 'logs', `${name}.log`);
  const log = await fs.open(logPath, 'w', 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await log.close();
  child.unref();
  const observed = await observedProcess(child.pid!);
  return { pid: observed.pid, startTime: observed.startTime, executable: observed.executable, cwd: observed.cwd, command: [command, ...args], logPath };
}

export async function waitForHttp(url: string, policy = { attempts: 60, intervalMs: 500 }): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : 'request failed'; }
    await new Promise((resolve) => setTimeout(resolve, policy.intervalMs));
  }
  throw new Error(`readiness failed for ${new URL(url).origin}: ${last}`);
}

export async function startHostProcesses(config: VerificationConfig, profile: ProcessProfile = 'disabled'): Promise<ProcessManifest> {
  if (profile === 'session-device-policy' || profile === 'session-finance-policy' || profile === 'session-finance-fault' || profile === 'session-rollout-pre-cutoff' || profile === 'session-rollout-post-cutoff') await assertDevicePolicyDatabase(config);
  const manifestPath = path.join(config.stateDir, 'processes.json');
  try { await fs.access(manifestPath); throw new Error('host processes already have an ownership manifest; run down or inspect status'); } catch (error) {
    if (error instanceof Error && error.message.includes('ownership manifest')) throw error;
  }
  await prepareDisposableSliderReadiness(config);
  await prepareDisposableIdentifierIndexes(config);
  await prepareDisposableSellerOrderIndexes(config);
  const commands = hostProcessCommands(config.root, config.ports);
  for (const item of Object.values(commands)) await fs.access(item.command);
  const faultCommand: HostCommand = { command: process.execPath, args: ['--import', 'tsx', path.join(config.root, 'tools', 'dev-verification', 'faultProxy.ts')], cwd: config.root };
  if (profile === 'session-cs-fault' || profile === 'session-finance-fault') {
    const listening = new Set<number>();
    const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(async (file) => { try { return await fs.readFile(file, 'utf8'); } catch { return ''; } }));
    for (const table of tables) for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === '0A' && fields[1]?.includes(':')) listening.add(Number.parseInt(fields[1].split(':').at(-1)!, 16));
    }
    for (const port of faultProfilePorts(config.ports)) if (listening.has(port)) throw new Error(`verification host port ${port} is already in use`);
  }
  const shared = await readEnvFile(path.join(config.stateDir, 'env', 'shared.env'));
  const rustSecrets = await readEnvFile(path.join(config.stateDir, 'env', 'rust.env'));
  const nodeSecrets = await readEnvFile(path.join(config.stateDir, 'env', 'node.env'));
  const base = buildHostChildEnv({ inherited: process.env, shared, secrets: {}, profile });
  const processes = {} as ProcessManifest['processes'];
  try {
    processes.rust = await spawnOwned('rust', commands.rust.command, commands.rust.args, commands.rust.cwd, {
      ...buildHostChildEnv({ inherited: base, shared: {}, secrets: rustSecrets, profile }),
      API_V2_HOST: '127.0.0.1',
      API_V2_PORT: String(config.ports.rust),
      API_V2_ALLOWED_ORIGIN: config.publicOrigin,
      ...((profile === 'session-finance-fault' || profile === 'session-cs-fault') ? {
        LOCAL_DESTRUCTIVE_CAPABILITY: nodeSecrets.LOCAL_DESTRUCTIVE_CAPABILITY,
        DEV_VERIFICATION_STATE_DIR: config.stateDir,
      } : {}),
    }, config.stateDir);
    await waitForHttp(`http://127.0.0.1:${config.ports.rust}/api/v2/health`);
    const upstreamPort = profile === 'session-cs-fault' || profile === 'session-finance-fault' ? faultProxyPort(config.ports) : config.ports.rust;
    if (profile === 'session-cs-fault' || profile === 'session-finance-fault') {
      processes.faultProxy = await spawnOwned('fault-proxy', faultCommand.command, faultCommand.args, faultCommand.cwd, {
        ...base,
        DEV_VERIFICATION_STATE_DIR: config.stateDir,
        DEV_VERIFICATION_RUST_ORIGIN: `http://127.0.0.1:${config.ports.rust}`,
        DEV_VERIFICATION_FAULT_PROXY_PORT: String(upstreamPort),
      }, config.stateDir);
      await waitForHttp(`http://127.0.0.1:${upstreamPort}/api/v2/health`);
    }
    processes.node = await spawnOwned('node', commands.node.command, commands.node.args, commands.node.cwd, { ...buildHostChildEnv({ inherited: base, shared: {}, secrets: nodeSecrets, profile }), HOST: '127.0.0.1', PORT: String(config.ports.node), NODE_ENV: 'production', PUBLIC_APP_URL: config.publicOrigin, API_V2_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}` }, config.stateDir);
    await waitForHttp(`http://127.0.0.1:${config.ports.node}/health`);
    processes.vite = await spawnOwned('vite', commands.vite.command, commands.vite.args, commands.vite.cwd, { ...base, VITE_API_URL: '/api', VITE_API_V2_URL: '/api/v2' }, config.stateDir);
    await waitForHttp(`http://127.0.0.1:${config.ports.vite}/`);
    const manifest = { createdAt: new Date().toISOString(), profile, processes };
    await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await fs.rename(`${manifestPath}.tmp`, manifestPath);
    return manifest;
  } catch (error) {
    if (Object.keys(processes).length > 0) {
      const failures: unknown[] = [error];
      const recoveryManifest: ProcessManifest = { createdAt: new Date().toISOString(), profile, processes };
      try {
        await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(recoveryManifest, null, 2), { mode: 0o600 });
        await fs.rename(`${manifestPath}.tmp`, manifestPath);
      } catch (manifestError) { failures.push(manifestError); }
      try { await stopOwnedProcesses(Object.values(processes).reverse()); }
      catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length > 1) throw new AggregateError(failures, 'host startup failed and recovery encountered errors');
      await fs.rm(manifestPath, { force: true });
    }
    throw error;
  }
}

async function stopOwnedProcesses(ownedProcesses: OwnedProcess[]): Promise<void> {
  for (const owned of ownedProcesses) {
    let observed: ObservedProcess;
    try { observed = await observedProcess(owned.pid); } catch { continue; }
    if (!processIdentityMatches(owned, observed)) throw new Error(`refusing to stop PID ${owned.pid}: process identity changed`);
    process.kill(-owned.pid, 'SIGTERM');
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const live = new Set<number>();
    for (const owned of ownedProcesses) { try { await observedProcess(owned.pid); live.add(owned.pid); } catch { /* exited */ } }
    if (live.size === 0) break;
    if (attempt === 99) assertProcessesExited(ownedProcesses.map(({ pid }) => pid), live);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function stopHostProcesses(config: VerificationConfig): Promise<void> {
  const manifestPath = path.join(config.stateDir, 'processes.json');
  let manifest: ProcessManifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await stopOwnedProcesses(Object.values(manifest.processes).reverse());
  await fs.rm(manifestPath, { force: true });
}
