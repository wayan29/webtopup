#!/usr/bin/env node
'use strict';

const http = require('http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9020;

/**
 * Reserved synthetic fixture markers (local development only).
 * Must never be mistaken for production identities.
 */
const FIXTURE_INVALID = 'syn-invalid';
const FIXTURE_OUTAGE = 'syn-outage';

/**
 * Explicit sandbox-only invalid marker for Rust classifiers.
 * Production/default providers must never emit this contract field.
 */
const SANDBOX_INVALID_MARKER = 'webtopup-sandbox-invalid';
const SANDBOX_INVALID_HEADER = 'x-webtopup-sandbox';
const SANDBOX_INVALID_HEADER_VALUE = 'invalid';

const normalizeStatus = (value, fallback = 'pending') => {
  const status = String(value || '').trim().toLowerCase();
  return ['pending', 'success', 'failed'].includes(status) ? status : fallback;
};

const statusFromText = (value, fallback) => {
  const text = String(value || '').toLowerCase();
  if (text.includes('mock-status-success')) return 'success';
  if (text.includes('mock-status-failed')) return 'failed';
  if (text.includes('mock-status-pending')) return 'pending';
  return fallback;
};

const sendJson = (response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const readJson = (request) => new Promise((resolve) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (chunks.length === 0) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      resolve({});
    }
  });
});

const isFixtureMarker = (value, marker) => String(value || '').trim() === marker;

const sandboxInvalidHeaders = () => ({
  [SANDBOX_INVALID_HEADER]: SANDBOX_INVALID_HEADER_VALUE,
});

const handleValidationOutage = (response) => {
  sendJson(response, 503, {
    success: false,
    message: 'Sandbox synthetic provider outage',
    errorMsg: 'Sandbox synthetic provider outage',
  });
};

const handleValidationInvalid = (response, kind) => {
  if (kind === 'codashop') {
    sendJson(response, 200, {
      success: false,
      errorMsg: 'Sandbox invalid user id (synthetic)',
      sandboxMarker: SANDBOX_INVALID_MARKER,
    }, sandboxInvalidHeaders());
    return;
  }
  sendJson(response, 200, {
    message: 'Invalid User ID or unknown error.',
    sandboxMarker: SANDBOX_INVALID_MARKER,
  }, sandboxInvalidHeaders());
};

/**
 * Operator CLI/config bind is fixed to exact loopback host and port 9020.
 * Any other host (including 0.0.0.0) or port is rejected.
 */
const validateBindConfig = (host, port) => {
  const normalizedPort = Number(port);
  return host === DEFAULT_HOST && normalizedPort === DEFAULT_PORT;
};

/**
 * Unbound test/API factory: returns an http.Server that is not listening.
 * Callers (unit tests) may bind any host/port. Operator CLI (startCli) alone
 * enforces the fixed 127.0.0.1:9020 bind via validateBindConfig before listen.
 */
