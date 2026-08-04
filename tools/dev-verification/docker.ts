import { spawn } from 'node:child_process';
import path from 'node:path';
import type { VerificationConfig } from './types.ts';

export const COMPOSE_PROJECT = 'webtopup-task14-dev';
export const MONGO_VOLUME = 'webtopup-task14-dev_mongo-data';
export type StackContainerInspection = { Id?: string; Config?: { Labels?: Record<string, string>; Cmd?: string[] }; HostConfig?: { NetworkMode?: string }; Mounts?: Array<{ Type?: string; Name?: string; Destination?: string }> };
type StackVolumeInspection = { Name?: string; Mountpoint?: string; CreatedAt?: string; Labels?: Record<string, string> };
type Probe = (command: string, args: readonly string[]) => Promise<boolean>;

const defaultProbe: Probe = (command, args) => new Promise((resolve) => {
  const child = spawn(command, [...args], { stdio: 'ignore' });
  child.once('error', () => resolve(false));
  child.once('exit', (code) => resolve(code === 0));
});

export async function resolveComposeCommand(probe: Probe = defaultProbe): Promise<readonly string[]> {
  if (await probe('docker', ['compose', 'version'])) return ['docker', 'compose'];
  if (await probe('docker-compose', ['version'])) return ['docker-compose'];
  throw new Error('Docker Compose v2 plugin or docker-compose is required');
}

export function composeArgs(root: string, action: readonly string[]): string[] {
  return ['--project-name', COMPOSE_PROJECT, '--file', path.join(root, 'compose.dev-verification.yml'), ...action];
}

export function assertExactVolumeRemovalTarget(volumeName: string): void {
  if (volumeName !== MONGO_VOLUME) throw new Error('refusing to remove anything except the exact verification Mongo volume');
}

export function assertStackOwnershipInspection(container: StackContainerInspection, volume: StackVolumeInspection): void {
  const labels = container.Config?.Labels;
  const mount = container.Mounts?.find((item) => item.Destination === '/data/db');
  if (!/^[a-f0-9]{64}$/u.test(container.Id ?? '') || labels?.['com.docker.compose.project'] !== COMPOSE_PROJECT || labels?.['com.docker.compose.service'] !== 'mongo') {
    throw new Error('Mongo container ownership does not match verification stack');
  }
  if (mount?.Type !== 'volume' || mount.Name !== MONGO_VOLUME) throw new Error('Mongo container volume ownership does not match verification stack');
  if (volume.Name !== MONGO_VOLUME || volume.Labels?.['com.docker.compose.project'] !== COMPOSE_PROJECT || !volume.Mountpoint?.endsWith(`/${MONGO_VOLUME}/_data`)) {
    throw new Error('Mongo volume ownership does not match verification stack');
  }
}

export function validateComposePortBindings(bindings: readonly string[]): void {
  for (const binding of bindings) {
    if (!binding.startsWith('127.0.0.1:') && !binding.startsWith('[::1]:')) throw new Error(`published port must bind to loopback: ${binding}`);
  }
}

const execute = (command: readonly string[], args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn(command[0], [...command.slice(1), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Compose failed with exit ${code}: ${stderr.trim().slice(0, 500)}`)));
});

const composeEnv = (config: VerificationConfig): NodeJS.ProcessEnv => ({
  ...process.env,
  DEV_VERIFY_ROOT: config.root,
  DEV_VERIFY_MONGO_PORT: String(config.ports.mongo),
  DEV_VERIFY_HTTPS_PORT: String(config.ports.https),
  DEV_VERIFY_NODE_PORT: String(config.ports.node),
  DEV_VERIFY_VITE_PORT: String(config.ports.vite),
});

export async function infrastructureUp(config: VerificationConfig): Promise<void> {
  validateComposePortBindings([`127.0.0.1:${config.ports.mongo}:27017`, `127.0.0.1:${config.ports.https}:443`]);
  const command = await resolveComposeCommand();
  await execute(command, composeArgs(config.root, ['up', '-d', '--wait']), composeEnv(config));
}

export async function infrastructureDown(config: VerificationConfig, purge = false): Promise<void> {
  const command = await resolveComposeCommand();
  let inspectedVolume: StackVolumeInspection | undefined;
  if (purge) {
    const inspected = await inspectStackOwnership();
    inspectedVolume = inspected.volume;
    assertExactVolumeRemovalTarget(inspectedVolume.Name ?? '');
  }
  await execute(command, composeArgs(config.root, ['down', '--remove-orphans']), composeEnv(config));
  if (purge) {
    assertExactVolumeRemovalTarget(inspectedVolume!.Name!);
    await execute(['docker'], ['volume', 'rm', MONGO_VOLUME], process.env);
  }
}

export async function inspectStackOwnership(): Promise<{ container: StackContainerInspection; volume: StackVolumeInspection }> {
  const containerId = (await execute(['docker'], ['ps', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`, '--filter', 'label=com.docker.compose.service=mongo', '--format', '{{.ID}}'], process.env)).trim();
  if (!containerId || containerId.includes('\n')) throw new Error('expected exactly one running verification Mongo container');
  const [containerRaw, volumeRaw] = await Promise.all([
    execute(['docker'], ['inspect', containerId], process.env),
    execute(['docker'], ['volume', 'inspect', MONGO_VOLUME], process.env),
  ]);
  const container = JSON.parse(containerRaw)[0] as StackContainerInspection;
  const volume = JSON.parse(volumeRaw)[0] as StackVolumeInspection;
  assertStackOwnershipInspection(container, volume);
  return { container, volume };
}

export async function infrastructureStatus(config: VerificationConfig): Promise<{ services: unknown[] }> {
  const command = await resolveComposeCommand();
  const output = await execute(command, composeArgs(config.root, ['ps', '--format', 'json']), composeEnv(config));
  return { services: output.trim() ? output.trim().split('\n').map((line) => JSON.parse(line)) : [] };
}
