import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Fastify from '../../../server/node_modules/fastify/fastify.js';
import cookie from '../../../server/node_modules/@fastify/cookie/plugin.js';
import apiV2ProxyRoutes from '../../../server/src/routes/apiV2ProxyRoutes.ts';
import { CSRF_COOKIE, RECOVERY_COOKIE, REFRESH_COOKIE } from '../../../server/src/utils/authCookies.ts';
import { registerGatewayCorrelationLifecycle } from '../../../server/src/utils/correlation.ts';

const syntheticRefresh = '000000000000000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const syntheticRecovery = '000000000000000000000001.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const syntheticCsrf = 'synthetic-csrf-proof';

test('credential proxy passes only exact 2FA challenges without installing cookies', async () => {
  let mixed = false;
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(mixed
      ? { message: 'Two-factor verification required', requiresTwoFactor: true, challengeToken: 'synthetic-challenge', accessToken: 'must-not-leak' }
      : { message: 'Two-factor verification required', requiresTwoFactor: true, challengeToken: 'synthetic-challenge' }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const previousEnv = Object.fromEntries(['API_V2_UPSTREAM_URL', 'API_V2_PROXY_SECRET', 'PUBLIC_APP_URL'].map((name) => [name, process.env[name]]));
  process.env.API_V2_UPSTREAM_URL = `http://127.0.0.1:${address.port}`;
  process.env.API_V2_PROXY_SECRET = 'synthetic-proxy-secret-for-challenge-test';
  process.env.PUBLIC_APP_URL = 'https://webtopup.local.test:9443';
  const app = Fastify({ logger: false });
  try {
    registerGatewayCorrelationLifecycle(app);
    await app.register(cookie);
    await app.register(apiV2ProxyRoutes, { prefix: '/api/v2' });
    const request = { method: 'POST' as const, url: '/api/v2/auth/member/login', headers: { origin: process.env.PUBLIC_APP_URL, 'content-type': 'application/json' }, payload: { email: 'synthetic@task14.invalid', password: 'synthetic-password' } };
    const challenge = await app.inject(request);
    assert.equal(challenge.statusCode, 200);
    assert.deepEqual(challenge.json(), { message: 'Two-factor verification required', requiresTwoFactor: true, challengeToken: 'synthetic-challenge' });
    assert.equal(challenge.headers['set-cookie'], undefined);
    mixed = true;
    const rejected = await app.inject(request);
    assert.equal(rejected.statusCode, 502);
    assert.equal(rejected.body.includes('must-not-leak'), false);
    assert.equal(rejected.headers['set-cookie'], undefined);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of Object.entries(previousEnv)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test('refresh proxy forwards the exact synthetic cookie pair in rewritten JSON', async () => {
  let observed = { refreshExact: false, recoveryExact: false, contentLengthExact: false, browserCookieForwarded: false };
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      observed = {
        refreshExact: payload.refreshToken === syntheticRefresh,
        recoveryExact: payload.recoveryToken === syntheticRecovery,
        contentLengthExact: request.headers['content-length'] === String(raw.length),
        browserCookieForwarded: typeof request.headers.cookie === 'string',
      };
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'AUTH_TOKEN_INVALID', message: 'synthetic boundary response' } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');

  const previousEnv = Object.fromEntries(['API_V2_UPSTREAM_URL', 'API_V2_PROXY_SECRET', 'PUBLIC_APP_URL'].map((name) => [name, process.env[name]]));
  process.env.API_V2_UPSTREAM_URL = `http://127.0.0.1:${address.port}`;
  process.env.API_V2_PROXY_SECRET = 'synthetic-proxy-secret-for-boundary-test';
  process.env.PUBLIC_APP_URL = 'https://webtopup.local.test:9443';
  const app = Fastify({ logger: false });
  try {
    registerGatewayCorrelationLifecycle(app);
    await app.register(cookie);
    await app.register(apiV2ProxyRoutes, { prefix: '/api/v2' });
    const response = await app.inject({
      method: 'POST', url: '/api/v2/auth/refresh',
      headers: {
        origin: process.env.PUBLIC_APP_URL,
        'content-type': 'application/json',
        'x-csrf-token': syntheticCsrf,
        cookie: `${REFRESH_COOKIE}=${syntheticRefresh}; ${RECOVERY_COOKIE}=${syntheticRecovery}; ${CSRF_COOKIE}=${syntheticCsrf}`,
      },
      payload: {},
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(observed, {
      refreshExact: true,
      recoveryExact: true,
      contentLengthExact: true,
      browserCookieForwarded: false,
    });
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
