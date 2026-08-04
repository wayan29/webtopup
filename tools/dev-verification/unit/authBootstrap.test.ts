import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clearAuthCookies, CSRF_COOKIE, CSRF_COOKIE_PATH, ensureCsrfCookie, RECOVERY_COOKIE, RECOVERY_COOKIE_PATH, REFRESH_COOKIE, REFRESH_COOKIE_PATH, requireTrustedAuthMutation, requiresCsrfProof } from '../../../server/src/utils/authCookies.ts';
import { authCookieDisposition } from '../../../server/src/utils/authErrors.ts';
import { resolveBootstrapFailurePhase } from '../../../client/src/auth/authErrors.ts';
import { credentialResponseRequiresCookies, prepareRewrittenJsonHeaders } from '../../../server/src/routes/apiV2ProxyRoutes.ts';

test('anonymous refresh reaches typed unauthenticated handler without weakening credentialed CSRF', () => {
  assert.equal(requiresCsrfProof({}), false);
  assert.equal(requiresCsrfProof({ [REFRESH_COOKIE]: 'synthetic' }), true);
  assert.equal(requiresCsrfProof({ [RECOVERY_COOKIE]: 'synthetic' }), true);
  assert.equal(requiresCsrfProof({ [REFRESH_COOKIE]: 'synthetic', [RECOVERY_COOKIE]: 'synthetic' }), true);
  assert.equal(requiresCsrfProof({ [CSRF_COOKIE]: 'synthetic' }), false);
});

type FakeReply = {
  sent: boolean;
  statusCode?: number;
  payload?: unknown;
  cleared: string[];
  status: (code: number) => FakeReply;
  send: (payload: unknown) => FakeReply;
  clearCookie: (name: string, options?: Record<string, unknown>) => FakeReply;
};
const reply = (): FakeReply => {
  const value = { sent: false, cleared: [] as string[] } as FakeReply;
  value.status = (code) => { value.statusCode = code; return value; };
  value.send = (payload) => { value.payload = payload; value.sent = true; return value; };
  value.clearCookie = (name) => { value.cleared.push(name); return value; };
  return value;
};
const runMiddleware = async (input: { origin?: string; contentType?: string; cookies?: Record<string, string>; csrf?: string }) => {
  process.env.PUBLIC_APP_URL = 'https://webtopup.local.test:9443';
  const response = reply();
  await requireTrustedAuthMutation({
    headers: {
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.contentType ? { 'content-type': input.contentType } : {}),
      ...(input.csrf ? { 'x-csrf-token': input.csrf } : {}),
    },
    cookies: input.cookies ?? {},
  } as never, response as never);
  return response;
};

test('anonymous exception still enforces trusted Origin and JSON content type', async () => {
  assert.equal((await runMiddleware({ contentType: 'application/json' })).statusCode, 403);
  assert.equal((await runMiddleware({ origin: 'https://evil.invalid', contentType: 'application/json' })).statusCode, 403);
  assert.equal((await runMiddleware({ origin: 'https://webtopup.local.test:9443', contentType: 'text/plain' })).statusCode, 415);
  assert.equal((await runMiddleware({ origin: 'https://webtopup.local.test:9443', contentType: 'application/json' })).sent, false);
});

test('every credential-cookie combination requires matching CSRF proof', async () => {
  const trusted = { origin: 'https://webtopup.local.test:9443', contentType: 'application/json' };
  for (const cookies of [
    { [REFRESH_COOKIE]: 'credential' },
    { [RECOVERY_COOKIE]: 'credential' },
    { [REFRESH_COOKIE]: 'credential', [RECOVERY_COOKIE]: 'recovery' },
  ]) {
    // Missing CSRF cookie entirely is an orphaned-credential case, covered as terminal below.
    assert.equal((await runMiddleware({ ...trusted, cookies })).statusCode, 401);
    assert.equal((await runMiddleware({ ...trusted, cookies: { ...cookies, [CSRF_COOKIE]: 'proof' }, csrf: 'wrong' })).statusCode, 403);
    assert.equal((await runMiddleware({ ...trusted, cookies: { ...cookies, [CSRF_COOKIE]: 'proof' }, csrf: 'proof' })).sent, false);
  }
});

