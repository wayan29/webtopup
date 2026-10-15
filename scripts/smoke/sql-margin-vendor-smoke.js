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
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname));
assert.ok(proxySecret && proxySecret.length >= 32);
const origin = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };
async function expectJson(response, status, label) {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: status=${response.status} body=${JSON.stringify(body).slice(0, 240)}`);
  return body;
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
  const email = `margin-owner-${suffix}@example.test`;
  const password = `MarginOwner-${crypto.randomBytes(20).toString('hex')}!`;
  let server;
  let sku;
  let purchaseId;
  let previousMargins;
  await db.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    previousMargins = await db.query("SELECT value,revision,updated_at FROM site_settings WHERE key='margins'");
    const expectedMargins = previousMargins.rowCount ? previousMargins.rows[0].value : { basic: 10, gold: 5, platinum: 0 };
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
    const bootstrap = spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PGHOST: dbUrl.hostname, PGPORT: dbUrl.port || '5432', PGDATABASE: database, PGUSER: decodeURIComponent(dbUrl.username), PGPASSWORD: decodeURIComponent(dbUrl.password), BOOTSTRAP_DATABASE: database, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_NAME: 'SQL Margin Smoke Owner' },
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
    const login = await expectJson(await fetch(`${origin}/v2/auth/staff/login`, { method: 'POST', headers, body: JSON.stringify({ email, password }) }), 200, 'owner login');
    const auth = { ...headers, authorization: `Bearer ${login.accessToken}` };
    const initial = await expectJson(await fetch(`${origin}/v2/margins`, { headers: auth }), 200, 'initial margins');
    assert.equal(initial.data.basic, expectedMargins.basic);
    assert.equal(initial.data.gold, expectedMargins.gold);
    assert.equal(initial.data.platinum, expectedMargins.platinum);
    const updated = await expectJson(await fetch(`${origin}/v2/margins`, { method: 'PUT', headers: auth, body: JSON.stringify({ basic: 12.5, gold: 7, platinum: 1, note: 'SQL margin smoke' }) }), 200, 'margin update');
    assert.equal(updated.data.basic, 12.5);
    assert.equal(updated.data.gold, 7);
    assert.equal(updated.data.platinum, 1);
    assert.equal(updated.data.note, 'SQL margin smoke');
    assert.equal(updated.meta.updatedBy.id, login.user.id);
    const persisted = await db.query("SELECT value,revision FROM site_settings WHERE key='margins'");
    assert.equal(persisted.rows[0].value.basic, 12.5);
    assert.ok(persisted.rows[0].revision >= 1);
    const invalid = await fetch(`${origin}/v2/margins`, { method: 'PUT', headers: auth, body: JSON.stringify({ basic: 501 }) });
    assert.equal(invalid.status, 400);
    sku = `MARGIN-${suffix.slice(0, 8)}`;
    const pricelist = { provider: 'digiflazz', sku, data: { buyer_sku_code: sku, product_name: 'Durable SQL Product', category: 'Games', brand: 'Smoke', cost: 7000 } };
    for (let pass = 1; pass <= 2; pass++) {
      await db.query(`INSERT INTO provider_pricelist(provider,sku,data) VALUES('digiflazz',$1,$2) ON CONFLICT(provider,sku) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`, [sku, pricelist.data]);
    }
    const pricelistRows = await db.query('SELECT count(*)::int AS count FROM provider_pricelist WHERE provider=$1 AND sku=$2', ['digiflazz', sku]);
    assert.equal(pricelistRows.rows[0].count, 1);
    const pricelistApi = await expectJson(await fetch(`${origin}/v2/vendors/digiflazz/pricelist?page=1&limit=10&search=${sku}`, { headers: auth }), 200, 'pricelist read');
    assert.equal(pricelistApi.total, 1);
    purchaseId = crypto.randomUUID();
    const purchaseData = { id: purchaseId, provider: 'digiflazz', ref_id: `REF-${suffix.slice(0, 8)}`, status: 'pending', price: 11000 };
    await db.query('INSERT INTO internal_provider_purchases(id,provider,ref_id,data) VALUES($1,$2,$3,$4)', [purchaseId, 'digiflazz', purchaseData.ref_id, purchaseData]);
    const purchasesApi = await expectJson(await fetch(`${origin}/v2/vendors/digiflazz/internal-purchases?limit=10`, { headers: auth }), 200, 'internal purchases');
    assert.ok(purchasesApi.data?.some?.(item => item.id === purchaseId));
    const purchaseRows = await db.query('SELECT count(*)::int AS count FROM internal_provider_purchases WHERE id=$1', [purchaseId]);
    assert.equal(purchaseRows.rows[0].count, 1);
    console.log(JSON.stringify({ database, marginDefaults: 'passed', marginUpdateAndAudit: 'passed', marginValidation: 'passed', vendorPricelistDurable: 'passed', internalPurchaseDurable: 'passed', revision: persisted.rows[0].revision }));
  } finally {
    await stopServer(server);
    try {
      const ids = (await db.query('SELECT id FROM users WHERE normalized_email=$1', [email])).rows.map(row => row.id);
      if (ids.length) {
        for (const table of ['auth_security_changes', 'auth_factor_challenges', 'auth_device_challenges', 'auth_global_revocations', 'auth_sessions']) await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`, [ids]);
        await db.query('DELETE FROM audit_events WHERE actor=ANY($1::text[])', [ids.map(String)]);
        await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
      }
      if (previousMargins?.rowCount) {
        const previous = previousMargins.rows[0];
        await db.query("UPDATE site_settings SET value=$1,revision=$2,updated_at=$3 WHERE key='margins'", [previous.value, previous.revision, previous.updated_at]);
      } else {
        await db.query("DELETE FROM site_settings WHERE key='margins'");
      }
      if (sku) await db.query("DELETE FROM provider_pricelist WHERE provider='digiflazz' AND sku=$1", [sku]);
    } finally { await db.end(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
