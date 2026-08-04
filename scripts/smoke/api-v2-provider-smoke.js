#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:9005').replace(/\/$/, '');
const email = process.env.SMOKE_EMAIL || 'tester29@gmail.com';
const password = process.env.SMOKE_PASSWORD || 'Tester2909!@';
const memberEmail = (process.env.SMOKE_MEMBER_EMAIL || '').trim();
const memberPassword = process.env.SMOKE_MEMBER_PASSWORD || '';
const smokeMongoUri = (process.env.SMOKE_MONGO_URI || process.env.MONGO_URI || '').trim();
const smokeMongoDb = (process.env.SMOKE_MONGO_DB || process.env.MONGO_DB || '').trim();
const providerMode = (process.env.PROVIDER_MODE || '').trim().toLowerCase();
const backendProviderConfirmed = process.env.CONFIRM_PROVIDER_BACKEND_MOCK === '1'
  || process.env.CONFIRM_PROVIDER_BACKEND_SANDBOX === '1';
const hasDirectRustGuardUrl = Boolean((process.env.API_V2_DIRECT_URL || process.env.API_V2_UPSTREAM_URL || '').trim());
const rustBaseUrl = (process.env.API_V2_DIRECT_URL || process.env.API_V2_UPSTREAM_URL || 'http://127.0.0.1:9010').replace(/\/$/, '');
const sandboxBaseUrl = (process.env.PROVIDER_SANDBOX_BASE_URL || 'http://127.0.0.1:9020').replace(/\/$/, '');
const validationSandboxConfirmed = process.env.CONFIRM_GAME_VALIDATION_SANDBOX === '1';
const requireTransactionCreateReadiness = process.env.REQUIRE_TRANSACTION_CREATE_READINESS === '1';

if (process.env.RUN_PROVIDER_SMOKE !== '1') {
  console.error('Refusing to run provider smoke without RUN_PROVIDER_SMOKE=1.');
  process.exit(1);
}

if (!['mock', 'sandbox'].includes(providerMode)) {
  console.error('Refusing to run provider smoke unless PROVIDER_MODE=mock or PROVIDER_MODE=sandbox.');
  process.exit(1);
}

if (!backendProviderConfirmed) {
  console.error('Refusing to run provider smoke unless CONFIRM_PROVIDER_BACKEND_MOCK=1 or CONFIRM_PROVIDER_BACKEND_SANDBOX=1 confirms the backend provider mode.');
  process.exit(1);
}

if (!smokeMongoUri) {
  console.error('Refusing to run provider smoke without SMOKE_MONGO_URI or MONGO_URI for fixture cleanup.');
  process.exit(1);
}

if (requireTransactionCreateReadiness && (!memberEmail || !memberPassword)) {
  console.error('Refusing transaction create readiness smoke without SMOKE_MEMBER_EMAIL and SMOKE_MEMBER_PASSWORD.');
  process.exit(1);
}

if (providerMode === 'sandbox') {
  const codashopBaseUrl = (process.env.GAME_VALIDATION_CODASHOP_BASE_URL || '').trim().replace(/\/$/, '');
  const gopayBaseUrl = (process.env.GAME_VALIDATION_GOPAY_BASE_URL || '').trim().replace(/\/$/, '');
  if (!validationSandboxConfirmed || codashopBaseUrl !== sandboxBaseUrl || gopayBaseUrl !== sandboxBaseUrl) {
    console.error('Refusing sandbox provider smoke unless game validation provider URLs point at the sandbox stub and CONFIRM_GAME_VALIDATION_SANDBOX=1.');
    process.exit(1);
  }
}

