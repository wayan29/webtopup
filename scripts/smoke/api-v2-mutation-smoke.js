#!/usr/bin/env node

const { acquireSmokeLock } = require('./lib/smoke-lock');
const { createSmokeReporter } = require('./lib/smoke-report');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:9005').replace(/\/$/, '');
const hasExplicitRustBaseUrl = Boolean((process.env.API_V2_DIRECT_URL || '').trim());
const rustBaseUrl = (process.env.API_V2_DIRECT_URL || 'http://localhost:9010').replace(/\/$/, '');
const email = process.env.SMOKE_EMAIL || 'tester29@gmail.com';
const password = process.env.SMOKE_PASSWORD || 'Tester2909!@';
const memberEmail = (process.env.SMOKE_MEMBER_EMAIL || '').trim();
const memberPassword = process.env.SMOKE_MEMBER_PASSWORD || '';
const smokeMongoUri = (process.env.SMOKE_MONGO_URI || process.env.MONGO_URI || '').trim();
const smokeMongoDb = (process.env.SMOKE_MONGO_DB || process.env.MONGO_DB || '').trim();
const requireMutationSmokeMongo = process.env.REQUIRE_MUTATION_SMOKE_MONGO === '1';
const SMOKE_PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let passedChecks = 0;
let skippedChecks = 0;
let optionalDepositE2eChecks = 0;
let optionalPointsE2eChecks = 0;
let optionalVoucherE2eChecks = 0;
let optionalBalanceAdjustE2eChecks = 0;
let optionalDepositCreateE2eChecks = 0;
let optionalTransactionRefundE2eChecks = 0;
let optionalTransactionStatusE2eChecks = 0;
let optionalGuestTransactionE2eChecks = 0;
let optionalTwoFactorE2eChecks = 0;
let optionalSettingsE2eChecks = 0;
const reporter = createSmokeReporter('api-v2-mutation');

if (process.env.RUN_API_V2_MUTATION_SMOKE !== '1') {
  console.error('Refusing to run mutation smoke without RUN_API_V2_MUTATION_SMOKE=1.');
  process.exit(1);
}

if (requireMutationSmokeMongo && !smokeMongoUri) {
  console.error('Refusing to run Mongo-backed mutation smoke without MONGO_URI or SMOKE_MONGO_URI.');
  process.exit(1);
}

acquireSmokeLock('mutation');

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

function assertStatus(name, response, body, expectedStatus) {
  if (response.status !== expectedStatus) {
    reporter.record('failed', name, {
      expectedStatus,
      status: response.status,
      message: body?.message || JSON.stringify(body),
    });
    throw new Error(
      `${name} expected HTTP ${expectedStatus}, got ${response.status}: ${body?.message || JSON.stringify(body)}`,
    );
  }
  passedChecks += 1;
  reporter.record('passed', name, { status: response.status });
}