test('missing CSRF cookie beside a credential cookie is terminal, not an unrecoverable 403', async () => {
  // wb_csrf is a session cookie while the credential cookies live for hours, so closing the
  // browser leaves credentials without CSRF proof. That must route to login, not hang bootstrap.
  const trusted = { origin: 'https://webtopup.local.test:9443', contentType: 'application/json' };
  for (const cookies of [
    { [REFRESH_COOKIE]: 'credential' },
    { [RECOVERY_COOKIE]: 'credential' },
    { [REFRESH_COOKIE]: 'credential', [RECOVERY_COOKIE]: 'recovery' },
  ]) {
    const response = await runMiddleware({ ...trusted, cookies });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(
      (response.payload as { error?: { code?: string } })?.error?.code,
      'AUTH_TOKEN_INVALID'
    );
    // Stale credentials must be tombstoned so the next bootstrap starts anonymous.
    assert.deepEqual(response.cleared, [REFRESH_COOKIE, RECOVERY_COOKIE, CSRF_COOKIE]);
  }
});

test('a present CSRF cookie with a wrong header still fails closed with 403', async () => {
  const trusted = { origin: 'https://webtopup.local.test:9443', contentType: 'application/json' };
  const cookies = { [REFRESH_COOKIE]: 'credential', [CSRF_COOKIE]: 'proof' };
  assert.equal((await runMiddleware({ ...trusted, cookies })).statusCode, 403);
  assert.equal((await runMiddleware({ ...trusted, cookies, csrf: 'wrong' })).statusCode, 403);
  assert.equal((await runMiddleware({ ...trusted, cookies, csrf: 'proof' })).sent, false);
});

test('the CSRF cookie outlives the browser session so credentials never orphan it', () => {
  const set: Array<{ name: string; options: Record<string, unknown> }> = [];
  ensureCsrfCookie({
    setCookie: (name: string, _value: string, options: Record<string, unknown>) => {
      set.push({ name, options });
    },
  } as never);
  assert.equal(set.length, 1);
  assert.equal(set[0]!.name, CSRF_COOKIE);
  assert.equal(typeof set[0]!.options.maxAge, 'number');
  assert.ok((set[0]!.options.maxAge as number) > 0);
});

test('credential tombstones preserve secure-prefix and exact path contracts', () => {
  const cleared: Array<{ name: string; options: Record<string, unknown> }> = [];
  clearAuthCookies({ clearCookie: (name: string, options: Record<string, unknown>) => { cleared.push({ name, options }); } } as never);
  const secure = process.env.NODE_ENV === 'production';
  assert.deepEqual(cleared, [
    { name: REFRESH_COOKIE, options: { path: REFRESH_COOKIE_PATH, secure } },
    { name: RECOVERY_COOKIE, options: { path: RECOVERY_COOKIE_PATH, secure } },
    { name: CSRF_COOKIE, options: { path: CSRF_COOKIE_PATH, secure } },
  ]);
});

test('production import resolves exact secure credential cookie names', () => {
  const modulePath = path.resolve(import.meta.dirname, '../../../server/src/utils/authCookies.ts');
  const script = `import(${JSON.stringify(modulePath)}).then(m=>{const calls=[];m.clearAuthCookies({clearCookie:(name,options)=>calls.push({name,options})});console.log(JSON.stringify({names:[m.REFRESH_COOKIE,m.RECOVERY_COOKIE],calls}))})`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: path.resolve(import.meta.dirname, '../../..'), env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), {
    names: ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery'],
    calls: [
      { name: '__Secure-wb_refresh', options: { path: '/api/v2/auth', secure: true } },
      { name: '__Secure-wb_rotation_recovery', options: { path: '/api/v2/auth', secure: true } },
      { name: 'wb_csrf', options: { path: '/', secure: true } },
    ],
  });
});