const lockPath = path.join(os.tmpdir(), 'webtopup-api-v2-smoke-suite.lock');
let lockFd = null;
try {
  lockFd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\nprovider\n`);
} catch {
  console.error(`Refusing to run provider smoke while another API v2 smoke run holds ${lockPath}.`);
  process.exit(1);
}

function releaseLock() {
  if (lockFd === null) return;
  try {
    fs.closeSync(lockFd);
  } catch {
    // best effort cleanup
  }
  lockFd = null;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // best effort cleanup
  }
}

process.on('exit', releaseLock);
process.on('SIGINT', () => {
  releaseLock();
  process.exit(130);
});
process.on('SIGTERM', () => {
  releaseLock();
  process.exit(143);
});

async function request(requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, options);
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

async function login(loginEmail, loginPassword, label) {
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

async function authedJson(token, method, requestPath, payload) {
  return request(requestPath, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
}

async function authedGet(token, requestPath) {
  return request(requestPath, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

function assertStatus(name, response, body, expectedStatus) {
  if (response.status !== expectedStatus) {
    throw new Error(`${name} expected HTTP ${expectedStatus}, got ${response.status}: ${body?.message || JSON.stringify(body)}`);
  }
}

function ok(name, status) {
  console.log(`ok ${name} ${status}`);
}

async function withSmokeDb(callback) {
  const mongoose = require('../../server/node_modules/mongoose');
  const connection = await mongoose.createConnection(smokeMongoUri, smokeMongoDb ? { dbName: smokeMongoDb } : {}).asPromise();
  try {
    await callback({
      ObjectId: mongoose.Types.ObjectId,
      guestTransactions: connection.collection('guesttransactions'),
      paymentMethods: connection.collection('paymentmethods'),
      products: connection.collection('products'),
      pointTransactions: connection.collection('pointtransactions'),
      transactions: connection.collection('transactions'),
      settings: connection.collection('settings'),
      users: connection.collection('users'),
      vendors: connection.collection('vendors'),
      dgcache: connection.collection('dgcache'),
    });
  } finally {
    await connection.close();
  }
}

async function smokeBoundaryChecks(teamToken) {
  const teamRejected = await authedJson(teamToken, 'POST', '/api/v2/transactions', {
    productCode: 'SMOKE-NO-PROVIDER-CALL',
    target: 'smoke-target',
  });
  assertStatus('provider smoke team transaction create rejection', teamRejected.response, teamRejected.body, 403);
  ok('provider smoke team transaction create rejection', teamRejected.response.status);

  const invalidRecheck = await authedJson(teamToken, 'POST', '/api/v2/transactions/not-an-id/recheck', {});
  assertStatus('provider smoke recheck invalid id', invalidRecheck.response, invalidRecheck.body, 400);
  ok('provider smoke recheck invalid id', invalidRecheck.response.status);

  if (hasDirectRustGuardUrl) {
    const directRust = await fetch(`${rustBaseUrl}/v2/transactions/not-an-id/recheck`, { method: 'POST' });
    const directText = await directRust.text();
    let directBody = null;
    try {
      directBody = directText ? JSON.parse(directText) : null;
    } catch {
      directBody = directText;
    }
    assertStatus('provider smoke direct rust recheck guard', directRust, directBody, 403);
    ok('provider smoke direct rust recheck guard', directRust.status);

    const directGuestConfirm = await fetch(`${rustBaseUrl}/v2/guest-transactions/000000000000000000000000/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const directGuestText = await directGuestConfirm.text();
    let directGuestBody = null;
    try {
      directGuestBody = directGuestText ? JSON.parse(directGuestText) : null;
    } catch {
      directGuestBody = directGuestText;
    }
    assertStatus('provider smoke direct rust guest confirm guard', directGuestConfirm, directGuestBody, 403);
    ok('provider smoke direct rust guest confirm guard', directGuestConfirm.status);
  } else {
    console.log('skip provider smoke direct rust guard no API_V2_DIRECT_URL or API_V2_UPSTREAM_URL');
  }
}

