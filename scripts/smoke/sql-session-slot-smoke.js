const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { Client } = serverRequire('pg');

const databaseUrl = process.env.DATABASE_URL;
const rustOriginValue = process.env.SQL_SESSION_SMOKE_RUST_ORIGIN;
const proxySecret = process.env.SQL_SESSION_SMOKE_PROXY_SECRET;
assert.ok(databaseUrl, 'DATABASE_URL is required');
assert.ok(rustOriginValue, 'SQL_SESSION_SMOKE_RUST_ORIGIN is required');
assert.ok(proxySecret && proxySecret.length >= 32, 'SQL_SESSION_SMOKE_PROXY_SECRET is required');
const databaseUrlParsed = new URL(databaseUrl);
const database = databaseUrlParsed.pathname.slice(1);
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u, 'refusing non-disposable database');
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(databaseUrlParsed.hostname), 'database host must be local');
const rustOrigin = new URL(rustOriginValue);
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(rustOrigin.hostname), 'Rust API origin must be local');
const headers = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };

async function post(pathname, body) {
  return fetch(`${rustOrigin.origin}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function get(pathname, accessToken) {
  return fetch(`${rustOrigin.origin}${pathname}`, {
    headers: { ...headers, authorization: `Bearer ${accessToken}` },
  });
}

async function bodyOf(response) {
  const body = await response.json();
  assert.equal(response.ok, true, `request failed status=${response.status} code=${body.error?.code ?? 'none'}`);
  return body;
}

function createOwner(email, password) {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../create-owner.js')], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PGHOST: databaseUrlParsed.hostname,
      PGPORT: databaseUrlParsed.port || '5432',
      PGDATABASE: database,
      PGUSER: decodeURIComponent(databaseUrlParsed.username),
      PGPASSWORD: decodeURIComponent(databaseUrlParsed.password),
      BOOTSTRAP_DATABASE: database,
      OWNER_EMAIL: email,
      OWNER_PASSWORD: password,
      OWNER_NAME: 'SQL Slot Smoke Owner',
    },
  });
  assert.equal(result.status, 0, `owner bootstrap: ${result.stderr}`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
}

async function cleanup(db, emails) {
  const rows = await db.query('SELECT id FROM users WHERE normalized_email = ANY($1::text[])', [emails]);
  const ids = rows.rows.map((row) => row.id);
  if (!ids.length) return;
  await db.query('DELETE FROM auth_device_challenges WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_factor_challenges WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_global_revocations WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_security_changes WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM audit_events WHERE actor = ANY($1::text[])', [ids.map(String)]);
  await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
}

async function main() {
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const suffix = crypto.randomUUID();
  const memberEmail = `slot-member-${suffix}@example.test`;
  const memberPassword = `SlotMember-${crypto.randomBytes(20).toString('hex')}!`;
  const ownerEmail = `slot-owner-${suffix}@example.test`;
  const ownerPassword = `SlotOwner-${crypto.randomBytes(20).toString('hex')}!`;
  const otherEmail = `slot-other-${suffix}@example.test`;
  const otherPassword = `SlotOther-${crypto.randomBytes(20).toString('hex')}!`;
  const emails = [memberEmail, ownerEmail, otherEmail];
  let connected = false;

  try {
    await db.connect();
    connected = true;
    assert.equal((await db.query('SELECT current_database() AS database')).rows[0].database, database);
    const botProtection = await db.query("SELECT value FROM site_settings WHERE key='botProtectionEnabled'");
    assert.notEqual(botProtection.rows[0]?.value, true, 'Turnstile must remain disabled in this disposable slot fixture');

    const memberRegistration = await bodyOf(await post('/v2/auth/register', {
      name: 'Slot Smoke Member', email: memberEmail, password: memberPassword,
    }));
    const noProxy = await fetch(`${rustOrigin.origin}/v2/auth/me`, {
      headers: { authorization: `Bearer ${memberRegistration.accessToken}` },
    });
    assert.equal(noProxy.status, 401, 'valid bearer alone must not bypass the proxy boundary');
    const trustedProfile = await get('/v2/auth/me', memberRegistration.accessToken);
    assert.equal(trustedProfile.status, 200, 'trusted proxy secret admits the SQL session');
    const firstSession = memberRegistration.session.sessionId;
    assert.match(firstSession, /^[0-9a-f-]{36}$/iu);
    const memberSessions = [memberRegistration];
    for (let index = 0; index < 3; index += 1) {
      memberSessions.push(await bodyOf(await post('/v2/auth/member/login', { email: memberEmail, password: memberPassword })));
    }
    const concurrent = await Promise.all([
      post('/v2/auth/member/login', { email: memberEmail, password: memberPassword }),
      post('/v2/auth/member/login', { email: memberEmail, password: memberPassword }),
    ]);
    const concurrentResults = await Promise.all(concurrent.map(async (response) => ({ status: response.status, body: await response.json() })));
    assert.ok(concurrentResults.every((result) => result.status === 200));
    const issued = concurrentResults.filter((result) => typeof result.body.accessToken === 'string');
    const challenged = concurrentResults.filter((result) => result.body.requiresDeviceSelection === true);
    assert.equal(issued.length, 1, 'one concurrent login owns the fifth member slot');
    assert.equal(challenged.length, 1, 'the concurrent overflow receives device selection');
    const challengeToken = challenged[0].body.challengeToken;
    assert.equal(typeof challengeToken, 'string');

    const memberRow = await db.query('SELECT id FROM users WHERE normalized_email=$1', [memberEmail]);
    const memberId = memberRow.rows[0].id;
    const foreignRegistration = await bodyOf(await post('/v2/auth/register', {
      name: 'Other Slot Member', email: otherEmail, password: otherPassword,
    }));
    const foreignSession = foreignRegistration.session.sessionId;

    const foreignSelection = await post('/v2/auth/device-selection', {
      challengeToken,
      revokeSessionId: foreignSession,
    });
    assert.equal(foreignSelection.status, 401, `cross-user challenge status=${foreignSelection.status}`);

    const selectedTarget = memberSessions[0].session.sessionId;
    const selection = await bodyOf(await post('/v2/auth/device-selection', {
      challengeToken,
      revokeSessionId: selectedTarget,
    }));
    assert.equal(typeof selection.accessToken, 'string');
    const replay = await bodyOf(await post('/v2/auth/device-selection', {
      challengeToken,
      revokeSessionId: selectedTarget,
    }));
    assert.deepEqual(replay, selection);
    const conflictingReplay = await post('/v2/auth/device-selection', {
      challengeToken,
      revokeSessionId: memberSessions[1].session.sessionId,
    });
    assert.equal(conflictingReplay.status, 409);

    const owned = await db.query(
      "SELECT slot, state, owns_slot FROM auth_sessions WHERE user_id=$1 ORDER BY slot,id",
      [memberId],
    );
    assert.equal(owned.rows.filter((row) => row.owns_slot && ['active', 'locked'].includes(row.state)).length, 5);
    assert.equal(owned.rows.filter((row) => row.state === 'revoked' && !row.owns_slot).length, 1);
    const revokedSession = memberSessions[1];
    await db.query(
      "UPDATE auth_sessions SET state='revoked', owns_slot=false WHERE id=$1 AND user_id=$2",
      [revokedSession.session.sessionId, memberId],
    );
    const revokedRead = await get('/v2/auth/me', revokedSession.accessToken);
    const revokedBody = await revokedRead.json();
    assert.equal(revokedRead.status, 401, `revoked access status=${revokedRead.status}`);
    assert.equal(revokedBody.error?.code, 'AUTH_SESSION_REVOKED');

    await bodyOf(await post('/v2/auth/member/login', { email: memberEmail, password: memberPassword }));
    const expiredChallenge = await bodyOf(await post('/v2/auth/member/login', { email: memberEmail, password: memberPassword }));
    assert.equal(expiredChallenge.requiresDeviceSelection, true);
    const challengeId = (await db.query(
      'SELECT id FROM auth_device_challenges WHERE user_id=$1 AND result_ciphertext IS NULL ORDER BY expires_at DESC LIMIT 1',
      [memberId],
    )).rows[0].id;
    await db.query("UPDATE auth_device_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [challengeId]);
    const expiredSelection = await post('/v2/auth/device-selection', {
      challengeToken: expiredChallenge.challengeToken,
      revokeSessionId: memberSessions[2].session.sessionId,
    });
    assert.equal(expiredSelection.status, 401, `expired challenge status=${expiredSelection.status}`);
    const expiredMemberSession = memberSessions[2];
    await db.query(
      "UPDATE auth_sessions SET state='active', absolute_expires_at=now()-interval '1 second' WHERE id=$1 AND user_id=$2",
      [expiredMemberSession.session.sessionId, memberId],
    );
    const expiredRead = await get('/v2/auth/me', expiredMemberSession.accessToken);
    const expiredBody = await expiredRead.json();
    assert.equal(expiredRead.status, 401);
    assert.equal(expiredBody.error?.code, 'AUTH_SESSION_EXPIRED');



    createOwner(ownerEmail, ownerPassword);
    const staffSessions = [];
    for (let index = 0; index < 2; index += 1) {
      staffSessions.push(await bodyOf(await post('/v2/auth/staff/login', { email: ownerEmail, password: ownerPassword })));
    }
    const staffOverflow = await bodyOf(await post('/v2/auth/staff/login', { email: ownerEmail, password: ownerPassword }));
    assert.equal(staffOverflow.requiresDeviceSelection, true);
    assert.equal(staffSessions.length, 2);
    const ownerId = (await db.query('SELECT id FROM users WHERE normalized_email=$1', [ownerEmail])).rows[0].id;
    const idleSession = staffSessions[0];
    await db.query(
      "UPDATE auth_sessions SET state='active', idle_expires_at=now()-interval '1 second' WHERE id=$1",
      [idleSession.session.sessionId],
    );
    const lockedRead = await get('/v2/auth/me', idleSession.accessToken);
    const lockedBody = await lockedRead.json();
    assert.equal(lockedRead.status, 401, `idle lock status=${lockedRead.status} code=${lockedBody.error?.code ?? 'none'}`);
    assert.equal(lockedBody.error?.code, 'AUTH_IDLE_LOCKED');

    const staffOwned = await db.query(
      "SELECT count(*)::int AS count FROM auth_sessions WHERE user_id=$1 AND owns_slot AND state IN ('active','locked')",
      [ownerId],
    );
    assert.equal(staffOwned.rows[0].count, 2);

    console.log(JSON.stringify({
      database,
      memberSlots: '5 including concurrent issuance',
      overflowChallenge: 'passed',
      crossUserChallenge: 'rejected',
      replacementReplayAndConflict: 'passed',
      staffSlots: '2',
      sessionStateErrors: 'revoked/expired/idle-locked distinct',
    }));
  } finally {
    if (connected) {
      try {
        await cleanup(db, emails);
      } finally {
        await db.end();
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
