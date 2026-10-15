const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'server/package.json'))('pg');
const url = new URL(process.env.DATABASE_URL || '');
const database = url.pathname.slice(1);
const proxySecret = process.env.API_V2_PROXY_SECRET;
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.ok(proxySecret && proxySecret.length >= 32);
const port = 19021;
const origin = `http://127.0.0.1:${port}`;
const baseHeaders = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };

function trusted(actor, stepUp = false) {
  return { ...baseHeaders, authorization: `Bearer ${actor.accessToken}`,
    'x-webtopup-user-id': actor.user.id, 'x-webtopup-user-role': actor.user.role,
    'x-webtopup-user-email': actor.user.email, 'x-webtopup-session-id': actor.session.sessionId,
    ...(stepUp ? { 'x-webtopup-step-up-group': 'team.manage_privileged' } : {}) };
}
async function request(route, method = 'GET', body, actor, stepUp = false) {
  return fetch(`${origin}${route}`, { method, headers: actor ? trusted(actor, stepUp) : baseHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
}
async function expectJson(response, status, label) {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: status=${response.status} code=${body.error?.code || 'none'}`);
  return body;
}
async function login(email, password) {
  return expectJson(await request('/v2/auth/staff/login', 'POST', { email, password }), 200, 'staff login');
}
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
async function cleanup(db, emails) {
  const ids = (await db.query('SELECT id FROM users WHERE normalized_email=ANY($1::text[])', [emails])).rows.map(row => row.id);
  if (!ids.length) return;
  for (const table of ['auth_security_changes', 'auth_factor_challenges', 'auth_device_challenges', 'auth_global_revocations', 'auth_sessions']) {
    await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`, [ids]);
  }
  await db.query('DELETE FROM audit_events WHERE actor=ANY($1::text[])', [ids.map(String)]);
  await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
}
async function main() {
  const suffix = crypto.randomUUID();
  const emails = Object.fromEntries(['owner', 'admin', 'cs', 'disabled', 'member', 'denied', 'spoofed', 'inactive-denied', 'forbidden']
    .map(role => [role, `team-${role}-${suffix}@example.test`]));
  const passwords = Object.fromEntries(['owner', 'admin', 'cs', 'disabled', 'member'].map(role => [role, `Team-${crypto.randomBytes(20).toString('hex')}!`]));
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  let server;
  await db.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    await assertPortFree();
    const ownerBootstrap = spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: database,
        PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), BOOTSTRAP_DATABASE: database,
        OWNER_EMAIL: emails.owner, OWNER_PASSWORD: passwords.owner, OWNER_NAME: 'SQL Team Smoke Owner' },
    });
    assert.equal(ownerBootstrap.status, 0, 'owner bootstrap must succeed');
    assert.ok(!`${ownerBootstrap.stdout}${ownerBootstrap.stderr}`.includes(passwords.owner));
    server = spawn(path.join(root, 'rust-api/target/debug/webtopup-rust-api'), [], {
      cwd: root, stdio: 'ignore', env: { ...process.env, SQL_DATABASE: database, MONGO_URI: '', API_V2_HOST: '127.0.0.1', API_V2_PORT: String(port), RUST_LOG: 'warn' },
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null || server.signalCode !== null) break;
      try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Rust candidate must become ready');
    let owner = await login(emails.owner, passwords.owner);
    await db.query("UPDATE auth_sessions SET idle_expires_at=now()-interval '1 second' WHERE id=$1", [owner.session.sessionId]);
    const locked = await expectJson(await request('/v2/auth/me', 'GET', undefined, owner), 401, 'idle locked read');
    assert.equal(locked.error.code, 'AUTH_IDLE_LOCKED');
    const unlocked = await expectJson(await request('/v2/auth/unlock', 'POST', {
      refreshToken: owner.refreshToken, recoveryToken: owner.recoveryToken, password: passwords.owner,
    }, undefined), 200, 'unlock');
    assert.ok(unlocked.accessToken !== owner.accessToken);
    owner = unlocked;
    await expectJson(await request('/v2/auth/me', 'GET', undefined, owner), 200, 'unlocked read');
    await expectJson(await request('/v2/auth/activity', 'POST', {}, owner), 200, 'activity');
    assert.ok((await db.query('SELECT idle_expires_at FROM auth_sessions WHERE id=$1', [owner.session.sessionId])).rows[0].idle_expires_at > new Date());

    const member = await expectJson(await request('/v2/auth/register', 'POST', {
      name: 'Spoof Header Member', email: emails.member, password: passwords.member,
    }), 200, 'member register');
    const spoofedHeaders = { ...trusted(owner, true), authorization: `Bearer ${member.accessToken}`, 'x-webtopup-user-permissions': 'manageTeam' };
    assert.equal((await fetch(`${origin}/v2/teams/admin/list`, { headers: spoofedHeaders })).status, 403);
    assert.equal((await fetch(`${origin}/v2/teams`, { method: 'POST', headers: spoofedHeaders,
      body: JSON.stringify({ name: 'Spoofed Admin', email: emails.spoofed, password: passwords.admin, role: 'admin' }) })).status, 403);

    const adminCreated = await expectJson(await request('/v2/teams', 'POST', {
      name: 'Team Admin', email: emails.admin, password: passwords.admin, role: 'admin', permissions: { manageTeam: true },
    }, owner, true), 201, 'owner creates admin');
    const adminId = adminCreated.user._id;
    assert.match(adminId, /^[0-9a-f-]{36}$/u);
    const admin = await login(emails.admin, passwords.admin);
    const csCreated = await expectJson(await request('/v2/teams', 'POST', {
      name: 'Team CS', email: emails.cs, password: passwords.cs, role: 'cs', permissions: { viewDashboard: true },
    }, admin, true), 201, 'admin creates CS');
    const csId = csCreated.user._id;
    assert.equal((await request('/v2/teams', 'POST', { name: 'Forbidden Admin', email: emails.forbidden, password: passwords.admin, role: 'admin' }, admin, true)).status, 403);
    const cs = await login(emails.cs, passwords.cs);
    assert.equal((await request('/v2/teams/admin/list', 'GET', undefined, cs)).status, 403);
    const list = await expectJson(await request('/v2/teams/admin/list', 'GET', undefined, owner), 200, 'owner list');
    assert.ok(list.members.some(row => row._id === adminId));
    assert.ok(list.members.some(row => row._id === csId));
    await expectJson(await request(`/v2/teams/${csId}`, 'PUT', { role: 'admin', permissions: { manageTeam: true } }, owner, true), 200, 'role change');
    assert.equal((await request('/v2/auth/me', 'GET', undefined, cs)).status, 401);
    const changedAdmin = await login(emails.cs, passwords.cs);
    await expectJson(await request(`/v2/teams/${csId}`, 'PUT', { permissions: { viewDashboard: true } }, owner, true), 200, 'permission change');
    assert.equal((await request('/v2/auth/me', 'GET', undefined, changedAdmin)).status, 401);
    const reducedAdmin = await login(emails.cs, passwords.cs);
    assert.equal((await request('/v2/teams/admin/list', 'GET', undefined, reducedAdmin)).status, 200);
    assert.equal((await request('/v2/teams', 'POST', { name: 'Denied CS', email: emails.denied, password: passwords.cs, role: 'cs' }, reducedAdmin)).status, 403);
    const disabledCreated = await expectJson(await request('/v2/teams', 'POST', {
      name: 'Disable CS', email: emails.disabled, password: passwords.disabled, role: 'cs',
    }, owner, true), 201, 'create deactivation target');
    const target = await login(emails.disabled, passwords.disabled);
    await expectJson(await request(`/v2/teams/${disabledCreated.user._id}/toggle`, 'PUT', {}, owner, true), 200, 'deactivate');
    const deniedRead = await expectJson(await request('/v2/auth/me', 'GET', undefined, target), 401, 'inactive read');
    assert.equal(deniedRead.error.code, 'AUTH_ACCOUNT_DISABLED');
    assert.equal((await request('/v2/teams', 'POST', { name: 'Denied Inactive CS', email: emails['inactive-denied'], password: passwords.cs, role: 'cs' }, target, true)).status, 401);
    const forbiddenRows = await db.query('SELECT count(*)::int AS count FROM users WHERE normalized_email=ANY($1::text[])', [[emails.denied, emails.spoofed, emails['inactive-denied'], emails.forbidden]]);
    assert.equal(forbiddenRows.rows[0].count, 0);
    console.log(JSON.stringify({ database, ownerAdminCsMatrix: 'passed', spoofedIdentityAndPermissionsRejected: 'passed', idleLockUnlockAndActivityRefresh: 'passed', nonOwnerPromotionDenial: 'passed', roleChangeEpochRevocation: 'passed', permissionChangeImmediate: 'passed', inactiveAccountRevocation: 'passed' }));
  } finally {
    await stopServer(server);
    try { await cleanup(db, Object.values(emails)); } finally { await db.end(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
