import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { assertExactVolumeRemovalTarget, assertStackOwnershipInspection, composeArgs, resolveComposeCommand, validateComposePortBindings } from '../docker.ts';

test('prefers Docker Compose v2 and falls back to legacy Compose', async () => {
  assert.deepEqual(await resolveComposeCommand(async (command, args) => command === 'docker' && args[0] === 'compose'), ['docker', 'compose']);
  assert.deepEqual(await resolveComposeCommand(async (command) => command === 'docker-compose'), ['docker-compose']);
  await assert.rejects(() => resolveComposeCommand(async () => false), /Docker Compose v2 plugin or docker-compose is required/);
});

test('pins project name and compose file', () => {
  const root = path.resolve('/tmp/project');
  assert.deepEqual(composeArgs(root, ['up', '-d']), [
    '--project-name', 'webtopup-task14-dev',
    '--file', path.join(root, 'compose.dev-verification.yml'),
    'up', '-d',
  ]);
});

test('accepts loopback-only published ports and rejects public bindings', () => {
  assert.doesNotThrow(() => validateComposePortBindings(['127.0.0.1:27018:27017', '127.0.0.1:9443:443']));
  assert.throws(() => validateComposePortBindings(['0.0.0.0:9443:443']), /loopback/);
  assert.throws(() => validateComposePortBindings(['9443:443']), /loopback/);
});

test('Vite explicitly allowlists only the local verification hostname', () => {
  const vite = fs.readFileSync(path.resolve(import.meta.dirname, '../../../client/vite.config.ts'), 'utf8');
  assert.match(vite, /allowedHosts:\s*\['webtopup\.local\.test'\]/u);
  assert.doesNotMatch(vite, /allowedHosts:\s*true/u);
});

test('HTTPS edge uses host networking to reach loopback-only host services', () => {
  const compose = fs.readFileSync(path.resolve(import.meta.dirname, '../../../compose.dev-verification.yml'), 'utf8');
  const caddy = fs.readFileSync(path.resolve(import.meta.dirname, '../../../infra/dev-verification/Caddyfile'), 'utf8');
  const caddySection = compose.slice(compose.indexOf('  caddy:'));
  assert.match(caddySection, /network_mode: host/u);
  assert.doesNotMatch(caddySection, /extra_hosts:/u);
  assert.doesNotMatch(caddySection, /ports:/u);
  assert.match(caddy, /https:\/\/webtopup\.local\.test:9443/u);
  assert.match(caddy, /127\.0\.0\.1:\{\$DEV_VERIFY_NODE_PORT\}/u);
  assert.match(caddy, /127\.0\.0\.1:\{\$DEV_VERIFY_VITE_PORT\}/u);
});

test('disposable Caddy isolates its admin endpoint from production Caddy', () => {
  const caddy = fs.readFileSync(path.resolve(import.meta.dirname, '../../../infra/dev-verification/Caddyfile'), 'utf8');
  assert.match(caddy, /admin\s+127\.0\.0\.1:2020/u);
  assert.doesNotMatch(caddy, /admin\s+127\.0\.0\.1:2019/u);
});

test('volume purge accepts only the exact inspected verification volume', () => {
  assert.doesNotThrow(() => assertExactVolumeRemovalTarget('webtopup-task14-dev_mongo-data'));
  assert.throws(() => assertExactVolumeRemovalTarget('other'), /exact verification Mongo volume/);
});

test('accepts only exact Compose container and volume labels for destructive proof', () => {
  const container = {
    Id: 'a'.repeat(64),
    Config: { Labels: { 'com.docker.compose.project': 'webtopup-task14-dev', 'com.docker.compose.service': 'mongo' } },
    Mounts: [{ Type: 'volume', Name: 'webtopup-task14-dev_mongo-data', Destination: '/data/db' }],
  };
  const volume = {
    Name: 'webtopup-task14-dev_mongo-data',
    Mountpoint: '/var/lib/docker/volumes/webtopup-task14-dev_mongo-data/_data',
    Labels: { 'com.docker.compose.project': 'webtopup-task14-dev' },
  };
  assert.doesNotThrow(() => assertStackOwnershipInspection(container, volume));
  assert.throws(() => assertStackOwnershipInspection({ ...container, Config: { Labels: { ...container.Config.Labels, 'com.docker.compose.project': 'other' } } }, volume), /container ownership/);
  assert.throws(() => assertStackOwnershipInspection(container, { ...volume, Name: 'other' }), /volume ownership/);
});

test('disposable Mongo raises its file descriptor limit for replica-set startup', () => {
  const compose = fs.readFileSync(path.resolve(import.meta.dirname, '../../../compose.dev-verification.yml'), 'utf8');
  const mongoSection = compose.slice(compose.indexOf('  mongo:'), compose.indexOf('  mongo-init:'));
  assert.match(mongoSection, /ulimits:\s*\n\s+nofile:\s*\n\s+soft:\s+65536\s*\n\s+hard:\s+65536/u);
});

test('Mongo uses host networking so its advertised loopback endpoint is reachable by host binaries', () => {
  const compose = fs.readFileSync(path.resolve(import.meta.dirname, '../../../compose.dev-verification.yml'), 'utf8');
  assert.match(compose, /network_mode: host/u);
  assert.match(compose, /"--port", "27018", "--bind_ip", "127\.0\.0\.1"/u);
  assert.match(compose, /host:"127\.0\.0\.1:27018"/u);
  assert.match(compose, /directConnection=true/u);
  assert.doesNotMatch(compose, /host:"mongo:27017"/u);
  assert.doesNotMatch(compose, /127\.0\.0\.1:\$\{DEV_VERIFY_MONGO_PORT/u);
});