async function smokeMemberTransactionCreate(memberToken, suffix) {
  if (!memberToken) {
    console.log('skip provider transaction create no member credentials');
    return 0;
  }

  let checks = 0;
  await withSmokeDb(async ({ pointTransactions, products, settings, transactions, users }) => {
    const member = await users.findOne({ email: memberEmail.toLowerCase(), role: 'member' }, { projection: { balance: 1, points: 1 } });
    if (!member) {
      console.log('skip provider transaction create no member fixture');
      return;
    }

    const amount = 20000;
    const pointsSetting = await settings.findOne({ key: 'points_per_transaction' }, { projection: { value: 1 } });
    const expectedEarnedPoints = Math.floor(amount / 10000) * (Number(pointsSetting?.value) || 100);
    const scenarios = [
      { status: 'pending', finalStatus: 'pending', refunded: false, balanceDelta: -amount, pointDelta: 0 },
      { status: 'success', finalStatus: 'success', refunded: false, balanceDelta: -amount, pointDelta: expectedEarnedPoints },
      { status: 'failed', finalStatus: 'failed', refunded: true, balanceDelta: 0, pointDelta: 0 },
    ];
    const originalBalance = Number(member.balance || 0);
    const originalPoints = Number(member.points || 0);
    const productIds = [];
    const targets = [];

    try {
      for (const scenario of scenarios) {
        const now = new Date();
        const productCode = `SMOKEPROVIDERCREATE-${scenario.status}-${suffix}`.toUpperCase().slice(0, 40);
        const target = `smoke-provider-create-mock-status-${scenario.status}-${suffix}`;
        targets.push(target);
        await users.updateOne({ _id: member._id }, { $set: { balance: originalBalance + amount + 1000, points: originalPoints, updatedAt: now } });
        await pointTransactions.deleteMany({ user: member._id, description: { $regex: `provider smoke create.*${suffix}` } });

        const product = await products.insertOne({
          productId: `smoke-provider-create-${scenario.status}-${suffix}`,
          name: `Smoke Provider Create ${scenario.status} ${suffix}`,
          code: productCode,
          category: 'Smoke',
          brand: 'Smoke',
          vendor: { name: 'Mock Provider', sku: `MOCK-CREATE-${scenario.status}-${suffix}` },
          price: { basic: amount, gold: amount, platinum: amount },
          costPrice: 1,
          status: true,
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
        productIds.push(product.insertedId);

        const create = await authedJson(memberToken, 'POST', '/api/v2/transactions', {
          productCode,
          target,
        });
        assertStatus(`provider smoke transaction create ${scenario.status}`, create.response, create.body, 201);
        if (create.body?.message !== 'Transaction created' || create.body?.transaction?.status !== scenario.finalStatus) {
          throw new Error(`provider smoke transaction create ${scenario.status} returned unexpected response`);
        }
        const saved = await transactions.findOne({ user: member._id, product: product.insertedId, target });
        if (!saved || saved.status !== scenario.finalStatus || saved.refunded !== scenario.refunded || Number(saved.amount || 0) !== amount) {
          throw new Error(`provider smoke transaction create ${scenario.status} persisted unexpected transaction`);
        }
        const afterUser = await users.findOne({ _id: member._id }, { projection: { balance: 1, points: 1 } });
        if (Number(afterUser?.balance || 0) !== originalBalance + amount + 1000 + scenario.balanceDelta) {
          throw new Error(`provider smoke transaction create ${scenario.status} produced unexpected balance`);
        }
        if (Number(afterUser?.points || 0) !== originalPoints + scenario.pointDelta) {
          throw new Error(`provider smoke transaction create ${scenario.status} produced unexpected points`);
        }
        checks += 1;
        ok(`provider smoke transaction create ${scenario.status}`, create.response.status);
      }
    } finally {
      await users.updateOne({ _id: member._id }, { $set: { balance: originalBalance, points: originalPoints, updatedAt: new Date() } });
      const createdTransactions = await transactions.find({ target: { $in: targets } }).project({ _id: 1 }).toArray();
      const transactionIds = createdTransactions.map((transaction) => transaction._id);
      if (transactionIds.length > 0) {
        await pointTransactions.deleteMany({ relatedTransaction: { $in: transactionIds } });
        await transactions.deleteMany({ _id: { $in: transactionIds } });
      }
      await transactions.deleteMany({ target: { $in: targets } });
      if (productIds.length > 0) {
        await products.deleteMany({ _id: { $in: productIds } });
      }
    }
  });

  return checks;
}

async function smokeTransactionRecheck(teamToken, suffix) {
  let checks = 0;
  await withSmokeDb(async ({ pointTransactions, products, settings, transactions, users }) => {
    const member = await users.findOne({ role: 'member' }, { projection: { balance: 1, points: 1 } });
    if (!member) {
      console.log('skip provider recheck no member fixture');
      return;
    }

    const amount = 20000;
    const pointsSetting = await settings.findOne({ key: 'points_per_transaction' }, { projection: { value: 1 } });
    const expectedEarnedPoints = Math.floor(amount / 10000) * (Number(pointsSetting?.value) || 100);
    const scenarios = [
      { status: 'pending', changed: false, finalStatus: 'pending', refunded: false, balanceDelta: 0, pointDelta: 0 },
      { status: 'success', changed: true, finalStatus: 'success', refunded: false, balanceDelta: 0, pointDelta: expectedEarnedPoints },
      { status: 'failed', changed: true, finalStatus: 'failed', refunded: true, balanceDelta: amount, pointDelta: 0 },
    ];
    const originalBalance = Number(member.balance || 0);
    const originalPoints = Number(member.points || 0);
    const productIds = [];
    const transactionIds = [];

    try {
      for (const scenario of scenarios) {
        const now = new Date();
        const productCode = `SMOKEPROVIDER-${scenario.status}-${suffix}`.toUpperCase().slice(0, 40);
        const target = `smoke-provider-recheck-mock-status-${scenario.status}-${suffix}`;
        await users.updateOne({ _id: member._id }, { $set: { balance: originalBalance, points: originalPoints, updatedAt: now } });
        await pointTransactions.deleteMany({ user: member._id, description: { $regex: `API v2 provider smoke ${suffix}` } });

        const product = await products.insertOne({
          productId: `smoke-provider-recheck-${scenario.status}-${suffix}`,
          name: `Smoke Provider Recheck ${scenario.status} ${suffix}`,
          code: productCode,
          category: 'Smoke',
          brand: 'Smoke',
          vendor: { name: 'Mock Provider', sku: `MOCK-STATUS-${scenario.status}-${suffix}` },
          price: { basic: amount, gold: amount, platinum: amount },
          costPrice: 1,
          status: true,
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
        productIds.push(product.insertedId);
        const transaction = await transactions.insertOne({
          user: member._id,
          product: product.insertedId,
          target,
          amount,
          status: 'pending',
          vendorTrxId: `SMOKE-RC-${scenario.status}-${suffix}`,
          refunded: false,
          source: 'web',
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
        transactionIds.push(transaction.insertedId);

        const recheck = await authedJson(teamToken, 'POST', `/api/v2/transactions/${transaction.insertedId.toString()}/recheck`, {});
        assertStatus(`provider smoke transaction recheck ${scenario.status}`, recheck.response, recheck.body, 200);
        if (recheck.body?.changed !== scenario.changed || recheck.body?.status !== scenario.status) {
          throw new Error(`provider smoke recheck ${scenario.status} returned unexpected response`);
        }
        const saved = await transactions.findOne({ _id: transaction.insertedId });
        if (!saved || saved.status !== scenario.finalStatus || saved.refunded !== scenario.refunded) {
          throw new Error(`provider smoke recheck ${scenario.status} persisted unexpected transaction state`);
        }
        const userAfter = await users.findOne({ _id: member._id }, { projection: { balance: 1, points: 1 } });
        if (Number(userAfter?.balance || 0) !== originalBalance + scenario.balanceDelta) {
          throw new Error(`provider smoke recheck ${scenario.status} produced unexpected balance`);
        }
        if (Number(userAfter?.points || 0) !== originalPoints + scenario.pointDelta) {
          throw new Error(`provider smoke recheck ${scenario.status} produced unexpected points`);
        }
        checks += 1;
        ok(`provider smoke transaction recheck ${scenario.status}`, recheck.response.status);
      }
    } finally {
      await users.updateOne({ _id: member._id }, { $set: { balance: originalBalance, points: originalPoints, updatedAt: new Date() } });
      if (transactionIds.length > 0) {
        await pointTransactions.deleteMany({ relatedTransaction: { $in: transactionIds } });
        await transactions.deleteMany({ _id: { $in: transactionIds } });
      }
      await transactions.deleteMany({ target: { $regex: `^smoke-provider-recheck-.*-${suffix}$` } });
      if (productIds.length > 0) {
        await products.deleteMany({ _id: { $in: productIds } });
      }
    }
  });

  return checks;
}

async function smokeGuestConfirm(teamToken, suffix) {
  let checks = 0;
  await withSmokeDb(async ({ guestTransactions, paymentMethods, products }) => {
    const method = await paymentMethods.findOne({}, { projection: { _id: 1 } });
    if (!method) {
      console.log('skip provider guest confirm no payment method fixture');
      return;
    }

    const scenarios = [
      { status: 'pending', finalStatus: 'pending', expectSn: false },
      { status: 'success', finalStatus: 'success', expectSn: providerMode === 'sandbox' },
      { status: 'failed', finalStatus: 'failed', expectSn: false },
      ...(providerMode === 'mock' ? [{ status: 'error', finalStatus: 'processing', expectSn: false }] : []),
    ];
    const productIds = [];
    const guestIds = [];

    try {
      for (const scenario of scenarios) {
        const now = new Date();
        const productCode = `SMOKEGUESTCONFIRM-${scenario.status}-${suffix}`.toUpperCase().slice(0, 40);
        const target = `smoke-guest-confirm-mock-status-${scenario.status}-${suffix}`;
        const product = await products.insertOne({
          productId: `smoke-guest-confirm-${scenario.status}-${suffix}`,
          name: `Smoke Guest Confirm ${scenario.status} ${suffix}`,
          code: productCode,
          category: 'Smoke',
          brand: 'Smoke',
          vendor: { name: 'Mock Provider', sku: `MOCK-GUEST-${scenario.status}-${suffix}` },
          price: { basic: 10000, gold: 10000, platinum: 10000 },
          costPrice: 1,
          status: true,
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
        productIds.push(product.insertedId);

        const guest = await guestTransactions.insertOne({
          invoiceNumber: `SMOKEGUESTCONFIRM${suffix.replace(/[^a-z0-9]/gi, '').toUpperCase()}${scenario.status}`.slice(0, 58),
          product: product.insertedId,
          target,
          whatsapp: `62813${String(Date.now()).slice(-8)}`,
          email: `smoke-guest-confirm-${scenario.status}@example.test`,
          amount: 10000,
          adminFee: 100,
          uniqueCode: 123,
          totalAmount: 10223,
          paymentMethod: method._id,
          paymentStatus: 'waiting_payment',
          transactionStatus: 'pending',
          expiredAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
        guestIds.push(guest.insertedId);

        const confirm = await authedJson(teamToken, 'POST', `/api/v2/guest-transactions/${guest.insertedId.toString()}/confirm`, {
          note: `API v2 provider smoke guest confirm ${scenario.status} ${suffix}`,
        });
        // Confirm is step-up gated. Mock smoke accounts intentionally have no 2FA step-up session.
        if (confirm.response.status === 403 && (confirm.body?.error?.code === 'AUTH_STEP_UP_REQUIRED' || confirm.body?.code === 'AUTH_STEP_UP_REQUIRED')) {
          console.log(`skip provider guest confirm ${scenario.status} step-up required in mock smoke`);
          continue;
        }
        assertStatus(`provider smoke guest confirm ${scenario.status}`, confirm.response, confirm.body, 200);
        if (confirm.body?.message !== 'Pembayaran guest berhasil dikonfirmasi') {
          throw new Error(`provider smoke guest confirm ${scenario.status} returned unexpected message`);
        }
        const saved = await guestTransactions.findOne({ _id: guest.insertedId });
        if (!saved || saved.paymentStatus !== 'paid' || saved.transactionStatus !== scenario.finalStatus) {
          throw new Error(`provider smoke guest confirm ${scenario.status} persisted unexpected state`);
        }
        if (!saved.vendorTrxId) {
          throw new Error(`provider smoke guest confirm ${scenario.status} did not retain vendor reference`);
        }
        if (scenario.expectSn && !saved.sn) {
          throw new Error(`provider smoke guest confirm ${scenario.status} did not persist SN`);
        }
        checks += 1;
        ok(`provider smoke guest confirm ${scenario.status}`, confirm.response.status);
      }
    } finally {
      if (guestIds.length > 0) {
        await guestTransactions.deleteMany({ _id: { $in: guestIds } });
      }
      await guestTransactions.deleteMany({ target: { $regex: `^smoke-guest-confirm-.*-${suffix}$` } });
      if (productIds.length > 0) {
        await products.deleteMany({ _id: { $in: productIds } });
      }
    }
  });

  return checks;
}

async function smokeProviderAdminEndpoints(teamToken) {
  if (providerMode !== 'sandbox') {
    console.log('skip provider admin endpoint smoke outside sandbox mode');
    return 0;
  }

  let checks = 0;
  await withSmokeDb(async ({ dgcache, products, vendors }) => {
    const providerSandboxBaseUrl = process.env.PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL
      || process.env.PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL
      || sandboxBaseUrl;
    const now = new Date();
    const digiflazzVendor = await vendors.findOne({ name: { $regex: 'digiflazz', $options: 'i' } });
    const tokovoucherVendor = await vendors.findOne({ name: { $regex: 'tokovoucher', $options: 'i' } });
    const originalDigiflazz = digiflazzVendor ? { ...digiflazzVendor } : null;
    const originalTokovoucher = tokovoucherVendor ? { ...tokovoucherVendor } : null;
    const originalDgcache = await dgcache.find({}).toArray();
    const originalSmokeSyncProducts = await products.find({ code: 'SMOKE-SANDBOX-SKU' }).toArray();
    const restoreVendor = async (original, fallbackName) => {
      if (original) {
        const { _id, ...document } = original;
        await vendors.replaceOne({ _id }, { _id, ...document }, { upsert: true });
      } else {
        await vendors.deleteMany({ name: { $regex: fallbackName, $options: 'i' } });
      }
    };

    try {
      const digiflazzConfig = {
        username: 'sandbox-user',
        apiKey: 'sandbox-key',
      };
      const tokovoucherConfig = {
        memberCode: 'sandbox-member',
        apiKey: 'sandbox-member',
        secret: 'sandbox-secret',
      };
      const digiflazzUpdate = {
        $set: {
          name: digiflazzVendor?.name || 'Digiflazz',
          apiBaseUrl: process.env.PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL || providerSandboxBaseUrl,
          config: digiflazzConfig,
          lowBalanceThreshold: 1000,
          status: true,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      };
      const tokovoucherUpdate = {
        $set: {
          name: tokovoucherVendor?.name || 'Tokovoucher',
          apiBaseUrl: process.env.PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL || providerSandboxBaseUrl,
          config: tokovoucherConfig,
          lowBalanceThreshold: 1000,
          status: true,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      };
      await vendors.updateOne(
        digiflazzVendor ? { _id: digiflazzVendor._id } : { name: 'Digiflazz' },
        digiflazzUpdate,
        { upsert: true },
      );
      await vendors.updateOne(
        tokovoucherVendor ? { _id: tokovoucherVendor._id } : { name: 'Tokovoucher' },
        tokovoucherUpdate,
        { upsert: true },
      );

      const activeDigiflazz = await vendors.findOne({ name: { $regex: 'digiflazz', $options: 'i' } });
      const activeTokovoucher = await vendors.findOne({ name: { $regex: 'tokovoucher', $options: 'i' } });
      if (!activeDigiflazz || !activeTokovoucher) {
        throw new Error('provider smoke could not prepare vendor fixtures');
      }

      const digiflazzSettings = await authedJson(teamToken, 'POST', '/api/v2/vendors/digiflazz/settings', {
        username: 'sandbox-saved-user',
        apiKey: 'sandbox-saved-key',
      });
      assertStatus('provider smoke digiflazz settings save', digiflazzSettings.response, digiflazzSettings.body, 200);
      if (digiflazzSettings.body?.success !== true || Number(digiflazzSettings.body?.balance || 0) !== 1000000) {
        throw new Error('provider smoke digiflazz settings save returned unexpected response');
      }
      const savedDigiflazz = await vendors.findOne({ _id: activeDigiflazz._id });
      if (savedDigiflazz?.config?.username !== 'sandbox-saved-user' || savedDigiflazz?.config?.apiKey !== 'sandbox-saved-key') {
        throw new Error('provider smoke digiflazz settings save did not persist expected config');
      }
      checks += 1;
      ok('provider smoke digiflazz settings save', digiflazzSettings.response.status);

      const tokovoucherSettings = await authedJson(teamToken, 'POST', '/api/v2/vendors/tokovoucher/settings', {
        memberCode: 'sandbox-saved-member',
        secret: 'sandbox-saved-secret',
      });
      assertStatus('provider smoke tokovoucher settings save', tokovoucherSettings.response, tokovoucherSettings.body, 200);
      if (tokovoucherSettings.body?.success !== true || Number(tokovoucherSettings.body?.balance || 0) !== 1000000) {
        throw new Error('provider smoke tokovoucher settings save returned unexpected response');
      }
      const savedTokovoucher = await vendors.findOne({ _id: activeTokovoucher._id });
      if (savedTokovoucher?.config?.memberCode !== 'sandbox-saved-member' || savedTokovoucher?.config?.secret !== 'sandbox-saved-secret') {
        throw new Error('provider smoke tokovoucher settings save did not persist expected config');
      }
      checks += 1;
      ok('provider smoke tokovoucher settings save', tokovoucherSettings.response.status);

      const digiflazzBalance = await authedGet(teamToken, '/api/v2/vendors/digiflazz/balance');
      assertStatus('provider smoke digiflazz balance', digiflazzBalance.response, digiflazzBalance.body, 200);
      if (Number(digiflazzBalance.body?.balance || 0) !== 1000000) {
        throw new Error('provider smoke digiflazz balance returned unexpected balance');
      }
      checks += 1;
      ok('provider smoke digiflazz balance', digiflazzBalance.response.status);

      const tokovoucherBalance = await authedGet(teamToken, '/api/v2/vendors/tokovoucher/balance');
      assertStatus('provider smoke tokovoucher balance', tokovoucherBalance.response, tokovoucherBalance.body, 200);
      if (Number(tokovoucherBalance.body?.balance || 0) !== 1000000) {
        throw new Error('provider smoke tokovoucher balance returned unexpected balance');
      }
      checks += 1;
      ok('provider smoke tokovoucher balance', tokovoucherBalance.response.status);

      for (const vendor of [activeDigiflazz, activeTokovoucher]) {
        const name = String(vendor.name || '').toLowerCase();
        const test = await authedJson(teamToken, 'POST', `/api/v2/vendors/${vendor._id.toString()}/test`, {});
        assertStatus(`provider smoke vendor test ${name}`, test.response, test.body, 200);
        if (test.body?.success !== true || Number(test.body?.balance || 0) !== 1000000) {
          throw new Error(`provider smoke vendor test ${name} returned unexpected response`);
        }
        checks += 1;
        ok(`provider smoke vendor test ${name}`, test.response.status);
      }

      const health = await authedGet(teamToken, '/api/v2/vendors/health');
      assertStatus('provider smoke vendor health', health.response, health.body, 200);
      if (!Array.isArray(health.body?.vendors) || health.body.vendors.length < 2) {
        throw new Error('provider smoke vendor health returned unexpected payload');
      }
      checks += 1;
      ok('provider smoke vendor health', health.response.status);

      const healthExport = await authedGet(teamToken, '/api/v2/vendors/health/export');
      assertStatus('provider smoke vendor health export', healthExport.response, healthExport.body, 200);
      if (typeof healthExport.body !== 'string' || !healthExport.body.includes('Vendor,Health,Configured')) {
        throw new Error('provider smoke vendor health export returned unexpected CSV');
      }
      checks += 1;
      ok('provider smoke vendor health export', healthExport.response.status);

      const pricelistFetch = await authedJson(teamToken, 'POST', '/api/v2/vendors/digiflazz/pricelist/fetch', {});
      assertStatus('provider smoke digiflazz pricelist fetch', pricelistFetch.response, pricelistFetch.body, 200);
      if (pricelistFetch.body?.success !== true || Number(pricelistFetch.body?.total || 0) !== 1) {
        throw new Error('provider smoke digiflazz pricelist fetch returned unexpected response');
      }
      checks += 1;
      ok('provider smoke digiflazz pricelist fetch', pricelistFetch.response.status);

      const digiflazzSync = await authedJson(teamToken, 'POST', `/api/v2/vendors/${activeDigiflazz._id.toString()}/sync`, {});
      assertStatus('provider smoke digiflazz sync', digiflazzSync.response, digiflazzSync.body, 200);
      if (Number(digiflazzSync.body?.syncedCount || 0) !== 1) {
        throw new Error('provider smoke digiflazz sync returned unexpected count');
      }
      checks += 1;
      ok('provider smoke digiflazz sync', digiflazzSync.response.status);

      const tokovoucherSync = await authedJson(teamToken, 'POST', `/api/v2/vendors/${activeTokovoucher._id.toString()}/sync`, {});
      assertStatus('provider smoke tokovoucher sync', tokovoucherSync.response, tokovoucherSync.body, 200);
      if (Number(tokovoucherSync.body?.syncedCount || 0) !== 0) {
        throw new Error('provider smoke tokovoucher sync returned unexpected count');
      }
      checks += 1;
      ok('provider smoke tokovoucher sync', tokovoucherSync.response.status);

      const tokovoucherCategories = await authedGet(teamToken, '/api/v2/vendors/tokovoucher/categories');
      assertStatus('provider smoke tokovoucher categories', tokovoucherCategories.response, tokovoucherCategories.body, 200);
      if (!Array.isArray(tokovoucherCategories.body?.data) || tokovoucherCategories.body.data.length !== 1) {
        throw new Error('provider smoke tokovoucher categories returned unexpected data');
      }
      checks += 1;
      ok('provider smoke tokovoucher categories', tokovoucherCategories.response.status);

      const tokovoucherOperators = await authedGet(teamToken, '/api/v2/vendors/tokovoucher/operators?categoryId=smoke-category');
      assertStatus('provider smoke tokovoucher operators', tokovoucherOperators.response, tokovoucherOperators.body, 200);
      if (!Array.isArray(tokovoucherOperators.body?.data) || tokovoucherOperators.body.data.length !== 1) {
        throw new Error('provider smoke tokovoucher operators returned unexpected data');
      }
      checks += 1;
      ok('provider smoke tokovoucher operators', tokovoucherOperators.response.status);

      const tokovoucherJenis = await authedGet(teamToken, '/api/v2/vendors/tokovoucher/jenis?operatorId=smoke-operator');
      assertStatus('provider smoke tokovoucher jenis', tokovoucherJenis.response, tokovoucherJenis.body, 200);
      if (!Array.isArray(tokovoucherJenis.body?.data) || tokovoucherJenis.body.data.length !== 1) {
        throw new Error('provider smoke tokovoucher jenis returned unexpected data');
      }
      checks += 1;
      ok('provider smoke tokovoucher jenis', tokovoucherJenis.response.status);

      const tokovoucherProducts = await authedGet(teamToken, '/api/v2/vendors/tokovoucher/products?jenisId=smoke-jenis');
      assertStatus('provider smoke tokovoucher products', tokovoucherProducts.response, tokovoucherProducts.body, 200);
      if (!Array.isArray(tokovoucherProducts.body?.data) || tokovoucherProducts.body.data.length !== 1) {
        throw new Error('provider smoke tokovoucher products returned unexpected data');
      }
      checks += 1;
      ok('provider smoke tokovoucher products', tokovoucherProducts.response.status);

      const tokovoucherSearch = await authedGet(teamToken, '/api/v2/vendors/tokovoucher/search?kode=SMOKE-TV-SKU');
      assertStatus('provider smoke tokovoucher search', tokovoucherSearch.response, tokovoucherSearch.body, 200);
      if (Number(tokovoucherSearch.body?.total || 0) !== 1) {
        throw new Error('provider smoke tokovoucher search returned unexpected total');
      }
      checks += 1;
      ok('provider smoke tokovoucher search', tokovoucherSearch.response.status);
    } finally {
      await restoreVendor(originalDigiflazz, 'digiflazz');
      await restoreVendor(originalTokovoucher, 'tokovoucher');
      await dgcache.deleteMany({});
      if (originalDgcache.length > 0) {
        await dgcache.insertMany(originalDgcache);
      }
      await products.deleteMany({ code: 'SMOKE-SANDBOX-SKU' });
      if (originalSmokeSyncProducts.length > 0) {
        await products.insertMany(originalSmokeSyncProducts);
      }
    }
  });

  return checks;
}

async function smokeGameValidationSandbox() {
  if (providerMode !== 'sandbox') {
    return 0;
  }

  let checks = 0;

  const freefire = await authedJson('', 'POST', '/api/v2/validate/freefire', { userId: '123456789' });
  assertStatus('provider smoke freefire validation sandbox', freefire.response, freefire.body, 200);
  if (freefire.body?.success !== true || freefire.body?.data?.nickname !== 'Sandbox FF 123456789') {
    throw new Error('provider smoke freefire validation sandbox returned unexpected response');
  }
  checks += 1;
  ok('provider smoke freefire validation sandbox', freefire.response.status);

  const mobilelegends = await authedJson('', 'POST', '/api/v2/validate/mobilelegends', {
    userId: '987654321',
    zoneId: '1234',
  });
  assertStatus('provider smoke mobilelegends validation sandbox', mobilelegends.response, mobilelegends.body, 200);
  if (mobilelegends.body?.success !== true || mobilelegends.body?.data?.nickname !== 'Sandbox ML 987654321-1234') {
    throw new Error('provider smoke mobilelegends validation sandbox returned unexpected response');
  }
  checks += 1;
  ok('provider smoke mobilelegends validation sandbox', mobilelegends.response.status);

  return checks;
}

async function main() {
  const teamToken = await login(email, password, 'team smoke');
  let memberToken = null;
  if (memberEmail && memberPassword) {
    memberToken = await login(memberEmail, memberPassword, 'member smoke');
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await smokeBoundaryChecks(teamToken);
  let checks = 4;
  checks += await smokeMemberTransactionCreate(memberToken, suffix);
  if (requireTransactionCreateReadiness && checks < 7) {
    throw new Error('transaction create readiness requires member create pending/success/failed coverage');
  }
  checks += await smokeTransactionRecheck(teamToken, suffix);
  checks += await smokeGuestConfirm(teamToken, suffix);
  checks += await smokeProviderAdminEndpoints(teamToken);
  checks += await smokeGameValidationSandbox();

  console.log(`\n${checks} API v2 provider smoke checks passed.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
