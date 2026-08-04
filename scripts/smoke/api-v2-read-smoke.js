#!/usr/bin/env node

const { acquireSmokeLock } = require('./lib/smoke-lock');
const { createSmokeReporter } = require('./lib/smoke-report');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:9005').replace(/\/$/, '');
const hasExplicitRustBaseUrl = Boolean((process.env.API_V2_DIRECT_URL || '').trim());
const rustBaseUrl = (process.env.API_V2_DIRECT_URL || 'http://localhost:9010').replace(/\/$/, '');
const email = process.env.SMOKE_EMAIL || 'tester29@gmail.com';
const password = process.env.SMOKE_PASSWORD || 'Tester2909!@';
const memberEmail = process.env.SMOKE_MEMBER_EMAIL || 'api-v2-member-smoke@example.com';
const memberPassword = process.env.SMOKE_MEMBER_PASSWORD || 'ApiV2MemberSmoke2909!';
let passedChecks = 0;
let skippedChecks = 0;
const reporter = createSmokeReporter('api-v2-read');

acquireSmokeLock('read');

const checks = [
  { name: 'health', path: '/api/v2/health', shape: 'object' },
  { name: 'ping', path: '/api/v2/ping', shape: 'object' },
  { name: 'auth me', path: '/api/v2/auth/me', shape: 'object' },
  { name: 'auth 2fa status', path: '/api/v2/auth/2fa/status', shape: 'object' },
  { name: 'api key', path: '/api/v2/api/key', shape: 'object' },
  { name: 'my profile member-only boundary', path: '/api/v2/users/me/profile', shape: 'object', expectedStatus: 403 },
  { name: 'my preferences', path: '/api/v2/users/me/preferences', shape: 'object' },
  {
    name: 'my login activity member-only boundary',
    path: '/api/v2/users/me/login-activity',
    shape: 'object',
    expectedStatus: 403,
  },
  {
    name: 'my balance history member-only boundary',
    path: '/api/v2/users/me/balance-history',
    shape: 'object',
    expectedStatus: 403,
  },
  { name: 'member transactions staff boundary', path: '/api/v2/transactions', shape: 'object', expectedStatus: 403 },
  { name: 'member deposits staff boundary', path: '/api/v2/deposits', shape: 'object', expectedStatus: 403 },
  { name: 'admin transactions', path: '/api/v2/transactions/admin?limit=2', shape: 'object' },
  { name: 'admin deposits', path: '/api/v2/deposits/admin/list?limit=2', shape: 'object' },
  { name: 'deposit queue snapshot', path: '/api/v2/deposits/queue-snapshot', shape: 'object' },
  { name: 'audit logs', path: '/api/v2/audit-logs?limit=2', shape: 'object' },
  { name: 'sales report', path: '/api/v2/reports/sales/summary', shape: 'object' },
  { name: 'sales report legacy alias', path: '/api/v2/reports/sales', shape: 'object' },
  { name: 'dashboard report', path: '/api/v2/reports/dashboard', shape: 'object' },
  { name: 'ops snapshot', path: '/api/v2/dashboard/ops-snapshot', shape: 'object' },
  { name: 'system status', path: '/api/v2/system/status', shape: 'object' },
  { name: 'notifications', path: '/api/v2/notifications/admin', shape: 'object' },
  { name: 'notifications summary', path: '/api/v2/notifications/admin/summary', shape: 'object' },
  { name: 'stuck transactions', path: '/api/v2/transactions/stuck?thresholdMinutes=15&limit=2', shape: 'object' },
  { name: 'manual transactions', path: '/api/v2/transactions/manual?limit=2', shape: 'object' },
  { name: 'seller orders', path: '/api/v2/digiflazz-seller/orders/admin?limit=2', shape: 'object' },
  { name: 'seller orders staff view', path: '/api/v2/digiflazz-seller/orders?limit=2', shape: 'array' },
  { name: 'seller settings', path: '/api/v2/digiflazz-seller/settings', shape: 'object' },
  { name: 'seller logs', path: '/api/v2/digiflazz-seller/logs', shape: 'array' },
  {
    name: 'seller callback scheduler config',
    path: '/api/v2/digiflazz-seller/orders/process-callback-retries/scheduler/config',
    shape: 'object',
  },
  { name: 'products admin', path: '/api/v2/products/admin/all', shape: 'array' },
  { name: 'products catalog audit', path: '/api/v2/products/admin/catalog-audit', shape: 'object' },
  { name: 'products admin sorting validation', path: '/api/v2/products/admin/sorting', shape: 'object', expectedStatus: 400 },
  { name: 'products public', path: '/api/v2/products', shape: 'array' },
  { name: 'product public invalid id boundary', path: '/api/v2/products/not-a-valid-id', shape: 'object', expectedStatus: 404 },
  { name: 'categories public', path: '/api/v2/categories', shape: 'array' },
  { name: 'category public invalid id boundary', path: '/api/v2/categories/not-a-valid-id', shape: 'object', expectedStatus: 404 },
  { name: 'categories admin', path: '/api/v2/categories/admin/all', shape: 'array' },
  { name: 'operators public', path: '/api/v2/operators', shape: 'array' },
  { name: 'operator public invalid id boundary', path: '/api/v2/operators/not-a-valid-id', shape: 'object', expectedStatus: 404 },
  { name: 'operators admin', path: '/api/v2/operators/admin/all', shape: 'array' },
  { name: 'product types public', path: '/api/v2/product-types', shape: 'array' },
  { name: 'product type public invalid id boundary', path: '/api/v2/product-types/not-a-valid-id', shape: 'object', expectedStatus: 404 },
  { name: 'product types admin', path: '/api/v2/product-types/admin/all', shape: 'array' },
  { name: 'payment methods public', path: '/api/v2/payment-methods', shape: 'array' },
  { name: 'payment methods active', path: '/api/v2/payment-methods/active', shape: 'array' },
  { name: 'payment methods admin', path: '/api/v2/payment-methods/admin/all', shape: 'array' },
  { name: 'payment categories public', path: '/api/v2/payment-categories', shape: 'array' },
  { name: 'payment categories active', path: '/api/v2/payment-categories/active', shape: 'array' },
  { name: 'payment categories admin', path: '/api/v2/payment-categories/admin/all', shape: 'array' },
  { name: 'public settings', path: '/api/v2/settings/public', shape: 'object' },
  { name: 'admin settings', path: '/api/v2/settings/admin/all', shape: 'object' },
  { name: 'margins', path: '/api/v2/margins', shape: 'object' },
  { name: 'sliders public', path: '/api/v2/sliders', shape: 'array' },
  { name: 'sliders admin', path: '/api/v2/sliders/admin/all', shape: 'array' },
  { name: 'flash sales active', path: '/api/v2/flash-sales/active', shape: 'array' },
  { name: 'flash sales admin', path: '/api/v2/flash-sales/admin/all', shape: 'array' },
  { name: 'leaderboard public', path: '/api/v2/leaderboard', shape: 'object' },
  { name: 'rewards public', path: '/api/v2/rewards', shape: 'array' },
  { name: 'rewards admin', path: '/api/v2/rewards/admin/all', shape: 'array' },
  { name: 'points settings', path: '/api/v2/points/settings', shape: 'object' },
  { name: 'points stats', path: '/api/v2/points/stats', shape: 'object' },
  { name: 'points history', path: '/api/v2/points/history?limit=2', shape: 'object' },
  { name: 'points transactions', path: '/api/v2/points/transactions?limit=2', shape: 'object' },
  { name: 'vouchers admin', path: '/api/v2/vouchers?limit=2', shape: 'object' },
  { name: 'guest transactions admin', path: '/api/v2/guest-transactions?limit=2', shape: 'object' },
  { name: 'vendors admin', path: '/api/v2/vendors/admin/all', shape: 'array' },
  { name: 'vendor health snapshot', path: '/api/v2/vendors/health-snapshot', shape: 'object' },
  { name: 'tokovoucher operators missing category', path: '/api/v2/vendors/tokovoucher/operators', shape: 'object', expectedStatus: 400 },
  { name: 'tokovoucher jenis missing operator', path: '/api/v2/vendors/tokovoucher/jenis', shape: 'object', expectedStatus: 400 },
  { name: 'tokovoucher products missing jenis', path: '/api/v2/vendors/tokovoucher/products', shape: 'object', expectedStatus: 400 },
  { name: 'tokovoucher search missing kode', path: '/api/v2/vendors/tokovoucher/search', shape: 'object', expectedStatus: 400 },
  { name: 'users admin', path: '/api/v2/users/admin/list?limit=2', shape: 'object' },
  { name: 'users admin legacy alias', path: '/api/v2/users?limit=2', shape: 'object' },
  { name: 'teams admin', path: '/api/v2/teams/admin/list', shape: 'object' },
  { name: 'teams admin legacy alias removed', path: '/api/v2/teams', shape: 'object', expectedStatus: 404 },
  { name: 'team audit logs admin read', path: '/api/v2/teams/admin/audit-logs?limit=2', shape: 'object' },
  { name: 'team login logs admin read', path: '/api/v2/teams/login-logs/all?limit=2', shape: 'object' },
  { name: 'webhook digiflazz config', path: '/api/v2/webhook/digiflazz/config', shape: 'object' },
  { name: 'webhook tokovoucher config', path: '/api/v2/webhook/tokovoucher/config', shape: 'object' },
  { name: 'webhook digiflazz logs', path: '/api/v2/webhook/digiflazz/logs?limit=2', shape: 'array' },
  { name: 'webhook tokovoucher logs', path: '/api/v2/webhook/tokovoucher/logs?limit=2', shape: 'array' },
  { name: 'upload list icons', path: '/api/v2/upload/list?type=icons', shape: 'object' },
  { name: 'upload list invalid type fallback', path: '/api/v2/upload/list?type=bad', shape: 'object', expectedFolder: 'icons' },
];

