import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = require('pg');
const bcrypt = require('bcrypt');

function command(script, env, args = [], cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd, env: { ...process.env, OWNER_EMAIL: '', OWNER_PASSWORD: '', OWNER_NAME: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (status) => { clearTimeout(deadline); resolve({ status, stdout, stderr }); });
  });
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
}

// Explicit opt-in: point PG* at a local disposable database using a role with CREATEDB.
// Each case creates its own database; this file never connects to a live application's database.
test('candidate tooling against isolated PostgreSQL databases', { timeout: 180000 }, async (t) => {
  const base = process.env.PGDATABASE;
  assert.ok(base && /^webtopup_ci_[a-z0-9_]+$/.test(base), 'PGDATABASE must be a disposable webtopup_ci_* database');
  assert.equal(process.env.TOOLING_TEST_DATABASE, base, 'TOOLING_TEST_DATABASE must explicitly confirm PGDATABASE');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST), 'PGHOST must be explicitly loopback');
  const admin = new Client({ database: base, connectionTimeoutMillis: 2000, query_timeout: 10000 });
  await admin.connect();
  const directory = await mkdtemp(path.join(tmpdir(), 'webtopup-tooling-'));
  async function isolated(run) {
    const database = `webtopup_ci_tooling_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const client = new Client({ database, connectionTimeoutMillis: 2000, query_timeout: 10000 });
    try {
      await client.connect();
      await run(client, {
        PGDATABASE: database, MIGRATION_DATABASE: database, BOOTSTRAP_DATABASE: database,
      });
    } finally {
      await client.end();
      await admin.query(`DROP DATABASE "${database}"`);
    }
  }
  async function fixture(name, files) {
    const location = path.join(directory, name);
    await mkdir(location);
    for (const [filename, sql] of Object.entries(files)) await writeFile(path.join(location, filename), sql);
    return location;
  }
  const migrate = (env, location, cwd = root) => command('tools/postgres-migration/migrate.mjs', env,
    location ? ['--directory', location] : [], cwd);
  const password = `test-only-${randomUUID()}`;
  const owner = (env, email = 'owner@example.test') => command('scripts/create-owner.js', {
    ...env, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_NAME: 'Test Owner',
  });
  try {
    await t.test('migration target refusal leaves a real database untouched', () => isolated(async (client, env) => {
      for (const rejected of [
        { ...env, MIGRATION_DATABASE: '' },
        { ...env, MIGRATION_DATABASE: 'webtopup_ci_other' },
        { ...env, PGDATABASE: 'webtopup_pg_dev', MIGRATION_DATABASE: 'webtopup_pg_dev' },
      ]) {
        const result = await migrate(rejected);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Migration target rejected/);
      }
      assert.equal((await client.query("SELECT to_regclass('schema_migrations') AS table_name")).rows[0].table_name, null);
    }));

    await t.test('default migrations work outside the repository working directory', () => isolated(async (client, env) => {
      success(await migrate(env, undefined, directory));
      const result = await client.query('SELECT count(*)::int AS count FROM schema_migrations');
      assert.ok(result.rows[0].count > 0);
      const missingColumns = await client.query(`
        WITH required(table_name, column_name) AS (VALUES
          ('users', 'last_otp_counter'),
          ('users', 'two_factor_enrollment_completed_at'),
          ('users', 'two_factor_pending_secret'),
          ('users', 'two_factor_pending_expires_at'),
          ('users', 'phone'), ('users', 'address'), ('users', 'avatar_url'),
          ('users', 'level'), ('users', 'preferences'),
          ('auth_sessions', 'role'), ('auth_sessions', 'slot'),
          ('auth_sessions', 'owns_slot'), ('auth_sessions', 'device_id'),
          ('auth_sessions', 'user_agent'), ('auth_sessions', 'ip_address'),
          ('auth_sessions', 'remember_me'), ('auth_sessions', 'absolute_expires_at'),
          ('auth_sessions', 'idle_expires_at'), ('auth_sessions', 'locked_at'),
          ('auth_sessions', 'cleanup_at'), ('auth_sessions', 'recovery_digest'),
          ('auth_sessions', 'rotation_key_id'), ('auth_sessions', 'predecessor'),
          ('auth_sessions', 'consumed_digests'), ('auth_sessions', 'unlock_password_attempts'),
          ('auth_sessions', 'unlock_otp_attempts'), ('auth_sessions', 'step_up_attempts')
        )
        SELECT required.table_name || '.' || required.column_name AS name
        FROM required
        LEFT JOIN information_schema.columns actual
          ON actual.table_schema='public'
          AND actual.table_name=required.table_name
          AND actual.column_name=required.column_name
        WHERE actual.column_name IS NULL
        ORDER BY name
      `);
      assert.deepEqual(missingColumns.rows, []);
      const missingTables = await client.query(`
        SELECT name FROM unnest(ARRAY[
          'auth_device_challenges', 'auth_factor_challenges',
          'auth_security_changes', 'auth_global_revocations'
        ]) AS required(name)
        WHERE to_regclass('public.' || name) IS NULL
        ORDER BY name
      `);
      assert.deepEqual(missingTables.rows, []);
      success(await migrate(env, undefined, directory));
      assert.deepEqual((await client.query('SELECT count(*)::int AS count FROM schema_migrations')).rows, result.rows);
    }));

    await t.test('checksum drift is rejected before applying any pending migration', () => isolated(async (client, env) => {
      const original = 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);';
      const location = await fixture('checksum', { '0001.sql': original });
      success(await migrate(env, location));
      const record = (await client.query('SELECT checksum, applied_at FROM schema_migrations')).rows[0];
      assert.equal(record.checksum, Buffer.from(original).toString('base64url'));
      success(await migrate(env, location));
      assert.deepEqual((await client.query('SELECT checksum, applied_at FROM schema_migrations')).rows[0], record);
      await writeFile(path.join(location, '0000.sql'), 'CREATE TABLE must_not_apply (id INTEGER);');
      await writeFile(path.join(location, '0001.sql'), `${original}\n-- changed`);
      const changed = await migrate(env, location);
      assert.equal(changed.status, 1);
      assert.match(changed.stderr, /Migration changed after apply: 0001.sql/);
      assert.equal((await client.query("SELECT to_regclass('must_not_apply') AS table_name")).rows[0].table_name, null);
      await rm(path.join(location, '0001.sql'));
      const missing = await migrate(env, location);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Applied migration missing from directory: 0001.sql/);
    }));

    await t.test('concurrent first runners apply DDL and effects exactly once', () => isolated(async (client, env) => {
      const location = await fixture('concurrency', {
        '0001.sql': 'SELECT pg_sleep(0.25); CREATE TABLE migration_effects (id INTEGER PRIMARY KEY); INSERT INTO migration_effects VALUES (1);',
        '0002.sql': 'INSERT INTO migration_effects VALUES (2);',
      });
      const results = await Promise.all([migrate(env, location), migrate(env, location), migrate(env, location)]);
      results.forEach(success);
      assert.deepEqual((await client.query('SELECT id FROM migration_effects ORDER BY id')).rows, [{ id: 1 }, { id: 2 }]);
      assert.equal((await client.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 2);
    }));

    await t.test('failed migration rolls back DDL, data, and tracking and releases its lock', () => isolated(async (client, env) => {
      const location = await fixture('rollback', {
        '0001.sql': 'CREATE TABLE rollback_probe (id INTEGER); INSERT INTO rollback_probe VALUES (1); SELECT missing_function();',
      });
      assert.equal((await migrate(env, location)).status, 1);
      assert.equal((await client.query("SELECT to_regclass('rollback_probe') AS table_name")).rows[0].table_name, null);
      assert.equal((await client.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 0);
      await writeFile(path.join(location, '0001.sql'), 'CREATE TABLE rollback_probe (id INTEGER); INSERT INTO rollback_probe VALUES (1);');
      success(await migrate(env, location));
      assert.deepEqual((await client.query('SELECT * FROM rollback_probe')).rows, [{ id: 1 }]);
    }));

    await t.test('owner bootstrap creates the actual identity and policy without disclosing secrets', () => isolated(async (client, env) => {
      await client.query(await readFile(path.join(root, 'rust-api/migrations/0001_identity.sql'), 'utf8'));
      const result = await owner(env, '  OWNER@Example.Test  ');
      success(result);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
      assert.ok(!`${result.stdout}${result.stderr}`.includes('owner@example.test'));
      const row = (await client.query('SELECT *, extract(epoch from (two_factor_enrollment_required_at - role_updated_at)) AS enrollment_seconds FROM users')).rows[0];
      assert.match(row.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      assert.equal(row.email, 'owner@example.test');
      assert.equal(row.name, 'Test Owner');
      assert.equal(row.role, 'owner');
      assert.equal(row.active, true);
      assert.equal(row.balance, '0');
      assert.equal(row.points, '0');
      assert.equal(row.session_version, 0);
      assert.equal(row.two_factor_enabled, false);
      assert.equal(Number(row.enrollment_seconds), 7 * 86400);
      assert.deepEqual(row.role_updated_at, row.policy_updated_at);
      assert.equal(bcrypt.getRounds(row.password_hash), 12);
      assert.equal(await bcrypt.compare(password, row.password_hash), true);
      const repeated = await owner(env);
      assert.equal(repeated.status, 1);
      assert.match(repeated.stderr, /Existing account rejected/);
      assert.deepEqual((await client.query('SELECT *, extract(epoch from (two_factor_enrollment_required_at - role_updated_at)) AS enrollment_seconds FROM users')).rows[0], row);
    }));

    await t.test('existing normalized identity is never promoted, reset, or reactivated', () => isolated(async (client, env) => {
      await client.query(await readFile(path.join(root, 'rust-api/migrations/0001_identity.sql'), 'utf8'));
      await client.query(`INSERT INTO users (email, password_hash, name, role, active, balance, points,
        session_version, two_factor_enabled, role_updated_at, policy_updated_at)
        VALUES (' Owner@Example.Test ', 'existing-hash', 'Existing Member', 'member', FALSE, 123, 45, 8, TRUE, now(), now())`);
      const before = (await client.query('SELECT * FROM users')).rows;
      assert.equal((await owner(env)).status, 1);
      assert.deepEqual((await client.query('SELECT * FROM users')).rows, before);
    }));

    await t.test('concurrent owner bootstrap creates exactly one owner', () => isolated(async (client, env) => {
      await client.query(await readFile(path.join(root, 'rust-api/migrations/0001_identity.sql'), 'utf8'));
      const results = await Promise.all([owner(env), owner(env)]);
      assert.deepEqual(results.map(({ status }) => status).sort(), [0, 1]);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM users WHERE role = 'owner'")).rows[0].count, 1);
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await admin.end();
  }
});
