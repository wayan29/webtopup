#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:9005').replace(/\/$/, '');
const memberEmail = (process.env.DRY_RUN_MEMBER_EMAIL || '').trim();
const memberPassword = process.env.DRY_RUN_MEMBER_PASSWORD || '';
const adminEmail = (process.env.DRY_RUN_ADMIN_EMAIL || process.env.SMOKE_EMAIL || '').trim();
const adminPassword = process.env.DRY_RUN_ADMIN_PASSWORD || process.env.SMOKE_PASSWORD || '';
const productCode = (process.env.DRY_RUN_PRODUCT_CODE || '').trim();
const target = (process.env.DRY_RUN_TARGET || '').trim();
const serverId = (process.env.DRY_RUN_SERVER_ID || '').trim();
const smokeMongoUri = (process.env.SMOKE_MONGO_URI || process.env.MONGO_URI || '').trim();
const smokeMongoDb = (process.env.SMOKE_MONGO_DB || process.env.MONGO_DB || '').trim();
const outputPath = (process.env.DRY_RUN_OUTPUT_PATH || '').trim();
const allowBalanceChange = process.env.CONFIRM_TRANSACTION_CREATE_DRY_RUN_BALANCE_CHANGE === '1';
const approved = process.env.RUN_TRANSACTION_CREATE_DRY_RUN === '1';

if (!approved) {
  console.error('Refusing to run transaction create dry run without RUN_TRANSACTION_CREATE_DRY_RUN=1.');
  process.exit(1);
}

if (!allowBalanceChange) {
  console.error('Refusing to run transaction create dry run without CONFIRM_TRANSACTION_CREATE_DRY_RUN_BALANCE_CHANGE=1.');
  process.exit(1);
}

for (const [name, value] of Object.entries({
  DRY_RUN_MEMBER_EMAIL: memberEmail,
  DRY_RUN_MEMBER_PASSWORD: memberPassword,
  DRY_RUN_ADMIN_EMAIL: adminEmail,
  DRY_RUN_ADMIN_PASSWORD: adminPassword,
  DRY_RUN_PRODUCT_CODE: productCode,
  DRY_RUN_TARGET: target,
  MONGO_URI: smokeMongoUri,
})) {
  if (!value) {
    console.error(`Refusing to run transaction create dry run without ${name}.`);
    process.exit(1);
  }
}