const csvChecks = [
  // Sensitive exports require step-up; smoke validates the gate, not the CSV body.
  { name: 'audit logs export step-up gate', path: '/api/v2/audit-logs/export?limit=2', expectStepUp: true },
  { name: 'sales report export step-up gate', path: '/api/v2/reports/sales/export', expectStepUp: true },
  { name: 'deposits export step-up gate', path: '/api/v2/deposits/admin/export', expectStepUp: true },
  // Seller export currently does not require step-up in gateway wiring.
  { name: 'seller orders export', path: '/api/v2/digiflazz-seller/orders/admin/export', header: 'Order ID' },
  { name: 'transactions export step-up gate', path: '/api/v2/transactions/admin/export', expectStepUp: true },
];

const negativeChecks = [
  {
    name: 'gateway rejects unauthenticated protected read',
    baseUrl,
    path: '/api/v2/transactions',
    expectedStatus: 401,
  },
  {
    name: 'direct rust rejects missing proxy context',
    baseUrl: rustBaseUrl,
    path: '/v2/transactions',
    expectedStatus: 403,
  },
  {
    name: 'direct rust audit export proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/audit-logs/export',
    expectedStatus: 403,
  },
  {
    name: 'direct rust system status proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/system/status',
    expectedStatus: 403,
  },
  {
    name: 'direct rust ops snapshot proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/dashboard/ops-snapshot',
    expectedStatus: 403,
  },
  {
    name: 'direct rust notification summary proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/notifications/admin/summary',
    expectedStatus: 403,
  },
  {
    name: 'direct rust admin transactions proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/transactions/admin?limit=1',
    expectedStatus: 403,
  },
  {
    name: 'direct rust admin deposits proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/deposits/admin/list?limit=1',
    expectedStatus: 403,
  },
  {
    name: 'direct rust admin users proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/users/admin/list?limit=1',
    expectedStatus: 403,
  },
  {
    name: 'direct rust admin teams proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/teams/admin/list',
    expectedStatus: 403,
  },
  {
    name: 'direct rust admin settings proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/settings/admin/all',
    expectedStatus: 403,
  },
  {
    name: 'direct rust reports export proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/reports/sales/export',
    expectedStatus: 403,
  },
  {
    name: 'vendor health realtime unauth boundary',
    baseUrl,
    path: '/api/v2/vendors/health',
    expectedStatus: 401,
  },
  {
    name: 'vendor health export unauth boundary',
    baseUrl,
    path: '/api/v2/vendors/health/export',
    expectedStatus: 401,
  },
  {
    name: 'digiflazz balance unauth boundary',
    baseUrl,
    path: '/api/v2/vendors/digiflazz/balance',
    expectedStatus: 401,
  },
  {
    name: 'tokovoucher balance unauth boundary',
    baseUrl,
    path: '/api/v2/vendors/tokovoucher/balance',
    expectedStatus: 401,
  },
  {
    name: 'digiflazz webhook empty payload boundary',
    baseUrl,
    path: '/api/v2/webhook/digiflazz',
    method: 'POST',
    expectedStatus: 400,
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  },
  {
    name: 'tokovoucher webhook empty payload boundary',
    baseUrl,
    path: '/api/v2/webhook/tokovoucher',
    method: 'POST',
    expectedStatus: 400,
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  },
  {
    name: 'direct rust digiflazz balance proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/vendors/digiflazz/balance',
    expectedStatus: 403,
  },
  {
    name: 'direct rust tokovoucher balance proxy rejection',
    baseUrl: rustBaseUrl,
    path: '/v2/vendors/tokovoucher/balance',
    expectedStatus: 403,
  },
  {
    name: 'open api rejects missing api key',
    baseUrl,
    path: '/api/v2/api/profile',
    expectedStatus: 401,
  },
  {
    name: 'open api rejects invalid api key',
    baseUrl,
    path: '/api/v2/api/profile',
    expectedStatus: 401,
    headers: { 'x-api-key': 'SMOKE_INVALID_API_KEY' },
  },
];

