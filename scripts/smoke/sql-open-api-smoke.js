const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'server/package.json'))('pg');

const databaseUrl = new URL(process.env.DATABASE_URL || '');
const database = decodeURIComponent(databaseUrl.pathname.slice(1));
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u, 'DATABASE_URL must target a disposable webtopup_ci_* database');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname), 'DATABASE_URL must use loopback');
const origin = process.env.OPEN_API_SMOKE_ORIGIN;
const gatewayOrigin = process.env.OPEN_API_SMOKE_GATEWAY_ORIGIN;
const token = process.env.OPEN_API_SMOKE_MEMBER_TOKEN;
const memberCode = process.env.OPEN_API_SMOKE_MEMBER_CODE;
const proxySecret = process.env.API_V2_PROXY_SECRET;
assert.ok(origin, 'OPEN_API_SMOKE_ORIGIN must point to the disposable Rust API');
assert.ok(gatewayOrigin, 'OPEN_API_SMOKE_GATEWAY_ORIGIN must point to the disposable Node gateway');
assert.ok(token, 'OPEN_API_SMOKE_MEMBER_TOKEN must be a disposable SQL member token');
assert.match(memberCode || '', /^MBR[A-Z0-9]+$/u, 'OPEN_API_SMOKE_MEMBER_CODE must identify the disposable member');
assert.ok(proxySecret && proxySecret.length >= 32, 'API_V2_PROXY_SECRET must be set');
const productCode = process.env.OPEN_API_SMOKE_PRODUCT_CODE;
assert.ok(productCode, 'OPEN_API_SMOKE_PRODUCT_CODE must identify a disposable active product');

