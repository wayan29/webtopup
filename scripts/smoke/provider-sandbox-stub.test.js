'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Reserved synthetic fixture markers (never production identities).
 * These exact IDs / suffixes are used only by the local provider sandbox.
 *
 * - ML success: userId=syn-ml-ok, zoneId=syn-zone-ok
 * - FF success: userId=syn-ff-ok
 * - Explicit invalid (public sandbox contract): userId=syn-invalid
 * - Explicit outage (public sandbox contract): userId=syn-outage
 *
 * Explicit invalid responses carry sandbox-only marker/header for Rust gate:
 * body.sandboxMarker === 'webtopup-sandbox-invalid' and header x-webtopup-sandbox: invalid.
 * Production/default provider classification remains conservative ProviderError.
 */
const FIXTURES = {
  mlUserId: 'syn-ml-ok',
  mlZoneId: 'syn-zone-ok',
  ffUserId: 'syn-ff-ok',
  invalidUserId: 'syn-invalid',
  outageUserId: 'syn-outage',
};

const stubPath = path.join(__dirname, 'provider-sandbox-stub.js');

function request(server, { method = 'GET', path: requestPath = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: address.address,
        port: address.port,
        method,
        path: requestPath,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode, raw, json, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('provider-sandbox-stub contracts', () => {
  let createProviderSandboxServer;
  let DEFAULT_HOST;
  let DEFAULT_PORT;
  let SANDBOX_INVALID_MARKER;
  let SANDBOX_INVALID_HEADER;
  let SANDBOX_INVALID_HEADER_VALUE;
  let validateBindConfig;
  let server;

  before(() => {
    ({
      createProviderSandboxServer,
      DEFAULT_HOST,
      DEFAULT_PORT,
      SANDBOX_INVALID_MARKER,
      SANDBOX_INVALID_HEADER,
      SANDBOX_INVALID_HEADER_VALUE,
      validateBindConfig,
    } = require(stubPath));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it('defaults to loopback host and port 9020', () => {
    assert.equal(DEFAULT_HOST, '127.0.0.1');
    assert.equal(DEFAULT_PORT, 9020);
  });

  it('hard rejects CLI/config host other than exact 127.0.0.1 including 0.0.0.0', () => {
    assert.equal(validateBindConfig('0.0.0.0', 9020), false);
    assert.equal(validateBindConfig('127.0.0.1', 9020), true);
    assert.equal(validateBindConfig('127.0.0.1', 19020), false);
    assert.equal(validateBindConfig('localhost', 9020), false);

    const rejected = spawnSync(process.execPath, [stubPath], {
      env: {
        ...process.env,
        PROVIDER_SANDBOX_HOST: '0.0.0.0',
        PROVIDER_SANDBOX_PORT: '9020',
      },
      encoding: 'utf8',
      timeout: 2000,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stderr}\n${rejected.stdout}`, /invalid_bind/);
  });

  it('exports a server factory and binds only to loopback when started', async () => {
    assert.equal(typeof createProviderSandboxServer, 'function');
    server = createProviderSandboxServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.notEqual(address.port, 0);
  });

  it('GET /health returns non-secret status/service contract', async () => {
    const response = await request(server, { path: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json, {
      status: 'ok',
      service: 'provider-sandbox',
    });
    const serialized = JSON.stringify(response.json);
    assert.equal(serialized.includes('env'), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('password'), false);
    assert.equal(serialized.includes('token'), false);
  });

  it('returns deterministic Mobile Legends success nickname for reserved fixture', async () => {
    const response = await request(server, {
      method: 'POST',
      path: '/initPayment.action',
      body: {
        voucherTypeName: 'MOBILE_LEGENDS',
        'user.userId': FIXTURES.mlUserId,
        'user.zoneId': FIXTURES.mlZoneId,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.success, true);
    assert.equal(response.json.errorMsg, undefined);
    const nickname = decodeURIComponent(response.json.confirmationFields.username);
    assert.match(nickname, /Sandbox ML/);
    assert.match(nickname, new RegExp(FIXTURES.mlUserId));
    assert.match(nickname, new RegExp(FIXTURES.mlZoneId));
  });

  it('returns deterministic Free Fire success nickname for reserved fixture', async () => {
    const response = await request(server, {
      method: 'POST',
      path: '/initPayment.action',
      body: {
        voucherTypeName: 'FREEFIRE',
        'user.userId': FIXTURES.ffUserId,
        'user.zoneId': '',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.success, true);
    assert.equal(response.json.errorMsg, undefined);
    const nickname = decodeURIComponent(response.json.confirmationFields.username);
    assert.match(nickname, /Sandbox FF/);
    assert.match(nickname, new RegExp(FIXTURES.ffUserId));
  });

  it('returns deterministic GoPay Free Fire success for reserved fixture', async () => {
    const response = await request(server, {
      path: `/games/v1/order/prepare/FREEFIRE?userId=${encodeURIComponent(FIXTURES.ffUserId)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.message, 'success');
    assert.match(String(response.json.data), /Sandbox FF/);
    assert.match(String(response.json.data), new RegExp(FIXTURES.ffUserId));
  });

  it('returns deterministic GoPay Mobile Legends success for reserved fixture', async () => {
    const response = await request(server, {
      method: 'POST',
      path: '/games/v1/order/user-account',
      body: {
        code: 'MOBILE_LEGENDS',
        data: { userId: FIXTURES.mlUserId, zoneId: FIXTURES.mlZoneId },
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.message, 'success');
    assert.match(String(response.json.data.username), /Sandbox ML/);
    assert.match(String(response.json.data.username), new RegExp(FIXTURES.mlUserId));
  });

  it('returns explicit synthetic invalid response with sandbox-only marker for reserved fixture', async () => {
    const codashop = await request(server, {
      method: 'POST',
      path: '/initPayment.action',
      body: {
        voucherTypeName: 'MOBILE_LEGENDS',
        'user.userId': FIXTURES.invalidUserId,
        'user.zoneId': FIXTURES.mlZoneId,
      },
    });
    assert.equal(codashop.statusCode, 200);
    assert.equal(codashop.json.success, false);
    assert.equal(typeof codashop.json.errorMsg, 'string');
    assert.match(codashop.json.errorMsg, /invalid|not found|tidak valid/i);
    assert.equal(codashop.json.confirmationFields, undefined);
    assert.equal(codashop.json.sandboxMarker, SANDBOX_INVALID_MARKER);
    assert.equal(
      String(codashop.headers[SANDBOX_INVALID_HEADER] || '').toLowerCase(),
      SANDBOX_INVALID_HEADER_VALUE,
    );

    const gopay = await request(server, {
      method: 'POST',
      path: '/games/v1/order/user-account',
      body: {
        code: 'MOBILE_LEGENDS',
        data: { userId: FIXTURES.invalidUserId, zoneId: FIXTURES.mlZoneId },
      },
    });
    assert.equal(gopay.statusCode, 200);
    assert.notEqual(String(gopay.json.message || '').toLowerCase(), 'success');
    assert.equal(gopay.json.data?.username, undefined);
    assert.equal(gopay.json.sandboxMarker, SANDBOX_INVALID_MARKER);
    assert.equal(
      String(gopay.headers[SANDBOX_INVALID_HEADER] || '').toLowerCase(),
      SANDBOX_INVALID_HEADER_VALUE,
    );
  });

  it('returns explicit synthetic outage response for reserved fixture', async () => {
    const codashop = await request(server, {
      method: 'POST',
      path: '/initPayment.action',
      body: {
        voucherTypeName: 'FREEFIRE',
        'user.userId': FIXTURES.outageUserId,
        'user.zoneId': '',
      },
    });
    assert.ok(codashop.statusCode === 503 || codashop.statusCode === 429 || codashop.statusCode >= 500);
    if (codashop.json) {
      assert.notEqual(codashop.json.success, true);
    }

    const gopayFf = await request(server, {
      path: `/games/v1/order/prepare/FREEFIRE?userId=${encodeURIComponent(FIXTURES.outageUserId)}`,
    });
    assert.ok(gopayFf.statusCode === 503 || gopayFf.statusCode === 429 || gopayFf.statusCode >= 500);
  });

  it('does not perform outbound network calls while exercising validation fixture handlers', async () => {
    // Block outbound sockets: any connect outside the local stub server fails closed.
    const address = server.address();
    const originalConnect = net.Socket.prototype.connect;
    const outboundAttempts = [];
    net.Socket.prototype.connect = function patchedConnect(...args) {
      const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};
      const port = typeof args[0] === 'number' ? args[0] : options.port;
      const host = typeof args[1] === 'string'
        ? args[1]
        : (options.host || options.hostname || '127.0.0.1');
      const isLocalStub = Number(port) === Number(address.port)
        && (host === '127.0.0.1' || host === address.address || host === 'localhost' || !host);
      if (!isLocalStub) {
        outboundAttempts.push({ host: String(host), port: Number(port) || 0 });
        const err = new Error('outbound socket blocked by no-outbound test guard');
        err.code = 'EOUTBOUNDBLOCKED';
        process.nextTick(() => this.emit('error', err));
        return this;
      }
      return originalConnect.apply(this, args);
    };

    try {
      const health = await request(server, { path: '/health' });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json.service, 'provider-sandbox');

      const ml = await request(server, {
        method: 'POST',
        path: '/initPayment.action',
        body: {
          voucherTypeName: 'MOBILE_LEGENDS',
          'user.userId': FIXTURES.mlUserId,
          'user.zoneId': FIXTURES.mlZoneId,
        },
      });
      assert.equal(ml.statusCode, 200);
      assert.equal(ml.json.success, true);

      const invalid = await request(server, {
        method: 'POST',
        path: '/initPayment.action',
        body: {
          voucherTypeName: 'FREEFIRE',
          'user.userId': FIXTURES.invalidUserId,
          'user.zoneId': '',
        },
      });
      assert.equal(invalid.statusCode, 200);
      assert.equal(invalid.json.sandboxMarker, SANDBOX_INVALID_MARKER);

      const outage = await request(server, {
        method: 'POST',
        path: '/initPayment.action',
        body: {
          voucherTypeName: 'FREEFIRE',
          'user.userId': FIXTURES.outageUserId,
          'user.zoneId': '',
        },
      });
      assert.ok(outage.statusCode >= 500);

      const gopay = await request(server, {
        path: `/games/v1/order/prepare/FREEFIRE?userId=${encodeURIComponent(FIXTURES.ffUserId)}`,
      });
      assert.equal(gopay.statusCode, 200);
      assert.equal(gopay.json.message, 'success');

      assert.deepEqual(outboundAttempts, []);
    } finally {
      net.Socket.prototype.connect = originalConnect;
    }
  });
});