const activeNegativeChecks = hasExplicitRustBaseUrl
  ? negativeChecks
  : negativeChecks.filter((check) => check.baseUrl !== rustBaseUrl);

async function request(path, options = {}) {
  const url = `${options.baseUrl || baseUrl}${path}`;
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

async function login() {
  const { response, body } = await request('/api/v2/auth/staff/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: process.env.SMOKE_ORIGIN || 'https://danayasa.biz.id',
    },
    body: JSON.stringify({ email, password, rememberMe: false }),
  });
  let token = body?.accessToken || body?.token;
  if (!token && (body?.code === 'AUTH_DEVICE_LIMIT_REACHED' || body?.challengeToken) && Array.isArray(body?.sessions) && body.sessions.length) {
    let lastError = '';
    for (const session of body.sessions) {
      const revokeSessionId = session.sessionId || session.id;
      if (!revokeSessionId) continue;
      const selection = await request('/api/v2/auth/device-selection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: process.env.SMOKE_ORIGIN || 'https://danayasa.biz.id',
        },
        body: JSON.stringify({ challengeToken: body.challengeToken, revokeSessionId }),
      });
      token = selection.body?.accessToken || selection.body?.token;
      if (selection.response.ok && token) {
        return token;
      }
      lastError = `${selection.response.status} ${selection.body?.message || JSON.stringify(selection.body) || ''}`.trim();
    }
    throw new Error(`device selection failed: ${lastError || 'no usable session'}`);
  }
  if (!response.ok || !token) {
    throw new Error(`login failed: ${response.status} ${body?.message || JSON.stringify(body) || ''}`.trim());
  }
  return token;
}

