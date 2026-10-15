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
const port = 19023;
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname));
assert.ok(proxySecret && proxySecret.length >= 32);
const origin = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };

async function expectJson(response, status, label) {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: status=${response.status} code=${body.error?.code || body.message || 'none'}`);
  return body;
}
async function login(email, password) {
  return expectJson(await fetch(`${origin}/v2/auth/staff/login`, { method: 'POST', headers, body: JSON.stringify({ email, password }) }), 200, 'owner login');
}
async function call(method, route, body, token) {
  return fetch(`${origin}${route}`, {
    method,
    headers: { ...headers, authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  const email = `taxonomy-owner-${suffix}@example.test`;
  const password = `Taxonomy-${crypto.randomBytes(20).toString('hex')}!`;
  let server;
  await db.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
    const bootstrap = spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PGHOST: dbUrl.hostname, PGPORT: dbUrl.port || '5432', PGDATABASE: database, PGUSER: decodeURIComponent(dbUrl.username), PGPASSWORD: decodeURIComponent(dbUrl.password), BOOTSTRAP_DATABASE: database, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_NAME: 'SQL Taxonomy Smoke Owner' },
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
    const owner = await login(email, password);
    const token = owner.accessToken;
    const suffixShort = suffix.slice(0, 8);
    const first = await expectJson(await call('POST', '/v2/categories/admin/create', { name: `Category First ${suffixShort}` }, token), 201, 'category create');
    const second = await expectJson(await call('POST', '/v2/categories/admin/create', { name: `Category Second ${suffixShort}` }, token), 201, 'second category create');
    const categoryId = first.category._id;
    const categoryUpdated = await expectJson(await call('PUT', `/v2/categories/admin/${categoryId}`, { name: `Category Updated ${suffixShort}` }, token), 200, 'category update');
    assert.equal(categoryUpdated.category.name, `Category Updated ${suffixShort}`);
    const operator = await expectJson(await call('POST', '/v2/operators/admin/create', { name: `Operator ${suffixShort}`, categoryId }, token), 201, 'operator create');
    const operatorId = operator.operator._id;
    const productType = await expectJson(await call('POST', '/v2/product-types/admin/create', { name: `Type ${suffixShort}`, categoryId, operatorId: operatorId }, token), 201, 'type create');
    const productTypeId = productType.productType._id;
    const allCategories = await expectJson(await call('GET', '/v2/categories/admin/all', undefined, token), 200, 'category list');
    const categoryIds = allCategories.map(row => row._id).reverse();
    await expectJson(await call('PUT', '/v2/categories/admin/sort-order', { orders: categoryIds.map((id, index) => ({ id, sortOrder: index + 1 })) }, token), 200, 'category reorder');
    const productPayload = {
      name: `Concurrent Product ${suffixShort}`, code: `TAX-${suffixShort}-A`, categoryId, operatorId: operatorId,
      productTypeId, paymentType: 'prabayar', brand: `Brand ${suffixShort}`, costPrice: 7000,
      price: { basic: 10000, gold: 11000, platinum: 12000 }, rewardPoints: 5, vendor: { name: 'mock', sku: `SKU-${suffixShort}` }, status: true,
    };
    const [left, right] = await Promise.all([
      call('POST', '/v2/products', { ...productPayload }, token),
      call('POST', '/v2/products', { ...productPayload, code: `TAX-${suffixShort}-B`, name: `${productPayload.name} B` }, token),
    ]);
    const leftBody = await expectJson(left, 201, 'concurrent product A');
    const rightBody = await expectJson(right, 201, 'concurrent product B');
    const productIds = [leftBody.product.productId, rightBody.product.productId];
    assert.ok(productIds.every(id => Number.isSafeInteger(id) && id > 0));
    assert.notEqual(productIds[0], productIds[1]);
    const duplicateCode = await call('POST', '/v2/products', { ...productPayload }, token);
    assert.equal(duplicateCode.status, 409, `duplicate code status=${duplicateCode.status}`);
    const rejectedParent = await call('DELETE', `/v2/categories/admin/${categoryId}`, undefined, token);
    assert.equal(rejectedParent.status, 400, `referenced parent delete status=${rejectedParent.status}`);
    const audit = await expectJson(await call('GET', '/v2/products/admin/catalog-audit?limit=10', undefined, token), 200, 'catalog audit');
    assert.equal(typeof audit.summary.products, 'number');
    console.log(JSON.stringify({ database, taxonomyCreateEditReorder: 'passed', relationsCompatible: 'passed', concurrentProducts: 'passed', jsSafeProductIds: productIds, codeConflict: '409', referencedParentDeleteRejected: 'passed', auditProducts: audit.summary.products }));
  } finally {
    await stopServer(server);
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
main().catch(error => { console.error(error); process.exitCode = 1; });
