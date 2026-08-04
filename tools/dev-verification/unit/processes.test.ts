import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveServerHost } from '../../../server/src/config/serverHost.ts';
import { assertDevicePolicyTarget, assertProcessesExited, assertVerificationHostPortsFree, buildHostChildEnv, devicePolicyRolloutEnv, financePolicyRolloutEnv, faultProfilePorts, faultProxyPort, hostProcessCommands, processIdentityMatches, sessionTestRolloutEnv, type OwnedProcess, type ObservedProcess } from '../processes.ts';

test('server host preserves default and accepts loopback verification binding', () => {
  assert.equal(resolveServerHost({}), '0.0.0.0');
  assert.equal(resolveServerHost({ HOST: '127.0.0.1' }), '127.0.0.1');
  assert.throws(() => resolveServerHost({ HOST: '' }), /HOST/);
  assert.throws(() => resolveServerHost({ HOST: 'not a host!' }), /HOST/);
});

const owned: OwnedProcess = { pid: 42, startTime: '100', executable: '/usr/bin/node', cwd: '/repo/server', command: ['npm', 'run', 'dev'], logPath: '/repo/.dev-verification/logs/node.log' };
const observed: ObservedProcess = { pid: 42, startTime: '100', executable: '/usr/bin/node', cwd: '/repo/server', command: ['npm', 'run', 'dev'] };

test('session test rollout profile is bounded to synthetic CS fixtures', () => {
  assert.deepEqual(sessionTestRolloutEnv(), {
    SESSION_REFRESH_ENABLED: 'true',
    SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0',
    SESSION_REFRESH_CS_COHORT_PERCENT: '100',
    SESSION_REFRESH_ADMIN_COHORT_PERCENT: '0',
    SESSION_REFRESH_OWNER_COHORT_PERCENT: '0',
  });
});

