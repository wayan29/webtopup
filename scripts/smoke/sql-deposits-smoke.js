#!/usr/bin/env node
// Fixtures persist because the financial ledger is append-only. Run only on an empty, confirmed disposable DB and destroy that DB after the smoke.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'server/package.json'))('pg');
const databaseUrl = process.env.DATABASE_URL || '';
const proxySecret = process.env.API_V2_PROXY_SECRET;
const rustBinary = path.join(root, 'rust-api/target/debug/webtopup-rust-api');
const databaseUrlParsed = new URL(databaseUrl);
const database = decodeURIComponent(databaseUrlParsed.pathname.slice(1));
const port = 19026;
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u, 'DATABASE_URL must target webtopup_ci_*');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrlParsed.hostname), 'DATABASE_URL must use loopback');
assert.equal(process.env.DEPOSIT_SMOKE_CONFIRM, `DISPOSABLE:${database}`, 'set DEPOSIT_SMOKE_CONFIRM=DISPOSABLE:<database>');
assert.ok(proxySecret && proxySecret.length >= 32, 'API_V2_PROXY_SECRET is required');
const origin = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': proxySecret };

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0; let accumulator = 0; const bytes = [];
  for (const character of value.toUpperCase().replace(/=+$/u, '')) {
    const digit = alphabet.indexOf(character); assert.notEqual(digit, -1, 'invalid TOTP seed');
    accumulator = (accumulator << 5) | digit; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >> bits) & 0xff); }
  }
  return Buffer.from(bytes);
}
function totp(seed, counter) {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', seed).update(message).digest(); const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function nextOtpCode(db, email, seed) {
  for (let attempt = 0; attempt < 65; attempt += 1) {
    const row = (await db.query('SELECT last_otp_counter FROM users WHERE normalized_email=$1', [email])).rows[0];
    const last = row.last_otp_counter === null ? -1 : Number(row.last_otp_counter);
    const current = Math.floor(Date.now() / 30000); const counter = Math.max(current - 2, last + 1);
    if (counter <= current + 2) return totp(seed, counter);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('no available TOTP counter');
}
async function json(response, status, label) {
  const body = await response.json(); assert.equal(response.status, status, `${label}: ${response.status} ${JSON.stringify(body)}`); return body;
}
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function main() {
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const suffix = crypto.randomUUID(); const email = `deposit-smoke-${suffix}@example.test`;
  const memberEmail = `deposit-member-${suffix}@example.test`; const password = `Deposit-${crypto.randomBytes(20).toString('hex')}!`;
  let server; let categoryId; let methodId; let memberId;
  await db.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    const existing = await db.query(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM deposits)::int AS deposits, (SELECT count(*) FROM ledger_entries)::int AS ledger`);
    assert.deepEqual(existing.rows[0], { users: 0, deposits: 0, ledger: 0 }, 'deposit smoke requires an empty disposable database');
    const bootstrap = spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PGHOST: databaseUrlParsed.hostname, PGPORT: databaseUrlParsed.port || '5432', PGDATABASE: database,
        PGUSER: decodeURIComponent(databaseUrlParsed.username), PGPASSWORD: decodeURIComponent(databaseUrlParsed.password), BOOTSTRAP_DATABASE: database,
        OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_NAME: 'SQL Deposit Smoke Owner' },
    });
    assert.equal(bootstrap.status, 0, `owner bootstrap failed: ${bootstrap.stderr}`);
    const bcrypt = createRequire(path.join(root, 'server/package.json'))('bcrypt');
    const memberHash = await bcrypt.hash(password, 10);
    memberId = (await db.query("INSERT INTO users(email,password_hash,name,role,active,balance,points,role_updated_at,policy_updated_at) VALUES($1,$2,'Deposit Smoke Member','member',true,0,0,now(),now()) RETURNING id", [memberEmail, memberHash])).rows[0].id;
    server = spawn(rustBinary, [], { cwd: root, stdio: 'ignore', env: { ...process.env, SQL_DATABASE: database, MONGO_URI: '', API_V2_HOST: '127.0.0.1', API_V2_PORT: String(port), RUST_LOG: 'warn' } });
    let healthy = false;
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null || server.signalCode !== null) break;
      try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) })).ok) { healthy = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, 'Rust API did not become healthy');
    const initial = await json(await fetch(`${origin}/v2/auth/staff/login`, { method: 'POST', headers, body: JSON.stringify({ email, password }) }), 200, 'owner login');
    const initialHeaders = { ...headers, authorization: `Bearer ${initial.accessToken}`, 'x-webtopup-session-id': initial.session.sessionId };
    const setup = await json(await fetch(`${origin}/v2/auth/2fa/setup`, { method: 'POST', headers: initialHeaders }), 200, '2FA setup');
    const seed = base32Decode(setup.secret);
    await json(await fetch(`${origin}/v2/auth/2fa/confirm`, { method: 'POST', headers: initialHeaders, body: JSON.stringify({ code: totp(seed, Math.floor(Date.now() / 30000) + 1), recoveryToken: initial.recoveryToken }) }), 200, '2FA confirm');
    const challenge = await json(await fetch(`${origin}/v2/auth/staff/login`, { method: 'POST', headers, body: JSON.stringify({ email, password }) }), 200, '2FA login challenge');
    const authenticated = await json(await fetch(`${origin}/v2/auth/2fa/login-verify`, { method: 'POST', headers, body: JSON.stringify({ challengeToken: challenge.challengeToken, code: await nextOtpCode(db, email, seed) }) }), 200, '2FA login');
    const staffHeaders = { ...headers, authorization: `Bearer ${authenticated.accessToken}`, 'x-webtopup-session-id': authenticated.session.sessionId };
    const stepUp = await json(await fetch(`${origin}/v2/auth/step-up`, { method: 'POST', headers: staffHeaders, body: JSON.stringify({ password, otp: await nextOtpCode(db, email, seed), actionGroup: 'finance.deposit_approval' }) }), 200, 'finance step-up');
    const approvalHeaders = { ...staffHeaders, 'x-webtopup-step-up-group': 'finance.deposit_approval', 'x-webtopup-step-up-token': stepUp.stepUpToken };
    const paymentStepUp = await json(await fetch(`${origin}/v2/auth/step-up`, { method: 'POST', headers: staffHeaders, body: JSON.stringify({ password, otp: await nextOtpCode(db, email, seed), actionGroup: 'integrations.credentials' }) }), 200, 'payment method step-up');
    const paymentHeaders = { ...staffHeaders, 'x-webtopup-step-up-group': 'integrations.credentials', 'x-webtopup-step-up-token': paymentStepUp.stepUpToken };
    const short = suffix.replaceAll('-', '').slice(0, 12);
    const category = await json(await fetch(`${origin}/v2/payment-categories`, { method: 'POST', headers: staffHeaders, body: JSON.stringify({ name: `Deposit Smoke ${short}`, slug: `deposit-smoke-${short}`, status: 'active', order: 10 }) }), 201, 'category create');
    categoryId = category.category._id;
    const method = await json(await fetch(`${origin}/v2/payment-methods`, { method: 'POST', headers: paymentHeaders, body: JSON.stringify({ name: `Smoke Transfer ${short}`, category: categoryId, accountNumber: `SMOKE-${short}`, accountName: 'Deposit Smoke', icon: '', minAmount: 1000, maxAmount: 1000000, adminFee: 0, adminPercent: 0, operationalStart: '00:00', operationalEnd: '23:59', useUniqueCode: false, status: 'active' }) }), 201, 'payment method create');
    methodId = method.method._id;
    const memberLogin = await json(await fetch(`${origin}/v2/auth/member/login`, { method: 'POST', headers, body: JSON.stringify({ email: memberEmail, password }) }), 200, 'member login');
    const memberHeaders = { ...headers, authorization: `Bearer ${memberLogin.accessToken}` };
    async function requestDeposit(amount) {
      const result = await json(await fetch(`${origin}/v2/deposits`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ amount, paymentMethodId: methodId }) }), 201, 'member deposit request');
      assert.equal(result.message, 'Deposit requested'); assert.equal(result.deposit.status, 'pending');
      assert.equal(result.paymentInfo.amount, amount); return result.deposit.id || result.deposit._id;
    }
    const approvedId = await requestDeposit(20000); const rejectedId = await requestDeposit(30000);
    const listing = await json(await fetch(`${origin}/v2/deposits/admin/all?limit=100`, { headers: staffHeaders }), 200, 'admin deposit listing');
    assert.ok(listing.items.some(item => String(item.id || item._id) === String(approvedId)));
    const claim = await json(await fetch(`${origin}/v2/deposits/${approvedId}/claim`, { method: 'POST', headers: staffHeaders }), 200, 'claim approved deposit');
    assert.equal(claim.message, 'Deposit claimed');
    const rejectClaim = await json(await fetch(`${origin}/v2/deposits/${rejectedId}/claim`, { method: 'POST', headers: staffHeaders }), 200, 'claim rejected deposit');
    assert.equal(rejectClaim.message, 'Deposit claimed');
    const before = Number((await db.query('SELECT balance FROM users WHERE id=$1', [memberId])).rows[0].balance);
    const approved = await json(await fetch(`${origin}/v2/deposits/${approvedId}/approve`, { method: 'PUT', headers: approvalHeaders, body: JSON.stringify({ note: 'SQL deposit smoke approval' }) }), 200, 'approve deposit');
    assert.equal(approved.message, 'Deposit approved'); assert.equal(approved.deposit.status, 'approved');
    assert.equal(approved.newBalance, before + approved.netAmountAdded);
    const replay = await fetch(`${origin}/v2/deposits/${approvedId}/approve`, { method: 'PUT', headers: approvalHeaders, body: JSON.stringify({ note: 'duplicate attempt' }) });
    assert.equal(replay.status, 409, 'approval replay must conflict');
    const rejected = await json(await fetch(`${origin}/v2/deposits/${rejectedId}/reject`, { method: 'PUT', headers: approvalHeaders, body: JSON.stringify({ note: 'SQL deposit smoke rejection' }) }), 200, 'reject deposit');
    assert.equal(rejected.message, 'Deposit rejected'); assert.equal(rejected.deposit.status, 'rejected');
    const balance = Number((await db.query('SELECT balance FROM users WHERE id=$1', [memberId])).rows[0].balance);
    assert.equal(balance, before + approved.netAmountAdded);
    const source = `deposit-approve:${approvedId}`;
    const ledger = await db.query("SELECT count(*)::int AS count,coalesce(sum(amount),0)::bigint AS amount FROM ledger_entries WHERE user_id=$1 AND source=$2 AND kind='credit' AND direction=1", [memberId, source]);
    assert.equal(ledger.rows[0].count, 1); assert.equal(Number(ledger.rows[0].amount), approved.netAmountAdded);
    const audit = await db.query("SELECT count(*)::int AS count FROM financial_audits WHERE action='deposit-approve' AND subject_id=$1 AND operation_key=$2", [approvedId, source]);
    assert.equal(audit.rows[0].count, 1);
    assert.equal(Number((await db.query("SELECT count(*) FROM ledger_entries WHERE user_id=$1 AND source LIKE 'deposit-approve:%' AND source<>$2", [memberId, source])).rows[0].count), 0);
    assert.equal(Number((await db.query("SELECT count(*) FROM ledger_entries WHERE user_id=$1 AND source=$2", [memberId, `deposit-approve:${rejectedId}`])).rows[0].count), 0);
    assert.equal(Number((await db.query("SELECT count(*) FROM financial_audits WHERE action='deposit-approve' AND subject_id=$1", [rejectedId])).rows[0].count), 0);
    assert.equal(Number((await db.query('SELECT balance FROM users WHERE id=$1', [memberId])).rows[0].balance), balance);
    console.log(JSON.stringify({ memberRequest: 'passed', staffClaim: 'passed', approvalAndExactlyOnceCreditLedgerAudit: 'passed', rejectionWithoutCredit: 'passed', fixtures: 'destroy the disposable database after this run' }));
  } finally {
    try { await stopServer(server); } finally { await db.end(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
