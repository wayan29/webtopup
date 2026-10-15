const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { Client } = serverRequire('pg');

const databaseUrl = process.env.DATABASE_URL;
const originValue = process.env.SQL_REFRESH_SMOKE_ORIGIN;
assert.ok(databaseUrl, 'DATABASE_URL is required');
assert.ok(originValue, 'SQL_REFRESH_SMOKE_ORIGIN is required');
const dbUrl = new URL(databaseUrl);
const database = dbUrl.pathname.slice(1);
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u, 'refusing non-disposable database');
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(dbUrl.hostname), 'database host must be local');
const origin = new URL(originValue);
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(origin.hostname), 'API origin must be local');
const apiOrigin = origin.origin;

function parseSetCookies(response) {
  const cookies = new Map();
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';');
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), {
      value: pair.slice(separator + 1),
      attributes: attributes.map((attribute) => attribute.trim().toLowerCase()),
    });
  }
  return cookies;
}

function cookieHeader(cookies) {
  return ['wb_refresh', 'wb_rotation_recovery', 'wb_csrf']
    .map((name) => `${name}=${cookies.get(name).value}`)
    .join('; ');
}

async function request(pathname, cookies, csrf) {
  return fetch(`${apiOrigin}${pathname}`, {
    method: 'POST',
    headers: {
      origin: apiOrigin,
      'content-type': 'application/json',
      cookie: cookieHeader(cookies),
      'x-csrf-token': csrf,
    },
    body: '{}',
  });
}

async function cleanup(db, email) {
  const rows = await db.query('SELECT id FROM users WHERE normalized_email=$1', [email]);
  const ids = rows.rows.map((row) => row.id);
  if (!ids.length) return;
  await db.query('DELETE FROM auth_global_revocations WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_security_changes WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_device_challenges WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_factor_challenges WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM audit_events WHERE actor = ANY($1::text[])', [ids.map(String)]);
  await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
}

async function main() {
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const email = `gateway-refresh-${crypto.randomUUID()}@example.test`;
  const password = `GatewayRefresh-${crypto.randomBytes(20).toString('hex')}!`;
  let connected = false;

  try {
    await db.connect();
    connected = true;
    assert.equal((await db.query('SELECT current_database() AS database')).rows[0].database, database);

    const registration = await fetch(`${apiOrigin}/api/v2/auth/register`, {
      method: 'POST',
      headers: { origin: apiOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Gateway Refresh Smoke', email, password }),
    });
    assert.equal(registration.status, 200, `register status=${registration.status}`);
    const registrationBody = await registration.json();
    const original = parseSetCookies(registration);
    for (const name of ['wb_refresh', 'wb_rotation_recovery', 'wb_csrf']) assert.ok(original.has(name), `missing cookie ${name}`);
    assert.ok(original.get('wb_refresh').attributes.includes('httponly'));
    assert.ok(original.get('wb_rotation_recovery').attributes.includes('httponly'));
    assert.ok(!original.get('wb_csrf').attributes.includes('httponly'));
    for (const key of ['refreshToken', 'recoveryToken']) assert.equal(key in registrationBody, false);
    const wrongOrigin = await fetch(`${apiOrigin}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: { origin: 'http://attacker.invalid', 'content-type': 'application/json', cookie: cookieHeader(original), 'x-csrf-token': original.get('wb_csrf').value },
      body: '{}',
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal((await wrongOrigin.json()).message, 'Forbidden origin');
    const missingCsrf = await fetch(`${apiOrigin}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: { origin: apiOrigin, 'content-type': 'application/json', cookie: cookieHeader(original) },
      body: '{}',
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).message, 'Invalid CSRF token');

    const first = await request('/api/v2/auth/refresh', original, original.get('wb_csrf').value);
    assert.equal(first.status, 200, `first refresh status=${first.status}`);
    const firstCookies = parseSetCookies(first);
    for (const name of ['wb_refresh', 'wb_rotation_recovery', 'wb_csrf']) assert.ok(firstCookies.has(name), `missing rotated cookie ${name}`);
    const firstBody = await first.json();
    for (const key of ['refreshToken', 'recoveryToken', 'refreshCookieMaxAgeSeconds', 'recoveryCookieMaxAgeSeconds']) {
      assert.equal(key in firstBody, false, `credential field leaked in JSON: ${key}`);
    }
    assert.notEqual(firstCookies.get('wb_refresh').value, original.get('wb_refresh').value);
    assert.notEqual(firstCookies.get('wb_rotation_recovery').value, original.get('wb_rotation_recovery').value);

    // Simulate a response lost after the upstream committed: retry the predecessor cookie pair.
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const recovered = await request('/api/v2/auth/refresh', original, original.get('wb_csrf').value);
    assert.equal(recovered.status, 200, `predecessor recovery status=${recovered.status}`);
    const recoveredCookies = parseSetCookies(recovered);
    assert.equal(recoveredCookies.get('wb_refresh').value, firstCookies.get('wb_refresh').value);
    assert.equal(recoveredCookies.get('wb_rotation_recovery').value, firstCookies.get('wb_rotation_recovery').value);

    const second = await request('/api/v2/auth/refresh', recoveredCookies, recoveredCookies.get('wb_csrf').value);
    assert.equal(second.status, 200, `successor rotation status=${second.status}`);
    const secondCookies = parseSetCookies(second);
    assert.notEqual(secondCookies.get('wb_refresh').value, recoveredCookies.get('wb_refresh').value);

    const reused = await request('/api/v2/auth/refresh', original, original.get('wb_csrf').value);
    assert.equal(reused.status, 401, `old predecessor reuse status=${reused.status}`);
    const reusedBody = await reused.json();
    assert.equal(reusedBody.error?.code, 'AUTH_REFRESH_REUSED');
    const sessionState = await db.query(
      'SELECT state, owns_slot, generation FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE normalized_email=$1)',
      [email],
    );
    assert.deepEqual(sessionState.rows[0], { state: 'revoked', owns_slot: false, generation: '2' });
    const logout = await request('/api/v2/auth/logout', secondCookies, secondCookies.get('wb_csrf').value);
    assert.equal(logout.status, 200, `logout status=${logout.status}`);
    const cleared = parseSetCookies(logout);
    for (const name of ['wb_refresh', 'wb_rotation_recovery', 'wb_csrf']) {
      assert.ok(cleared.has(name), `logout must clear ${name}`);
      assert.ok(cleared.get(name).value === '' || cleared.get(name).attributes.includes('max-age=0'));
    }

    console.log(JSON.stringify({
      database,
      gatewayCookies: 'HttpOnly refresh/recovery, readable CSRF',
      responseLossRecovery: 'same committed successor cookies',
      jsonSecretStripping: 'passed',
      predecessorReuse: 'session revoked',
      originAndCsrfRejection: 'passed',
      logoutClearsAuthCookies: 'passed',
    }));
  } finally {
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