test('rewritten auth JSON payload drops stale browser framing headers', () => {
  const routeSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../../server/src/routes/apiV2ProxyRoutes.ts'), 'utf8');
  assert.match(routeSource, /prepareRewrittenJsonHeaders\(forwardHeadersWithTrace\(request, proxySecret, gatewayCorrelationId\)\)[\s\S]{0,300}JSON\.stringify\(logout \? \{ refreshToken \} : \{ refreshToken, recoveryToken \}\)/u);
  assert.match(routeSource, /const proxyUnlock[\s\S]*?prepareRewrittenJsonHeaders\(forwardHeadersWithTrace\(request, proxySecret, gatewayCorrelationId\)\)[\s\S]*?JSON\.stringify\(\{ \.\.\.body, refreshToken, recoveryToken \}\)/u);
  const headers = new Headers({ 'content-length': '2', 'content-type': 'text/plain', origin: 'https://webtopup.local.test:9443' });
  const prepared = prepareRewrittenJsonHeaders(headers);
  assert.equal(prepared.get('content-length'), null);
  assert.equal(prepared.get('content-type'), 'application/json');
  assert.equal(prepared.get('origin'), 'https://webtopup.local.test:9443');
});

test('session policy change clears terminal credential cookies', () => {
  assert.equal(authCookieDisposition('AUTH_SESSION_POLICY_CHANGED'), 'clear');
});

test('typed 2FA login challenge does not require credential cookies', () => {
  assert.equal(credentialResponseRequiresCookies({ accessToken: 'synthetic', refreshToken: 'synthetic', recoveryToken: 'synthetic' }), true);
  assert.equal(credentialResponseRequiresCookies({ message: 'Two-factor verification required', requiresTwoFactor: true, challengeToken: 'synthetic' }), false);
  assert.equal(credentialResponseRequiresCookies({ requiresTwoFactor: true }), true);
  assert.equal(credentialResponseRequiresCookies({ challengeToken: 'synthetic' }), true);
  assert.equal(credentialResponseRequiresCookies({ message: 'Two-factor verification required', requiresTwoFactor: true, challengeToken: '   ' }), true);
  assert.equal(credentialResponseRequiresCookies({ message: 'Two-factor verification required', requiresTwoFactor: true, challengeToken: 'synthetic', accessToken: 'mixed' }), true);
  assert.equal(credentialResponseRequiresCookies({ message: 'Two-factor verification required', requiresTwoFactor: true, challengeToken: 'synthetic', unexpected: true }), true);
});

test('typed missing-session outcome transitions bootstrap to revoked rather than retry screen', () => {
  assert.equal(resolveBootstrapFailurePhase({ status: 401, code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' }), 'revoked');
});

test('an idle-locked refresh routes to the lock screen instead of the bootstrap retry screen', () => {
  // A 423 AUTH_IDLE_LOCKED refresh during bootstrap is a lockable session, not a failed
  // verification. Routing it to 'bootstrap-retry' shows "Verifikasi sesi tertunda" with a Coba
  // lagi button that re-runs the same refresh, which the server answers 423 again and then
  // rate-limits with 429, leaving no way to reach the password/OTP unlock form.
  assert.equal(
    resolveBootstrapFailurePhase({ status: 423, code: 'AUTH_IDLE_LOCKED', message: 'Sesi terkunci' }),
    'locked'
  );
});

test('a rate-limited bootstrap refresh enters a non-retrying phase', () => {
  // 429 means the server is refusing more attempts for now. Reusing offline-stale would still
  // expose Coba lagi and auto-refresh on visibility/online, guaranteeing another 429.
  assert.equal(
    resolveBootstrapFailurePhase({ status: 429, message: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' }),
    'rate-limited'
  );
});
