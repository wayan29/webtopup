import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VerificationConfig } from './types.ts';

export type { VerificationConfig } from './types.ts';

export const REQUIRED_DB = 'webtopup_task14_dev';
export const REQUIRED_PROVIDER_MODE = 'mock';
export const DISABLED_ROLLOUT = Object.freeze({ enabled: false, member: 0, cs: 0, admin: 0, owner: 0 });
export const DEFAULT_VERIFICATION_PORTS = Object.freeze({ mongo: 27018, node: 19005, rust: 19010, vite: 19006, https: 9443 });

const parseEnv = (text: string): Record<string, string> => Object.fromEntries(
  text.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error('invalid generated environment line');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const parsePercent = (value: string | undefined, name: string): number => {
  if (!value || !/^(?:0|[1-9]\d?|100)$/u.test(value)) throw new Error(`${name} must be an integer from 0 to 100`);
  return Number(value);
};

const parsePort = (value: string | undefined, name: string): number => {
  if (!value || !/^\d+$/u.test(value)) throw new Error(`${name} must be a valid port`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) throw new Error(`${name} must be a valid port`);
  return parsed;
};

export function assertSafeVerificationConfig(config: VerificationConfig): void {
  if (config.databaseName !== REQUIRED_DB) throw new Error(`database must be ${REQUIRED_DB}`);
  if (config.providerMode !== REQUIRED_PROVIDER_MODE) throw new Error('PROVIDER_MODE must be mock');
  if (!config.localMarker) throw new Error('LOCAL_DEV_VERIFICATION marker is required');

  const expectedState = path.resolve(config.root, '.dev-verification');
  if (path.resolve(config.stateDir) !== expectedState) throw new Error('state directory must be the repository .dev-verification directory');

  const authority = config.mongoUri.match(/^mongodb:\/\/([^/]+)\//u)?.[1];
  if (!authority || authority.includes(',')) throw new Error('MONGO_URI must contain a single Mongo host');
  let mongo: URL;
  try { mongo = new URL(config.mongoUri); } catch { throw new Error('MONGO_URI must be a valid loopback Mongo URI'); }
  if (mongo.protocol !== 'mongodb:') throw new Error('MONGO_URI must use mongodb protocol');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(mongo.hostname)) throw new Error('MONGO_URI must target loopback Mongo');
  if (mongo.port !== String(config.ports.mongo)) throw new Error('MONGO_URI must use the configured Mongo port');
  if (mongo.searchParams.get('replicaSet') !== 'rs0') throw new Error('MONGO_URI must include replicaSet=rs0');
  if (mongo.searchParams.get('directConnection') !== 'true') throw new Error('MONGO_URI must include directConnection=true');
  if (mongo.pathname.replace(/^\//u, '') !== REQUIRED_DB) throw new Error(`Mongo URI database must be ${REQUIRED_DB}`);

  let publicOrigin: URL;
  try { publicOrigin = new URL(config.publicOrigin); } catch { throw new Error('public origin must be valid HTTPS'); }
  if (publicOrigin.protocol !== 'https:') throw new Error('public origin must use HTTPS');
  if (publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) throw new Error('public origin must not include path, query, or fragment');

  const rollout = config.rollout;
  if (rollout.enabled || rollout.member !== 0 || rollout.cs !== 0 || rollout.admin !== 0 || rollout.owner !== 0) {
    throw new Error('rollout must start disabled with zero cohorts');
  }
  for (const [name, port] of Object.entries(config.ports)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} port must be valid`);
  }
}

export function loadVerificationConfig(root: string): VerificationConfig {
  const resolvedRoot = path.resolve(root);
  const stateDir = path.join(resolvedRoot, '.dev-verification');
  const envPath = path.join(stateDir, 'env', 'shared.env');
  const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const enabled = env.SESSION_REFRESH_ENABLED;
  if (enabled !== 'false') throw new Error('SESSION_REFRESH_ENABLED must be false');
  const config: VerificationConfig = {
    root: resolvedRoot,
    stateDir,
    databaseName: env.MONGO_DB,
    mongoUri: env.MONGO_URI,
    publicOrigin: env.PUBLIC_ORIGIN,
    providerMode: env.PROVIDER_MODE as 'mock',
    localMarker: env.LOCAL_DEV_VERIFICATION === 'true',
    rollout: {
      enabled: false,
      member: parsePercent(env.SESSION_REFRESH_MEMBER_COHORT_PERCENT, 'member cohort'),
      cs: parsePercent(env.SESSION_REFRESH_CS_COHORT_PERCENT, 'cs cohort'),
      admin: parsePercent(env.SESSION_REFRESH_ADMIN_COHORT_PERCENT, 'admin cohort'),
      owner: parsePercent(env.SESSION_REFRESH_OWNER_COHORT_PERCENT, 'owner cohort'),
    },
    ports: {
      mongo: parsePort(env.MONGO_PORT, 'Mongo'),
      node: parsePort(env.NODE_PORT, 'Node'),
      rust: parsePort(env.RUST_PORT, 'Rust'),
      vite: parsePort(env.VITE_PORT, 'Vite'),
      https: parsePort(env.HTTPS_PORT, 'HTTPS'),
    },
  };
  assertSafeVerificationConfig(config);
  return config;
}

export const currentModuleDirectory = path.dirname(fileURLToPath(import.meta.url));