async function loginWithCredentials(loginEmail, loginPassword, label) {
  const { response, body } = await request((String(label || '').toLowerCase().includes('member') ? '/api/v2/auth/member/login' : '/api/v2/auth/staff/login'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: process.env.SMOKE_ORIGIN || 'https://danayasa.biz.id',
    },
    body: JSON.stringify({ email: loginEmail, password: loginPassword, rememberMe: false }),
  });
  let token = body?.accessToken || body?.token;
  if (!token && (body?.code === 'AUTH_DEVICE_LIMIT_REACHED' || body?.challengeToken) && Array.isArray(body?.sessions) && body.sessions.length) {
    let lastError = '';
    for (const session of body.sessions) {
      const revokeSessionId = session.sessionId || session.id;
      if (!revokeSessionId) continue;
      const selection = await request('/api/v2/auth/device-selection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: process.env.SMOKE_ORIGIN || 'https://danayasa.biz.id',
        },
        body: JSON.stringify({ challengeToken: body.challengeToken, revokeSessionId }),
      });
      token = selection.body?.accessToken || selection.body?.token;
      if (selection.response.ok && token) {
        return token;
      }
      lastError = `${selection.response.status} ${selection.body?.message || JSON.stringify(selection.body) || ''}`.trim();
    }
    throw new Error(`device selection failed: ${lastError || 'no usable session'}`);
  }
  if (!response.ok || !token) {
    throw new Error(`${label} login failed: ${response.status} ${body?.message || JSON.stringify(body) || ''}`.trim());
  }
  return token;
}

