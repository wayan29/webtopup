import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_VERIFICATION_PORTS } from './config.ts';

const runQuiet = (command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
  let error = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { error += chunk; });
  child.once('error', (cause) => reject(new Error(`unable to run ${command}: ${(cause as Error).message}`)));
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed with exit ${code}: ${error.trim().slice(0, 500)}`)));
});

const secret = (bytes = 48): string => crypto.randomBytes(bytes).toString('base64url');
const envText = (values: Record<string, string | number | boolean>): string => `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;

async function writePrivate(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

export async function generateLocalState(root: string): Promise<void> {
  const stateDir = path.resolve(root, '.dev-verification');
  const envDir = path.join(stateDir, 'env');
  const certDir = path.join(stateDir, 'certs');
  await fs.mkdir(envDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(certDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(stateDir, 'logs'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(stateDir, 'reports'), { recursive: true, mode: 0o700 });

  const sharedPath = path.join(envDir, 'shared.env');
  try {
    await fs.access(sharedPath);
  } catch {
    await writePrivate(sharedPath, envText({
      LOCAL_DEV_VERIFICATION: true,
      PUBLIC_ORIGIN: 'https://webtopup.local.test:9443',
      MONGO_URI: 'mongodb://127.0.0.1:27018/webtopup_task14_dev?replicaSet=rs0&directConnection=true',
      MONGO_DB: 'webtopup_task14_dev',
      MONGO_PORT: DEFAULT_VERIFICATION_PORTS.mongo,
      NODE_PORT: DEFAULT_VERIFICATION_PORTS.node,
      RUST_PORT: DEFAULT_VERIFICATION_PORTS.rust,
      VITE_PORT: DEFAULT_VERIFICATION_PORTS.vite,
      HTTPS_PORT: DEFAULT_VERIFICATION_PORTS.https,
      PROVIDER_MODE: 'mock',
      SESSION_REFRESH_ENABLED: false,
      SESSION_REFRESH_MEMBER_COHORT_PERCENT: 0,
      SESSION_REFRESH_CS_COHORT_PERCENT: 0,
      SESSION_REFRESH_ADMIN_COHORT_PERCENT: 0,
      SESSION_REFRESH_OWNER_COHORT_PERCENT: 0,
    }));
    const jwt = secret();
    const proxy = secret();
    await writePrivate(path.join(envDir, 'node.env'), envText({
      JWT_SECRET: jwt,
      API_V2_PROXY_SECRET: proxy,
      FIXTURE_MEMBER_PASSWORD: secret(24),
      FIXTURE_STAFF_PASSWORD: secret(24),
      FIXTURE_ADMIN_PASSWORD: secret(24),
      LOCAL_DESTRUCTIVE_CAPABILITY: secret(48),
    }));
    await writePrivate(path.join(envDir, 'rust.env'), envText({
      JWT_SECRET: jwt,
      API_V2_PROXY_SECRET: proxy,
      SESSION_TOKEN_HASH_SECRET: secret(),
      SESSION_ROTATION_ACTIVE_KEY_ID: 'rotation-local-v1',
      SESSION_ROTATION_KEYS: `rotation-local-v1:${secret(32)}`,
      SESSION_RECOVERY_ENCRYPTION_ACTIVE_KEY_ID: 'recovery-local-v1',
      SESSION_RECOVERY_ENCRYPTION_KEYS: `recovery-local-v1:${secret(32)}`,
    }));
  }

  const certificate = path.join(certDir, 'webtopup.local.test.pem');
  const privateKey = path.join(certDir, 'webtopup.local.test-key.pem');
  try {
    await Promise.all([fs.access(certificate), fs.access(privateKey)]);
  } catch {
    await runQuiet('mkcert', ['-install']);
    await runQuiet('mkcert', ['-cert-file', certificate, '-key-file', privateKey, 'webtopup.local.test', 'localhost', '127.0.0.1', '::1']);
    await fs.chmod(privateKey, 0o600);
  }
}
