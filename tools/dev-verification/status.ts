import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';
import type { ProcessManifest } from './processes.ts';
import { processIdentityMatches } from './processes.ts';
import { infrastructureStatus } from './docker.ts';
import type { RolloutConfig, VerificationConfig, VerificationResultStatus, VerificationStatus } from './types.ts';

export type RuntimeIdentity = { name: string; pid: number; startTime: string; executable: string; version: string | null; binarySha256: string };
export type ComposeIdentity = { service: string; state: string; image: string; imageId?: string; containerId?: string };
export type StatusObservations = {
  commit: string; trackedDirty: boolean; providerMode: 'mock'; rollout: RolloutConfig;
  processes: RuntimeIdentity[]; composeServices: ComposeIdentity[];
  replicaSet: { name: string; writablePrimary: boolean; memberCount: number } | null;
  result?: VerificationResultStatus;
};

const RESULTS = new Set<VerificationResultStatus>(['LOCAL DEV VERIFIED', 'LOCAL DEV FAILED', 'NOT RUN', 'NOT APPLICABLE']);

export function sanitizeComposeServices(raw: readonly Record<string, unknown>[]): ComposeIdentity[] {
  return raw.map((service) => ({
    service: String(service.Service ?? service.service ?? ''), state: String(service.State ?? service.state ?? ''),
    image: String(service.Image ?? service.image ?? ''),
    imageId: typeof service.ImageID === 'string' ? service.ImageID : typeof service.imageId === 'string' ? service.imageId : undefined,
    containerId: typeof service.ID === 'string' ? service.ID : typeof service.containerId === 'string' ? service.containerId : undefined,
  }));
}

export function rolloutForProcessProfile(profile: ProcessManifest['profile'] | undefined, configured: RolloutConfig): RolloutConfig {
  if (profile === 'disabled') return { enabled: false, member: 0, cs: 0, admin: 0, owner: 0 };
  if (profile === undefined) return configured;
  if (profile === 'session-cs' || profile === 'session-cs-fault') return { enabled: true, member: 0, cs: 100, admin: 0, owner: 0 };
  if (profile === 'session-device-policy') return { enabled: true, member: 100, cs: 100, admin: 0, owner: 0 };
  if (profile === 'session-finance-policy' || profile === 'session-finance-fault') return { enabled: true, member: 0, cs: 0, admin: 100, owner: 0 };
  if (profile === 'session-rollout-pre-cutoff' || profile === 'session-rollout-post-cutoff') return { enabled: true, member: 0, cs: 100, admin: 0, owner: 0 };
  throw new Error('unknown verification process profile');
}

export function assertCompleteStatusIdentity(observed: Pick<StatusObservations, 'processes' | 'composeServices'>): void {
  if (observed.processes.some((item) => !item.version)) throw new Error('running process version is unavailable');
  if (observed.composeServices.some((item) => item.state === 'running' && (!item.imageId || !item.containerId))) throw new Error('running Compose image identity is unavailable');
}

export function statusFromObservations(observed: StatusObservations): VerificationStatus {
  const result = observed.result ?? 'NOT RUN';
  if (!RESULTS.has(result)) throw new Error('invalid local result status');
  return { ...observed, result };
}

const execute = (command: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] }); let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; });
  child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error('status identity command failed')));
});

const sha256File = async (file: string): Promise<string> => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function runtimeIdentity(name: string, owned: ProcessManifest['processes'][keyof ProcessManifest['processes']]): Promise<RuntimeIdentity> {
  const proc = `/proc/${owned.pid}`;
  const [stat, executable, cwd, rawCommand] = await Promise.all([
    fs.readFile(path.join(proc, 'stat'), 'utf8'), fs.readlink(path.join(proc, 'exe')), fs.readlink(path.join(proc, 'cwd')), fs.readFile(path.join(proc, 'cmdline')),
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const observed = { pid: owned.pid, startTime: fields[19], executable, cwd, command: rawCommand.toString('utf8').split('\0').filter(Boolean) };
  if (!processIdentityMatches(owned, observed)) throw new Error(`status refused changed PID ${owned.pid}`);
  let version: string | null;
  if (name === 'vite') {
    const packageJson = JSON.parse(await fs.readFile(path.join(owned.cwd, 'node_modules', 'vite', 'package.json'), 'utf8')) as { version?: unknown };
    version = typeof packageJson.version === 'string' ? packageJson.version : null;
  } else if (name === 'rust') {
    const cargo = await fs.readFile(path.join(owned.cwd, 'Cargo.toml'), 'utf8');
    version = cargo.match(/^version\s*=\s*"([^"]+)"/mu)?.[1] ?? null;
  } else {
    version = (await execute(executable, ['--version'])).slice(0, 120) || null;
  }
  const identityFile = name === 'faultProxy' ? path.join(owned.cwd, 'tools', 'dev-verification', 'faultProxy.ts') : executable;
  return { name, pid: owned.pid, startTime: owned.startTime, executable, version, binarySha256: await sha256File(identityFile) };
}

export async function collectStatus(config: VerificationConfig): Promise<VerificationStatus> {
  const commit = await execute('git', ['-C', config.root, 'rev-parse', 'HEAD']);
  const trackedDirty = (await execute('git', ['-C', config.root, 'status', '--porcelain', '--untracked-files=no'])) !== '';
  let processes: RuntimeIdentity[] = [];
  let rollout = config.rollout;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(config.stateDir, 'processes.json'), 'utf8')) as ProcessManifest;
    rollout = rolloutForProcessProfile(manifest.profile, config.rollout);
    processes = await Promise.all(Object.entries(manifest.processes).map(([name, owned]) => runtimeIdentity(name, owned)));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const rawServices = (await infrastructureStatus(config)).services as Record<string, unknown>[];
  const composeServices = sanitizeComposeServices(rawServices);
  for (const service of composeServices.filter((item) => item.state === 'running')) {
    if (!service.containerId) throw new Error('running Compose container identity is unavailable');
    const inspected = JSON.parse(await execute('docker', ['inspect', '--format', '{{json .Image}}', service.containerId])) as unknown;
    if (typeof inspected !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(inspected)) throw new Error('running Compose image identity is unavailable');
    service.imageId = inspected;
  }
  let replicaSet: StatusObservations['replicaSet'] = null;
  if (composeServices.some((item) => item.service === 'mongo' && item.state === 'running')) {
    const mongo = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 1500 });
    try {
      await mongo.connect(); const hello = await mongo.db('admin').command({ hello: 1 });
      replicaSet = { name: String(hello.setName ?? ''), writablePrimary: hello.isWritablePrimary === true, memberCount: Array.isArray(hello.hosts) ? hello.hosts.length : 0 };
    } finally { await mongo.close(); }
  }
  assertCompleteStatusIdentity({ processes, composeServices });
  return statusFromObservations({ commit, trackedDirty, providerMode: config.providerMode, rollout, processes, composeServices, replicaSet });
}
