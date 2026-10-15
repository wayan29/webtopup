#!/usr/bin/env node
// Route-level PostgreSQL smoke. Only runs against explicitly confirmed disposable CI DBs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'server/package.json'))('pg');

const databaseUrl = process.env.DATABASE_URL || '';
let database;
try { database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1)); } catch {}
if (!/^webtopup_ci_[a-z0-9_]+$/.test(database || '') || ['webtopup_ci_prod', 'webtopup_ci_live'].includes(database)) {
  console.error(`refusing guest transaction smoke for database ${database || '(missing)'}`);
  process.exit(2);
}
if (process.env.GUEST_TRANSACTION_SMOKE_CONFIRM !== `DISPOSABLE:${database}`) {
  console.error('set GUEST_TRANSACTION_SMOKE_CONFIRM=DISPOSABLE:<database> to permit this smoke');
  process.exit(2);
}
const originValue = process.env.API_V2_DIRECT_URL;
const token = process.env.GUEST_CHECKOUT_TOKEN;
const productCode = process.env.GUEST_CHECKOUT_PRODUCT_CODE;
const paymentMethodId = process.env.GUEST_CHECKOUT_PAYMENT_METHOD_ID;
assert.ok(originValue && token && productCode && paymentMethodId, 'API_V2_DIRECT_URL, GUEST_CHECKOUT_TOKEN, GUEST_CHECKOUT_PRODUCT_CODE, and GUEST_CHECKOUT_PAYMENT_METHOD_ID are required');
const origin = new URL(originValue);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'API origin must use loopback');
const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });

async function main() {
  await client.connect();
  const fixture = await client.query('SELECT id FROM products WHERE code = $1 LIMIT 1', [productCode]);
  assert.equal(fixture.rowCount, 1, 'configured guest product must exist in disposable DB');
  const key = `guest-smoke-${crypto.randomUUID()}`;
  const body = { productCode, target: `smoke-${crypto.randomUUID()}`, whatsapp: '6281234567890', paymentMethodId };
  const send = () => fetch(new URL('/api/v2/guest-transactions', origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const first = await send();
  const firstBody = await first.text();
  assert.equal(first.status, 201, `guest checkout must succeed: ${first.status} ${firstBody}`);
  const replay = await send();
  assert.equal(replay.status, first.status, 'idempotent replay status');
  assert.equal(await replay.text(), firstBody, 'idempotent replay body must be identical');
  const count = await client.query('SELECT count(*)::int AS count FROM guest_transactions WHERE idempotency_key IS NOT NULL AND target = $1', [body.target]);
  assert.equal(count.rows[0].count, 1, 'replay must create exactly one guest transaction');
  console.log(JSON.stringify({ ok: true, scenario: 'guest-checkout-idempotency', status: first.status }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => client.end());
