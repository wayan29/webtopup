const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { Client } = serverRequire('pg');

const databaseUrl = process.env.DATABASE_URL;
const proxySecret = process.env.API_V2_PROXY_SECRET;
const rustBinary = path.resolve(__dirname, '../../rust-api/target/debug/webtopup-rust-api');
const port = 19020;
assert.ok(databaseUrl, 'DATABASE_URL is required');
assert.ok(proxySecret && proxySecret.length >= 32, 'API_V2_PROXY_SECRET is required');
const dbUrl = new URL(databaseUrl);
const database = dbUrl.pathname.slice(1);
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u, 'refusing non-disposable database');
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(dbUrl.hostname), 'database host must be local');

const baseHeaders = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of value.toUpperCase().replace(/=+$/u, '')) {
    const digit = alphabet.indexOf(character);
    assert.notEqual(digit, -1, 'invalid Base32 TOTP seed');
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function totp(seed, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', seed).update(message).digest();
  const offset = digest[19] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function nextOtpCode(db, email, seed) {
  for (let attempt = 0; attempt < 65; attempt += 1) {
    const row = await db.query('SELECT last_otp_counter FROM users WHERE normalized_email=$1', [email]);
    const last = row.rows[0].last_otp_counter === null ? -1 : Number(row.rows[0].last_otp_counter);
    const current = Math.floor(Date.now() / 30_000);
    const counter = Math.max(current - 2, last + 1);
    if (counter <= current + 2) return totp(seed, counter);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('no accepted TOTP counter available');
}

async function cleanup(db, email) {
  const rows = await db.query('SELECT id FROM users WHERE normalized_email=$1', [email]);
  const ids = rows.rows.map((row) => row.id);
  if (!ids.length) return;
  await db.query('DELETE FROM auth_security_changes WHERE user_id=ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_factor_challenges WHERE user_id=ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_device_challenges WHERE user_id=ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_global_revocations WHERE user_id=ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM audit_events WHERE actor=ANY($1::text[])', [ids.map(String)]);
  await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
}

function createOwner(dbUrl, database, email, password) {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../create-owner.js')], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PGHOST: dbUrl.hostname,
      PGPORT: dbUrl.port || '5432',
      PGDATABASE: database,
      PGUSER: decodeURIComponent(dbUrl.username),
      PGPASSWORD: decodeURIComponent(dbUrl.password),
      BOOTSTRAP_DATABASE: database,
      OWNER_EMAIL: email,
      OWNER_PASSWORD: password,
      OWNER_NAME: 'SQL 2FA Smoke Owner',
    },
  });
  assert.equal(result.status, 0, `owner bootstrap: ${result.stderr}`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, 'exit');
    child.kill('SIGKILL');
    await Promise.race([killed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

async function main() {
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const suffix = crypto.randomUUID();
  const email = `sql-2fa-${suffix}@example.test`;
  const password = `Sql2fa-${crypto.randomBytes(20).toString('hex')}!`;
  let connected = false;
  const sqlAuthErrors = [];
  let server;
  try {
    await db.connect();
    connected = true;
    assert.equal((await db.query('SELECT current_database() AS database')).rows[0].database, database);
    assert.notEqual((await db.query("SELECT value FROM site_settings WHERE key='botProtectionEnabled'")).rows[0]?.value, true,
      'Turnstile must remain disabled in this disposable 2FA fixture');
    createOwner(dbUrl, database, email, password);

    const occupied = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) }).then(() => true).catch(() => false);
    assert.equal(occupied, false, `refusing occupied Rust port ${port}`);
    server = spawn(rustBinary, [], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, SQL_DATABASE: database, MONGO_URI: '', API_V2_HOST: '127.0.0.1', API_V2_PORT: String(port), RUST_LOG: 'warn' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr.setEncoding('utf8');
    server.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.includes('SQL auth operation failed')) sqlAuthErrors.push(line.slice(-1000));
      }
    });
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null || server.signalCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, 'Rust API candidate did not become healthy');

    const origin = `http://127.0.0.1:${port}`;
    const loginResponse = await fetch(`${origin}/v2/auth/staff/login`, {
      method: 'POST', headers: baseHeaders, body: JSON.stringify({ email, password }),
    });
    assert.equal(loginResponse.status, 200, `staff login status=${loginResponse.status}`);
    const login = await loginResponse.json();
    const sessionId = login.session.sessionId;
    const authHeaders = { ...baseHeaders, authorization: `Bearer ${login.accessToken}` };

    const setupResponse = await fetch(`${origin}/v2/auth/2fa/setup`, { method: 'POST', headers: authHeaders });
    assert.equal(setupResponse.status, 200, `2FA setup status=${setupResponse.status}`);
    const setup = await setupResponse.json();
    const seed = base32Decode(setup.secret);
    assert.ok(setup.otpauthUrl.startsWith('otpauth://totp/'));
    const stored = await db.query('SELECT two_factor_pending_secret FROM users WHERE normalized_email=$1', [email]);
    assert.equal(Buffer.isBuffer(stored.rows[0].two_factor_pending_secret), true);
    assert.equal(stored.rows[0].two_factor_pending_secret.includes(Buffer.from(setup.secret)), false);

    const counter = Math.floor(Date.now() / 30_000);
    const invalidCode = totp(seed, counter + 100);
    const mutationHeaders = { ...authHeaders, 'x-webtopup-session-id': sessionId };
    const invalid = await fetch(`${origin}/v2/auth/2fa/confirm`, {
      method: 'POST', headers: mutationHeaders,
      body: JSON.stringify({ code: invalidCode, recoveryToken: login.recoveryToken }),
    });
    const invalidBody = await invalid.json();
    assert.equal(invalid.status, 400);
    assert.equal(invalidBody.error?.code, 'REAUTH_OTP_INVALID');

    const confirmationCode = totp(seed, counter + 1);
    const confirmationRequest = () => fetch(`${origin}/v2/auth/2fa/confirm`, {
      method: 'POST', headers: mutationHeaders,
      body: JSON.stringify({ code: confirmationCode, recoveryToken: login.recoveryToken }),
      signal: AbortSignal.timeout(6000),
    });
    const confirmationResponse = await confirmationRequest();
    const confirmed = await confirmationResponse.json();
    if (confirmationResponse.status !== 200) {
      console.log(JSON.stringify({
        confirmStatus: confirmationResponse.status,
        errorCode: confirmed.error?.code ?? 'none',
        sqlAuthError: sqlAuthErrors.at(-1) ?? 'none',
      }));
    }
    assert.equal(confirmationResponse.status, 200, `confirm status=${confirmationResponse.status} code=${confirmed.error?.code ?? 'none'} message=${confirmed.error?.message ?? 'none'}`);
    assert.equal(confirmed.enabled, true);
    const replayResponse = await confirmationRequest();
    assert.equal(replayResponse.status, 200, `confirm replay status=${replayResponse.status}`);
    assert.deepEqual(await replayResponse.json(), confirmed);

    const active = await db.query(
      'SELECT two_factor_enabled, two_factor_secret, two_factor_pending_secret, last_otp_counter FROM users WHERE normalized_email=$1',
      [email],
    );
    assert.equal(active.rows[0].two_factor_enabled, true);
    assert.equal(active.rows[0].two_factor_pending_secret, null);
    assert.equal(Buffer.isBuffer(active.rows[0].two_factor_secret), true);
    assert.equal(active.rows[0].two_factor_secret.includes(Buffer.from(setup.secret)), false);
    const originalSessions = await db.query('SELECT state FROM auth_sessions WHERE id=$1', [sessionId]);
    assert.equal(originalSessions.rows[0].state, 'revoked');

    const challengeResponse = await fetch(`${origin}/v2/auth/staff/login`, {
      method: 'POST', headers: baseHeaders, body: JSON.stringify({ email, password }),
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json();
    assert.equal(challenge.requiresTwoFactor, true);
    const loginCode = await nextOtpCode(db, email, seed);
    const verifyResponse = await fetch(`${origin}/v2/auth/2fa/login-verify`, {
      method: 'POST', headers: baseHeaders,
      body: JSON.stringify({ challengeToken: challenge.challengeToken, code: loginCode }),
    });
    assert.equal(verifyResponse.status, 200, `2FA login status=${verifyResponse.status}`);
    const authenticated = await verifyResponse.json();
    assert.equal(authenticated.user.role, 'owner');
    const replayVerify = await fetch(`${origin}/v2/auth/2fa/login-verify`, {
      method: 'POST', headers: baseHeaders,
      body: JSON.stringify({ challengeToken: challenge.challengeToken, code: loginCode }),
    });
    assert.equal(replayVerify.status, 401);

    const currentSessionHeaders = {
      ...baseHeaders,
      authorization: `Bearer ${authenticated.accessToken}`,
      'x-webtopup-session-id': authenticated.session.sessionId,
    };
    const stepUpCode = await nextOtpCode(db, email, seed);
    const stepUpResponse = await fetch(`${origin}/v2/auth/step-up`, {
      method: 'POST',
      headers: currentSessionHeaders,
      body: JSON.stringify({ password, otp: stepUpCode, actionGroup: 'team.manage_privileged' }),
    });
    assert.equal(stepUpResponse.status, 200, `step-up status=${stepUpResponse.status}`);
    assert.equal((await stepUpResponse.json()).actionGroup, 'team.manage_privileged');
    const logoutAllCode = await nextOtpCode(db, email, seed);
    const logoutAllStepUp = await fetch(`${origin}/v2/auth/step-up`, {
      method: 'POST',
      headers: currentSessionHeaders,
      body: JSON.stringify({ password, otp: logoutAllCode, actionGroup: 'security.sessions_all' }),
    });
    assert.equal(logoutAllStepUp.status, 200, `logout-all step-up status=${logoutAllStepUp.status}`);
    const logoutAllGrant = await logoutAllStepUp.json();
    const logoutAllHeaders = {
      ...currentSessionHeaders,
      'x-webtopup-step-up-group': 'security.sessions_all',
      'x-webtopup-step-up-token': logoutAllGrant.stepUpToken,
    };
    const revokeAll = () => fetch(`${origin}/v2/auth/sessions/revoke-all`, {
      method: 'POST', headers: logoutAllHeaders, body: '{}',
    });
    const revokeAllResponse = await revokeAll();
    assert.equal(revokeAllResponse.status, 200, `logout-all status=${revokeAllResponse.status}`);
    assert.equal((await revokeAllResponse.json()).ok, true);
    const revokeAllReplay = await revokeAll();
    assert.equal(revokeAllReplay.status, 200, `logout-all recovery status=${revokeAllReplay.status}`);
    assert.equal((await revokeAllReplay.json()).ok, true);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM auth_global_revocations WHERE source_session_id=$1', [authenticated.session.sessionId])).rows[0].count, 1);

    const reauthChallengeResponse = await fetch(`${origin}/v2/auth/staff/login`, {
      method: 'POST', headers: baseHeaders, body: JSON.stringify({ email, password }),
    });
    assert.equal(reauthChallengeResponse.status, 200);
    const reauthChallenge = await reauthChallengeResponse.json();
    assert.equal(reauthChallenge.requiresTwoFactor, true);
    const reauthCode = await nextOtpCode(db, email, seed);
    const reauthResponse = await fetch(`${origin}/v2/auth/2fa/login-verify`, {
      method: 'POST', headers: baseHeaders,
      body: JSON.stringify({ challengeToken: reauthChallenge.challengeToken, code: reauthCode }),
    });
    assert.equal(reauthResponse.status, 200, `post-logout 2FA login status=${reauthResponse.status}`);
    const reauthenticated = await reauthResponse.json();
    const reauthenticatedHeaders = {
      ...baseHeaders,
      authorization: `Bearer ${reauthenticated.accessToken}`,
      'x-webtopup-session-id': reauthenticated.session.sessionId,
    };

    const disableCode = await nextOtpCode(db, email, seed);
    const disableRequest = () => fetch(`${origin}/v2/auth/2fa/disable`, {
      method: 'POST',
      headers: reauthenticatedHeaders,
      body: JSON.stringify({ password, code: disableCode, recoveryToken: reauthenticated.recoveryToken }),
      signal: AbortSignal.timeout(6000),
    });
    const disableResponse = await disableRequest();
    assert.equal(disableResponse.status, 200, `2FA disable status=${disableResponse.status}`);
    const disabled = await disableResponse.json();
    assert.equal(disabled.enabled, false);
    const disableReplay = await disableRequest();
    assert.equal(disableReplay.status, 200, `2FA disable replay status=${disableReplay.status}`);
    assert.deepEqual(await disableReplay.json(), disabled);
    const disabledRow = await db.query('SELECT two_factor_enabled, two_factor_secret FROM users WHERE normalized_email=$1', [email]);
    assert.equal(disabledRow.rows[0].two_factor_enabled, false);
    assert.equal(disabledRow.rows[0].two_factor_secret, null);
    const revokedSource = await db.query('SELECT state FROM auth_sessions WHERE id=$1', [reauthenticated.session.sessionId]);
    assert.equal(revokedSource.rows[0].state, 'revoked');

    console.log(JSON.stringify({
      database,
      ownerEnrollment: 'passed',
      encryptedPendingAndActiveSeeds: 'passed',
      wrongOtpRejected: 'passed',
      confirmationResponseLossReplay: 'passed',
      sessionsRevokedAndReissued: 'passed',
      twoFactorLoginAndReplayRejection: 'passed',
      stepUp: 'passed',
      logoutAllAndRecovery: 'passed',
      disableAndResponseLossReplay: 'passed',
    }));
  } finally {
    await stopServer(server);
    if (connected) {
      try {
        await cleanup(db, email);
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