const createProviderSandboxServer = () => {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || DEFAULT_HOST}`);
    const body = request.method === 'POST' ? await readJson(request) : {};
    const topUpFallback = normalizeStatus(process.env.PROVIDER_SANDBOX_TOPUP_STATUS, 'pending');
    const recheckFallback = normalizeStatus(process.env.PROVIDER_SANDBOX_RECHECK_STATUS, 'pending');
    const sn = process.env.PROVIDER_SANDBOX_SN || 'SANDBOX-SN';

    if (url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'provider-sandbox' });
      return;
    }

    if (url.pathname === '/transaction') {
      const target = body.customer_no || body.target || '';
      const status = statusFromText(target, request.method === 'POST' ? topUpFallback : recheckFallback);
      sendJson(response, 200, {
        data: {
          status,
          ref_id: body.ref_id || 'SANDBOX-REF',
          message: `Sandbox Digiflazz ${status}`,
          sn: status === 'success' ? sn : undefined,
        },
      });
      return;
    }

    if (url.pathname === '/v1/transaksi') {
      const status = statusFromText(body.tujuan || body.target || '', topUpFallback);
      sendJson(response, 200, {
        status: 1,
        data: {
          status,
          ref_id: body.ref_id || 'SANDBOX-REF',
          message: `Sandbox Tokovoucher ${status}`,
          sn: status === 'success' ? sn : undefined,
        },
      });
      return;
    }

    if (url.pathname === '/v1/transaksi/status') {
      const status = statusFromText(body.ref_id || '', recheckFallback);
      sendJson(response, 200, {
        status: 1,
        data: {
          status,
          ref_id: body.ref_id || 'SANDBOX-REF',
          message: `Sandbox Tokovoucher status ${status}`,
          sn: status === 'success' ? sn : undefined,
        },
      });
      return;
    }

    if (url.pathname === '/cek-saldo' || url.pathname === '/member') {
      sendJson(response, 200, { data: { deposit: 1000000, saldo: 1000000 } });
      return;
    }

    if (url.pathname === '/price-list') {
      sendJson(response, 200, {
        data: [
          {
            buyer_sku_code: 'SMOKE-SANDBOX-SKU',
            product_name: 'Smoke Sandbox Product',
            category: 'Smoke',
            brand: 'Sandbox',
            type: 'Umum',
            seller_product_status: true,
            buyer_product_status: true,
            price: 1000,
            desc: 'Sandbox smoke product',
          },
        ],
      });
      return;
    }

    if (url.pathname === '/member/produk/category/list') {
      sendJson(response, 200, { status: 1, data: [{ id: 'smoke-category', nama: 'Smoke Category' }] });
      return;
    }

    if (url.pathname === '/member/produk/operator/list') {
      sendJson(response, 200, { status: 1, data: [{ id: 'smoke-operator', nama: 'Smoke Operator' }] });
      return;
    }

    if (url.pathname === '/member/produk/jenis/list') {
      sendJson(response, 200, { status: 1, data: [{ id: 'smoke-jenis', nama: 'Smoke Jenis' }] });
      return;
    }

    if (url.pathname === '/member/produk/list' || url.pathname === '/produk/code') {
      sendJson(response, 200, {
        status: 1,
        data: [
          {
            code: 'SMOKE-TV-SKU',
            nama: 'Smoke Tokovoucher Product',
            price: 1000,
            status: 1,
          },
        ],
      });
      return;
    }

    if (url.pathname === '/initPayment.action') {
      const voucherTypeName = String(body.voucherTypeName || '').toUpperCase();
      const userId = String(body['user.userId'] || '');
      const zoneId = String(body['user.zoneId'] || '');

      if (isFixtureMarker(userId, FIXTURE_OUTAGE)) {
        handleValidationOutage(response);
        return;
      }
      if (isFixtureMarker(userId, FIXTURE_INVALID)) {
        handleValidationInvalid(response, 'codashop');
        return;
      }

      const nickname = voucherTypeName === 'MOBILE_LEGENDS'
        ? `Sandbox ML ${userId}-${zoneId}`
        : `Sandbox FF ${userId}`;
      sendJson(response, 200, {
        success: true,
        confirmationFields: {
          username: encodeURIComponent(nickname),
          roles: [{ role: encodeURIComponent(nickname) }],
        },
      });
      return;
    }

    if (url.pathname === '/games/v1/order/prepare/FREEFIRE') {
      const userId = url.searchParams.get('userId') || '';
      if (isFixtureMarker(userId, FIXTURE_OUTAGE)) {
        handleValidationOutage(response);
        return;
      }
      if (isFixtureMarker(userId, FIXTURE_INVALID)) {
        handleValidationInvalid(response, 'gopay');
        return;
      }
      sendJson(response, 200, { message: 'success', data: `Sandbox FF ${userId}` });
      return;
    }

    if (url.pathname === '/games/v1/order/user-account') {
      const userId = String(body?.data?.userId || '');
      const zoneId = String(body?.data?.zoneId || '');
      if (isFixtureMarker(userId, FIXTURE_OUTAGE)) {
        handleValidationOutage(response);
        return;
      }
      if (isFixtureMarker(userId, FIXTURE_INVALID)) {
        handleValidationInvalid(response, 'gopay');
        return;
      }
      sendJson(response, 200, {
        message: 'success',
        data: { username: `Sandbox ML ${userId}-${zoneId}` },
      });
      return;
    }

    sendJson(response, 404, { message: 'Sandbox route not found' });
  });

  return server;
};

const startCli = () => {
  const host = process.env.PROVIDER_SANDBOX_HOST || DEFAULT_HOST;
  const port = Number(process.env.PROVIDER_SANDBOX_PORT || DEFAULT_PORT);
  if (!validateBindConfig(host, port)) {
    process.stderr.write('invalid_bind\n');
    process.exit(1);
  }

  const server = createProviderSandboxServer();

  server.listen(port, host, () => {
    // Fixed operator label only — no env-derived host/port values.
    console.log('Provider sandbox stub listening on loopback operator bind');
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
};

module.exports = {
  createProviderSandboxServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  FIXTURE_INVALID,
  FIXTURE_OUTAGE,
  SANDBOX_INVALID_MARKER,
  SANDBOX_INVALID_HEADER,
  SANDBOX_INVALID_HEADER_VALUE,
  validateBindConfig,
};

if (require.main === module) {
  startCli();
}