function assertShape(check, body) {
  if (check.shape === 'array' && !Array.isArray(body)) {
    throw new Error(`expected array, got ${typeof body}`);
  }
  if (check.shape === 'object' && (!body || Array.isArray(body) || typeof body !== 'object')) {
    throw new Error(`expected object, got ${Array.isArray(body) ? 'array' : typeof body}`);
  }
  if (check.expectedFolder && body?.folder !== check.expectedFolder) {
    throw new Error(`expected folder ${check.expectedFolder}, got ${body?.folder || 'missing'}`);
  }
}

function ok(name, status) {
  passedChecks += 1;
  reporter.record('passed', name, { status });
  console.log(`ok ${name} ${status}`);
}

function skip(name, reason) {
  skippedChecks += 1;
  reporter.record('skipped', name, { reason });
  console.log(`skip ${name} ${reason}`);
}

function objectIdFromAny(value) {
  return value?._id || value?.id;
}

function relationId(value) {
  return typeof value === 'string' ? value : objectIdFromAny(value);
}

function firstArrayFromBody(body) {
  if (Array.isArray(body)) {
    return body;
  }
  for (const key of ['items', 'users', 'members', 'data', 'products']) {
    if (Array.isArray(body?.[key])) {
      return body[key];
    }
  }
  return [];
}