const keyManagementRoutes = new Set(['/v2/api/key', '/v2/api/key/generate', '/v2/api/key/revoke']);
let partnerAuth;
async function request(method, route, body) {
  const throughGateway = keyManagementRoutes.has(route);
  const requestOrigin = throughGateway ? gatewayOrigin : origin;
  const requestPath = throughGateway ? `/api/v2${route.slice(3)}` : route;
  const url = new URL(requestPath, requestOrigin);
  let requestHeaders;
  if (throughGateway) {
    requestHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  } else {
    assert.ok(partnerAuth, 'Open API key must be issued before partner requests');
    const refId = body?.refId || url.searchParams.get('refId') || '';
    const suppliedSignature = url.searchParams.get('signature');
    requestHeaders = {
      'content-type': 'application/json',
      'x-api-v2-proxy-secret': proxySecret,
      'x-open-api-member_id': memberCode,
      'x-open-api-api_key': partnerAuth.apiKey,
      'x-open-api-signature': suppliedSignature || crypto.createHash('md5').update(`${memberCode}:${partnerAuth.apiKey}:${partnerAuth.secret}:${refId}`).digest('hex'),
      ...(refId ? { 'x-open-api-ref_id': refId } : {}),
    };
  }
  return fetch(url, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
}
async function json(response, status, label) {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: status=${response.status} payload=${JSON.stringify(body)}`);
  return body;
}
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  await db.connect();
  let apiKey;
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    const member = await db.query('SELECT id, active FROM users WHERE member_code = $1 AND role = $2', [memberCode, 'member']);
    assert.equal(member.rowCount, 1, 'disposable member must exist exactly once');
    assert.equal(member.rows[0].active, true, 'disposable member must be active');

    const issued = await json(await request('POST', '/v2/api/key/generate', {}), 200, 'issue key');
    apiKey = issued.data?.apiKey || issued.apiKey;
    const secret = issued.data?.secret || issued.secret;
    partnerAuth = { apiKey, secret }
    const status = await json(await request('GET', '/v2/api/key'), 200, 'key status');
    assert.equal(status.data?.hasApiKey ?? status.hasApiKey, true);
    const signature = (refId) => crypto.createHash('md5').update(`${memberCode}:${apiKey}:${secret}:${refId}`).digest('hex');

    const goodRef = `smoke-${crypto.randomUUID()}`;
    const valid = await request('GET', `/v2/api/profile?memberCode=${encodeURIComponent(memberCode)}&apiKey=${encodeURIComponent(apiKey)}&refId=${encodeURIComponent(goodRef)}&signature=${signature(goodRef)}`);
    assert.ok(valid.status < 500, `valid signature must be processed, got ${valid.status}`);
    const invalid = await request('GET', `/v2/api/profile?memberCode=${encodeURIComponent(memberCode)}&apiKey=${encodeURIComponent(apiKey)}&refId=${encodeURIComponent(goodRef)}&signature=invalid`);
    assert.ok([400, 401, 403].includes(invalid.status), `invalid signature must be rejected, got ${invalid.status}`);
    const wrongRef = `smoke-${crypto.randomUUID()}`;
    const mismatched = await request('GET', `/v2/api/profile?memberCode=${encodeURIComponent(memberCode)}&apiKey=${encodeURIComponent(apiKey)}&refId=${encodeURIComponent(wrongRef)}&signature=${signature(goodRef)}`);
    assert.ok([400, 401, 403].includes(mismatched.status), `ref-bound signature mismatch must be rejected, got ${mismatched.status}`);

    for (const route of ['/v2/api/categories', '/v2/api/operators', '/v2/api/product-types', '/v2/api/products', '/v2/api/transactions?page=1&limit=5']) {
      const response = await request('GET', route);
      assert.ok(response.status < 500, `${route} SQL read should be available, got ${response.status}`);
    }
    const product = await db.query('SELECT id, price_basic FROM products WHERE code = $1 AND status = TRUE', [productCode]);
    assert.equal(product.rowCount, 1, 'disposable active Open API product must exist exactly once');
    const balanceBefore = BigInt((await db.query('SELECT balance FROM users WHERE id = $1', [member.rows[0].id])).rows[0].balance);
    const orderRef = `openapi-smoke-${crypto.randomUUID()}`;
    const payload = { productCode, target: 'smoke-disposable-target', refId: orderRef };
    const order = await request('POST', '/v2/api/transaction', payload);
    const orderText = await order.text();
    assert.ok([200, 201].includes(order.status), `disposable order should succeed, got ${order.status}: ${orderText}`);
    const orderBody = JSON.parse(orderText);
    assert.ok(orderBody.data?.trx_id, 'successful order must return transaction id');
    const replay = await request('POST', '/v2/api/transaction', payload);
    assert.ok([200, 201].includes(replay.status), `same-reference replay should return the existing order, got ${replay.status}`);
    const balanceAfter = BigInt((await db.query('SELECT balance FROM users WHERE id = $1', [member.rows[0].id])).rows[0].balance);
    const persisted = await db.query('SELECT id, amount, user_id, partner_ref FROM financial_transactions WHERE user_id = $1 AND partner_ref = $2', [member.rows[0].id, orderRef]);
    assert.equal(persisted.rowCount, 1, 'replay must not persist a second financial transaction');
    assert.equal(persisted.rows[0].amount, String(product.rows[0].price_basic));
    assert.equal(balanceBefore - balanceAfter, BigInt(product.rows[0].price_basic), 'replay must debit the member exactly once');
    const revoke = await json(await request('DELETE', '/v2/api/key/revoke', {}), 200, 'revoke key');
    assert.ok(revoke.message || revoke.success || revoke.data, 'revoke should report success');
    const revoked = await request('GET', `/v2/api/profile?memberCode=${encodeURIComponent(memberCode)}&apiKey=${encodeURIComponent(apiKey)}&refId=${encodeURIComponent(goodRef)}&signature=${signature(goodRef)}`);
    assert.ok([400, 401, 403].includes(revoked.status), `revoked key must be rejected, got ${revoked.status}`);
    apiKey = undefined;
    console.log('Open API SQL key/signature/read/order/replay/debit smoke passed.');
  } finally {
    if (apiKey) {
      // Best-effort cleanup is limited to the exact key just issued by this run.
      await db.query('UPDATE open_api_credentials SET active = false, secret_nonce = NULL, secret_ciphertext = NULL WHERE api_key = $1', [apiKey]);
    }
    await db.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
