const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'server/package.json'))('pg');
const { chromium } = createRequire(path.join(root, 'package.json'))('@playwright/test');
const dbUrl = new URL(process.env.DATABASE_URL || '');
const database = dbUrl.pathname.slice(1);
const origin = new URL(process.env.SQL_BROWSER_SMOKE_ORIGIN || '');
assert.match(database, /^webtopup_ci_[a-z0-9_]+$/u);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
const port = 19010;
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const email = `sql-browser-${crypto.randomUUID()}@example.test`;
  const password = `Browser-${crypto.randomBytes(20).toString('hex')}!`;
  let server, browser;
  await db.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
    const created = spawnSync(process.execPath, [path.join(root, 'scripts/create-owner.js')], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PGHOST: dbUrl.hostname, PGPORT: dbUrl.port || '5432', PGDATABASE: database,
        PGUSER: decodeURIComponent(dbUrl.username), PGPASSWORD: decodeURIComponent(dbUrl.password), BOOTSTRAP_DATABASE: database,
        OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_NAME: 'SQL Browser Smoke Owner' },
    });
    assert.equal(created.status, 0, 'owner bootstrap failed');
    server = spawn(path.join(root, 'rust-api/target/debug/webtopup-rust-api'), [], {
      cwd: root, stdio: 'ignore', env: { ...process.env, SQL_DATABASE: database, MONGO_URI: '', API_V2_HOST: '127.0.0.1', API_V2_PORT: String(port), RUST_LOG: 'warn' },
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null || server.signalCode !== null) break;
      try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Rust candidate must become healthy');
    browser = await chromium.launch({ headless: true, executablePath: process.env.DEV_VERIFICATION_CHROME_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const authResponses = [], pageErrors = [], failedRequests = [];
    page.on('response', response => { const pathname = new URL(response.url()).pathname; if (pathname.startsWith('/api/v2/auth/')) authResponses.push({ path: pathname, status: response.status() }); });
    page.on('pageerror', error => pageErrors.push({ name: error.name, message: String(error.message || '') }));
    page.on('requestfailed', request => failedRequests.push(new URL(request.url()).pathname));
    await page.goto(`${origin.origin}/staff/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await Promise.all([
      page.waitForURL(url => url.pathname === '/admin/dashboard', { timeout: 30000 }),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.getByRole('button', { name: 'Keluar dari admin' }).waitFor({ state: 'visible', timeout: 15000 });
    assert.ok(authResponses.some(response => response.path === '/api/v2/auth/staff/login' && response.status === 200));
    await page.screenshot({ path: '/tmp/sql-browser-auth-dashboard.png', fullPage: false });
    await db.query("UPDATE auth_sessions SET idle_expires_at=now()-interval '1 second' WHERE user_id=(SELECT id FROM users WHERE normalized_email=$1) AND state='active'", [email]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const lockDialog = page.getByRole('dialog', { name: 'Sesi dikunci' });
    await lockDialog.waitFor({ state: 'visible', timeout: 20000 });
    await lockDialog.getByLabel('Password', { exact: true }).fill(password);
    const unlockResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/auth/unlock');
    await lockDialog.getByRole('button', { name: 'Buka sesi' }).click();
    const unlockResult = await unlockResponse;
    const unlockPayload = await unlockResult.json();
    assert.equal(unlockResult.status(), 200, `unlock error=${unlockPayload.error?.code ?? 'none'}`);
    try {
      await lockDialog.waitFor({ state: 'hidden', timeout: 20000 });
    } catch (error) {
      await page.screenshot({ path: '/tmp/sql-browser-auth-unlock.png', fullPage: false });
      console.log(JSON.stringify({ unlockStatus: unlockResult.status(), dialogCount: await lockDialog.count(), alerts: await page.getByRole('alert').allTextContents(), authResponses }));
      throw error;
    }
    const unlockedState = await db.query('SELECT state,generation,idle_expires_at FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE normalized_email=$1)', [email]);
    assert.equal(unlockedState.rows[0].state, 'active');
    assert.ok(Number(unlockedState.rows[0].generation) >= 1);
    assert.ok(unlockedState.rows[0].idle_expires_at > new Date());
    const logoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/auth/logout');
    await page.getByRole('button', { name: 'Keluar dari admin' }).click();
    assert.equal((await logoutResponse).status(), 200);
    try {
      await page.waitForURL(url => url.pathname === '/staff/login', { timeout: 20000 });
    } catch (error) {
      await page.screenshot({ path: '/tmp/sql-browser-auth-logout.png', fullPage: false });
      console.log(JSON.stringify({ logoutUrlAfterResponse: page.url(), pageErrors, failedRequests, authResponses }));
      throw error;
    }
    await page.waitForSelector('#email', { state: 'visible', timeout: 20000 });
    assert.equal(await page.locator('#email').isVisible(), true);
    assert.deepEqual(pageErrors, []);
    const sessions = await db.query('SELECT state,owns_slot,generation,idle_expires_at FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE normalized_email=$1)', [email]);
    assert.ok(sessions.rows.every(row => row.state === 'revoked' && !row.owns_slot));
    console.log(JSON.stringify({ database, browser: 'Chromium', staffLogin: 'passed', idleUnlock: 'passed', logout: 'passed', sqlSessionRevokedAfterLogout: 'passed', authPageErrors: [], failedRequests, authResponses, screenshot: '/tmp/sql-browser-auth-dashboard.png' }));
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited; }
    }
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