async function runCheck(check, token) {
  const { response, body } = await request(check.path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const expectedStatus = check.expectedStatus || 200;
  if (response.status !== expectedStatus) {
    throw new Error(`expected HTTP ${expectedStatus}, got ${response.status}: ${body?.message || JSON.stringify(body)}`);
  }
  assertShape(check, body);
  return { response, body };
}

async function runDynamicDetailChecks(token, failures) {
  const result = { passed: 0, skipped: 0 };
  const detailChecks = [
    {
      name: 'product public detail',
      listPath: '/api/v2/products',
      detailPath: (item) => `/api/v2/products/${objectIdFromAny(item)}`,
    },
    {
      name: 'category public detail',
      listPath: '/api/v2/categories',
      detailPath: (item) => `/api/v2/categories/${objectIdFromAny(item)}`,
    },
    {
      name: 'operator public detail',
      listPath: '/api/v2/operators',
      detailPath: (item) => `/api/v2/operators/${objectIdFromAny(item)}`,
    },
    {
      name: 'product type public detail',
      listPath: '/api/v2/product-types',
      detailPath: (item) => `/api/v2/product-types/${objectIdFromAny(item)}`,
    },
    {
      name: 'reward public detail',
      listPath: '/api/v2/rewards',
      detailPath: (item) => `/api/v2/rewards/${objectIdFromAny(item)}`,
    },
    {
      name: 'article public detail',
      listPath: '/api/v2/articles',
      detailPath: (item) => item?.slug && `/api/v2/articles/${encodeURIComponent(item.slug)}`,
    },
    {
      name: 'user admin detail',
      listPath: '/api/v2/users/admin/list?limit=1',
      detailPath: (item) => `/api/v2/users/${objectIdFromAny(item)}`,
    },
    {
      name: 'team admin detail',
      listPath: '/api/v2/teams/admin/list',
      findItem: (item) => item?.role && item.role !== 'owner',
      detailPath: (item) => `/api/v2/teams/${objectIdFromAny(item)}`,
    },
    {
      name: 'vendor admin detail',
      listPath: '/api/v2/vendors/admin/all',
      detailPath: (item) => `/api/v2/vendors/${objectIdFromAny(item)}`,
    },
    {
      name: 'vendor stats',
      listPath: '/api/v2/vendors/admin/all',
      detailPath: (item) => `/api/v2/vendors/${objectIdFromAny(item)}/stats`,
    },
  ];

  for (const check of detailChecks) {
    try {
      const { body } = await request(check.listPath, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const items = firstArrayFromBody(body);
      const item = check.findItem ? items.find(check.findItem) : items[0];
      const path = item && check.detailPath(item);
      if (!path) {
        skip(check.name, 'no fixture');
        result.skipped += 1;
        continue;
      }
      const detail = await runCheck({ name: check.name, path, shape: 'object' }, token);
      ok(check.name, detail.response.status);
      result.passed += 1;
    } catch (error) {
      reporter.record('failed', check.name, { message: error.message });
      failures.push({ check, error });
      console.error(`fail ${check.name}: ${error.message}`);
    }
  }
  return result;
}

async function runDynamicSortingChecks(token, failures) {
  const result = { passed: 0, skipped: 0 };
  try {
    const { body } = await request('/api/v2/products/admin/all', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const product = firstArrayFromBody(body).find((item) => relationId(item?.categoryId));
    const categoryId = relationId(product?.categoryId);
    if (!categoryId) {
      skip('products admin sorting', 'no category fixture');
      result.skipped += 1;
      return result;
    }

    const sorting = await runCheck(
      {
        name: 'products admin sorting by category',
        path: `/api/v2/products/admin/sorting?categoryId=${encodeURIComponent(categoryId)}`,
        shape: 'array',
      },
      token,
    );
    ok('products admin sorting by category', sorting.response.status);
    result.passed += 1;
  } catch (error) {
    reporter.record('failed', 'products admin sorting by category', { message: error.message });
    failures.push({ check: { name: 'products admin sorting by category' }, error });
    console.error(`fail products admin sorting by category: ${error.message}`);
  }
  return result;
}

async function runDynamicOpenApiChecks(token, failures) {
  const crypto = require('crypto');
  const result = { passed: 0, skipped: 0 };
  let apiKey = '';
  let apiSecret = '';
  let memberId = '';
  let generatedKey = false;
  let memberToken = '';
  try {
    memberToken = await loginWithCredentials(memberEmail, memberPassword, 'member');
    // Always regenerate so this smoke has a one-time secret for signed Open API calls.
    const generated = await request('/api/v2/api/key/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    if (generated.response.status !== 200 || !generated.body?.apiKey || !generated.body?.secret) {
      throw new Error(`expected generated API key+secret, got ${generated.response.status}: ${generated.body?.message || JSON.stringify(generated.body)}`);
    }
    apiKey = generated.body.apiKey || generated.body.api_key || '';
    apiSecret = generated.body.secret || '';
    memberId = generated.body.memberId || generated.body.member_id || generated.body.memberCode || '';
    generatedKey = true;
    ok('open api generate fixture key', generated.response.status);
    result.passed += 1;

    if (!memberId || !apiKey || !apiSecret) {
      throw new Error(`incomplete open api generate payload: ${JSON.stringify(generated.body)}`);
    }
  } catch (error) {
    reporter.record('failed', 'api key dynamic lookup', { message: error.message });
    failures.push({ check: { name: 'api key dynamic lookup' }, error });
    console.error(`fail api key dynamic lookup: ${error.message}`);
    return result;
  }

  if (!apiKey || !apiSecret || !memberId) {
    skip('open api read checks', 'no signed open api credentials');
    result.skipped += 4;
    return result;
  }

  const sign = (refId = '') => crypto
    .createHash('md5')
    .update(refId ? `${memberId}:${apiKey}:${apiSecret}:${refId}` : `${memberId}:${apiKey}:${apiSecret}`)
    .digest('hex');

  try {
    const openApiChecks = [
      { name: 'open api profile', path: '/api/v2/api/profile', shape: 'object' },
      { name: 'open api products', path: '/api/v2/api/products', shape: 'object' }, // envelope {success,data}
      { name: 'open api transactions', path: '/api/v2/api/transactions?limit=2', shape: 'object' },
      {
        name: 'open api transaction check not found boundary',
        path: '/api/v2/api/transaction/check?trx_id=000000000000000000000000',
        shape: 'object',
        expectedStatus: 404,
      },
    ];

    for (const check of openApiChecks) {
      try {
        const signature = sign();
        const joiner = check.path.includes('?') ? '&' : '?';
        const signedPath = `${check.path}${joiner}member_id=${encodeURIComponent(memberId)}&api_key=${encodeURIComponent(apiKey)}&signature=${encodeURIComponent(signature)}`;
        const { response, body } = await request(signedPath);
        const expectedStatus = check.expectedStatus || 200;
        if (response.status !== expectedStatus) {
          throw new Error(`expected HTTP ${expectedStatus}, got ${response.status}: ${body?.message || JSON.stringify(body)}`);
        }
        assertShape(check, body);
        ok(check.name, response.status);
        result.passed += 1;
      } catch (error) {
        reporter.record('failed', check.name, { message: error.message });
        failures.push({ check, error });
        console.error(`fail ${check.name}: ${error.message}`);
      }
    }
  } finally {
    if (generatedKey && memberToken) {
      const revoked = await request('/api/v2/api/key/revoke', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      if (revoked.response.status === 200) {
        ok('open api revoke fixture key', revoked.response.status);
        result.passed += 1;
      } else {
        reporter.record('failed', 'open api revoke fixture key', {
          message: `expected HTTP 200, got ${revoked.response.status}: ${revoked.body?.message || JSON.stringify(revoked.body)}`,
        });
        failures.push({
          check: { name: 'open api revoke fixture key' },
          error: new Error(`expected HTTP 200, got ${revoked.response.status}: ${revoked.body?.message || JSON.stringify(revoked.body)}`),
        });
      }
    }
  }

  return result;
}

async function main() {
  const token = await login();
  const failures = [];
  const me = await runCheck({ name: 'auth me metadata', path: '/api/v2/auth/me', shape: 'object' }, token);
  const smokeRole = me.body?.user?.role || me.body?.role || '';
  const checksForRole = checks.map((check) => {
    if (smokeRole === 'owner' && (check.name === 'team audit logs permission boundary' || check.name === 'team login logs permission boundary')) {
      return { ...check, expectedStatus: 200 };
    }
    return check;
  });

  for (const check of checksForRole) {
    try {
      const { response } = await runCheck(check, token);
      ok(check.name, response.status);
    } catch (error) {
      reporter.record('failed', check.name, { message: error.message });
      failures.push({ check, error });
      console.error(`fail ${check.name}: ${error.message}`);
    }
  }

  // Member-owned surfaces must work with a member token (staff is rejected above).
  try {
    const memberToken = await loginWithCredentials(memberEmail, memberPassword, 'member');
    for (const check of [
      { name: 'member transactions as member', path: '/api/v2/transactions', shape: 'array' },
      { name: 'member deposits as member', path: '/api/v2/deposits', shape: 'array' },
    ]) {
      const { response } = await runCheck(check, memberToken);
      ok(check.name, response.status);
    }
  } catch (error) {
    reporter.record('failed', 'member owned reads', { message: error.message });
    failures.push({ check: { name: 'member owned reads' }, error });
    console.error(`fail member owned reads: ${error.message}`);
  }

  const dynamicResult = await runDynamicDetailChecks(token, failures);
  const sortingResult = await runDynamicSortingChecks(token, failures);
  const openApiResult = await runDynamicOpenApiChecks(token, failures);

  for (const check of csvChecks) {
    try {
      const { response, body } = await request(check.path, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (check.expectStepUp) {
        if (response.status !== 403) {
          throw new Error(`expected step-up HTTP 403, got ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
        }
        const code = body?.error?.code || body?.code || '';
        if (code && code !== 'AUTH_STEP_UP_REQUIRED') {
          throw new Error(`expected AUTH_STEP_UP_REQUIRED, got ${code}`);
        }
        ok(check.name, response.status);
        continue;
      }
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
      }
      if (!contentType.toLowerCase().includes('text/csv')) {
        throw new Error(`expected text/csv, got ${contentType || 'missing content-type'}`);
      }
      if (typeof body !== 'string' || !body.includes(check.header)) {
        throw new Error(`missing CSV header fragment ${check.header}`);
      }
      ok(check.name, response.status);
    } catch (error) {
      reporter.record('failed', check.name, { message: error.message });
      failures.push({ check, error });
      console.error(`fail ${check.name}: ${error.message}`);
    }
  }

  for (const check of activeNegativeChecks) {
    try {
      const { response, body } = await request(check.path, {
        baseUrl: check.baseUrl,
        method: check.method,
        headers: check.headers,
        body: check.body,
      });
      if (response.status !== check.expectedStatus) {
        throw new Error(
          `expected HTTP ${check.expectedStatus}, got ${response.status}: ${body?.message || JSON.stringify(body)}`,
        );
      }
      ok(check.name, response.status);
    } catch (error) {
      reporter.record('failed', check.name, { message: error.message });
      failures.push({ check, error });
      console.error(`fail ${check.name}: ${error.message}`);
    }
  }

  if (!hasExplicitRustBaseUrl) {
    skip('direct rust proxy guard checks', 'no API_V2_DIRECT_URL');
  }

  if (failures.length > 0) {
    reporter.write({ passed: passedChecks, skipped: skippedChecks, failed: failures.length });
    console.error(`\n${failures.length} API v2 smoke check(s) failed.`);
    process.exit(1);
  }

  reporter.write({ passed: passedChecks, skipped: skippedChecks, failed: failures.length });
  console.log(`\n${passedChecks} API v2 smoke checks passed (${skippedChecks} skipped).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
