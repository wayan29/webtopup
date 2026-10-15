const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { Client } = serverRequire('pg');

const databaseUrl = process.env.DATABASE_URL;
const rustOriginValue = process.env.SQL_SESSION_SMOKE_RUST_ORIGIN;
const proxySecret = process.env.SQL_SESSION_SMOKE_PROXY_SECRET;
assert.ok(databaseUrl, 'DATABASE_URL is required');
assert.ok(rustOriginValue, 'SQL_SESSION_SMOKE_RUST_ORIGIN is required');
assert.ok(proxySecret && proxySecret.length >= 32, 'SQL_SESSION_SMOKE_PROXY_SECRET is required');
const dbUrl = new URL(databaseUrl);
const database = dbUrl.pathname.slice(1);
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u, 'refusing non-disposable database');
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(dbUrl.hostname), 'database host must be local');
const rustOrigin = new URL(rustOriginValue);
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(rustOrigin.hostname), 'Rust API origin must be local');
const headers = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };

async function post(path, body) {
  return fetch(`${rustOrigin.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function success(response, label) {
  const body = await response.json();
  assert.equal(response.status, 200, `${label}: status=${response.status} code=${body.error?.code ?? 'none'}`);
  return body;
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
  const email = `rotation-${crypto.randomUUID()}@example.test`;
  const password = `Rotation-${crypto.randomBytes(20).toString('hex')}!`;
  let connected = false;

  try {
    await db.connect();
    connected = true;
    assert.equal((await db.query('SELECT current_database() AS database')).rows[0].database, database);
    const registration = await success(await post('/v2/auth/register', {
      name: 'Refresh Rotation Smoke', email, password,
    }), 'register');
    const predecessor = {
      refreshToken: registration.refreshToken,
      recoveryToken: registration.recoveryToken,
    };
    assert.equal(typeof predecessor.refreshToken, 'string');
    assert.equal(typeof predecessor.recoveryToken, 'string');

    const concurrent = await Promise.all([
      post('/v2/auth/refresh', predecessor),
      post('/v2/auth/refresh', predecessor),
    ]);
    const concurrentResults = await Promise.all(concurrent.map(async (response) => ({
      status: response.status,
      body: await response.json(),
    })));
    const committed = concurrentResults.filter((result) => result.status === 200);
    const raced = concurrentResults.filter((result) => result.status === 409);
    assert.equal(committed.length, 1, 'one predecessor refresh commits');
    assert.equal(raced.length, 1, 'concurrent predecessor refresh is rejected during race grace');
    assert.equal(raced[0].body.error?.code, 'AUTH_REFRESH_RACE');
    const firstSuccessor = committed[0].body;
    const successor1 = { refreshToken: firstSuccessor.refreshToken, recoveryToken: firstSuccessor.recoveryToken };

    await new Promise((resolve) => setTimeout(resolve, 5100));
    const recovered = await success(await post('/v2/auth/refresh', predecessor), 'response-loss recovery');
    assert.ok(recovered.refreshToken === successor1.refreshToken, 'predecessor recovery returns the committed refresh token');
    assert.ok(recovered.recoveryToken === successor1.recoveryToken, 'predecessor recovery returns the committed recovery token');

    const secondRotation = await success(await post('/v2/auth/refresh', successor1), 'successor rotation');
    assert.ok(secondRotation.refreshToken !== successor1.refreshToken, 'successor rotation advances the refresh token');
    assert.ok(secondRotation.recoveryToken !== successor1.recoveryToken, 'successor rotation advances the recovery token');

    const reuse = await post('/v2/auth/refresh', predecessor);
    const reuseBody = await reuse.json();
    assert.equal(reuse.status, 401, `consumed predecessor reuse: status=${reuse.status}`);
    assert.equal(reuseBody.error?.code, 'AUTH_REFRESH_REUSED');
    const state = await db.query(
      'SELECT state, owns_slot, generation FROM auth_sessions WHERE id=$1',
      [registration.session.sessionId],
    );
    assert.deepEqual(state.rows[0], { state: 'revoked', owns_slot: false, generation: '2' });

    console.log(JSON.stringify({
      database,
      concurrentRefresh: 'one commit, one AUTH_REFRESH_RACE',
      lostResponseRecovery: 'predecessor returned committed successor',
      successorRotation: 'passed',
      oldPredecessorReuse: 'revoked session durably',
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
