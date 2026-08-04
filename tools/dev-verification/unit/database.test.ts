import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  assertBootstrapProof, assertDestructiveDatabaseTarget, assertFreshBootstrapTarget, assertMarkedResetProof, assertResetPreconditions,
  capabilityDigest, safeMongoError, type BootstrapProof, type DatabaseMarker, type MongoHello,
} from '../database.ts';
import type { VerificationConfig } from '../types.ts';

const root = path.resolve('/repo');
const capability = 'local-capability-with-at-least-thirty-two-random-characters';
const config: VerificationConfig = {
  root, stateDir: path.join(root, '.dev-verification'), databaseName: 'webtopup_task14_dev',
  mongoUri: 'mongodb://127.0.0.1:27018/webtopup_task14_dev?replicaSet=rs0&directConnection=true', publicOrigin: 'https://webtopup.local.test:9443',
  providerMode: 'mock', localMarker: true, rollout: { enabled: false, member: 0, cs: 0, admin: 0, owner: 0 },
  ports: { mongo: 27018, node: 19005, rust: 19010, vite: 19006, https: 9443 },
};
const hello: MongoHello = { setName: 'rs0', isWritablePrimary: true, me: '127.0.0.1:27018', hosts: ['127.0.0.1:27018'] };
const marker: DatabaseMarker = {
  kind: 'webtopup-local-dev-verification', databaseName: 'webtopup_task14_dev',
  capabilityDigest: capabilityDigest(capability), volumeName: 'webtopup-task14-dev_mongo-data',
};
const proof: BootstrapProof = {
  composeProject: 'webtopup-task14-dev', service: 'mongo',
  containerId: 'a'.repeat(64), volumeName: 'webtopup-task14-dev_mongo-data',
  volumeMountpoint: '/var/lib/docker/volumes/webtopup-task14-dev_mongo-data/_data',
  databaseNames: ['admin', 'config', 'local'], hostProcessesStopped: true,
};

test('accepts only exact capability-bound marker and single-member local primary', () => {
  assert.doesNotThrow(() => assertDestructiveDatabaseTarget(config, hello, marker, capability));
});

test('rejects wrong database, topology, primary, peer, members, marker, or capability', () => {
  assert.throws(() => assertDestructiveDatabaseTarget({ ...config, databaseName: 'POBB' }, hello, marker, capability), /database/);
  assert.throws(() => assertDestructiveDatabaseTarget(config, { ...hello, setName: 'other' }, marker, capability), /replica set/);
  assert.throws(() => assertDestructiveDatabaseTarget(config, { ...hello, isWritablePrimary: false }, marker, capability), /primary/);
  assert.throws(() => assertDestructiveDatabaseTarget(config, { ...hello, me: 'db.example:27017' }, marker, capability), /local peer/);
  assert.throws(() => assertDestructiveDatabaseTarget(config, { ...hello, hosts: [...hello.hosts!, 'db.example:27017'] }, marker, capability), /single local member/);
  assert.throws(() => assertDestructiveDatabaseTarget(config, hello, null, capability), /marker/);
  assert.throws(() => assertDestructiveDatabaseTarget(config, hello, { ...marker, databaseName: 'other' }, capability), /marker/);
  assert.throws(() => assertDestructiveDatabaseTarget(config, hello, marker, 'wrong-capability-that-is-still-long-enough'), /capability/);
});

test('bootstrap requires a new empty stack-owned volume, stopped host processes, and exact topology', () => {
  assert.doesNotThrow(() => assertBootstrapProof(proof));
  assert.doesNotThrow(() => assertFreshBootstrapTarget(config, proof, hello));
  assert.throws(() => assertFreshBootstrapTarget(config, proof, { ...hello, hosts: ['other:27017'] }), /topology/);
  assert.throws(() => assertBootstrapProof({ ...proof, composeProject: 'other' }), /Compose project/);
  assert.throws(() => assertBootstrapProof({ ...proof, volumeName: 'other' }), /volume/);
  assert.throws(() => assertBootstrapProof({ ...proof, databaseNames: [...proof.databaseNames, 'webtopup_task14_dev'] }), /empty/);
  assert.throws(() => assertBootstrapProof({ ...proof, hostProcessesStopped: false }), /host processes/);
});

test('marked reset proof permits only system databases plus the approved marked database', () => {
  assert.doesNotThrow(() => assertMarkedResetProof({ ...proof, databaseNames: [...proof.databaseNames, 'webtopup_task14_dev'] }));
  assert.throws(() => assertMarkedResetProof({ ...proof, databaseNames: [...proof.databaseNames, 'other'] }), /approved marked database/);
});

test('reset preconditions bind proof, marker, capability, and repeated observations', () => {
  const markedProof = { ...proof, databaseNames: [...proof.databaseNames, 'webtopup_task14_dev'] };
  assert.doesNotThrow(() => assertResetPreconditions(config, markedProof, { ...hello, localTime: 'first' } as MongoHello, marker, capability, { ...hello, localTime: 'second' } as MongoHello, marker));
  assert.throws(() => assertResetPreconditions(config, markedProof, hello, marker, capability, { ...hello, isWritablePrimary: false }, marker), /recheck/);
  assert.throws(() => assertResetPreconditions(config, markedProof, hello, marker, capability, hello, { ...marker, volumeName: 'other' }), /recheck/);
});

test('redacts Mongo credentials and credential-like query values from operator errors', () => {
  const output = safeMongoError(new Error('connect mongodb://user:super-secret@127.0.0.1:27018/db?authMechanismProperties=SERVICE_NAME:private failed password=also-private'));
  assert.doesNotMatch(output, /super-secret|private|also-private|user:/u);
  assert.match(output, /mongodb:\/\/\[REDACTED\]@127\.0\.0\.1/u);
});
