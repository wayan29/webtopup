import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import type { VerificationConfig } from './types.ts';
import { REQUIRED_DB, assertSafeVerificationConfig } from './config.ts';

export type MongoHello = { setName?: string; isWritablePrimary?: boolean; me?: string; hosts?: string[] };
export type DatabaseMarker = {
  kind: 'webtopup-local-dev-verification';
  databaseName: string;
  capabilityDigest: string;
  volumeName: string;
};
export type BootstrapProof = {
  composeProject: string;
  service: 'mongo';
  containerId: string;
  volumeName: string;
  volumeMountpoint: string;
  databaseNames: string[];
  hostProcessesStopped: boolean;
};

export const MARKER_COLLECTION = '__localVerification';
export const EXPECTED_COMPOSE_PROJECT = 'webtopup-task14-dev';
export const EXPECTED_VOLUME = 'webtopup-task14-dev_mongo-data';

export function capabilityDigest(capability: string): string {
  if (capability.length < 32) throw new Error('local destructive capability is invalid');
  return crypto.createHash('sha256').update(capability, 'utf8').digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function markerMatches(config: VerificationConfig, marker: DatabaseMarker | null, capability: string): boolean {
  return Boolean(marker
    && marker.kind === 'webtopup-local-dev-verification'
    && marker.databaseName === config.databaseName
    && marker.volumeName === EXPECTED_VOLUME
    && equalDigest(marker.capabilityDigest, capabilityDigest(capability)));
}

function topologyMatches(config: VerificationConfig, hello: MongoHello): boolean {
  const peer = `127.0.0.1:${config.ports.mongo}`;
  return hello.setName === 'rs0'
    && hello.isWritablePrimary === true
    && (hello.me === peer || hello.me === `localhost:${config.ports.mongo}`)
    && Array.isArray(hello.hosts)
    && hello.hosts.length === 1
    && (hello.hosts[0] === peer || hello.hosts[0] === `localhost:${config.ports.mongo}`);
}

export function assertDestructiveDatabaseTarget(config: VerificationConfig, hello: MongoHello, marker: DatabaseMarker | null, capability: string): void {
  assertSafeVerificationConfig(config);
  if (hello.setName !== 'rs0') throw new Error('destructive operation requires replica set rs0');
  if (hello.isWritablePrimary !== true) throw new Error('destructive operation requires writable primary');
  if (hello.me !== `127.0.0.1:${config.ports.mongo}` && hello.me !== `localhost:${config.ports.mongo}`) throw new Error('destructive operation requires exact local peer');
  if (!Array.isArray(hello.hosts) || hello.hosts.length !== 1 || !topologyMatches(config, hello)) throw new Error('destructive operation requires exact single local member');
  if (!marker || marker.kind !== 'webtopup-local-dev-verification' || marker.databaseName !== config.databaseName || marker.volumeName !== EXPECTED_VOLUME) throw new Error('destructive operation requires exact verification marker');
  if (!markerMatches(config, marker, capability)) throw new Error('destructive operation capability does not match marker');
}

export function assertFreshBootstrapTarget(config: VerificationConfig, proof: BootstrapProof, hello: MongoHello): void {
  assertSafeVerificationConfig(config);
  assertBootstrapProof(proof);
  if (!topologyMatches(config, hello)) throw new Error('bootstrap Mongo topology does not match exact local single-member primary');
}

export function assertBootstrapProof(proof: BootstrapProof): void {
  if (proof.composeProject !== EXPECTED_COMPOSE_PROJECT || proof.service !== 'mongo') throw new Error('bootstrap requires exact Compose project and Mongo service');
  if (!/^[a-f0-9]{64}$/u.test(proof.containerId)) throw new Error('bootstrap requires exact container identity');
  if (proof.volumeName !== EXPECTED_VOLUME || !proof.volumeMountpoint.endsWith(`/${EXPECTED_VOLUME}/_data`)) throw new Error('bootstrap requires exact stack-owned volume');
  if (!proof.hostProcessesStopped) throw new Error('bootstrap requires verification host processes to be stopped');
  const allowed = new Set(['admin', 'config', 'local']);
  if (proof.databaseNames.some((name) => !allowed.has(name))) throw new Error('bootstrap requires an empty application database volume');
}

export function assertMarkedResetProof(proof: BootstrapProof): void {
  if (proof.composeProject !== EXPECTED_COMPOSE_PROJECT || proof.service !== 'mongo' || proof.volumeName !== EXPECTED_VOLUME) throw new Error('reset requires exact verification stack ownership');
  if (!proof.hostProcessesStopped) throw new Error('reset requires verification host processes to be stopped');
  const allowed = new Set(['admin', 'config', 'local', REQUIRED_DB]);
  if (proof.databaseNames.some((name) => !allowed.has(name)) || !proof.databaseNames.includes(REQUIRED_DB)) throw new Error('reset permits only system databases plus the approved marked database');
}

export function assertResetPreconditions(
  config: VerificationConfig, proof: BootstrapProof,
  firstHello: MongoHello, firstMarker: DatabaseMarker | null, capability: string,
  secondHello: MongoHello, secondMarker: DatabaseMarker | null,
): void {
  assertMarkedResetProof(proof);
  assertDestructiveDatabaseTarget(config, firstHello, firstMarker, capability);
  try {
    assertDestructiveDatabaseTarget(config, secondHello, secondMarker, capability);
    const topologyIdentity = (hello: MongoHello) => JSON.stringify({
      setName: hello.setName,
      isWritablePrimary: hello.isWritablePrimary,
      me: hello.me,
      hosts: [...(hello.hosts ?? [])].sort(),
    });
    const markerIdentity = (marker: DatabaseMarker | null) => JSON.stringify(marker && {
      kind: marker.kind,
      databaseName: marker.databaseName,
      capabilityDigest: marker.capabilityDigest,
      volumeName: marker.volumeName,
    });
    if (topologyIdentity(firstHello) !== topologyIdentity(secondHello) || markerIdentity(firstMarker) !== markerIdentity(secondMarker)) throw new Error('identity changed');
  } catch { throw new Error('destructive target recheck failed'); }
}

export function safeMongoError(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Mongo operation failed';
  message = message.replace(/mongodb(?:\+srv)?:\/\/[^@\s]+@/giu, 'mongodb://[REDACTED]@');
  message = message.replace(/([?&](?:authMechanismProperties|authSource|password|secret|token)=)[^&\s]*/giu, '$1[REDACTED]');
  message = message.replace(/\b(password|secret|token)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]');
  return message;
}

export async function resetVerificationDatabase(
  config: VerificationConfig, proof: BootstrapProof, capability: string,
): Promise<void> {
  assertSafeVerificationConfig(config);
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const db = client.db(config.databaseName);
    const readIdentity = async () => ({
      hello: await client.db('admin').command<MongoHello>({ hello: 1 }),
      marker: await db.collection<DatabaseMarker>(MARKER_COLLECTION).findOne({ kind: 'webtopup-local-dev-verification' }, { projection: { _id: 0 } }),
    });
    const first = await readIdentity();
    const second = await readIdentity();
    assertResetPreconditions(config, proof, first.hello, first.marker, capability, second.hello, second.marker);
    await db.dropDatabase();
    const replacement: DatabaseMarker = {
      kind: 'webtopup-local-dev-verification', databaseName: REQUIRED_DB,
      capabilityDigest: capabilityDigest(capability), volumeName: EXPECTED_VOLUME,
    };
    await db.collection<DatabaseMarker>(MARKER_COLLECTION).insertOne(replacement);
  } catch (error) { throw new Error(safeMongoError(error)); }
  finally { await client.close(); }
}
