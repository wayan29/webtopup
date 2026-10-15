const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'server/package.json'))('pg');
const bcrypt = createRequire(path.join(root, 'server/package.json'))('bcrypt');
const dbUrl = new URL(process.env.DATABASE_URL || '');
const database = dbUrl.pathname.slice(1);
const proxySecret = process.env.API_V2_PROXY_SECRET;
const port = 19022;
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname));
assert.ok(proxySecret && proxySecret.length >= 32);
const origin = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };
async function login(route, email, password) {
  const started = Date.now();
  const response = await fetch(`${origin}/v2/auth/${route}/login`, { method: 'POST', headers, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  return { status: response.status, body, elapsed: Date.now() - started };
}
async function expectInvalid(result, label) {
  assert.equal(result.status, 400, `${label}: status=${result.status} code=${result.body.error?.code || 'none'}`);
  assert.equal(result.body.error?.code, 'AUTH_INVALID_CREDENTIALS');
  assert.equal(result.body.error?.message, 'Login gagal. Periksa email dan password Anda.');
  assert.ok(result.elapsed >= 1400, `${label} timing floor: ${result.elapsed}ms`);
}
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const suffix = crypto.randomUUID();
  const ownerEmail = `login-owner-${suffix}@example.test`;
  const ownerPassword = `LoginOwner-${crypto.randomBytes(20).toString('hex')}!`;
  const memberEmail = `login-member-${suffix}@example.test`;
  const memberPassword = `LoginMember-${crypto.randomBytes(20).toString('hex')}!`;
  const disabledEmail = `login-disabled-${suffix}@example.test`;
  const disabledPassword = `LoginDisabled-${crypto.randomBytes(20).toString('hex')}!`;
  let server;
  await db.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    const setting = await db.query("SELECT value FROM site_settings WHERE key='botProtectionEnabled'");
    assert.notEqual(setting.rows[0]?.value, true, 'Turnstile must remain disabled in this boundary fixture');
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
    const bootstrap = spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PGHOST: dbUrl.hostname, PGPORT: dbUrl.port || '5432', PGDATABASE: database, PGUSER: decodeURIComponent(dbUrl.username), PGPASSWORD: decodeURIComponent(dbUrl.password), BOOTSTRAP_DATABASE: database, OWNER_EMAIL: ownerEmail, OWNER_PASSWORD: ownerPassword, OWNER_NAME: 'SQL Login Boundary Owner' },
    });
    assert.equal(bootstrap.status, 0, 'owner bootstrap failed');
    server = spawn(path.join(root, 'rust-api/target/debug/webtopup-rust-api'), [], { cwd: root, stdio: 'ignore', env: { ...process.env, SQL_DATABASE: database, MONGO_URI: '', API_V2_HOST: '127.0.0.1', API_V2_PORT: String(port), RUST_LOG: 'warn' } });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null || server.signalCode !== null) break;
      try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Rust candidate must become healthy');
    const disabledHash = await bcrypt.hash(disabledPassword, 12);
    await db.query(`INSERT INTO users(email,password_hash,name,role,active,role_updated_at,policy_updated_at) VALUES($1,$2,'Disabled Login Smoke','member',false,now(),now())`, [disabledEmail, disabledHash]);
    const validOwner = await login('staff', ownerEmail, ownerPassword);
    assert.equal(validOwner.status, 200);
    assert.equal(validOwner.body.user.role, 'owner');
    const [ownerAsMember, unknownEmail, wrongPassword, disabledAccount] = await Promise.all([
      login('member', ownerEmail, ownerPassword),
      login('member', `unknown-${suffix}@example.test`, memberPassword),
      login('member', memberEmail, `Wrong-${crypto.randomUUID()}!`),
      login('member', disabledEmail, disabledPassword),
    ]);
    expectInvalid(ownerAsMember, 'owner on member audience');
    expectInvalid(unknownEmail, 'unknown email');
    expectInvalid(wrongPassword, 'wrong password');
    expectInvalid(disabledAccount, 'disabled account');
    assert.deepEqual(
      [unknownEmail, wrongPassword, disabledAccount].map(({ status, body }) => ({ status, body })),
      Array(3).fill({ status: unknownEmail.status, body: unknownEmail.body }),
    );
    const failedAudits = await db.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE action='login_failed' AND outcome='failed' AND payload->>'audience'='member'",
    );
    assert.ok(failedAudits.rows[0].count >= 4);
    console.log(JSON.stringify({ database, staffLogin: 'passed', memberRegisterOrFixture: 'direct SQL disabled fixture', audienceBoundary: 'passed', unknownBadDisabledEquivalent: 'passed', loginTimingFloor: 'passed', failedLoginAudits: failedAudits.rows[0].count }));
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited; }
    }
    try {
      const emails = [ownerEmail, memberEmail, disabledEmail];
      const ids = (await db.query('SELECT id FROM users WHERE normalized_email=ANY($1::text[])', [emails])).rows.map(row => row.id);
      if (ids.length) {
        for (const table of ['auth_security_changes', 'auth_factor_challenges', 'auth_device_challenges', 'auth_global_revocations', 'auth_sessions']) await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`, [ids]);
        await db.query('DELETE FROM audit_events WHERE actor=ANY($1::text[])', [ids.map(String)]);
        await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
      }
    } finally { await db.end(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