test('device-policy profile enables only synthetic member and CS cohorts', () => {
  assert.deepEqual(devicePolicyRolloutEnv(), {
    SESSION_REFRESH_ENABLED: 'true',
    SESSION_REFRESH_MEMBER_COHORT_PERCENT: '100',
    SESSION_REFRESH_CS_COHORT_PERCENT: '100',
    SESSION_REFRESH_ADMIN_COHORT_PERCENT: '0',
    SESSION_REFRESH_OWNER_COHORT_PERCENT: '0',
  });
  const conflict = { SESSION_REFRESH_ENABLED: 'false', SESSION_REFRESH_CS_COHORT_PERCENT: '0', SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0', SESSION_REFRESH_ADMIN_COHORT_PERCENT: '100' };
  const env = buildHostChildEnv({ inherited: conflict, shared: conflict, secrets: conflict, profile: 'session-device-policy' });
  assert.deepEqual(Object.fromEntries(Object.keys(devicePolicyRolloutEnv()).map((key) => [key, env[key]])), devicePolicyRolloutEnv());
});

test('finance-policy profile enables only the synthetic admin cohort required by finance integration', () => {
  assert.deepEqual(financePolicyRolloutEnv(), {
    SESSION_REFRESH_ENABLED: 'true', SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0', SESSION_REFRESH_CS_COHORT_PERCENT: '0', SESSION_REFRESH_ADMIN_COHORT_PERCENT: '100', SESSION_REFRESH_OWNER_COHORT_PERCENT: '0',
  });
  const env = buildHostChildEnv({ inherited: {}, shared: {}, secrets: {}, profile: 'session-finance-policy' });
  assert.deepEqual(Object.fromEntries(Object.keys(financePolicyRolloutEnv()).map((key) => [key, env[key]])), financePolicyRolloutEnv());
});

test('device-policy profile requires stable exact disposable Mongo identity', () => {
  const hello = { setName: 'rs0', isWritablePrimary: true, me: '127.0.0.1:27018', hosts: ['127.0.0.1:27018'] };
  const marker = { kind: 'webtopup-local-dev-verification' as const, databaseName: 'webtopup_task14_dev', capabilityDigest: 'a'.repeat(64), volumeName: 'webtopup-task14-dev_mongo-data' };
  assert.doesNotThrow(() => assertDevicePolicyTarget({ mongo: 27018 }, hello, marker, hello, marker));
  assert.throws(() => assertDevicePolicyTarget({ mongo: 27018 }, { ...hello, setName: 'other' }, marker, hello, marker), /device-policy/);
  assert.throws(() => assertDevicePolicyTarget({ mongo: 27018 }, hello, { ...marker, databaseName: 'other' }, hello, marker), /device-policy/);
  assert.throws(() => assertDevicePolicyTarget({ mongo: 27018 }, hello, marker, { ...hello, hosts: ['localhost:27018'] }, marker), /changed/);
});

test('disabled profile forces rollout and cutoff off despite inherited environment', () => {
  const inherited = { SESSION_REFRESH_ENABLED: 'true', SESSION_REFRESH_MEMBER_COHORT_PERCENT: '100', SESSION_REFRESH_CS_COHORT_PERCENT: '100', SESSION_REFRESH_ADMIN_COHORT_PERCENT: '100', SESSION_REFRESH_OWNER_COHORT_PERCENT: '100', LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL: '2099-01-01T00:00:00Z' };
  const env = buildHostChildEnv({ inherited, shared: inherited, secrets: inherited, profile: 'disabled' });
  assert.deepEqual({ enabled: env.SESSION_REFRESH_ENABLED, member: env.SESSION_REFRESH_MEMBER_COHORT_PERCENT, cs: env.SESSION_REFRESH_CS_COHORT_PERCENT, admin: env.SESSION_REFRESH_ADMIN_COHORT_PERCENT, owner: env.SESSION_REFRESH_OWNER_COHORT_PERCENT, cutoff: env.LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL }, { enabled: 'false', member: '0', cs: '0', admin: '0', owner: '0', cutoff: '' });
});

test('bounded rollout has final precedence over inherited and secret environments', () => {
  const conflict = { SESSION_REFRESH_ENABLED: 'false', SESSION_REFRESH_CS_COHORT_PERCENT: '0', SESSION_REFRESH_MEMBER_COHORT_PERCENT: '100' };
  const env = buildHostChildEnv({ inherited: conflict, shared: conflict, secrets: conflict, profile: 'session-cs' });
  assert.deepEqual(Object.fromEntries(Object.keys(sessionTestRolloutEnv()).map((key) => [key, env[key]])), sessionTestRolloutEnv());
});

test('owned host logs are truncated at every profile boundary', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', 'processes.ts'), 'utf8');
  assert.match(source, /fs\.open\(logPath, 'w', 0o600\)/);
  assert.doesNotMatch(source, /fs\.open\(logPath, 'a'/);
});

test('host process commands use stable direct executables instead of package wrappers', () => {
  const commands = hostProcessCommands('/repo', { mongo: 27018, node: 19005, rust: 19010, vite: 19006, https: 9443 });
  assert.equal(commands.rust.command, '/repo/rust-api/target/debug/webtopup-rust-api');
  assert.deepEqual(commands.node, { command: process.execPath, args: ['/repo/server/dist/index.js'], cwd: '/repo/server' });
  assert.deepEqual(commands.vite, { command: process.execPath, args: ['/repo/client/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '19006'], cwd: '/repo/client' });
});

test('fault profile reserves and preflights all four host ports', () => {
  assert.equal(faultProxyPort({ rust: 19010 }), 19011);
  assert.deepEqual(faultProfilePorts({ node: 19005, rust: 19010, vite: 19006 }), [19005, 19010, 19006, 19011]);
  assert.throws(() => faultProxyPort({ rust: 65535 }), /port/);
});

test('bootstrap rejects any listener on verification host process ports', () => {
  assert.doesNotThrow(() => assertVerificationHostPortsFree({ node: 19005, rust: 19010, vite: 19006 }, new Set()));
  assert.throws(() => assertVerificationHostPortsFree({ node: 19005, rust: 19010, vite: 19006 }, new Set([19010])), /port 19010/);
});

test('process shutdown proof rejects any surviving owned PID', () => {
  assert.doesNotThrow(() => assertProcessesExited([42, 43], new Set()));
  assert.throws(() => assertProcessesExited([42, 43], new Set([43])), /PID 43/);
});

test('process identity requires exact ordered argv rather than substrings', () => {
  assert.equal(processIdentityMatches({ ...owned, command: ['/usr/bin/node', 'server.js', '--port', '19005'] }, { ...observed, executable: '/usr/bin/node', command: ['/usr/bin/node', 'server.js', '--port', '19005'] }), true);
  assert.equal(processIdentityMatches({ ...owned, command: ['/usr/bin/node', 'server.js', '--port', '19005'] }, { ...observed, executable: '/usr/bin/node', command: ['/usr/bin/node', 'server.js', '19005', '--port'] }), false);
  assert.equal(processIdentityMatches({ ...owned, command: ['/usr/bin/node', 'server.js'] }, { ...observed, executable: '/usr/bin/node', command: ['/usr/bin/node-helper', 'server.js'] }), false);
});

test('process identity requires every ownership field', () => {
  assert.equal(processIdentityMatches(owned, observed), true);
  assert.equal(processIdentityMatches(owned, { ...observed, startTime: '101' }), false);
  assert.equal(processIdentityMatches(owned, { ...observed, cwd: '/other' }), false);
  assert.equal(processIdentityMatches(owned, { ...observed, executable: '/usr/bin/bash' }), false);
  assert.equal(processIdentityMatches(owned, { ...observed, command: ['npm', 'run', 'other'] }), false);
});
