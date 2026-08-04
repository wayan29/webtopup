import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompleteStatusIdentity, rolloutForProcessProfile, sanitizeComposeServices, statusFromObservations } from '../status.ts';

const rollout = { enabled: false, member: 0, cs: 0, admin: 0, owner: 0 } as const;

test('status preserves source and verified runtime identity without env or command arguments', () => {
  const status = statusFromObservations({
    commit: 'a'.repeat(40), trackedDirty: false, providerMode: 'mock', rollout,
    processes: [{ name: 'node', pid: 42, startTime: '100', executable: '/usr/bin/node', version: 'v24.0.0', binarySha256: 'b'.repeat(64) }],
    composeServices: [{ service: 'mongo', state: 'running', image: 'mongo:7', imageId: 'sha256:' + 'c'.repeat(64), containerId: 'd'.repeat(64) }],
    replicaSet: { name: 'rs0', writablePrimary: true, memberCount: 1 },
  });
  assert.equal(status.commit, 'a'.repeat(40));
  assert.equal(status.trackedDirty, false);
  assert.equal(status.processes[0]?.pid, 42);
  assert.equal(status.composeServices[0]?.imageId, 'sha256:' + 'c'.repeat(64));
  assert.deepEqual(status.replicaSet, { name: 'rs0', writablePrimary: true, memberCount: 1 });
  assert.equal(JSON.stringify(status).includes('env'), false);
  assert.equal(JSON.stringify(status).includes('command'), false);
});

test('compose status accepts only explicit non-secret identity fields', () => {
  const services = sanitizeComposeServices([{ Service: 'mongo', State: 'running', Image: 'mongo:7', ImageID: 'sha256:' + 'b'.repeat(64), ID: 'a'.repeat(64), Environment: 'PASSWORD=synthetic', Command: 'mongod --key synthetic' }]);
  assert.deepEqual(services, [{ service: 'mongo', state: 'running', image: 'mongo:7', imageId: 'sha256:' + 'b'.repeat(64), containerId: 'a'.repeat(64) }]);
  assert.equal(JSON.stringify(services).includes('synthetic'), false);
});

test('complete running identity requires immutable image IDs and process versions', () => {
  assert.doesNotThrow(() => assertCompleteStatusIdentity({
    processes: [{ name: 'node', pid: 42, startTime: '100', executable: '/usr/bin/node', version: 'v24', binarySha256: 'b'.repeat(64) }],
    composeServices: [{ service: 'mongo', state: 'running', image: 'mongo:7', imageId: 'sha256:' + 'c'.repeat(64), containerId: 'd'.repeat(64) }],
  }));
  assert.throws(() => assertCompleteStatusIdentity({ processes: [], composeServices: [{ service: 'mongo', state: 'running', image: 'mongo:7', containerId: 'd'.repeat(64) }] }), /image identity/);
  assert.throws(() => assertCompleteStatusIdentity({ processes: [{ name: 'rust', pid: 42, startTime: '100', executable: '/bin/rust', version: null, binarySha256: 'b'.repeat(64) }], composeServices: [] }), /process version/);
});

test('disabled process profile reports actual forced zero rollout despite configured values', () => {
  assert.deepEqual(rolloutForProcessProfile('disabled', { enabled: true, member: 100, cs: 100, admin: 100, owner: 100 }), { enabled: false, member: 0, cs: 0, admin: 0, owner: 0 });
});

test('status reports actual bounded process rollout profile', () => {
  assert.deepEqual(rolloutForProcessProfile(undefined, rollout), rollout);
  assert.deepEqual(rolloutForProcessProfile('disabled', rollout), rollout);
  assert.deepEqual(rolloutForProcessProfile('session-cs', rollout), { enabled: true, member: 0, cs: 100, admin: 0, owner: 0 });
  assert.deepEqual(rolloutForProcessProfile('session-cs-fault', rollout), { enabled: true, member: 0, cs: 100, admin: 0, owner: 0 });
  assert.deepEqual(rolloutForProcessProfile('session-device-policy', rollout), { enabled: true, member: 100, cs: 100, admin: 0, owner: 0 });
  assert.deepEqual(rolloutForProcessProfile('session-finance-policy', rollout), { enabled: true, member: 0, cs: 0, admin: 100, owner: 0 });
  assert.throws(() => rolloutForProcessProfile('unknown' as never, rollout), /process profile/);
});

test('result vocabulary rejects deployment or staging claims', () => {
  assert.throws(() => statusFromObservations({
    commit: 'a'.repeat(40), trackedDirty: false, providerMode: 'mock', rollout,
    processes: [], composeServices: [], replicaSet: null, result: 'DEPLOYMENT VERIFIED' as never,
  }), /local result status/);
});
