const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'server/package.json'))('pg');
const dbUrl = new URL(process.env.DATABASE_URL || '');
const database = dbUrl.pathname.slice(1);
const proxySecret = process.env.API_V2_PROXY_SECRET;
const port = 19024;
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u, 'DATABASE_URL must target a disposable webtopup_ci_* database');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname), 'DATABASE_URL must use loopback');
assert.ok(proxySecret && proxySecret.length >= 32, 'API_V2_PROXY_SECRET must be set');
const origin = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };
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
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >> bits) & 0xff); }
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

async function expectJson(response, status, label) {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: status=${response.status} code=${body.error?.code || body.message || 'none'}`);
  return body;
}
async function call(method, route, body, token, stepUpToken) {
  const stepUpHeaders = stepUpToken ? {
    'x-webtopup-step-up-group': 'integrations.credentials',
    'x-webtopup-step-up-token': stepUpToken,
  } : {};
  return fetch(`${origin}${route}`, {
    method,
    headers: { ...headers, authorization: `Bearer ${token}`, ...stepUpHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const suffix = crypto.randomUUID();
  const email = `payment-smoke-${suffix}@example.test`;
  const password = `Payment-${crypto.randomBytes(20).toString('hex')}!`;
  let server;
  let categoryIds = [];
  let methodIds = [];
  await db.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
    const bootstrap = spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PGHOST: dbUrl.hostname, PGPORT: dbUrl.port || '5432', PGDATABASE: database,
        PGUSER: decodeURIComponent(dbUrl.username), PGPASSWORD: decodeURIComponent(dbUrl.password), BOOTSTRAP_DATABASE: database,
        OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_NAME: 'SQL Payment Smoke Owner' },
    });
    assert.equal(bootstrap.status, 0, 'owner bootstrap failed');
    server = spawn(path.join(root, 'rust-api/target/debug/webtopup-rust-api'), [], {
      cwd: root, stdio: 'ignore', env: { ...process.env, SQL_DATABASE: database, MONGO_URI: '', API_V2_HOST: '127.0.0.1', API_V2_PORT: String(port), RUST_LOG: 'warn' },
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null || server.signalCode !== null) break;
      try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Rust candidate must become healthy');
    const initialLogin = await expectJson(await fetch(`${origin}/v2/auth/staff/login`, {
      method: 'POST', headers, body: JSON.stringify({ email, password }),
    }), 200, 'initial owner login');
    const setup = await expectJson(await fetch(`${origin}/v2/auth/2fa/setup`, {
      method: 'POST', headers: { ...headers, authorization: `Bearer ${initialLogin.accessToken}` },
    }), 200, 'owner 2FA setup');
    const seed = base32Decode(setup.secret);
    const initialSessionId = initialLogin.session.sessionId;
    const confirmHeaders = { ...headers, authorization: `Bearer ${initialLogin.accessToken}`, 'x-webtopup-session-id': initialSessionId };
    const confirmationCode = totp(seed, Math.floor(Date.now() / 30_000) + 1);
    await expectJson(await fetch(`${origin}/v2/auth/2fa/confirm`, {
      method: 'POST', headers: confirmHeaders,
      body: JSON.stringify({ code: confirmationCode, recoveryToken: initialLogin.recoveryToken }),
    }), 200, 'owner 2FA confirmation');
    const challenge = await expectJson(await fetch(`${origin}/v2/auth/staff/login`, {
      method: 'POST', headers, body: JSON.stringify({ email, password }),
    }), 200, 'owner 2FA challenge');
    assert.equal(challenge.requiresTwoFactor, true);
    const authenticated = await expectJson(await fetch(`${origin}/v2/auth/2fa/login-verify`, {
      method: 'POST', headers,
      body: JSON.stringify({ challengeToken: challenge.challengeToken, code: await nextOtpCode(db, email, seed) }),
    }), 200, 'owner 2FA login');
    const token = authenticated.accessToken;
    const sessionId = authenticated.session.sessionId;
    const stepUp = await expectJson(await fetch(`${origin}/v2/auth/step-up`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token}`, 'x-webtopup-session-id': sessionId },
      body: JSON.stringify({ password, otp: await nextOtpCode(db, email, seed), actionGroup: 'integrations.credentials' }),
    }), 200, 'payment credentials step-up');
    const stepUpToken = stepUp.stepUpToken;
    const short = suffix.slice(0, 8);
    const fixtureDayOffset = Number(BigInt(`0x${suffix.replaceAll('-', '').slice(0, 12)}`) % 100_000n);
    const localDate = new Date(Date.UTC(2030, 0, 1) + fixtureDayOffset * 86_400_000).toISOString().slice(0, 10);
    const [fixtureYear, fixtureMonth, fixtureDay] = localDate.split('-');
    const nextLocalDate = new Date(Date.UTC(2030, 0, 1) + (fixtureDayOffset + 1) * 86_400_000).toISOString().slice(0, 10);
    const expectedReferencePrefix = `REF${fixtureDay}${fixtureMonth}${fixtureYear}`;

    const first = await expectJson(await call('POST', '/v2/payment-categories', {
      name: `Smoke Category ${short}`, slug: `smoke-category-${short}`, status: 'active', order: 10,
    }, token), 201, 'category create');
    const firstCategoryId = first.category._id;
    assert.ok(firstCategoryId);
    categoryIds.push(firstCategoryId);
    const second = await expectJson(await call('POST', '/v2/payment-categories', {
      name: `Smoke Category Other ${short}`, slug: `smoke-category-other-${short}`, status: 'active', order: 20,
    }, token), 201, 'second category create');
    const secondCategoryId = second.category._id;
    assert.ok(secondCategoryId);
    categoryIds.push(secondCategoryId);
    const categoryId = firstCategoryId;
    const updatedCategory = await expectJson(await call('PUT', `/v2/payment-categories/${categoryId}`, {
      name: `Smoke Category Updated ${short}`, slug: `smoke-category-updated-${short}`, status: 'active', order: 10,
    }, token), 200, 'category update');
    assert.equal(updatedCategory.category.name, `Smoke Category Updated ${short}`);
    await expectJson(await call('PUT', '/v2/payment-categories/reorder', {
      orders: [{ id: secondCategoryId, order: 1 }, { id: categoryId, order: 2 }],
    }, token), 200, 'category reorder');

    const methodPayload = {
      name: `Smoke Transfer ${short}`, category: categoryId, accountNumber: `SMOKE-${short}`,
      accountName: `Payment Smoke ${short}`, icon: '', minAmount: 1000, maxAmount: 1000000,
      adminFee: 0, adminPercent: 0, operationalStart: '00:00', operationalEnd: '23:59',
      useUniqueCode: true, status: 'active',
    };
    const createdMethod = await expectJson(await call('POST', '/v2/payment-methods', methodPayload, token, stepUpToken), 201, 'payment method create');
    const methodId = createdMethod.method._id;
    assert.ok(methodId);
    methodIds.push(methodId);
    const updatedMethod = await expectJson(await call('PUT', `/v2/payment-methods/${methodId}`, {
      ...methodPayload, name: `Smoke Transfer Updated ${short}`,
    }, token, stepUpToken), 200, 'payment method update');
    assert.equal(updatedMethod.method.name, `Smoke Transfer Updated ${short}`);

    const adminCategories = await expectJson(await call('GET', '/v2/payment-categories/admin/all', undefined, token), 200, 'admin categories');
    assert.ok(adminCategories.some(row => row._id === categoryId && row.order === 2));
    const adminMethods = await expectJson(await call('GET', '/v2/payment-methods/admin/all', undefined, token), 200, 'admin methods');
    assert.ok(adminMethods.some(row => row._id === methodId));
    const publicCategories = await expectJson(await fetch(`${origin}/v2/payment-categories`), 200, 'public categories');
    assert.ok(publicCategories.some(row => row._id === categoryId));
    const activeCategories = await expectJson(await call('GET', '/v2/payment-categories/active', undefined, token), 200, 'active categories');
    assert.ok(activeCategories.some(row => row._id === categoryId));
    const publicMethods = await expectJson(await fetch(`${origin}/v2/payment-methods`), 200, 'public methods');
    const disabledCategory = await expectJson(await call('PUT', `/v2/payment-categories/${categoryId}`, {
      name: `Smoke Category Updated ${short}`, slug: `smoke-category-updated-${short}`, status: 'inactive', order: 2,
    }, token), 200, 'deactivate category');
    assert.equal(disabledCategory.category.status, 'inactive');
    const categoryFilteredMethods = await expectJson(await fetch(`${origin}/v2/payment-methods`), 200, 'category-filtered methods');
    assert.ok(!categoryFilteredMethods.some(row => row._id === methodId), 'method with inactive category must not appear publicly');
    await expectJson(await call('PUT', `/v2/payment-categories/${categoryId}`, {
      name: `Smoke Category Updated ${short}`, slug: `smoke-category-updated-${short}`, status: 'active', order: 2,
    }, token), 200, 'reactivate category');
    const utcMinute = Math.floor(Date.now() / 60000) % (24 * 60);
    const outsideMinute = (utcMinute + 180) % (24 * 60);
    const outsideStart = `${String(Math.floor(outsideMinute / 60)).padStart(2, '0')}:${String(outsideMinute % 60).padStart(2, '0')}`;
    const outsideEndMinute = (outsideMinute + 1) % (24 * 60);
    const outsideEnd = `${String(Math.floor(outsideEndMinute / 60)).padStart(2, '0')}:${String(outsideEndMinute % 60).padStart(2, '0')}`;
    await expectJson(await call('PUT', `/v2/payment-methods/${methodId}`, { ...methodPayload, operationalStart: outsideStart, operationalEnd: outsideEnd }, token, stepUpToken), 200, 'set outside operating window');
    const operationalFilteredMethods = await expectJson(await fetch(`${origin}/v2/payment-methods`), 200, 'operationally filtered methods');
    assert.ok(!operationalFilteredMethods.some(row => row._id === methodId), 'out-of-hours method must not appear publicly');
    await expectJson(await call('PUT', `/v2/payment-methods/${methodId}`, { ...methodPayload }, token, stepUpToken), 200, 'restore operating hours');
    const inactiveMethod = await expectJson(await call('PUT', `/v2/payment-methods/${methodId}`, {
      ...methodPayload, status: 'inactive', name: `Smoke Transfer Inactive ${short}`,
    }, token, stepUpToken), 200, 'deactivate method');
    assert.equal(inactiveMethod.method.status, 'inactive');
    const filteredMethods = await expectJson(await call('GET', '/v2/payment-methods/active', undefined, token), 200, 'active public methods');
    assert.ok(!filteredMethods.some(row => row._id === methodId), 'inactive method must not appear in active methods');
    await expectJson(await call('PUT', `/v2/payment-methods/${methodId}`, { ...methodPayload }, token, stepUpToken), 200, 'reactivate method');

    const allocationTimestamp = `${localDate}T12:00:00+07:00`;
    const catalogSmoke = path.join(root, 'rust-api/target/debug/catalog_smoke');
    const allocateReference = () => new Promise((resolve, reject) => {
      const child = spawn(catalogSmoke, ['reference', methodId, allocationTimestamp], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`catalog_smoke reference exited ${code}: ${stderr}`)));
    });
    const references = await Promise.all(Array.from({ length: 12 }, allocateReference));
    assert.equal(new Set(references).size, references.length, 'concurrent references must be unique');
    assert.ok(references.every(reference => new RegExp(`^${expectedReferencePrefix}\\d{4}$`, 'u').test(reference)));
    const allocationRows = await db.query('SELECT reference FROM payment_reference_allocations WHERE payment_method_id=$1 AND date_wib=$2::date ORDER BY sequence', [methodId, localDate]);
    assert.equal(allocationRows.rowCount, references.length);
    assert.deepEqual(new Set(allocationRows.rows.map(row => row.reference)), new Set(references));
    const nextDayReference = await new Promise((resolve, reject) => {
      const child = spawn(catalogSmoke, ['reference', methodId, `${nextLocalDate}T00:01:00+07:00`], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`catalog_smoke rollover exited ${code}: ${stderr}`)));
    });
    const nextDatePrefix = `REF${nextLocalDate.slice(8, 10)}${nextLocalDate.slice(5, 7)}${nextLocalDate.slice(0, 4)}`;
    assert.match(nextDayReference, new RegExp(`^${nextDatePrefix}0001$`, 'u'), 'WIB date rollover resets daily sequence');
    const rolloverRows = await db.query('SELECT reference, sequence FROM payment_reference_allocations WHERE payment_method_id=$1 AND date_wib=$2::date', [methodId, nextLocalDate]);
    assert.deepEqual(rolloverRows.rows, [{ reference: nextDayReference, sequence: '1' }]);
    const referenceDependency = await call('DELETE', `/v2/payment-methods/${methodId}`, undefined, token, stepUpToken);
    assert.equal(referenceDependency.status, 400, `method with allocated references must be protected; status=${referenceDependency.status}`);
    await db.query('DELETE FROM payment_reference_allocations WHERE payment_method_id=$1', [methodId]);
    const dependencyReference = `PAYMENT-SMOKE-${suffix}`;
    await db.query('INSERT INTO deposits (payment_method_id, reference) VALUES ($1, $2)', [methodId, dependencyReference]);
    const methodDependency = await call('DELETE', `/v2/payment-methods/${methodId}`, undefined, token, stepUpToken);
    assert.equal(methodDependency.status, 400, `method with dependencies must be protected; status=${methodDependency.status}`);
    const categoryDependency = await call('DELETE', `/v2/payment-categories/${categoryId}`, undefined, token);
    assert.equal(categoryDependency.status, 400, `category with method dependency must be protected; status=${categoryDependency.status}`);
    await db.query('DELETE FROM deposits WHERE payment_method_id=$1 AND reference=$2', [methodId, dependencyReference]);
    await db.query('DELETE FROM payment_reference_allocations WHERE payment_method_id=$1', [methodId]);
    const deletedMethod = await expectJson(await call('DELETE', `/v2/payment-methods/${methodId}`, undefined, token, stepUpToken), 200, 'payment method delete');
    assert.ok(deletedMethod.message);
    await expectJson(await call('DELETE', `/v2/payment-categories/${categoryId}`, undefined, token), 200, 'category delete');
    await expectJson(await call('DELETE', `/v2/payment-categories/${secondCategoryId}`, undefined, token), 200, 'second category delete');

    console.log(JSON.stringify({ database, categoryCrudReorder: 'passed', methodCrud: 'passed', publicFiltering: 'passed', categoryDependencyDeleteBlocked: 'passed', methodDependencyDeleteBlocked: 'passed', concurrentUniqueReferences: references.length }));
  } finally {
    await stopServer(server);
    try {
      if (methodIds.length) {
        await db.query('DELETE FROM deposits WHERE payment_method_id=ANY($1::uuid[])', [methodIds]);
        await db.query('DELETE FROM guest_orders WHERE payment_method_id=ANY($1::uuid[])', [methodIds]);
        await db.query('DELETE FROM payment_reference_allocations WHERE payment_method_id=ANY($1::uuid[])', [methodIds]);
        await db.query('DELETE FROM payment_methods WHERE id=ANY($1::uuid[])', [methodIds]);
      }
      if (categoryIds.length) await db.query('DELETE FROM payment_categories WHERE id=ANY($1::uuid[])', [categoryIds]);
    } finally {
      try {
        const ids = (await db.query('SELECT id FROM users WHERE normalized_email=$1', [email])).rows.map(row => row.id);
        if (ids.length) {
          for (const table of ['auth_security_changes', 'auth_factor_challenges', 'auth_device_challenges', 'auth_global_revocations', 'auth_sessions']) await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`, [ids]);
          await db.query('DELETE FROM audit_events WHERE actor=ANY($1::text[])', [ids.map(String)]);
          await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
        }
      } finally { await db.end(); }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
