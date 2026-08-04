import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { assertSafeVerificationConfig, DEFAULT_VERIFICATION_PORTS, type VerificationConfig } from '../config.ts';

const root = path.resolve('/tmp/webtopup-source');
const valid: VerificationConfig = {
  root,
  stateDir: path.join(root, '.dev-verification'),
  databaseName: 'webtopup_task14_dev',
  mongoUri: 'mongodb://127.0.0.1:27018/webtopup_task14_dev?replicaSet=rs0&directConnection=true',
  publicOrigin: 'https://webtopup.local.test:9443',
  providerMode: 'mock',
  localMarker: true,
  rollout: { enabled: false, member: 0, cs: 0, admin: 0, owner: 0 },
  ports: { mongo: 27018, node: 19005, rust: 19010, vite: 19006, https: 9443 },
};

test('uses host ports isolated from the normal development stack', () => {
  assert.deepEqual(DEFAULT_VERIFICATION_PORTS, { mongo: 27018, node: 19005, rust: 19010, vite: 19006, https: 9443 });
});

test('accepts the exact disposable local configuration', () => {
  assert.doesNotThrow(() => assertSafeVerificationConfig(valid));
});

test('rejects any other destructive database target', () => {
  assert.throws(() => assertSafeVerificationConfig({ ...valid, databaseName: 'POBB' }), /database must be webtopup_task14_dev/);
});

test('rejects non-loopback Mongo and missing replica set', () => {
  assert.throws(() => assertSafeVerificationConfig({ ...valid, mongoUri: 'mongodb://db.example/webtopup_task14_dev?replicaSet=rs0&directConnection=true' }), /loopback Mongo/);
  assert.throws(() => assertSafeVerificationConfig({ ...valid, mongoUri: 'mongodb://127.0.0.1:27018/webtopup_task14_dev' }), /replicaSet=rs0/);
  assert.throws(() => assertSafeVerificationConfig({ ...valid, mongoUri: 'mongodb://127.0.0.1:27019/webtopup_task14_dev?replicaSet=rs0&directConnection=true' }), /configured Mongo port/);
  assert.throws(() => assertSafeVerificationConfig({ ...valid, mongoUri: 'mongodb://127.0.0.1:27018/webtopup_task14_dev?replicaSet=rs0' }), /directConnection=true/);
  assert.throws(() => assertSafeVerificationConfig({ ...valid, mongoUri: 'mongodb://127.0.0.1:27018,localhost:27018/webtopup_task14_dev?replicaSet=rs0&directConnection=true' }), /single Mongo host/);
});

test('rejects live providers and enabled rollout', () => {
  assert.throws(() => assertSafeVerificationConfig({ ...valid, providerMode: 'live' as 'mock' }), /PROVIDER_MODE must be mock/);
  assert.throws(() => assertSafeVerificationConfig({ ...valid, rollout: { ...valid.rollout, enabled: true, member: 1 } }), /rollout must start disabled/);
});

test('rejects state outside the repository and non-HTTPS origin', () => {
  assert.throws(() => assertSafeVerificationConfig({ ...valid, stateDir: '/tmp/other' }), /state directory/);
  assert.throws(() => assertSafeVerificationConfig({ ...valid, publicOrigin: 'http://webtopup.local.test:9443' }), /HTTPS/);
});
