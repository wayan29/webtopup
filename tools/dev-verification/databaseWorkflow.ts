import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import type { VerificationConfig } from './types.ts';
import { infrastructureDown, infrastructureUp, inspectStackOwnership } from './docker.ts';
import { assertNoVerificationHostListeners, stopHostProcesses } from './processes.ts';
import {
  assertBootstrapProof, assertDestructiveDatabaseTarget, assertFreshBootstrapTarget, assertMarkedResetProof,
  capabilityDigest, EXPECTED_VOLUME, MARKER_COLLECTION,
  resetVerificationDatabase, type BootstrapProof, type DatabaseMarker, type MongoHello,
} from './database.ts';

const parsePrivateEnv = async (file: string): Promise<Record<string, string>> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const split = line.indexOf('=');
    if (split < 1) throw new Error('invalid private environment');
    return [line.slice(0, split), line.slice(split + 1)];
  }),
);

async function capability(config: VerificationConfig): Promise<string> {
  const env = await parsePrivateEnv(path.join(config.stateDir, 'env', 'node.env'));
  const value = env.LOCAL_DESTRUCTIVE_CAPABILITY;
  if (!value || value.length < 32) throw new Error('local destructive capability is unavailable; regenerate local state');
  return value;
}

async function stackProof(config: VerificationConfig, client: MongoClient): Promise<{ proof: BootstrapProof; hello: MongoHello }> {
  try { await fs.access(path.join(config.stateDir, 'processes.json')); throw new Error('verification host processes must be stopped'); }
  catch (error) { if (error instanceof Error && error.message.includes('must be stopped')) throw error; }
  await assertNoVerificationHostListeners(config.ports);
  const { container, volume } = await inspectStackOwnership();
  const databases = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(({ name }) => name);
  const hello = await client.db('admin').command<MongoHello>({ hello: 1 });
  return {
    proof: {
      composeProject: 'webtopup-task14-dev', service: 'mongo', containerId: container.Id!,
      volumeName: volume.Name!, volumeMountpoint: volume.Mountpoint!, databaseNames: databases,
      hostProcessesStopped: true,
    },
    hello,
  };
}

export async function bootstrapFreshVerificationDatabase(config: VerificationConfig): Promise<void> {
  await stopHostProcesses(config);
  await infrastructureDown(config, true);
  await infrastructureUp(config);
  const localCapability = await capability(config);
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const first = await stackProof(config, client);
    assertBootstrapProof(first.proof);
    assertFreshBootstrapTarget(config, first.proof, first.hello);
    const second = await stackProof(config, client);
    assertBootstrapProof(second.proof);
    assertFreshBootstrapTarget(config, second.proof, second.hello);
    if (first.proof.containerId !== second.proof.containerId || first.proof.volumeMountpoint !== second.proof.volumeMountpoint) throw new Error('bootstrap stack identity changed before marker write');
    const marker: DatabaseMarker = {
      kind: 'webtopup-local-dev-verification', databaseName: config.databaseName,
      capabilityDigest: capabilityDigest(localCapability), volumeName: EXPECTED_VOLUME,
    };
    await client.db(config.databaseName).collection<DatabaseMarker>(MARKER_COLLECTION).insertOne(marker);
  } finally { await client.close(); }
}

export async function assertMarkedVerificationDatabaseReady(config: VerificationConfig): Promise<void> {
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const observed = await stackProof(config, client);
    assertMarkedResetProof(observed.proof);
    const localCapability = await capability(config);
    const readIdentity = async () => ({
      hello: await client.db('admin').command<MongoHello>({ hello: 1 }),
      marker: await client.db(config.databaseName).collection<DatabaseMarker>(MARKER_COLLECTION).findOne({ kind: 'webtopup-local-dev-verification' }, { projection: { _id: 0 } }),
    });
    const first = await readIdentity(); const second = await readIdentity();
    assertDestructiveDatabaseTarget(config, first.hello, first.marker, localCapability);
    assertDestructiveDatabaseTarget(config, second.hello, second.marker, localCapability);
    const identity = (value: typeof first) => JSON.stringify({
      topology: { setName: value.hello.setName, isWritablePrimary: value.hello.isWritablePrimary, me: value.hello.me, hosts: value.hello.hosts },
      marker: value.marker && { kind: value.marker.kind, databaseName: value.marker.databaseName, capabilityDigest: value.marker.capabilityDigest, volumeName: value.marker.volumeName },
    });
    if (identity(first) !== identity(second)) throw new Error('marked verification database identity changed before mutation');
  } finally { await client.close(); }
}

export async function resetMarkedVerificationDatabase(config: VerificationConfig): Promise<void> {
  await stopHostProcesses(config);
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const observed = await stackProof(config, client);
    assertMarkedResetProof(observed.proof);
    await resetVerificationDatabase(config, observed.proof, await capability(config));
  } finally { await client.close(); }
}
