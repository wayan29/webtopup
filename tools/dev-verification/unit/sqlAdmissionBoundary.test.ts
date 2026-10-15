import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Fastify from '../../../server/node_modules/fastify/fastify.js';
import cookie from '../../../server/node_modules/@fastify/cookie/plugin.js';
import { authenticate, authenticateUnlock, hasPermission } from '../../../server/src/middlewares/authMiddleware.ts';
import type { AuthRequest } from '../../../server/src/middlewares/authMiddleware.ts';
import { REFRESH_COOKIE, RECOVERY_COOKIE } from '../../../server/src/utils/authCookies.ts';

const sid = '12345678-1234-4234-8234-123456789abc';
const userId = '12345678-1234-4234-8234-123456789abd';

test('SQL admission rejects browser identity, preserves typed rejection and fails closed on upstream errors', async () => {
  let mode = 'denied';
  let observed: http.IncomingHttpHeaders = {};
  let body: Record<string, unknown> = {};
  const upstream = http.createServer((request, response) => {
    observed = request.headers;
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString());
      if (mode === 'unavailable') { response.writeHead(500); response.end('private database failure'); return; }
      if (mode === 'denied') { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'AUTH_SESSION_REVOKED', message: 'Session revoked' } })); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ user: { id: userId, email: 'staff@example.invalid', role: 'cs', permissions: [] }, sessionId: mode === 'invalid' ? sid.replaceAll('-', '').slice(0, 24) : sid, admissionKind: mode === 'unlock' ? 'unlock' : 'ordinary' }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const names = ['API_V2_UPSTREAM_URL', 'API_V2_PROXY_SECRET'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.API_V2_UPSTREAM_URL = `http://127.0.0.1:${address.port}`;
  process.env.API_V2_PROXY_SECRET = 'synthetic-exact-proxy-secret-at-least-32';
  const app = Fastify();
  await app.register(cookie);
  app.get('/api/v2/protected', { preHandler: authenticate }, async request => ({ user: (request as AuthRequest).user }));
  app.get('/api/v2/permission', { preHandler: [authenticate, hasPermission('viewUsers')] }, async () => ({ ok: true }));
  app.post('/api/v2/auth/unlock', { preHandler: authenticateUnlock }, async request => ({ user: (request as AuthRequest).user }));
  try {
    const spoofed = { 'x-webtopup-session-id': sid, 'x-user-id': userId, 'x-api-v2-proxy-secret': 'browser-secret' };
    assert.equal((await app.inject({ url: '/api/v2/protected', headers: spoofed })).statusCode, 401);
    const headers = { ...spoofed, authorization: 'Bearer signed-token' };
    const revoked = await app.inject({ url: '/api/v2/protected', headers });
    assert.equal(revoked.json().error.code, 'AUTH_SESSION_REVOKED');
    assert.equal(observed.authorization, 'Bearer signed-token');
    assert.equal(observed['x-api-v2-proxy-secret'], process.env.API_V2_PROXY_SECRET);
    assert.equal(observed['x-user-id'], undefined);
    assert.deepEqual(body, { method: 'GET', path: '/protected' });
    mode = 'invalid';
    assert.equal((await app.inject({ url: '/api/v2/protected', headers })).statusCode, 502);
    mode = 'ordinary';
    assert.equal((await app.inject({ url: '/api/v2/permission', headers: { ...headers, 'x-user-permissions': 'viewUsers' } })).statusCode, 403);
    mode = 'unlock';
    const unlock = await app.inject({ method: 'POST', url: '/api/v2/auth/unlock', headers: { cookie: `${REFRESH_COOKIE}=${sid}.refresh; ${RECOVERY_COOKIE}=${sid}.recovery` } });
    assert.equal(unlock.statusCode, 200);
    assert.equal(unlock.json().user.sessionId, sid);
    assert.equal(observed.authorization, undefined);
    assert.deepEqual(body, { method: 'POST', path: '/auth/unlock', refreshToken: `${sid}.refresh`, recoveryToken: `${sid}.recovery` });
    mode = 'unavailable';
    const failure = await app.inject({ url: '/api/v2/protected', headers });
    assert.equal(failure.statusCode, 503);
    assert.equal(failure.body.includes('private database failure'), false);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});