function objectId(value, label) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label} missing object id`);
  }
  return value;
}

function objectIdFromAny(value, label) {
  return objectId(value?._id || value?.id, label);
}

async function uploadSmokeCover(token, filename) {
  const form = new FormData();
  form.append('file', new Blob([SMOKE_PNG_1X1], { type: 'image/png' }), filename);
  return request('/api/v2/upload?type=covers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

async function authedJson(token, method, path, payload, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...extraHeaders };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return request(path, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

async function jsonRequest(method, path, payload, options = {}) {
  return request(path, {
    ...options,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function ok(name, status) {
  console.log(`ok ${name} ${status}`);
}

function skip(name, reason) {
  skippedChecks += 1;
  reporter.record('skipped', name, { reason });
  console.log(`skip ${name} ${reason}`);
}

function assertStepUpRequired(name, response, body) {
  const code = body?.error?.code || body?.code;
  if (response.status !== 403 || code !== 'AUTH_STEP_UP_REQUIRED') {
    reporter.record('failed', name, {
      expectedStatus: 403,
      expectedCode: 'AUTH_STEP_UP_REQUIRED',
      status: response.status,
      code,
      message: body?.message || JSON.stringify(body),
    });
    throw new Error(
      `${name} expected AUTH_STEP_UP_REQUIRED, got ${response.status} ${code || body?.message || JSON.stringify(body)}`,
    );
  }
  passedChecks += 1;
  reporter.record('passed', name, { status: response.status, code });
}

async function withSmokeDb(callback) {
  if (!smokeMongoUri) {
    skip('mongo-backed e2e smoke', 'no mongo uri');
    return;
  }

  const mongoose = require('../../server/node_modules/mongoose');
  const connection = await mongoose.createConnection(smokeMongoUri, smokeMongoDb ? { dbName: smokeMongoDb } : {}).asPromise();
  try {
    await callback({
      ObjectId: mongoose.Types.ObjectId,
      deposits: connection.collection('deposits'),
      paymentCategories: connection.collection('paymentcategories'),
      paymentMethods: connection.collection('paymentmethods'),
      pointTransactions: connection.collection('pointtransactions'),
      products: connection.collection('products'),
      guestTransactions: connection.collection('guesttransactions'),
      transactions: connection.collection('transactions'),
      notificationStates: connection.collection('adminnotificationstates'),
      settings: connection.collection('settings'),
      users: connection.collection('users'),
      vouchers: connection.collection('vouchers'),
      userBalanceAdjustments: connection.collection('userbalanceadjustments'),
    });
  } finally {
    await connection.close();
  }
}

async function getSmokeUserId(token) {
  const me = await authedJson(token, 'GET', '/api/v2/auth/me');
  assertStatus('deposit e2e auth me', me.response, me.body, 200);
  const userId = me.body?.user?._id || me.body?.user?.id || me.body?._id || me.body?.id;
  return objectId(userId, 'deposit e2e user');
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let current = 0;
  const bytes = [];
  for (const character of String(value || '').replace(/=|\s/g, '').toUpperCase()) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) {
      throw new Error('2fa e2e secret is not valid base32');
    }
    current = (current << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret) {
  const crypto = require('crypto');
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[19] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}

async function runTwoFactorE2eSmoke(token) {
  await withSmokeDb(async ({ ObjectId, users }) => {
    const userId = new ObjectId(await getSmokeUserId(token));
    const original = await users.findOne(
      { _id: userId },
      { projection: { twoFactorEnabled: 1, twoFactorSecret: 1, twoFactorPendingSecret: 1 } },
    );
    if (!original) {
      throw new Error('2fa e2e user not found');
    }
    if (original.twoFactorEnabled) {
      skip('2fa e2e smoke', 'user already has 2fa enabled');
      return;
    }

    try {
      const setup = await authedJson(token, 'POST', '/api/v2/auth/2fa/setup');
      assertStatus('2fa e2e setup', setup.response, setup.body, 200);
      const secret = setup.body?.secret;
      if (!secret || !setup.body?.otpauthUrl || !setup.body?.qrCodeDataUrl) {
        throw new Error('2fa e2e setup returned incomplete payload');
      }
      optionalTwoFactorE2eChecks += 1;
      ok('2fa e2e setup', setup.response.status);

      const confirm = await authedJson(token, 'POST', '/api/v2/auth/2fa/confirm', { code: totpCode(secret) });
      assertStatus('2fa e2e confirm', confirm.response, confirm.body, 200);
      if (confirm.body?.enabled !== true) {
        throw new Error('2fa e2e confirm did not enable 2fa');
      }
      optionalTwoFactorE2eChecks += 1;
      ok('2fa e2e confirm', confirm.response.status);

      const challenge = await request('/api/v2/auth/staff/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: process.env.SMOKE_ORIGIN || 'https://danayasa.biz.id',
        },
        body: JSON.stringify({ email, password, rememberMe: false }),
      });
      assertStatus('2fa e2e login challenge', challenge.response, challenge.body, 200);
      if (!challenge.body?.requiresTwoFactor || !challenge.body?.challengeToken) {
        throw new Error('2fa e2e login did not require 2fa');
      }
      optionalTwoFactorE2eChecks += 1;
      ok('2fa e2e login challenge', challenge.response.status);

      const verified = await jsonRequest('POST', '/api/v2/auth/2fa/login-verify', {
        challengeToken: challenge.body.challengeToken,
        code: totpCode(secret),
      });
      assertStatus('2fa e2e login verify', verified.response, verified.body, 200);
      if (!(verified.body?.accessToken || verified.body?.token)) {
        throw new Error('2fa e2e verify did not return token');
      }
      optionalTwoFactorE2eChecks += 1;
      ok('2fa e2e login verify', verified.response.status);

      const disable = await authedJson(token, 'POST', '/api/v2/auth/2fa/disable', { code: totpCode(secret) });
      assertStatus('2fa e2e disable', disable.response, disable.body, 200);
      if (disable.body?.enabled !== false) {
        throw new Error('2fa e2e disable did not disable 2fa');
      }
      optionalTwoFactorE2eChecks += 1;
      ok('2fa e2e disable', disable.response.status);
    } finally {
      const unset = {};
      const set = { updatedAt: new Date() };
      if (Object.prototype.hasOwnProperty.call(original, 'twoFactorEnabled')) {
        set.twoFactorEnabled = original.twoFactorEnabled;
      } else {
        unset.twoFactorEnabled = '';
      }
      if (Object.prototype.hasOwnProperty.call(original, 'twoFactorSecret')) {
        set.twoFactorSecret = original.twoFactorSecret;
      } else {
        unset.twoFactorSecret = '';
      }
      if (Object.prototype.hasOwnProperty.call(original, 'twoFactorPendingSecret')) {
        set.twoFactorPendingSecret = original.twoFactorPendingSecret;
      } else {
        unset.twoFactorPendingSecret = '';
      }
      await users.updateOne({ _id: userId }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    }
  });
}

async function runSettingsMutationSmoke(token, suffix) {
  const all = await authedJson(token, 'GET', '/api/v2/settings/admin/all');
  assertStatus('settings e2e read all', all.response, all.body, 200);
  if (typeof all.body?.revision !== 'number') {
    throw new Error('settings admin all is missing revision');
  }
  optionalSettingsE2eChecks += 1;
  ok('settings e2e read all', all.response.status);

  const unknown = await authedJson(token, 'PUT', '/api/v2/settings/admin/update', {
    expectedRevision: all.body.revision,
    changes: { [`unknownSmoke${suffix}`]: true },
  }, { 'Idempotency-Key': `smoke_unknown_${suffix}` });
  assertStatus('settings unknown key boundary', unknown.response, unknown.body, 400);
  optionalSettingsE2eChecks += 1;
  ok('settings unknown key boundary', unknown.response.status);

  const invalidRange = await authedJson(token, 'PUT', '/api/v2/settings/admin/update', {
    expectedRevision: all.body.revision,
    changes: { minDeposit: 20000, maxDeposit: 10000 },
  }, { 'Idempotency-Key': `smoke_range_${suffix}` });
  assertStatus('settings deposit range boundary', invalidRange.response, invalidRange.body, 400);
  optionalSettingsE2eChecks += 1;
  ok('settings deposit range boundary', invalidRange.response.status);

  const closedSingle = await authedJson(token, 'PUT', '/api/v2/settings/admin/logo', {
    value: 'javascript:alert(1)',
  });
  if (![400, 405].includes(closedSingle.response.status)) {
    throw new Error(`settings single mutation expected 400/405, got ${closedSingle.response.status}`);
  }
  optionalSettingsE2eChecks += 1;
  ok('settings single mutation closed', closedSingle.response.status);

  const pub = await jsonRequest('GET', '/api/v2/settings/public');
  assertStatus('settings public get', pub.response, pub.body, 200);
  const etag = pub.response.headers.get('etag');
  const cacheControl = pub.response.headers.get('cache-control') || '';
  if (!etag || !/no-cache/i.test(cacheControl) || typeof pub.body?.revision !== 'number') {
    throw new Error('settings public freshness contract is incomplete');
  }
  const cached = await jsonRequest('GET', '/api/v2/settings/public', undefined, {
    headers: { 'If-None-Match': etag },
  });
  if (cached.response.status !== 304) {
    throw new Error(`settings public If-None-Match expected 304, got ${cached.response.status}`);
  }
  optionalSettingsE2eChecks += 1;
  ok('settings public etag', cached.response.status);
}

async function runNotificationMutationSmoke(token) {
  const invalidRead = await authedJson(token, 'POST', '/api/v2/notifications/admin/smoke-invalid/read', {
    fingerprint: '',
  });
  assertStatus('notification mark read invalid fingerprint', invalidRead.response, invalidRead.body, 400);
  ok('notification mark read invalid fingerprint', invalidRead.response.status);

  const invalidDismiss = await authedJson(token, 'POST', '/api/v2/notifications/admin/smoke-invalid/dismiss', {
    fingerprint: '',
  });
  assertStatus('notification dismiss invalid fingerprint', invalidDismiss.response, invalidDismiss.body, 400);
  ok('notification dismiss invalid fingerprint', invalidDismiss.response.status);

  await withSmokeDb(async ({ ObjectId, notificationStates }) => {
    const userId = new ObjectId(await getSmokeUserId(token));
    const originalStates = await notificationStates.find({ userId }).toArray();
    try {
      const list = await authedJson(token, 'GET', '/api/v2/notifications/admin');
      assertStatus('notification mutation list snapshot', list.response, list.body, 200);
      if (!Array.isArray(list.body?.notifications)) {
        throw new Error('notification mutation list snapshot expected notifications array');
      }
      ok('notification mutation list snapshot', list.response.status);

      const notification = list.body.notifications.find((item) => item?.id && item?.fingerprint);
      if (notification) {
        const staleRead = await authedJson(token, 'POST', `/api/v2/notifications/admin/${notification.id}/read`, {
          fingerprint: `${notification.fingerprint}:stale`,
        });
        assertStatus('notification mark read stale fingerprint', staleRead.response, staleRead.body, 400);
        ok('notification mark read stale fingerprint', staleRead.response.status);

        const markRead = await authedJson(token, 'POST', `/api/v2/notifications/admin/${notification.id}/read`, {
          fingerprint: notification.fingerprint,
        });
        assertStatus('notification mark read e2e', markRead.response, markRead.body, 200);
        ok('notification mark read e2e', markRead.response.status);

        const dismiss = await authedJson(token, 'POST', `/api/v2/notifications/admin/${notification.id}/dismiss`, {
          fingerprint: notification.fingerprint,
        });
        assertStatus('notification dismiss e2e', dismiss.response, dismiss.body, 200);
        ok('notification dismiss e2e', dismiss.response.status);
      } else {
        skip('notification specific state e2e', 'no active notification');
      }

      const markAllRead = await authedJson(token, 'POST', '/api/v2/notifications/admin/read-all');
      assertStatus('notification mark all read e2e', markAllRead.response, markAllRead.body, 200);
      if (markAllRead.body?.success !== true || typeof markAllRead.body?.updated !== 'number') {
        throw new Error('notification mark all read e2e returned unexpected payload');
      }
      ok('notification mark all read e2e', markAllRead.response.status);
    } finally {
      await notificationStates.deleteMany({ userId });
      if (originalStates.length > 0) {
        await notificationStates.insertMany(originalStates);
      }
    }
  });
}

async function runWebhookConfigMutationSmoke(token) {
  const unknownProvider = await authedJson(token, 'POST', '/api/v2/webhook/smoke-unknown/config', {
    whitelistIP: '127.0.0.1',
  });
  assertStatus('webhook config unknown provider', unknownProvider.response, unknownProvider.body, 404);
  ok('webhook config unknown provider', unknownProvider.response.status);

  const unsafeDigiflazz = await authedJson(token, 'POST', '/api/v2/webhook/digiflazz/config', {
    secret: '',
    whitelistIP: '',
  });
  assertStatus('webhook digiflazz empty protection boundary', unsafeDigiflazz.response, unsafeDigiflazz.body, 400);
  ok('webhook digiflazz empty protection boundary', unsafeDigiflazz.response.status);

  await withSmokeDb(async ({ settings }) => {
    const keys = ['digiflazzWhitelistIP', 'digiflazzWebhookSecret'];
    const originals = await settings.find({ key: { $in: keys } }).toArray();
    try {
      const saveWhitelist = await authedJson(token, 'POST', '/api/v2/webhook/digiflazz/config', {
        whitelistIP: '127.0.0.1, 10.0.0.1',
      });
      assertStatus('webhook digiflazz whitelist save e2e', saveWhitelist.response, saveWhitelist.body, 200);
      ok('webhook digiflazz whitelist save e2e', saveWhitelist.response.status);

      const config = await authedJson(token, 'GET', '/api/v2/webhook/digiflazz/config');
      assertStatus('webhook digiflazz whitelist readback e2e', config.response, config.body, 200);
      if (config.body?.whitelistIP !== '127.0.0.1,10.0.0.1' || config.body?.protected !== true) {
        throw new Error('webhook digiflazz whitelist readback returned unexpected payload');
      }
      ok('webhook digiflazz whitelist readback e2e', config.response.status);
    } finally {
      await settings.deleteMany({ key: { $in: keys } });
      if (originals.length > 0) {
        await settings.insertMany(originals);
      }
    }
  });

  await withSmokeDb(async ({ settings }) => {
    const keys = ['tokovoucherWhitelistIP'];
    const originals = await settings.find({ key: { $in: keys } }).toArray();
    try {
      const tokovoucherBoundary = await authedJson(token, 'POST', '/api/v2/webhook/tokovoucher/config', {
        whitelistIP: '127.0.0.1',
      });
      if (![200, 400].includes(tokovoucherBoundary.response.status)) {
        assertStatus('webhook tokovoucher config boundary', tokovoucherBoundary.response, tokovoucherBoundary.body, 400);
      } else {
        passedChecks += 1;
      }
      ok('webhook tokovoucher config boundary', tokovoucherBoundary.response.status);
    } finally {
      await settings.deleteMany({ key: { $in: keys } });
      if (originals.length > 0) {
        await settings.insertMany(originals);
      }
    }
  });
}

async function runMarginsMutationSmoke(token) {
  const negative = await authedJson(token, 'PUT', '/api/v2/margins', { basic: -1 });
  assertStatus('margins negative boundary', negative.response, negative.body, 400);
  ok('margins negative boundary', negative.response.status);

  const tooLarge = await authedJson(token, 'PUT', '/api/v2/margins', { gold: 501 });
  assertStatus('margins max boundary', tooLarge.response, tooLarge.body, 400);
  ok('margins max boundary', tooLarge.response.status);

  const longNote = await authedJson(token, 'PUT', '/api/v2/margins', { note: 'x'.repeat(501) });
  assertStatus('margins note length boundary', longNote.response, longNote.body, 400);
  ok('margins note length boundary', longNote.response.status);

  await withSmokeDb(async ({ settings }) => {
    const original = await settings.findOne({ key: 'margins' });
    try {
      const update = await authedJson(token, 'PUT', '/api/v2/margins', {
        basic: 11,
        gold: 6,
        platinum: 1,
        note: 'API v2 mutation smoke margins restore check',
      });
      assertStatus('margins valid update e2e', update.response, update.body, 200);
      if (update.body?.data?.basic !== 11 || update.body?.data?.gold !== 6 || update.body?.data?.platinum !== 1) {
        throw new Error('margins valid update e2e returned unexpected payload');
      }
      ok('margins valid update e2e', update.response.status);
    } finally {
      await settings.deleteMany({ key: 'margins' });
      if (original) {
        await settings.insertOne(original);
      }
    }
  });
}

async function runUploadBoundarySmoke(token) {
  const missingFilename = await authedJson(token, 'DELETE', '/api/v2/upload?type=icons');
  assertStatus('upload delete missing filename boundary', missingFilename.response, missingFilename.body, 400);
  ok('upload delete missing filename boundary', missingFilename.response.status);

  const traversal = await authedJson(token, 'DELETE', '/api/v2/upload?type=icons&filename=../package.json');
  assertStatus('upload delete traversal boundary', traversal.response, traversal.body, 404);
  ok('upload delete traversal boundary', traversal.response.status);
}

async function runDepositE2eSmoke(token, paymentMethodId, suffix) {
  await withSmokeDb(async ({ ObjectId, deposits, users }) => {
    const userId = new ObjectId(await getSmokeUserId(token));
    const paymentMethodObjectId = new ObjectId(paymentMethodId);
    const createdDepositIds = [];
    let originalBalance = null;
    const marker = `api-v2-smoke-${suffix}`;

    const createDeposit = async (label, amount = 12000, adminFee = 100) => {
      const now = new Date();
      const result = await deposits.insertOne({
        user: userId,
        amount,
        uniqueCode: 0,
        adminFee,
        totalAmount: amount,
        paymentMethod: paymentMethodObjectId,
        status: 'pending',
        proof: `${marker}-${label}`,
        createdAt: now,
        updatedAt: now,
      });
      createdDepositIds.push(result.insertedId);
      return result.insertedId.toString();
    };

    try {
      const claimDepositId = await createDeposit('claim-release-reject');
      const claim = await authedJson(token, 'POST', `/api/v2/deposits/${claimDepositId}/claim`);
      assertStatus('deposit e2e claim', claim.response, claim.body, 200);
      if ((claim.body?.deposit?.assignedTo?._id || '') !== userId.toString()) {
        throw new Error('deposit e2e claim did not assign deposit to smoke user');
      }
      optionalDepositE2eChecks += 1;
      ok('deposit e2e claim', claim.response.status);

      const release = await authedJson(token, 'POST', `/api/v2/deposits/${claimDepositId}/release-claim`);
      assertStatus('deposit e2e release claim', release.response, release.body, 200);
      if (release.body?.deposit?.assignedTo?._id) {
        throw new Error('deposit e2e release did not clear assignment');
      }
      optionalDepositE2eChecks += 1;
      ok('deposit e2e release claim', release.response.status);

      const reject = await authedJson(token, 'PUT', `/api/v2/deposits/${claimDepositId}/reject`, {
        note: 'API v2 mutation smoke rejection',
      });
      assertStatus('deposit e2e reject', reject.response, reject.body, 200);
      if (reject.body?.deposit?.status !== 'rejected') {
        throw new Error('deposit e2e reject did not mark deposit rejected');
      }
      optionalDepositE2eChecks += 1;
      ok('deposit e2e reject', reject.response.status);

      const userBefore = await users.findOne({ _id: userId }, { projection: { balance: 1 } });
      if (!userBefore) {
        throw new Error('deposit e2e user not found');
      }
      originalBalance = Number(userBefore.balance || 0);
      const approveDepositId = await createDeposit('approve', 15000, 250);
      const approve = await authedJson(token, 'PUT', `/api/v2/deposits/${approveDepositId}/approve`, {
        note: 'API v2 mutation smoke approval',
      });
      assertStatus('deposit e2e approve', approve.response, approve.body, 200);
      const expectedBalance = originalBalance + 14750;
      if (approve.body?.deposit?.status !== 'approved' || Number(approve.body?.newBalance) !== expectedBalance) {
        throw new Error('deposit e2e approve did not credit expected balance');
      }
      optionalDepositE2eChecks += 1;
      ok('deposit e2e approve', approve.response.status);

      await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      optionalDepositE2eChecks += 1;
      ok('deposit e2e balance restore', 200);
    } finally {
      if (originalBalance !== null) {
        await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      }
      if (createdDepositIds.length > 0) {
        await deposits.deleteMany({ _id: { $in: createdDepositIds } });
      }
      await deposits.deleteMany({ proof: { $regex: `^${marker}` } });
    }
  });
}

async function runDepositCreateE2eSmoke(suffix) {
    if (!memberEmail || !memberPassword) {
    skip('deposit create e2e', 'no member credentials');
    return;
  }

  await withSmokeDb(async ({ deposits, paymentCategories, paymentMethods }) => {
    const marker = `api-v2-smoke-deposit-create-${suffix}`;
    let categoryId = null;
    let methodId = null;

    const now = new Date();
    const category = await paymentCategories.insertOne({
      name: `Smoke Deposit Create ${suffix}`,
      slug: marker,
      icon: '/uploads/icons/smoke-payment.svg',
      order: 9999,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    categoryId = category.insertedId;
    const method = await paymentMethods.insertOne({
      name: `Smoke Deposit Method ${suffix}`,
      category: categoryId,
      accountNumber: `SMOKE-${suffix}`,
      accountName: 'Smoke Test',
      icon: '/uploads/icons/smoke-method.svg',
      minAmount: 10000,
      maxAmount: 20000,
      adminFee: 100,
      adminPercent: 0,
      operationalStart: '00:00',
      operationalEnd: '00:00',
      useUniqueCode: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    methodId = method.insertedId;

    const token = await loginWithCredentials(memberEmail, memberPassword, 'member');
    let depositId = null;
    try {
      const create = await authedJson(token, 'POST', '/api/v2/deposits', {
        amount: 12000,
        paymentMethodId: methodId.toString(),
      });
      assertStatus('deposit create e2e', create.response, create.body, 201);
      depositId = create.body?.deposit?._id;
      if (!depositId || create.body?.deposit?.status !== 'pending' || Number(create.body?.paymentInfo?.amount) !== 12000) {
        throw new Error('deposit create e2e returned unexpected deposit payload');
      }
      optionalDepositCreateE2eChecks += 1;
      ok('deposit create e2e', create.response.status);
    } finally {
      if (depositId) {
        await deposits.deleteOne({ _id: depositId });
      }
      if (methodId) {
        await paymentMethods.deleteOne({ _id: methodId });
      }
      if (categoryId) {
        await paymentCategories.deleteOne({ _id: categoryId });
      }
      await deposits.deleteMany({ paymentMethod: methodId });
    }
  });
}

async function runPointsE2eSmoke(token, suffix) {
  await withSmokeDb(async ({ ObjectId, pointTransactions, users }) => {
    const userId = new ObjectId(await getSmokeUserId(token));
    const marker = `API v2 mutation smoke points ${suffix}`;
    let originalPoints = null;

    try {
      const userBefore = await users.findOne({ _id: userId }, { projection: { points: 1 } });
      if (!userBefore) {
        throw new Error('points e2e user not found');
      }
      originalPoints = Number(userBefore.points || 0);

      const add = await authedJson(token, 'POST', '/api/v2/points/adjust', {
        userId: userId.toString(),
        points: 7,
        description: `${marker} add`,
      });
      assertStatus('points e2e add', add.response, add.body, 200);
      if (Number(add.body?.newPoints) !== originalPoints + 7) {
        throw new Error('points e2e add did not return expected points');
      }
      optionalPointsE2eChecks += 1;
      ok('points e2e add', add.response.status);

      const subtract = await authedJson(token, 'POST', '/api/v2/points/adjust', {
        userId: userId.toString(),
        points: -7,
        description: `${marker} subtract`,
      });
      assertStatus('points e2e subtract', subtract.response, subtract.body, 200);
      if (Number(subtract.body?.newPoints) !== originalPoints) {
        throw new Error('points e2e subtract did not restore expected points');
      }
      optionalPointsE2eChecks += 1;
      ok('points e2e subtract', subtract.response.status);
    } finally {
      if (originalPoints !== null) {
        await users.updateOne({ _id: userId }, { $set: { points: originalPoints, updatedAt: new Date() } });
      }
      await pointTransactions.deleteMany({ description: { $regex: `^${marker}` } });
    }
  });
}

async function runVoucherE2eSmoke(token, suffix) {
  await withSmokeDb(async ({ ObjectId, users, vouchers }) => {
    const userId = new ObjectId(await getSmokeUserId(token));
    const code = `SMOKERDM${suffix.replace(/[^a-z0-9]/gi, '').toUpperCase()}`.slice(0, 32);
    const amount = 777;
    let voucherId = null;
    let originalBalance = null;

    try {
      const userBefore = await users.findOne({ _id: userId }, { projection: { balance: 1 } });
      if (!userBefore) {
        throw new Error('voucher e2e user not found');
      }
      originalBalance = Number(userBefore.balance || 0);
      const now = new Date();
      const voucher = await vouchers.insertOne({
        code,
        amount,
        isRedeemed: false,
        isArchived: false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      voucherId = voucher.insertedId;

      const redeem = await authedJson(token, 'POST', '/api/v2/vouchers/redeem', { code: code.toLowerCase() });
      assertStatus('voucher e2e redeem', redeem.response, redeem.body, 200);
      if (redeem.body?.code !== code || Number(redeem.body?.amount) !== amount || Number(redeem.body?.newBalance) !== originalBalance + amount) {
        throw new Error('voucher e2e redeem did not credit expected balance');
      }
      optionalVoucherE2eChecks += 1;
      ok('voucher e2e redeem', redeem.response.status);

      const duplicate = await authedJson(token, 'POST', '/api/v2/vouchers/redeem', { code });
      assertStatus('voucher e2e duplicate redeem', duplicate.response, duplicate.body, 400);
      optionalVoucherE2eChecks += 1;
      ok('voucher e2e duplicate redeem', duplicate.response.status);

      await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      optionalVoucherE2eChecks += 1;
      ok('voucher e2e balance restore', 200);
    } finally {
      if (originalBalance !== null) {
        await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      }
      if (voucherId) {
        await vouchers.deleteOne({ _id: voucherId });
      }
      await vouchers.deleteMany({ code });
    }
  });
}

async function runBalanceAdjustE2eSmoke(token, suffix) {
  await withSmokeDb(async ({ userBalanceAdjustments, users }) => {
    const targetUser = await users.findOne({ role: 'member' }, { projection: { balance: 1 } });
    if (!targetUser) {
      skip('balance adjust e2e', 'no member fixture');
      return;
    }
    const userId = targetUser._id;
    const marker = `API v2 mutation smoke balance ${suffix}`;
    const amount = 321;
    let originalBalance = null;

    try {
      originalBalance = Number(targetUser.balance || 0);

      const add = await authedJson(token, 'POST', `/api/v2/users/${userId.toString()}/balance`, {
        amount,
        type: 'add',
        reason: `${marker} add`,
      });
      assertStatus('balance adjust e2e add', add.response, add.body, 200);
      if (Number(add.body?.audit?.balanceBefore) !== originalBalance || Number(add.body?.audit?.balanceAfter) !== originalBalance + amount) {
        throw new Error('balance adjust e2e add returned unexpected balance audit');
      }
      optionalBalanceAdjustE2eChecks += 1;
      ok('balance adjust e2e add', add.response.status);

      const subtract = await authedJson(token, 'POST', `/api/v2/users/${userId.toString()}/balance`, {
        amount,
        type: 'subtract',
        reason: `${marker} subtract`,
      });
      assertStatus('balance adjust e2e subtract', subtract.response, subtract.body, 200);
      if (Number(subtract.body?.audit?.balanceBefore) !== originalBalance + amount || Number(subtract.body?.audit?.balanceAfter) !== originalBalance) {
        throw new Error('balance adjust e2e subtract returned unexpected balance audit');
      }
      optionalBalanceAdjustE2eChecks += 1;
      ok('balance adjust e2e subtract', subtract.response.status);

      await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      optionalBalanceAdjustE2eChecks += 1;
      ok('balance adjust e2e balance restore', 200);
    } finally {
      if (originalBalance !== null) {
        await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      }
      await userBalanceAdjustments.deleteMany({ reason: { $regex: `^${marker}` } });
    }
  });
}

async function runTransactionRefundE2eSmoke(token, suffix) {
  await withSmokeDb(async ({ ObjectId, products, transactions, userBalanceAdjustments, users }) => {
    const targetUser = await users.findOne({ role: 'member' }, { projection: { balance: 1 } });
    if (!targetUser) {
      skip('transaction refund e2e', 'no member fixture');
      return;
    }

    const userId = targetUser._id;
    const marker = `API v2 mutation smoke refund ${suffix}`;
    const amount = 432;
    let originalBalance = Number(targetUser.balance || 0);
    let productId = null;
    let transactionId = null;

    try {
      const now = new Date();
      const product = await products.insertOne({
        name: `Smoke Refund Product ${suffix}`,
        code: `SMOKEREFUND-${suffix}`.toUpperCase().slice(0, 40),
        category: 'Smoke',
        brand: 'Smoke',
        vendor: { name: 'Smoke Vendor' },
        price: amount,
        status: false,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      productId = product.insertedId;
      const transaction = await transactions.insertOne({
        user: userId,
        product: productId,
        target: `smoke-refund-${suffix}`,
        amount,
        status: 'processing',
        customerRefId: `SMOKE-REFUND-${suffix}`,
        message: marker,
        refunded: false,
        source: 'web',
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      transactionId = transaction.insertedId;

      const refund = await authedJson(token, 'POST', `/api/v2/transactions/${transactionId.toString()}/refund`, {
        reason: `${marker} reason`,
      });
      assertStatus('transaction refund e2e', refund.response, refund.body, 200);
      if (refund.body?.message !== 'Saldo transaksi berhasil direfund' || refund.body?.transaction?.status !== 'failed' || refund.body?.transaction?.refunded !== true) {
        throw new Error('transaction refund e2e returned unexpected transaction payload');
      }
      optionalTransactionRefundE2eChecks += 1;
      ok('transaction refund e2e', refund.response.status);

      const userAfter = await users.findOne({ _id: userId }, { projection: { balance: 1 } });
      if (Number(userAfter?.balance || 0) !== originalBalance + amount) {
        throw new Error('transaction refund e2e did not credit expected balance');
      }
      const updatedTransaction = await transactions.findOne({ _id: transactionId });
      if (!updatedTransaction?.refunded || updatedTransaction.status !== 'failed' || updatedTransaction.refundReason !== `${marker} reason`) {
        throw new Error('transaction refund e2e did not persist refund metadata');
      }
      const adjustment = await userBalanceAdjustments.findOne({ user: userId, reason: { $regex: `^Refund transaksi .*${marker}` } });
      if (!adjustment || Number(adjustment.amount) !== amount || adjustment.type !== 'add') {
        throw new Error('transaction refund e2e did not create expected balance adjustment');
      }
      optionalTransactionRefundE2eChecks += 1;
      ok('transaction refund e2e balance and audit', 200);

      const duplicate = await authedJson(token, 'POST', `/api/v2/transactions/${transactionId.toString()}/refund`, {
        reason: `${marker} duplicate`,
      });
      assertStatus('transaction refund e2e duplicate', duplicate.response, duplicate.body, 409);
      optionalTransactionRefundE2eChecks += 1;
      ok('transaction refund e2e duplicate', duplicate.response.status);

      await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      optionalTransactionRefundE2eChecks += 1;
      ok('transaction refund e2e balance restore', 200);
    } finally {
      await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, updatedAt: new Date() } });
      await userBalanceAdjustments.deleteMany({ reason: { $regex: `^Refund transaksi .*${marker}` } });
      if (transactionId) {
        await transactions.deleteOne({ _id: transactionId });
      }
      await transactions.deleteMany({ customerRefId: `SMOKE-REFUND-${suffix}` });
      if (productId) {
        await products.deleteOne({ _id: productId });
      }
    }
  });
}

async function runTransactionStatusE2eSmoke(token, suffix) {
  await withSmokeDb(async ({ products, pointTransactions, transactions, users }) => {
    const targetUser = await users.findOne({ role: 'member' }, { projection: { balance: 1, points: 1 } });
    if (!targetUser) {
      skip('transaction status e2e', 'no member fixture');
      return;
    }

    const userId = targetUser._id;
    const marker = `API v2 mutation smoke status ${suffix}`;
    const amount = 20000;
    const originalBalance = Number(targetUser.balance || 0);
    const originalPoints = Number(targetUser.points || 0);
    let productId = null;
    let transactionId = null;

    try {
      const now = new Date();
      const product = await products.insertOne({
        name: `Smoke Status Product ${suffix}`,
        code: `SMOKESTATUS-${suffix}`.toUpperCase().slice(0, 40),
        category: 'Smoke',
        brand: 'Smoke',
        vendor: { name: 'Smoke Vendor' },
        price: amount,
        status: false,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      productId = product.insertedId;
      const transaction = await transactions.insertOne({
        user: userId,
        product: productId,
        target: `smoke-status-${suffix}`,
        amount,
        status: 'pending',
        customerRefId: `SMOKE-STATUS-${suffix}`,
        message: marker,
        refunded: false,
        source: 'web',
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      transactionId = transaction.insertedId;

      const fail = await authedJson(token, 'PUT', `/api/v2/transactions/${transactionId.toString()}/status`, {
        status: 'failed',
        vendorTrxId: `VENDOR-${suffix}`,
        sn: `SN-${suffix}`,
        note: `${marker} failed`,
      });
      assertStatus('transaction status e2e pending to failed', fail.response, fail.body, 200);
      if (fail.body?.message !== 'Transaction updated' || fail.body?.transaction?.status !== 'failed' || fail.body?.transaction?.refunded !== true) {
        throw new Error('transaction status e2e failed transition returned unexpected payload');
      }
      const afterFailUser = await users.findOne({ _id: userId }, { projection: { balance: 1 } });
      if (Number(afterFailUser?.balance || 0) !== originalBalance + amount) {
        throw new Error('transaction status e2e failed transition did not credit balance');
      }
      optionalTransactionStatusE2eChecks += 1;
      ok('transaction status e2e pending to failed', fail.response.status);

      const processing = await authedJson(token, 'PUT', `/api/v2/transactions/${transactionId.toString()}/status`, {
        status: 'processing',
        vendorTrxId: '',
        sn: '',
        note: `${marker} processing`,
      });
      assertStatus('transaction status e2e failed to processing', processing.response, processing.body, 200);
      const afterProcessing = await transactions.findOne({ _id: transactionId });
      const afterProcessingUser = await users.findOne({ _id: userId }, { projection: { balance: 1 } });
      if (afterProcessing?.refunded !== false || Object.prototype.hasOwnProperty.call(afterProcessing, 'vendorTrxId') || Object.prototype.hasOwnProperty.call(afterProcessing, 'sn')) {
        throw new Error('transaction status e2e processing transition did not clear refunded/vendor fields');
      }
      if (Number(afterProcessingUser?.balance || 0) !== originalBalance) {
        throw new Error('transaction status e2e processing transition did not debit refunded balance');
      }
      optionalTransactionStatusE2eChecks += 1;
      ok('transaction status e2e failed to processing', processing.response.status);

      const success = await authedJson(token, 'PUT', `/api/v2/transactions/${transactionId.toString()}/status`, {
        status: 'success',
        note: `${marker} success`,
      });
      assertStatus('transaction status e2e processing to success', success.response, success.body, 200);
      const earned = await pointTransactions.findOne({ user: userId, relatedTransaction: transactionId, type: 'earn' });
      const afterSuccessUser = await users.findOne({ _id: userId }, { projection: { points: 1 } });
      if (!earned || Number(earned.points || 0) <= 0 || Number(afterSuccessUser?.points || 0) !== originalPoints + Number(earned.points || 0)) {
        throw new Error('transaction status e2e success transition did not award points');
      }
      optionalTransactionStatusE2eChecks += 1;
      ok('transaction status e2e processing to success', success.response.status);

      const failedAgain = await authedJson(token, 'PUT', `/api/v2/transactions/${transactionId.toString()}/status`, {
        status: 'failed',
        note: `${marker} failed again`,
      });
      assertStatus('transaction status e2e success to failed', failedAgain.response, failedAgain.body, 200);
      const pointNet = await pointTransactions.aggregate([
        { $match: { user: userId, relatedTransaction: transactionId } },
        { $group: { _id: null, total: { $sum: '$points' } } },
      ]).toArray();
      const afterFailedAgainUser = await users.findOne({ _id: userId }, { projection: { balance: 1, points: 1 } });
      if (Number(pointNet[0]?.total || 0) !== 0 || Number(afterFailedAgainUser?.points || 0) !== originalPoints) {
        throw new Error('transaction status e2e failed transition did not revoke points');
      }
      if (Number(afterFailedAgainUser?.balance || 0) !== originalBalance + amount) {
        throw new Error('transaction status e2e success to failed did not credit balance');
      }
      optionalTransactionStatusE2eChecks += 1;
      ok('transaction status e2e success to failed', failedAgain.response.status);

      await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, points: originalPoints, updatedAt: new Date() } });
      optionalTransactionStatusE2eChecks += 1;
      ok('transaction status e2e balance points restore', 200);
    } finally {
      await users.updateOne({ _id: userId }, { $set: { balance: originalBalance, points: originalPoints, updatedAt: new Date() } });
      if (transactionId) {
        await pointTransactions.deleteMany({ relatedTransaction: transactionId });
        await transactions.deleteOne({ _id: transactionId });
      }
      await transactions.deleteMany({ customerRefId: `SMOKE-STATUS-${suffix}` });
      if (productId) {
        await products.deleteOne({ _id: productId });
      }
    }
  });
}

async function runGuestTransactionE2eSmoke(token, suffix) {
  await withSmokeDb(async ({ ObjectId, guestTransactions, paymentCategories, paymentMethods, products }) => {
    const method = await paymentMethods.findOne({}, { projection: { _id: 1 } });
    if (!method) {
      skip('guest transaction e2e', 'no payment method fixture');
      return;
    }

    const marker = `API v2 mutation smoke guest ${suffix}`;
    let productId = null;
    let createProductId = null;
    let createCategoryId = null;
    let createMethodId = null;
    const createdGuestIds = [];

    const createGuest = async (label, paymentStatus = 'waiting_payment', transactionStatus = 'pending') => {
      const now = new Date();
      const result = await guestTransactions.insertOne({
        invoiceNumber: `SMOKEGUEST${suffix.replace(/[^a-z0-9]/gi, '').toUpperCase()}${label}`.slice(0, 48),
        product: productId,
        target: `smoke-guest-${label}-${suffix}`,
        whatsapp: `62812${String(Date.now()).slice(-8)}`,
        email: `smoke-guest-${label}@example.test`,
        amount: 10000,
        adminFee: 100,
        uniqueCode: 123,
        totalAmount: 10223,
        paymentMethod: method._id,
        paymentStatus,
        transactionStatus,
        expiredAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      createdGuestIds.push(result.insertedId);
      return result.insertedId;
    };

    try {
      const now = new Date();
      const product = await products.insertOne({
        productId: `SMOKE-GUEST-${suffix}`.toUpperCase().slice(0, 48),
        name: `Smoke Guest Product ${suffix}`,
        code: `SMOKEGUEST-${suffix}`.toUpperCase().slice(0, 40),
        category: 'Smoke',
        brand: 'Smoke',
        vendor: { name: 'Smoke Vendor' },
        price: { basic: 10000, gold: 10000, platinum: 10000 },
        status: false,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      productId = product.insertedId;

      const createCategory = await paymentCategories.insertOne({
        name: `Smoke Guest Bank Transfer ${suffix}`,
        slug: `smoke-guest-bank-transfer-${suffix}`,
        status: 'active',
        order: 9999,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      createCategoryId = createCategory.insertedId;

      const createMethod = await paymentMethods.insertOne({
        name: `Smoke Guest Bank ${suffix}`,
        category: createCategoryId,
        accountNumber: `SMOKEGUEST${suffix.replace(/[^a-z0-9]/gi, '').toUpperCase()}`.slice(0, 32),
        accountName: 'Smoke Guest Test',
        minAmount: 1000,
        maxAmount: 5000000,
        adminFee: 100,
        adminPercent: 1,
        operationalStart: '00:00',
        operationalEnd: '23:59',
        useUniqueCode: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      createMethodId = createMethod.insertedId;

      const createProduct = await products.insertOne({
        productId: `SMOKE-GUEST-CREATE-${suffix}`.toUpperCase().slice(0, 48),
        name: `Smoke Guest Create Product ${suffix}`,
        code: `SMOKEGUESTCREATE-${suffix}`.toUpperCase().slice(0, 48),
        category: `Smoke Guest Create Category ${suffix}`,
        brand: `Smoke Guest Create Brand ${suffix}`,
        vendor: { name: 'Smoke Vendor' },
        price: { basic: 10000, gold: 10000, platinum: 10000 },
        status: true,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      createProductId = createProduct.insertedId;

      const guestCreate = await jsonRequest('POST', '/api/v2/guest-transactions', {
        productCode: `SMOKEGUESTCREATE-${suffix}`.toUpperCase().slice(0, 48),
        target: `smoke-guest-create-${suffix}`,
        whatsapp: `+62 812 ${String(Date.now()).slice(-8)}`,
        email: `smoke-guest-create-${suffix}@example.test`,
        paymentMethodId: createMethodId.toString(),
      }, {
        headers: { Authorization: 'Bearer intentionally-invalid-smoke-token' },
      });
      assertStatus('guest transaction e2e create', guestCreate.response, guestCreate.body, 201);
      const createdId = objectId(guestCreate.body?.transaction?._id, 'guest transaction e2e create');
      createdGuestIds.push(new ObjectId(createdId));
      if (guestCreate.body?.transaction?.paymentStatus !== 'waiting_payment' || guestCreate.body?.transaction?.transactionStatus !== 'pending' || guestCreate.body?.paymentInfo?.totalAmount < 10100) {
        throw new Error('guest transaction e2e create returned unexpected payload');
      }
      optionalGuestTransactionE2eChecks += 1;
      ok('guest transaction e2e create', guestCreate.response.status);

      const persistedGuestCreate = await guestTransactions.findOne({ _id: new ObjectId(createdId) });
      if (!persistedGuestCreate || persistedGuestCreate.product.toString() !== createProductId.toString() || persistedGuestCreate.paymentMethod.toString() !== createMethodId.toString()) {
        throw new Error('guest transaction e2e create did not persist expected references');
      }
      optionalGuestTransactionE2eChecks += 1;
      ok('guest transaction e2e create persistence', 200);

      const cancelId = await createGuest('CANCEL');
      const cancel = await authedJson(token, 'POST', `/api/v2/guest-transactions/${cancelId.toString()}/cancel`, {
        note: `${marker} cancel`,
      });
      assertStatus('guest transaction e2e cancel', cancel.response, cancel.body, 200);
      if (cancel.body?.message !== 'Transaksi guest dibatalkan' || cancel.body?.transaction?.paymentStatus !== 'cancelled' || cancel.body?.transaction?.transactionStatus !== 'failed') {
        throw new Error('guest transaction e2e cancel returned unexpected payload');
      }
      optionalGuestTransactionE2eChecks += 1;
      ok('guest transaction e2e cancel', cancel.response.status);

      const paidId = await createGuest('STATUS', 'paid', 'processing');
      const success = await authedJson(token, 'PUT', `/api/v2/guest-transactions/${paidId.toString()}/status`, {
        transactionStatus: 'success',
        vendorTrxId: `GUEST-VENDOR-${suffix}`,
        sn: `GUEST-SN-${suffix}`,
        note: `${marker} success`,
      });
      assertStatus('guest transaction e2e status success', success.response, success.body, 200);
      if (success.body?.message !== 'Status transaksi guest diperbarui' || success.body?.transaction?.transactionStatus !== 'success' || success.body?.transaction?.vendorTrxId !== `GUEST-VENDOR-${suffix}` || success.body?.transaction?.sn !== `GUEST-SN-${suffix}`) {
        throw new Error('guest transaction e2e status success returned unexpected payload');
      }
      optionalGuestTransactionE2eChecks += 1;
      ok('guest transaction e2e status success', success.response.status);

      const clear = await authedJson(token, 'PUT', `/api/v2/guest-transactions/${paidId.toString()}/status`, {
        transactionStatus: 'failed',
        vendorTrxId: '',
        sn: '',
        note: `${marker} clear`,
      });
      assertStatus('guest transaction e2e status clear', clear.response, clear.body, 200);
      const cleared = await guestTransactions.findOne({ _id: paidId });
      if (cleared?.transactionStatus !== 'failed' || Object.prototype.hasOwnProperty.call(cleared, 'vendorTrxId') || Object.prototype.hasOwnProperty.call(cleared, 'sn')) {
        throw new Error('guest transaction e2e status clear did not clear optional fields');
      }
      optionalGuestTransactionE2eChecks += 1;
      ok('guest transaction e2e status clear', clear.response.status);
    } finally {
      if (createdGuestIds.length > 0) {
        await guestTransactions.deleteMany({ _id: { $in: createdGuestIds } });
      }
      await guestTransactions.deleteMany({ target: { $regex: `^smoke-guest-.*${suffix}` } });
      if (productId) {
        await products.deleteOne({ _id: productId });
      }
      if (createProductId) {
        await products.deleteOne({ _id: createProductId });
      }
      if (createMethodId) {
        await paymentMethods.deleteOne({ _id: createMethodId });
      }
      if (createCategoryId) {
        await paymentCategories.deleteOne({ _id: createCategoryId });
      }
    }
  });
}

async function assertNegativeMutationChecks() {
  const payload = {
    name: `Smoke Negative ${Date.now()}`,
    slug: `smoke-negative-${Date.now()}`,
    status: 'inactive',
  };
  const gatewayUnauth = await jsonRequest('POST', '/api/v2/payment-categories', payload);
  assertStatus('gateway unauthenticated mutation rejection', gatewayUnauth.response, gatewayUnauth.body, 401);
  console.log(`ok gateway unauthenticated mutation rejection ${gatewayUnauth.response.status}`);

  if (!hasExplicitRustBaseUrl) {
    skip('direct rust mutation proxy guard checks', 'no API_V2_DIRECT_URL');
    return;
  }

  const directRust = await jsonRequest('POST', '/v2/payment-categories', payload, { baseUrl: rustBaseUrl });
  assertStatus('direct rust mutation proxy rejection', directRust.response, directRust.body, 403);
  console.log(`ok direct rust mutation proxy rejection ${directRust.response.status}`);

  const directRustDepositClaim = await jsonRequest('POST', '/v2/deposits/000000000000000000000000/claim', undefined, {
    baseUrl: rustBaseUrl,
  });
  assertStatus(
    'direct rust deposit claim proxy rejection',
    directRustDepositClaim.response,
    directRustDepositClaim.body,
    403,
  );
  console.log(`ok direct rust deposit claim proxy rejection ${directRustDepositClaim.response.status}`);

  const directRustDepositReject = await jsonRequest(
    'PUT',
    '/v2/deposits/000000000000000000000000/reject',
    { note: 'Smoke rejection boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust deposit reject proxy rejection',
    directRustDepositReject.response,
    directRustDepositReject.body,
    403,
  );
  console.log(`ok direct rust deposit reject proxy rejection ${directRustDepositReject.response.status}`);

  const directRustDepositApprove = await jsonRequest(
    'PUT',
    '/v2/deposits/000000000000000000000000/approve',
    { note: 'Smoke approval boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust deposit approve proxy rejection',
    directRustDepositApprove.response,
    directRustDepositApprove.body,
    403,
  );
  console.log(`ok direct rust deposit approve proxy rejection ${directRustDepositApprove.response.status}`);

  const directRustPointsAdjust = await jsonRequest(
    'POST',
    '/v2/points/adjust',
    { userId: '000000000000000000000000', points: 1, description: 'Smoke points boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust points adjust proxy rejection',
    directRustPointsAdjust.response,
    directRustPointsAdjust.body,
    403,
  );
  console.log(`ok direct rust points adjust proxy rejection ${directRustPointsAdjust.response.status}`);

  const directRustVoucherRedeem = await jsonRequest(
    'POST',
    '/v2/vouchers/redeem',
    { code: 'SMOKEBOUNDARY' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust voucher redeem proxy rejection',
    directRustVoucherRedeem.response,
    directRustVoucherRedeem.body,
    403,
  );
  console.log(`ok direct rust voucher redeem proxy rejection ${directRustVoucherRedeem.response.status}`);

  const directRustBalanceAdjust = await jsonRequest(
    'POST',
    '/v2/users/000000000000000000000000/balance',
    { amount: 1, type: 'add', reason: 'Smoke balance boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust balance adjust proxy rejection',
    directRustBalanceAdjust.response,
    directRustBalanceAdjust.body,
    403,
  );
  console.log(`ok direct rust balance adjust proxy rejection ${directRustBalanceAdjust.response.status}`);

  const directRustDepositCreate = await jsonRequest(
    'POST',
    '/v2/deposits',
    { amount: 10000, paymentMethodId: '000000000000000000000000' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust deposit create proxy rejection',
    directRustDepositCreate.response,
    directRustDepositCreate.body,
    403,
  );
  console.log(`ok direct rust deposit create proxy rejection ${directRustDepositCreate.response.status}`);

  const directRustTwoFactorSetup = await jsonRequest(
    'POST',
    '/v2/auth/2fa/setup',
    {},
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust 2fa setup proxy rejection', directRustTwoFactorSetup.response, directRustTwoFactorSetup.body, 403);
  console.log(`ok direct rust 2fa setup proxy rejection ${directRustTwoFactorSetup.response.status}`);

  const directRustTwoFactorConfirm = await jsonRequest(
    'POST',
    '/v2/auth/2fa/confirm',
    { code: '000000' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust 2fa confirm proxy rejection', directRustTwoFactorConfirm.response, directRustTwoFactorConfirm.body, 403);
  console.log(`ok direct rust 2fa confirm proxy rejection ${directRustTwoFactorConfirm.response.status}`);

  const directRustTwoFactorDisable = await jsonRequest(
    'POST',
    '/v2/auth/2fa/disable',
    { code: '000000' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust 2fa disable proxy rejection', directRustTwoFactorDisable.response, directRustTwoFactorDisable.body, 403);
  console.log(`ok direct rust 2fa disable proxy rejection ${directRustTwoFactorDisable.response.status}`);

  const directRustSessionRevoke = await jsonRequest(
    'POST',
    '/v2/auth/sessions/revoke',
    {},
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust session revoke proxy rejection', directRustSessionRevoke.response, directRustSessionRevoke.body, 403);
  console.log(`ok direct rust session revoke proxy rejection ${directRustSessionRevoke.response.status}`);

  const directRustPasswordChange = await jsonRequest(
    'PUT',
    '/v2/users/me/password',
    { currentPassword: 'old-password', newPassword: 'new-password', confirmPassword: 'new-password' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust password change proxy rejection', directRustPasswordChange.response, directRustPasswordChange.body, 403);
  console.log(`ok direct rust password change proxy rejection ${directRustPasswordChange.response.status}`);

  const directRustTeamResetTwoFactor = await jsonRequest(
    'PUT',
    '/v2/teams/000000000000000000000000/reset-2fa',
    {},
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust team reset 2fa proxy rejection', directRustTeamResetTwoFactor.response, directRustTeamResetTwoFactor.body, 403);
  console.log(`ok direct rust team reset 2fa proxy rejection ${directRustTeamResetTwoFactor.response.status}`);

  const directRustTransactionRefund = await jsonRequest(
    'POST',
    '/v2/transactions/000000000000000000000000/refund',
    { reason: 'Smoke refund boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust transaction refund proxy rejection',
    directRustTransactionRefund.response,
    directRustTransactionRefund.body,
    403,
  );
  console.log(`ok direct rust transaction refund proxy rejection ${directRustTransactionRefund.response.status}`);

  const directRustTransactionRecheck = await jsonRequest(
    'POST',
    '/v2/transactions/000000000000000000000000/recheck',
    {},
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust transaction recheck proxy rejection',
    directRustTransactionRecheck.response,
    directRustTransactionRecheck.body,
    403,
  );
  console.log(`ok direct rust transaction recheck proxy rejection ${directRustTransactionRecheck.response.status}`);

  const directRustTransactionStatus = await jsonRequest(
    'PUT',
    '/v2/transactions/000000000000000000000000/status',
    { status: 'failed', note: 'Smoke status boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust transaction status proxy rejection',
    directRustTransactionStatus.response,
    directRustTransactionStatus.body,
    403,
  );
  console.log(`ok direct rust transaction status proxy rejection ${directRustTransactionStatus.response.status}`);

  const directRustGuestCancel = await jsonRequest(
    'POST',
    '/v2/guest-transactions/000000000000000000000000/cancel',
    { note: 'Smoke guest cancel boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust guest transaction cancel proxy rejection',
    directRustGuestCancel.response,
    directRustGuestCancel.body,
    403,
  );
  console.log(`ok direct rust guest transaction cancel proxy rejection ${directRustGuestCancel.response.status}`);

  const directRustGuestConfirm = await jsonRequest(
    'POST',
    '/v2/guest-transactions/000000000000000000000000/confirm',
    { note: 'Smoke guest confirm boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust guest transaction confirm proxy rejection',
    directRustGuestConfirm.response,
    directRustGuestConfirm.body,
    403,
  );
  console.log(`ok direct rust guest transaction confirm proxy rejection ${directRustGuestConfirm.response.status}`);

  const directRustGuestStatus = await jsonRequest(
    'PUT',
    '/v2/guest-transactions/000000000000000000000000/status',
    { transactionStatus: 'failed', note: 'Smoke guest status boundary' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust guest transaction status proxy rejection',
    directRustGuestStatus.response,
    directRustGuestStatus.body,
    403,
  );
  console.log(`ok direct rust guest transaction status proxy rejection ${directRustGuestStatus.response.status}`);

  const directRustDigiflazzPricelistFetch = await jsonRequest(
    'POST',
    '/v2/vendors/digiflazz/pricelist/fetch',
    undefined,
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust digiflazz pricelist fetch proxy rejection',
    directRustDigiflazzPricelistFetch.response,
    directRustDigiflazzPricelistFetch.body,
    403,
  );
  console.log(`ok direct rust digiflazz pricelist fetch proxy rejection ${directRustDigiflazzPricelistFetch.response.status}`);

  const directRustDigiflazzSettingsSave = await jsonRequest(
    'POST',
    '/v2/vendors/digiflazz/settings',
    { username: 'smoke', apiKey: 'smoke' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust digiflazz settings save proxy rejection',
    directRustDigiflazzSettingsSave.response,
    directRustDigiflazzSettingsSave.body,
    403,
  );
  console.log(`ok direct rust digiflazz settings save proxy rejection ${directRustDigiflazzSettingsSave.response.status}`);

  const directRustTokovoucherSettingsSave = await jsonRequest(
    'POST',
    '/v2/vendors/tokovoucher/settings',
    { memberCode: 'smoke', secret: 'smoke' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust tokovoucher settings save proxy rejection',
    directRustTokovoucherSettingsSave.response,
    directRustTokovoucherSettingsSave.body,
    403,
  );
  console.log(`ok direct rust tokovoucher settings save proxy rejection ${directRustTokovoucherSettingsSave.response.status}`);

  const directRustVendorSync = await jsonRequest(
    'POST',
    '/v2/vendors/000000000000000000000000/sync',
    undefined,
    { baseUrl: rustBaseUrl },
  );
  assertStatus(
    'direct rust vendor sync proxy rejection',
    directRustVendorSync.response,
    directRustVendorSync.body,
    403,
  );
  console.log(`ok direct rust vendor sync proxy rejection ${directRustVendorSync.response.status}`);

  const directRustMarginsUpdate = await jsonRequest(
    'PUT',
    '/v2/margins',
    { basic: 1 },
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust margins update proxy rejection', directRustMarginsUpdate.response, directRustMarginsUpdate.body, 403);
  console.log(`ok direct rust margins update proxy rejection ${directRustMarginsUpdate.response.status}`);

  const directRustUploadDelete = await jsonRequest(
    'DELETE',
    '/v2/upload?type=icons&filename=smoke.png',
    undefined,
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust upload delete proxy rejection', directRustUploadDelete.response, directRustUploadDelete.body, 403);
  console.log(`ok direct rust upload delete proxy rejection ${directRustUploadDelete.response.status}`);

  const directRustUploadPost = await request('/v2/upload?type=icons', {
    baseUrl: rustBaseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=smoke' },
    body: '--smoke--\r\n',
  });
  assertStatus('direct rust upload post proxy rejection', directRustUploadPost.response, directRustUploadPost.body, 403);
  console.log(`ok direct rust upload post proxy rejection ${directRustUploadPost.response.status}`);

  const directRustUploadMultiplePost = await request('/v2/upload/multiple?type=icons', {
    baseUrl: rustBaseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=smoke' },
    body: '--smoke--\r\n',
  });
  assertStatus('direct rust upload multiple post proxy rejection', directRustUploadMultiplePost.response, directRustUploadMultiplePost.body, 403);
  console.log(`ok direct rust upload multiple post proxy rejection ${directRustUploadMultiplePost.response.status}`);

  const directRustNotificationReadAll = await jsonRequest(
    'POST',
    '/v2/notifications/admin/read-all',
    undefined,
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust notification read all proxy rejection', directRustNotificationReadAll.response, directRustNotificationReadAll.body, 403);
  console.log(`ok direct rust notification read all proxy rejection ${directRustNotificationReadAll.response.status}`);

  const directRustWebhookConfig = await jsonRequest(
    'POST',
    '/v2/webhook/digiflazz/config',
    { whitelistIP: '127.0.0.1' },
    { baseUrl: rustBaseUrl },
  );
  assertStatus('direct rust webhook config proxy rejection', directRustWebhookConfig.response, directRustWebhookConfig.body, 403);
  console.log(`ok direct rust webhook config proxy rejection ${directRustWebhookConfig.response.status}`);
}

async function main() {
  await assertNegativeMutationChecks();
  const token = await login();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const paymentCategorySlug = `smoke-payment-${suffix}`;
  const paymentCategoryName = `Smoke Payment ${suffix}`;
  const methodName = `Smoke Method ${suffix}`;
  const taxonomyCategoryName = `Smoke Category ${suffix}`;
  const operatorName = `Smoke Operator ${suffix}`;
  const productTypeName = `Smoke Product Type ${suffix}`;
  const vendorName = `Smoke Vendor ${suffix}`;
  const productName = `Smoke Product ${suffix}`;
  const productCode = `SMOKE-${suffix}`.toUpperCase();
  const sliderName = `Smoke Slider ${suffix}`;
  const articleTitle = `Smoke Article ${suffix}`;
  const rewardName = `Smoke Reward ${suffix}`;
  const voucherCode = `SMOKE${suffix.replace(/[^a-z0-9]/gi, '').toUpperCase()}`.slice(0, 30);
  let paymentCategoryId = null;
  let methodId = null;
  let taxonomyCategoryId = null;
  let operatorId = null;
  let productTypeId = null;
  let vendorId = null;
  let productId = null;
  let sliderId = null;
  let sliderRevision = null;
  let sliderCoverFilename = null;
  let sliderArchived = false;
  let articleId = null;
  let rewardId = null;
  let voucherId = null;
  let voucherArchived = false;

  try {
    const invalidDepositClaim = await authedJson(token, 'POST', '/api/v2/deposits/not-an-id/claim');
    assertStatus('deposit claim invalid id', invalidDepositClaim.response, invalidDepositClaim.body, 400);
    console.log(`ok deposit claim invalid id ${invalidDepositClaim.response.status}`);

    const invalidDepositRelease = await authedJson(token, 'POST', '/api/v2/deposits/not-an-id/release-claim');
    assertStatus('deposit release invalid id', invalidDepositRelease.response, invalidDepositRelease.body, 400);
    console.log(`ok deposit release invalid id ${invalidDepositRelease.response.status}`);

    const invalidDepositReject = await authedJson(token, 'PUT', '/api/v2/deposits/not-an-id/reject', {
      note: 'Smoke invalid id',
    });
    assertStepUpRequired('deposit reject invalid id', invalidDepositReject.response, invalidDepositReject.body);
    console.log(`ok deposit reject invalid id ${invalidDepositReject.response.status} AUTH_STEP_UP_REQUIRED`);

    const invalidDepositApprove = await authedJson(token, 'PUT', '/api/v2/deposits/not-an-id/approve', {
      note: 'Smoke invalid id',
    });
    assertStepUpRequired('deposit approve invalid id', invalidDepositApprove.response, invalidDepositApprove.body);
    console.log(`ok deposit approve invalid id ${invalidDepositApprove.response.status} AUTH_STEP_UP_REQUIRED`);

    const missingDepositApprove = await authedJson(
      token,
      'PUT',
      '/api/v2/deposits/000000000000000000000000/approve',
      { note: 'Smoke missing deposit' },
    );
    assertStepUpRequired('deposit approve missing deposit', missingDepositApprove.response, missingDepositApprove.body);
    console.log(`ok deposit approve missing deposit ${missingDepositApprove.response.status} AUTH_STEP_UP_REQUIRED`);

    const missingDepositRejectNote = await authedJson(
      token,
      'PUT',
      '/api/v2/deposits/000000000000000000000000/reject',
      { note: '' },
    );
    assertStepUpRequired('deposit reject missing note', missingDepositRejectNote.response, missingDepositRejectNote.body);
    console.log(`ok deposit reject missing note ${missingDepositRejectNote.response.status} AUTH_STEP_UP_REQUIRED`);

    const missingPointsUser = await authedJson(token, 'POST', '/api/v2/points/adjust', {
      userId: '000000000000000000000000',
      points: 1,
      description: 'Smoke missing points user',
    });
    assertStatus('points adjust missing user', missingPointsUser.response, missingPointsUser.body, 404);
    console.log(`ok points adjust missing user ${missingPointsUser.response.status}`);

    const invalidVoucherCode = await authedJson(token, 'POST', '/api/v2/vouchers/redeem', { code: 'bad!' });
    assertStatus('voucher redeem invalid code', invalidVoucherCode.response, invalidVoucherCode.body, 400);
    console.log(`ok voucher redeem invalid code ${invalidVoucherCode.response.status}`);

    const unknownVoucherCode = await authedJson(token, 'POST', '/api/v2/vouchers/redeem', { code: `MISS${voucherCode}` });
    assertStatus('voucher redeem unknown code', unknownVoucherCode.response, unknownVoucherCode.body, 404);
    console.log(`ok voucher redeem unknown code ${unknownVoucherCode.response.status}`);

    const invalidBalanceId = await authedJson(token, 'POST', '/api/v2/users/not-an-id/balance', {
      amount: 1,
      type: 'add',
      reason: 'Smoke invalid id',
    });
    assertStatus('balance adjust invalid id', invalidBalanceId.response, invalidBalanceId.body, 400);
    console.log(`ok balance adjust invalid id ${invalidBalanceId.response.status}`);

    const invalidBalanceAmount = await authedJson(token, 'POST', '/api/v2/users/000000000000000000000000/balance', {
      amount: 0,
      type: 'add',
      reason: 'Smoke invalid amount',
    });
    assertStatus('balance adjust invalid amount', invalidBalanceAmount.response, invalidBalanceAmount.body, 400);
    console.log(`ok balance adjust invalid amount ${invalidBalanceAmount.response.status}`);

    const invalidBalanceType = await authedJson(token, 'POST', '/api/v2/users/000000000000000000000000/balance', {
      amount: 1,
      type: 'bad',
      reason: 'Smoke invalid type',
    });
    assertStatus('balance adjust invalid type', invalidBalanceType.response, invalidBalanceType.body, 400);
    console.log(`ok balance adjust invalid type ${invalidBalanceType.response.status}`);

    const missingBalanceUser = await authedJson(token, 'POST', '/api/v2/users/000000000000000000000000/balance', {
      amount: 1,
      type: 'add',
      reason: 'Smoke missing balance user',
    });
    assertStatus('balance adjust missing user', missingBalanceUser.response, missingBalanceUser.body, 404);
    console.log(`ok balance adjust missing user ${missingBalanceUser.response.status}`);

    const invalidAuditStartDate = await authedJson(token, 'GET', '/api/v2/audit-logs?startDate=bad-date');
    assertStatus('audit logs invalid start date boundary', invalidAuditStartDate.response, invalidAuditStartDate.body, 400);
    ok('audit logs invalid start date boundary', invalidAuditStartDate.response.status);

    const invalidAuditExportEndDate = await authedJson(token, 'GET', '/api/v2/audit-logs/export?endDate=bad-date');
    // Without exports.sensitive step-up, the gateway must reject before Rust date validation.
    assertStepUpRequired('audit logs export invalid end date boundary', invalidAuditExportEndDate.response, invalidAuditExportEndDate.body);
    ok('audit logs export invalid end date boundary', invalidAuditExportEndDate.response.status);

    const unauthTwoFactorSetup = await jsonRequest('POST', '/api/v2/auth/2fa/setup', {});
    assertStatus('2fa setup unauthenticated', unauthTwoFactorSetup.response, unauthTwoFactorSetup.body, 401);
    console.log(`ok 2fa setup unauthenticated ${unauthTwoFactorSetup.response.status}`);

    const missingTwoFactorLoginPayload = await jsonRequest('POST', '/api/v2/auth/2fa/login-verify', {});
    assertStatus('2fa login verify missing payload', missingTwoFactorLoginPayload.response, missingTwoFactorLoginPayload.body, 400);
    console.log(`ok 2fa login verify missing payload ${missingTwoFactorLoginPayload.response.status}`);

    const missingTwoFactorConfirmCode = await authedJson(token, 'POST', '/api/v2/auth/2fa/confirm', { code: '' });
    assertStatus('2fa confirm missing code', missingTwoFactorConfirmCode.response, missingTwoFactorConfirmCode.body, 400);
    console.log(`ok 2fa confirm missing code ${missingTwoFactorConfirmCode.response.status}`);

    await runTwoFactorE2eSmoke(token);
    await runSettingsMutationSmoke(token, suffix);
    await runNotificationMutationSmoke(token);
    await runWebhookConfigMutationSmoke(token);
    await runMarginsMutationSmoke(token);
    await runUploadBoundarySmoke(token);

    const unauthSessionRevoke = await jsonRequest('POST', '/api/v2/auth/sessions/revoke', {});
    assertStatus('session revoke unauthenticated', unauthSessionRevoke.response, unauthSessionRevoke.body, 401);
    console.log(`ok session revoke unauthenticated ${unauthSessionRevoke.response.status}`);

    const passwordChangeTeamBoundary = await authedJson(token, 'PUT', '/api/v2/users/me/password', {
      currentPassword: 'old-password',
      newPassword: 'new-password',
      confirmPassword: 'new-password',
    });
    assertStatus('password change team boundary', passwordChangeTeamBoundary.response, passwordChangeTeamBoundary.body, 403);
    console.log(`ok password change team boundary ${passwordChangeTeamBoundary.response.status}`);

    const invalidRefundId = await authedJson(token, 'POST', '/api/v2/transactions/not-an-id/refund', {
      reason: 'Smoke invalid refund id',
    });
    assertStatus('transaction refund invalid id', invalidRefundId.response, invalidRefundId.body, 400);
    console.log(`ok transaction refund invalid id ${invalidRefundId.response.status}`);

    const invalidRefundReason = await authedJson(token, 'POST', '/api/v2/transactions/000000000000000000000000/refund', {
      reason: 'bad',
    });
    assertStatus('transaction refund invalid reason', invalidRefundReason.response, invalidRefundReason.body, 400);
    console.log(`ok transaction refund invalid reason ${invalidRefundReason.response.status}`);

    const missingRefundTransaction = await authedJson(token, 'POST', '/api/v2/transactions/000000000000000000000000/refund', {
      reason: 'Smoke missing refund transaction',
    });
    assertStatus('transaction refund missing transaction', missingRefundTransaction.response, missingRefundTransaction.body, 404);
    console.log(`ok transaction refund missing transaction ${missingRefundTransaction.response.status}`);

    const invalidStatusId = await authedJson(token, 'PUT', '/api/v2/transactions/not-an-id/status', {
      status: 'failed',
    });
    assertStatus('transaction status invalid id', invalidStatusId.response, invalidStatusId.body, 400);
    console.log(`ok transaction status invalid id ${invalidStatusId.response.status}`);

    const invalidTransactionStatus = await authedJson(token, 'PUT', '/api/v2/transactions/000000000000000000000000/status', {
      status: 'bad',
    });
    assertStatus('transaction status invalid status', invalidTransactionStatus.response, invalidTransactionStatus.body, 400);
    console.log(`ok transaction status invalid status ${invalidTransactionStatus.response.status}`);

    const longStatusNote = await authedJson(token, 'PUT', '/api/v2/transactions/000000000000000000000000/status', {
      status: 'failed',
      note: 'x'.repeat(501),
    });
    assertStatus('transaction status long note', longStatusNote.response, longStatusNote.body, 400);
    console.log(`ok transaction status long note ${longStatusNote.response.status}`);

    const missingStatusTransaction = await authedJson(token, 'PUT', '/api/v2/transactions/000000000000000000000000/status', {
      status: 'failed',
      note: 'Smoke missing status transaction',
    });
    assertStatus('transaction status missing transaction', missingStatusTransaction.response, missingStatusTransaction.body, 404);
    console.log(`ok transaction status missing transaction ${missingStatusTransaction.response.status}`);

    const invalidGuestCancelId = await authedJson(token, 'POST', '/api/v2/guest-transactions/not-an-id/cancel', {
      note: 'Smoke invalid guest cancel id',
    });
    assertStatus('guest transaction cancel invalid id', invalidGuestCancelId.response, invalidGuestCancelId.body, 400);
    console.log(`ok guest transaction cancel invalid id ${invalidGuestCancelId.response.status}`);

    const missingGuestCancel = await authedJson(token, 'POST', '/api/v2/guest-transactions/000000000000000000000000/cancel', {
      note: 'Smoke missing guest cancel',
    });
    assertStatus('guest transaction cancel missing transaction', missingGuestCancel.response, missingGuestCancel.body, 404);
    console.log(`ok guest transaction cancel missing transaction ${missingGuestCancel.response.status}`);

    const invalidGuestConfirmId = await authedJson(token, 'POST', '/api/v2/guest-transactions/not-an-id/confirm', {
      note: 'Smoke invalid guest confirm id',
    });
    assertStatus('guest transaction confirm invalid id', invalidGuestConfirmId.response, invalidGuestConfirmId.body, 400);
    console.log(`ok guest transaction confirm invalid id ${invalidGuestConfirmId.response.status}`);

    const missingGuestConfirm = await authedJson(token, 'POST', '/api/v2/guest-transactions/000000000000000000000000/confirm', {
      note: 'Smoke missing guest confirm',
    });
    assertStatus('guest transaction confirm missing transaction', missingGuestConfirm.response, missingGuestConfirm.body, 404);
    console.log(`ok guest transaction confirm missing transaction ${missingGuestConfirm.response.status}`);

    const invalidGuestStatusId = await authedJson(token, 'PUT', '/api/v2/guest-transactions/not-an-id/status', {
      transactionStatus: 'failed',
    });
    assertStatus('guest transaction status invalid id', invalidGuestStatusId.response, invalidGuestStatusId.body, 400);
    console.log(`ok guest transaction status invalid id ${invalidGuestStatusId.response.status}`);

    const invalidGuestStatus = await authedJson(token, 'PUT', '/api/v2/guest-transactions/000000000000000000000000/status', {
      transactionStatus: 'bad',
    });
    assertStatus('guest transaction status invalid status', invalidGuestStatus.response, invalidGuestStatus.body, 400);
    console.log(`ok guest transaction status invalid status ${invalidGuestStatus.response.status}`);

    const longGuestStatusNote = await authedJson(token, 'PUT', '/api/v2/guest-transactions/000000000000000000000000/status', {
      transactionStatus: 'failed',
      note: 'x'.repeat(501),
    });
    assertStatus('guest transaction status long note', longGuestStatusNote.response, longGuestStatusNote.body, 400);
    console.log(`ok guest transaction status long note ${longGuestStatusNote.response.status}`);

    const missingGuestStatus = await authedJson(token, 'PUT', '/api/v2/guest-transactions/000000000000000000000000/status', {
      transactionStatus: 'failed',
      note: 'Smoke missing guest status',
    });
    assertStatus('guest transaction status missing transaction', missingGuestStatus.response, missingGuestStatus.body, 404);
    console.log(`ok guest transaction status missing transaction ${missingGuestStatus.response.status}`);

    const missingGuestCreateFields = await jsonRequest('POST', '/api/v2/guest-transactions', {
      productCode: '',
      target: '',
      whatsapp: '',
      paymentMethodId: '',
    });
    assertStatus('guest transaction create missing fields', missingGuestCreateFields.response, missingGuestCreateFields.body, 400);
    console.log(`ok guest transaction create missing fields ${missingGuestCreateFields.response.status}`);

    const missingGuestCreateProduct = await jsonRequest('POST', '/api/v2/guest-transactions', {
      productCode: `MISSING-${voucherCode}`,
      target: 'smoke-target',
      whatsapp: '6281200000000',
      paymentMethodId: '000000000000000000000000',
    });
    assertStatus('guest transaction create missing product', missingGuestCreateProduct.response, missingGuestCreateProduct.body, 404);
    console.log(`ok guest transaction create missing product ${missingGuestCreateProduct.response.status}`);

    const invalidFreeFireValidation = await jsonRequest('POST', '/api/v2/validate/freefire', { userId: '12' });
    assertStatus('freefire validation invalid user id', invalidFreeFireValidation.response, invalidFreeFireValidation.body, 400);
    console.log(`ok freefire validation invalid user id ${invalidFreeFireValidation.response.status}`);

    const invalidMobileLegendsValidation = await jsonRequest('POST', '/api/v2/validate/mobilelegends', {
      userId: '12345',
      zoneId: '',
    });
    assertStatus('mobilelegends validation missing zone id', invalidMobileLegendsValidation.response, invalidMobileLegendsValidation.body, 400);
    console.log(`ok mobilelegends validation missing zone id ${invalidMobileLegendsValidation.response.status}`);

    const invalidVendorTestId = await authedJson(token, 'POST', '/api/v2/vendors/not-an-id/test');
    assertStatus('vendor test invalid id', invalidVendorTestId.response, invalidVendorTestId.body, 404);
    console.log(`ok vendor test invalid id ${invalidVendorTestId.response.status}`);

    const missingVendorTest = await authedJson(token, 'POST', '/api/v2/vendors/000000000000000000000000/test');
    assertStatus('vendor test missing vendor', missingVendorTest.response, missingVendorTest.body, 404);
    console.log(`ok vendor test missing vendor ${missingVendorTest.response.status}`);

    const invalidVendorSyncId = await authedJson(token, 'POST', '/api/v2/vendors/not-an-id/sync');
    assertStatus('vendor sync invalid id', invalidVendorSyncId.response, invalidVendorSyncId.body, 404);
    console.log(`ok vendor sync invalid id ${invalidVendorSyncId.response.status}`);

    const missingVendorSync = await authedJson(token, 'POST', '/api/v2/vendors/000000000000000000000000/sync');
    assertStatus('vendor sync missing vendor', missingVendorSync.response, missingVendorSync.body, 404);
    console.log(`ok vendor sync missing vendor ${missingVendorSync.response.status}`);

    const unauthDigiflazzPricelistFetch = await request('/api/v2/vendors/digiflazz/pricelist/fetch', {
      method: 'POST',
    });
    assertStatus('digiflazz pricelist fetch unauthenticated', unauthDigiflazzPricelistFetch.response, unauthDigiflazzPricelistFetch.body, 401);
    console.log(`ok digiflazz pricelist fetch unauthenticated ${unauthDigiflazzPricelistFetch.response.status}`);

    const unauthDigiflazzSettingsSave = await jsonRequest('POST', '/api/v2/vendors/digiflazz/settings', {
      username: 'smoke',
      apiKey: 'smoke',
    });
    assertStatus('digiflazz settings save unauthenticated', unauthDigiflazzSettingsSave.response, unauthDigiflazzSettingsSave.body, 401);
    console.log(`ok digiflazz settings save unauthenticated ${unauthDigiflazzSettingsSave.response.status}`);

    const unauthTokovoucherSettingsSave = await jsonRequest('POST', '/api/v2/vendors/tokovoucher/settings', {
      memberCode: 'smoke',
      secret: 'smoke',
    });
    assertStatus('tokovoucher settings save unauthenticated', unauthTokovoucherSettingsSave.response, unauthTokovoucherSettingsSave.body, 401);
    console.log(`ok tokovoucher settings save unauthenticated ${unauthTokovoucherSettingsSave.response.status}`);

    const invalidDepositCreateAmount = await authedJson(token, 'POST', '/api/v2/deposits', {
      amount: 0,
      paymentMethodId: '000000000000000000000000',
    });
    assertStatus('deposit create invalid amount', invalidDepositCreateAmount.response, invalidDepositCreateAmount.body, 403);
    console.log(`ok deposit create invalid amount ${invalidDepositCreateAmount.response.status}`);

    const missingDepositCreateMethod = await authedJson(token, 'POST', '/api/v2/deposits', { amount: 10000 });
    assertStatus('deposit create team account rejection', missingDepositCreateMethod.response, missingDepositCreateMethod.body, 403);
    console.log(`ok deposit create team account rejection ${missingDepositCreateMethod.response.status}`);

    const categoryCreate = await authedJson(token, 'POST', '/api/v2/payment-categories', {
      name: paymentCategoryName,
      slug: paymentCategorySlug,
      icon: '/uploads/icons/smoke-payment.svg',
      order: 9999,
      status: 'inactive',
    });
    assertStatus('payment category create', categoryCreate.response, categoryCreate.body, 201);
    paymentCategoryId = objectId(categoryCreate.body?.category?._id, 'payment category create');
    console.log(`ok payment category create ${categoryCreate.response.status}`);

    const categoryUpdate = await authedJson(token, 'PUT', `/api/v2/payment-categories/${paymentCategoryId}`, {
      name: `${paymentCategoryName} Updated`,
      slug: `${paymentCategorySlug}-updated`,
      icon: '/uploads/icons/smoke-payment-updated.svg',
      order: 9998,
      status: 'inactive',
    });
    assertStatus('payment category update', categoryUpdate.response, categoryUpdate.body, 200);
    console.log(`ok payment category update ${categoryUpdate.response.status}`);

    const methodCreate = await authedJson(token, 'POST', '/api/v2/payment-methods', {
      name: methodName,
      category: paymentCategoryId,
      accountNumber: `SMOKE-${suffix}`,
      accountName: 'Smoke Test',
      icon: '/uploads/icons/smoke-method.svg',
      minAmount: 10000,
      maxAmount: 20000,
      adminFee: 0,
      adminPercent: 0,
      operationalStart: '00:00',
      operationalEnd: '23:59',
      useUniqueCode: false,
      status: 'inactive',
    });
    assertStatus('payment method create', methodCreate.response, methodCreate.body, 201);
    methodId = objectId(methodCreate.body?.method?._id, 'payment method create');
    console.log(`ok payment method create ${methodCreate.response.status}`);

    const methodUpdate = await authedJson(token, 'PUT', `/api/v2/payment-methods/${methodId}`, {
      name: `${methodName} Updated`,
      category: paymentCategoryId,
      accountNumber: `SMOKE-UPD-${suffix}`,
      accountName: 'Smoke Test Updated',
      icon: '/uploads/icons/smoke-method-updated.svg',
      minAmount: 15000,
      maxAmount: 25000,
      adminFee: 100,
      adminPercent: 1,
      operationalStart: '01:00',
      operationalEnd: '23:00',
      useUniqueCode: true,
      status: 'inactive',
    });
    assertStatus('payment method update', methodUpdate.response, methodUpdate.body, 200);
    console.log(`ok payment method update ${methodUpdate.response.status}`);

    await runDepositE2eSmoke(token, methodId, suffix);
    await runDepositCreateE2eSmoke(suffix);
    await runPointsE2eSmoke(token, suffix);
    await runVoucherE2eSmoke(token, suffix);
    await runBalanceAdjustE2eSmoke(token, suffix);
    await runTransactionRefundE2eSmoke(token, suffix);
    await runTransactionStatusE2eSmoke(token, suffix);
    await runGuestTransactionE2eSmoke(token, suffix);

    const taxonomyCategoryCreate = await authedJson(token, 'POST', '/api/v2/categories/admin/create', {
      name: taxonomyCategoryName,
      icon: '/uploads/icons/smoke-category.svg',
      sortOrder: 9999,
      status: false,
    });
    assertStatus('taxonomy category create', taxonomyCategoryCreate.response, taxonomyCategoryCreate.body, 201);
    taxonomyCategoryId = objectId(taxonomyCategoryCreate.body?.category?._id, 'taxonomy category create');
    console.log(`ok taxonomy category create ${taxonomyCategoryCreate.response.status}`);

    const taxonomyCategoryUpdate = await authedJson(token, 'PUT', `/api/v2/categories/admin/${taxonomyCategoryId}`, {
      name: `${taxonomyCategoryName} Updated`,
      icon: '/uploads/icons/smoke-category-updated.svg',
      sortOrder: 9998,
      status: false,
    });
    assertStatus('taxonomy category update', taxonomyCategoryUpdate.response, taxonomyCategoryUpdate.body, 200);
    console.log(`ok taxonomy category update ${taxonomyCategoryUpdate.response.status}`);

    const operatorCreate = await authedJson(token, 'POST', '/api/v2/operators/admin/create', {
      name: operatorName,
      categoryId: taxonomyCategoryId,
      icon: '/uploads/icons/smoke-operator.svg',
      instructionImage: '',
      checkUsername: false,
      usernameLabel: 'User ID',
      validationType: 'none',
      description: 'Smoke test operator',
      isCustomProduct: false,
      userIdLabel: 'User ID',
      userIdType: 'number',
      hasServerId: false,
      serverIdLabel: 'Server ID',
      serverIdDropdown: false,
      serverIdType: 'number',
      serverOptions: [],
      sortOrder: 9999,
      status: false,
    });
    assertStatus('taxonomy operator create', operatorCreate.response, operatorCreate.body, 201);
    operatorId = objectId(operatorCreate.body?.operator?._id, 'taxonomy operator create');
    console.log(`ok taxonomy operator create ${operatorCreate.response.status}`);

    const operatorUpdate = await authedJson(token, 'PUT', `/api/v2/operators/admin/${operatorId}`, {
      name: `${operatorName} Updated`,
      categoryId: taxonomyCategoryId,
      icon: '/uploads/icons/smoke-operator-updated.svg',
      description: 'Smoke test operator updated',
      sortOrder: 9998,
      status: false,
    });
    assertStatus('taxonomy operator update', operatorUpdate.response, operatorUpdate.body, 200);
    console.log(`ok taxonomy operator update ${operatorUpdate.response.status}`);

    const productTypeCreate = await authedJson(token, 'POST', '/api/v2/product-types/admin/create', {
      name: productTypeName,
      categoryId: taxonomyCategoryId,
      operatorId,
      icon: '/uploads/icons/smoke-type.svg',
      cover: '/uploads/covers/smoke-type.svg',
      openTime: '00:00',
      closeTime: '23:59',
      open24Hours: true,
      estimatedDelivery: 'Instant',
      processType: 'auto',
      description: 'Smoke test product type',
      popupInfo: { title: '', content: '', image: '', buttonText: '', buttonLink: '', enabled: false },
      sortOrder: 9999,
      status: false,
    });
    assertStatus('taxonomy product type create', productTypeCreate.response, productTypeCreate.body, 201);
    productTypeId = objectId(productTypeCreate.body?.productType?._id, 'taxonomy product type create');
    console.log(`ok taxonomy product type create ${productTypeCreate.response.status}`);

    const productTypeUpdate = await authedJson(token, 'PUT', `/api/v2/product-types/admin/${productTypeId}`, {
      name: `${productTypeName} Updated`,
      categoryId: taxonomyCategoryId,
      operatorId,
      icon: '/uploads/icons/smoke-type-updated.svg',
      cover: '/uploads/covers/smoke-type-updated.svg',
      openTime: '01:00',
      closeTime: '23:00',
      open24Hours: false,
      estimatedDelivery: '5 menit',
      processType: 'manual',
      description: 'Smoke test product type updated',
      popupInfo: { title: 'Smoke', content: 'Smoke test', image: '', buttonText: '', buttonLink: '', enabled: false },
      sortOrder: 9998,
      status: false,
    });
    assertStatus('taxonomy product type update', productTypeUpdate.response, productTypeUpdate.body, 200);
    console.log(`ok taxonomy product type update ${productTypeUpdate.response.status}`);

    const vendorCreate = await authedJson(token, 'POST', '/api/v2/vendors', {
      name: vendorName,
      apiBaseUrl: 'https://smoke.invalid/api',
      config: { mode: 'smoke', apiKey: 'not-a-secret' },
      lowBalanceThreshold: 0,
      status: false,
    });
    assertStatus('vendor create', vendorCreate.response, vendorCreate.body, 201);
    vendorId = objectId(vendorCreate.body?.vendor?._id, 'vendor create');
    console.log(`ok vendor create ${vendorCreate.response.status}`);

    const vendorUpdate = await authedJson(token, 'PUT', `/api/v2/vendors/${vendorId}`, {
      name: `${vendorName} Updated`,
      apiBaseUrl: 'https://smoke.invalid/updated',
      config: { mode: 'smoke-updated', apiKey: 'not-a-secret-updated' },
      lowBalanceThreshold: 1000,
      status: false,
    });
    assertStatus('vendor update', vendorUpdate.response, vendorUpdate.body, 200);
    console.log(`ok vendor update ${vendorUpdate.response.status}`);

    const productCreate = await authedJson(token, 'POST', '/api/v2/products', {
      name: productName,
      code: productCode,
      categoryId: taxonomyCategoryId,
      operatorId,
      productTypeId,
      paymentType: 'prabayar',
      costPrice: 1000,
      price: { basic: 1100, gold: 1050, platinum: 1025 },
      rewardPoints: 0,
      icon: '/uploads/icons/smoke-product.svg',
      vendor: { name: `${vendorName} Updated`, sku: `SKU-${suffix}` },
      status: false,
      sortOrder: 9999,
    });
    assertStatus('product create', productCreate.response, productCreate.body, 201);
    productId = objectId(productCreate.body?.product?._id, 'product create');
    console.log(`ok product create ${productCreate.response.status}`);

    const productUpdate = await authedJson(token, 'PUT', `/api/v2/products/${productId}`, {
      name: `${productName} Updated`,
      code: `${productCode}-UPD`,
      categoryId: taxonomyCategoryId,
      operatorId,
      productTypeId,
      paymentType: 'prabayar',
      costPrice: 1200,
      price: { basic: 1300, gold: 1250, platinum: 1225 },
      rewardPoints: 1,
      icon: '/uploads/icons/smoke-product-updated.svg',
      vendor: { name: `${vendorName} Updated`, sku: `SKU-UPD-${suffix}` },
      status: false,
      sortOrder: 9998,
    });
    assertStatus('product update', productUpdate.response, productUpdate.body, 200);
    console.log(`ok product update ${productUpdate.response.status}`);

    const slidersBefore = await authedJson(token, 'GET', '/api/v2/sliders/admin/all');
    assertStatus('slider revisioned snapshot', slidersBefore.response, slidersBefore.body, 200);
    if (!Number.isSafeInteger(slidersBefore.body?.revision) || !Array.isArray(slidersBefore.body?.sliders)) {
      throw new Error('slider revisioned snapshot expected revision and sliders');
    }
    sliderRevision = slidersBefore.body.revision;
    const sliderUploadFilename = `smoke-slider-${suffix}.png`;
    const sliderUpload = await uploadSmokeCover(token, sliderUploadFilename);
    assertStatus('slider cover upload', sliderUpload.response, sliderUpload.body, 200);
    if (!/^\/uploads\/covers\/[\w.-]+\.png$/u.test(String(sliderUpload.body?.url || ''))) {
      throw new Error(`slider cover upload returned non-canonical URL: ${JSON.stringify(sliderUpload.body)}`);
    }
    sliderCoverFilename = sliderUpload.body.filename;
    const sliderImage = sliderUpload.body.url;
    const sliderCreateKey = `smoke-slider-create-${suffix}`;
    const sliderCreate = await authedJson(token, 'POST', '/api/v2/sliders/admin/create', {
      expectedRevision: sliderRevision,
      slider: { name: sliderName, image: sliderImage, link: '/smoke-slider', status: false },
    }, { 'Idempotency-Key': sliderCreateKey });
    assertStatus('slider create', sliderCreate.response, sliderCreate.body, 201);
    sliderId = objectId(sliderCreate.body?.slider?._id, 'slider create');
    sliderRevision = sliderCreate.body.revision;
    console.log(`ok slider create ${sliderCreate.response.status}`);

    const sliderUpdate = await authedJson(token, 'PUT', `/api/v2/sliders/admin/${sliderId}`, {
      expectedRevision: sliderRevision,
      changes: { name: `${sliderName} Updated`, link: '/smoke-slider-updated' },
    }, { 'Idempotency-Key': `smoke-slider-update-${suffix}` });
    assertStatus('slider update', sliderUpdate.response, sliderUpdate.body, 200);
    sliderRevision = sliderUpdate.body.revision;
    console.log(`ok slider update ${sliderUpdate.response.status}`);

    const sliderArchive = await authedJson(token, 'POST', `/api/v2/sliders/admin/${sliderId}/archive`, {
      expectedRevision: sliderRevision,
    }, { 'Idempotency-Key': `smoke-slider-archive-${suffix}` });
    assertStatus('slider archive', sliderArchive.response, sliderArchive.body, 200);
    sliderRevision = sliderArchive.body.revision;
    sliderArchived = true;
    console.log(`ok slider archive ${sliderArchive.response.status}`);

    const sliderRestore = await authedJson(token, 'POST', `/api/v2/sliders/admin/${sliderId}/restore`, {
      expectedRevision: sliderRevision,
    }, { 'Idempotency-Key': `smoke-slider-restore-${suffix}` });
    assertStatus('slider restore', sliderRestore.response, sliderRestore.body, 200);
    sliderRevision = sliderRestore.body.revision;
    sliderArchived = false;
    console.log(`ok slider restore ${sliderRestore.response.status}`);

    const sliderCurrent = await authedJson(token, 'GET', '/api/v2/sliders/admin/all');
    assertStatus('slider reorder snapshot', sliderCurrent.response, sliderCurrent.body, 200);
    sliderRevision = sliderCurrent.body.revision;
    const sliderOrders = sliderCurrent.body.sliders.map((slider, index) => ({ id: objectIdFromAny(slider, 'slider reorder snapshot'), sortOrder: index }));
    const sliderReorder = await authedJson(token, 'PUT', '/api/v2/sliders/admin/reorder', {
      expectedRevision: sliderRevision,
      orders: sliderOrders,
    }, { 'Idempotency-Key': `smoke-slider-reorder-${suffix}` });
    assertStatus('slider reorder', sliderReorder.response, sliderReorder.body, 200);
    sliderRevision = sliderReorder.body.revision;
    console.log(`ok slider reorder ${sliderReorder.response.status}`);

    const articleCreate = await authedJson(token, 'POST', '/api/v2/articles', {
      title: articleTitle,
      excerpt: 'Smoke test article excerpt',
      content: '<p>Smoke test article content.</p>',
      image: '/uploads/covers/smoke-article.svg',
      category: 'Smoke',
      status: 'draft',
    });
    assertStatus('article create', articleCreate.response, articleCreate.body, 201);
    articleId = objectId(articleCreate.body?._id, 'article create');
    console.log(`ok article create ${articleCreate.response.status}`);

    const articleUpdate = await authedJson(token, 'PUT', `/api/v2/articles/${articleId}`, {
      title: `${articleTitle} Updated`,
      excerpt: 'Smoke test article excerpt updated',
      content: '<p>Smoke test article content updated.</p>',
      image: '/uploads/covers/smoke-article-updated.svg',
      category: 'Smoke',
      status: 'draft',
    });
    assertStatus('article update', articleUpdate.response, articleUpdate.body, 200);
    console.log(`ok article update ${articleUpdate.response.status}`);

    const rewardCreate = await authedJson(token, 'POST', '/api/v2/rewards/admin/create', {
      name: rewardName,
      description: 'Smoke test reward',
      pointsRequired: 999999,
      stock: 0,
      imageUrl: '/uploads/icons/smoke-reward.svg',
      category: 'Smoke',
      status: false,
    });
    assertStatus('reward create', rewardCreate.response, rewardCreate.body, 201);
    rewardId = objectId(rewardCreate.body?.reward?._id, 'reward create');
    console.log(`ok reward create ${rewardCreate.response.status}`);

    const rewardUpdate = await authedJson(token, 'PUT', `/api/v2/rewards/admin/${rewardId}`, {
      name: `${rewardName} Updated`,
      description: 'Smoke test reward updated',
      pointsRequired: 999998,
      stock: 0,
      imageUrl: '/uploads/icons/smoke-reward-updated.svg',
      category: 'Smoke Updated',
      status: false,
    });
    assertStatus('reward update', rewardUpdate.response, rewardUpdate.body, 200);
    console.log(`ok reward update ${rewardUpdate.response.status}`);

    const voucherCreate = await authedJson(token, 'POST', '/api/v2/vouchers', {
      amount: 1000,
      code: voucherCode,
    });
    assertStatus('voucher create', voucherCreate.response, voucherCreate.body, 201);
    voucherId = objectId(voucherCreate.body?.items?.[0]?._id, 'voucher create');
    console.log(`ok voucher create ${voucherCreate.response.status}`);

    const voucherArchive = await authedJson(token, 'DELETE', `/api/v2/vouchers/${voucherId}`, {
      reason: 'API v2 mutation smoke cleanup check',
    });
    assertStatus('voucher archive', voucherArchive.response, voucherArchive.body, 200);
    voucherArchived = true;
    console.log(`ok voucher archive ${voucherArchive.response.status}`);

    const voucherRestore = await authedJson(token, 'PATCH', `/api/v2/vouchers/${voucherId}/restore`, {});
    assertStatus('voucher restore', voucherRestore.response, voucherRestore.body, 200);
    voucherArchived = false;
    console.log(`ok voucher restore ${voucherRestore.response.status}`);
  } finally {
    const cleanupErrors = [];
    if (voucherId && !voucherArchived) {
      try {
        const voucherCleanup = await authedJson(token, 'DELETE', `/api/v2/vouchers/${voucherId}`, {
          reason: 'API v2 mutation smoke cleanup',
        });
        assertStatus('voucher cleanup archive', voucherCleanup.response, voucherCleanup.body, 200);
        console.log(`ok voucher cleanup archive ${voucherCleanup.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (rewardId) {
      try {
        const rewardDelete = await authedJson(token, 'DELETE', `/api/v2/rewards/admin/${rewardId}`);
        assertStatus('reward cleanup', rewardDelete.response, rewardDelete.body, 200);
        console.log(`ok reward cleanup ${rewardDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (articleId) {
      try {
        const articleDelete = await authedJson(token, 'DELETE', `/api/v2/articles/${articleId}`);
        assertStatus('article cleanup', articleDelete.response, articleDelete.body, 200);
        console.log(`ok article cleanup ${articleDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (sliderId && !sliderArchived) {
      try {
        const sliderSnapshot = await authedJson(token, 'GET', '/api/v2/sliders/admin/all');
        assertStatus('slider cleanup snapshot', sliderSnapshot.response, sliderSnapshot.body, 200);
        const sliderCleanup = await authedJson(token, 'POST', `/api/v2/sliders/admin/${sliderId}/archive`, {
          expectedRevision: sliderSnapshot.body.revision,
        }, { 'Idempotency-Key': `smoke-slider-cleanup-archive-${suffix}` });
        assertStatus('slider cleanup archive', sliderCleanup.response, sliderCleanup.body, 200);
        sliderArchived = true;
        console.log(`ok slider cleanup archive ${sliderCleanup.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (sliderCoverFilename) {
      try {
        const coverCleanup = await request(`/api/v2/upload?type=covers&filename=${encodeURIComponent(sliderCoverFilename)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        assertStatus('slider cover cleanup', coverCleanup.response, coverCleanup.body, 200);
        console.log(`ok slider cover cleanup ${coverCleanup.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (productId) {
      try {
        const productDelete = await authedJson(token, 'DELETE', `/api/v2/products/${productId}`);
        assertStatus('product cleanup', productDelete.response, productDelete.body, 200);
        console.log(`ok product cleanup ${productDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (vendorId) {
      try {
        const vendorDelete = await authedJson(token, 'DELETE', `/api/v2/vendors/${vendorId}`);
        assertStatus('vendor cleanup', vendorDelete.response, vendorDelete.body, 200);
        console.log(`ok vendor cleanup ${vendorDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (productTypeId) {
      try {
        const productTypeDelete = await authedJson(token, 'DELETE', `/api/v2/product-types/admin/${productTypeId}`);
        assertStatus('taxonomy product type cleanup', productTypeDelete.response, productTypeDelete.body, 200);
        console.log(`ok taxonomy product type cleanup ${productTypeDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (operatorId) {
      try {
        const operatorDelete = await authedJson(token, 'DELETE', `/api/v2/operators/admin/${operatorId}`);
        assertStatus('taxonomy operator cleanup', operatorDelete.response, operatorDelete.body, 200);
        console.log(`ok taxonomy operator cleanup ${operatorDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (taxonomyCategoryId) {
      try {
        const categoryDelete = await authedJson(token, 'DELETE', `/api/v2/categories/admin/${taxonomyCategoryId}`);
        assertStatus('taxonomy category cleanup', categoryDelete.response, categoryDelete.body, 200);
        console.log(`ok taxonomy category cleanup ${categoryDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (methodId) {
      try {
        const methodDelete = await authedJson(token, 'DELETE', `/api/v2/payment-methods/${methodId}`);
        assertStatus('payment method cleanup', methodDelete.response, methodDelete.body, 200);
        console.log(`ok payment method cleanup ${methodDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (paymentCategoryId) {
      try {
        const categoryDelete = await authedJson(token, 'DELETE', `/api/v2/payment-categories/${paymentCategoryId}`);
        assertStatus('payment category cleanup', categoryDelete.response, categoryDelete.body, 200);
        console.log(`ok payment category cleanup ${categoryDelete.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.map((error) => error.message).join('; '));
    }
  }

  reporter.write({ passed: passedChecks, skipped: skippedChecks, failed: 0 });
  console.log(`\n${passedChecks} API v2 mutation smoke checks passed (${skippedChecks} skipped).`);
}

main().catch((error) => {
  reporter.write({ passed: passedChecks, skipped: skippedChecks, failed: 1, error: error.message || String(error) });
  console.error(error.message || error);
  process.exit(1);
});