const lockPath = path.join(os.tmpdir(), 'webtopup-api-v2-smoke-suite.lock');
let lockFd = null;
try {
  lockFd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\ntransaction-create-dry-run\n`);
} catch {
  console.error(`Refusing to run transaction create dry run while another API v2 smoke run holds ${lockPath}.`);
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

async function login(email, password, label) {
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
    headers: { Authorization: `Bearer ${token}` },
  });
}

function assertStatus(name, response, body, expectedStatus) {
  if (response.status !== expectedStatus) {
    throw new Error(`${name} expected HTTP ${expectedStatus}, got ${response.status}: ${body?.message || JSON.stringify(body)}`);
  }
}

function transactionId(transaction) {
  return transaction?._id || transaction?.id;
}

async function withDb(callback) {
  const mongoose = require('../../server/node_modules/mongoose');
  const connection = await mongoose.createConnection(smokeMongoUri, smokeMongoDb ? { dbName: smokeMongoDb } : {}).asPromise();
  try {
    return await callback({
      products: connection.collection('products'),
      transactions: connection.collection('transactions'),
      users: connection.collection('users'),
    });
  } finally {
    await connection.close();
  }
}

function writeResult(result) {
  const json = JSON.stringify(result, null, 2);
  console.log(json);
  if (!outputPath) return;

  fs.writeFileSync(outputPath, `${json}\n`);
  console.log(`\nWrote dry-run result to ${outputPath}`);
}

async function main() {
  const memberToken = await login(memberEmail, memberPassword, 'member dry-run');
  const adminToken = await login(adminEmail, adminPassword, 'admin dry-run');

  const before = await withDb(async ({ products, users }) => {
    const member = await users.findOne({ email: memberEmail.toLowerCase() }, { projection: { balance: 1, points: 1, email: 1 } });
    if (!member) {
      throw new Error('dry-run member not found in Mongo');
    }
    const product = await products.findOne({ code: productCode }, { projection: { code: 1, name: 1, price: 1, vendor: 1, status: 1 } });
    if (!product) {
      throw new Error(`dry-run product not found for code ${productCode}`);
    }
    return {
      memberId: member._id.toString(),
      startingBalance: Number(member.balance || 0),
      startingPoints: Number(member.points || 0),
      product: {
        id: product._id.toString(),
        code: product.code,
        name: product.name,
        vendor: product.vendor,
        price: product.price,
        status: product.status,
      },
    };
  });

  const payload = {
    productCode,
    target,
    ...(serverId ? { serverId } : {}),
  };
  const create = await authedJson(memberToken, 'POST', '/api/v2/transactions', payload);
  assertStatus('transaction create dry run', create.response, create.body, 201);
  const createdId = transactionId(create.body?.transaction);
  if (!createdId) {
    throw new Error('transaction create dry run did not return transaction id');
  }

  const adminList = await authedGet(adminToken, `/api/v2/transactions/admin?search=${encodeURIComponent(createdId)}&scope=all&limit=5`);
  assertStatus('transaction create dry run admin lookup', adminList.response, adminList.body, 200);
  const adminItems = Array.isArray(adminList.body?.items) ? adminList.body.items : [];
  const adminTransaction = adminItems.find((item) => transactionId(item) === createdId || item._id === createdId || item.id === createdId);
  if (!adminTransaction) {
    throw new Error('transaction create dry run could not find transaction in admin list');
  }

  const after = await withDb(async ({ transactions, users }) => {
    const mongoose = require('../../server/node_modules/mongoose');
    const member = await users.findOne({ email: memberEmail.toLowerCase() }, { projection: { balance: 1, points: 1 } });
    const transaction = await transactions.findOne({ _id: mongoose.Types.ObjectId.createFromHexString(createdId) });
    return {
      endingBalance: Number(member?.balance || 0),
      endingPoints: Number(member?.points || 0),
      transactionCountForTarget: await transactions.countDocuments({ target }),
      persistedStatus: transaction?.status,
      persistedAmount: Number(transaction?.amount || 0),
      persistedVendorTrxId: transaction?.vendorTrxId || '',
      persistedSn: transaction?.sn || '',
      persistedRefunded: Boolean(transaction?.refunded),
    };
  });

  const result = {
    status: 'pass',
    generatedAt: new Date().toISOString(),
    baseUrl,
    memberEmail,
    productCode,
    target,
    serverId: serverId || null,
    transactionId: createdId,
    startingBalance: before.startingBalance,
    endingBalance: after.endingBalance,
    balanceDelta: after.endingBalance - before.startingBalance,
    startingPoints: before.startingPoints,
    endingPoints: after.endingPoints,
    pointsDelta: after.endingPoints - before.startingPoints,
    product: before.product,
    createResponse: {
      status: create.body?.transaction?.status,
      amount: create.body?.transaction?.amount,
      vendorTrxId: create.body?.transaction?.vendorTrxId,
      sn: create.body?.transaction?.sn,
      remainingBalance: create.body?.remainingBalance,
    },
    persisted: after,
    adminTransaction: {
      status: adminTransaction.status,
      amount: adminTransaction.amount,
      vendorTrxId: adminTransaction.vendorTrxId,
      sn: adminTransaction.sn,
      refunded: adminTransaction.refunded,
    },
    checklist: {
      localTransactionCreated: true,
      adminTransactionFound: true,
      duplicateLocalTransactionsForTarget: after.transactionCountForTarget > 1,
      providerVerificationRequired: true,
    },
  };

  writeResult(result);
  console.log('\nDry-run local/API checks passed. Verify provider dashboard manually before approving fallback removal.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
