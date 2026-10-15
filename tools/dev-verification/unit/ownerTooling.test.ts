import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

function bootstrap(overrides: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
    env: {
      ...process.env,
      PGHOST: '127.0.0.1', PGPORT: '1',
      PGDATABASE: '', BOOTSTRAP_DATABASE: '',
      OWNER_EMAIL: '', OWNER_PASSWORD: '', OWNER_NAME: '',
      ...overrides,
    },
    encoding: 'utf8', timeout: 10000,
  });
}

test('owner bootstrap rejects missing, live, and unconfirmed targets before connecting', () => {
  for (const target of [
    {},
    { PGDATABASE: 'webtopup_pg_dev', BOOTSTRAP_DATABASE: 'webtopup_pg_dev' },
    { PGDATABASE: 'webtopup_ci_owner', BOOTSTRAP_DATABASE: 'webtopup_ci_other' },
  ]) {
    const result = bootstrap(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bootstrap target rejected/);
    assert.equal(result.stdout, '');
  }
});

test('owner bootstrap validates explicit credentials without leaking them', () => {
  const password = 'test-only-password-do-not-log';
  for (const credentials of [
    { OWNER_PASSWORD: password },
    { OWNER_EMAIL: 'invalid', OWNER_PASSWORD: password },
    { OWNER_EMAIL: 'owner@example.test', OWNER_PASSWORD: 'short' },
    { OWNER_EMAIL: 'owner@example.test', OWNER_PASSWORD: 'é'.repeat(37) },
    { OWNER_EMAIL: 'owner@example.test', OWNER_PASSWORD: password, OWNER_NAME: '   ' },
  ]) {
    const result = bootstrap({
      PGDATABASE: 'webtopup_ci_owner', BOOTSTRAP_DATABASE: 'webtopup_ci_owner',
      ...credentials,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OWNER_EMAIL, OWNER_NAME/);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(password));
  }
});
