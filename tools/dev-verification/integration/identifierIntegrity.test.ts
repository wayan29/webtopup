import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { loginFixture } from '../e2e/fixtures.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');
const readinessBin = path.join(root, 'rust-api', 'target', 'debug', 'site_config_identifier_readiness');

type Env = Record<string, string>;

test('identifier readiness, allocation, OpenAPI, and fail-closed index gates', async () => {
  const [shared, nodeSecrets] = await Promise.all([
    readEnv(path.join(stateDir, 'env', 'shared.env')),
    readEnv(path.join(stateDir, 'env', 'node.env')),
  ]);
  assert.equal(shared.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(shared.MONGO_DB, 'webtopup_task14_dev');
  assert.match(shared.MONGO_URI, /replicaSet=rs0/);

  const member = await loginFixture('identifier-member');
  const manager = await loginFixture('site-config-manager');
  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const rustBase = `http://127.0.0.1:${shared.RUST_PORT}`;
  const mongo = new MongoClient(shared.MONGO_URI);
  const marker = `id-${crypto.randomUUID().slice(0, 8)}`;
  const productId = new ObjectId();
  const createdTxnIds: ObjectId[] = [];
  let droppedIndex = false;
  let primary: unknown = null;
  const originalSettings = new Map<string, unknown>();

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    assert.ok(await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    }));

    const beforeDocs = {
      transactions: await db.collection('transactions').countDocuments(),
      counters: await db.collection('identifiercounters').countDocuments(),
      invoices: await db.collection('guesttransactions').countDocuments(),
    };
    const beforeIndexes = await inspectExactIndexes(db);

    const dryRun = await runReadiness(shared, []);
    assert.ok(dryRun.stdout.includes(`database=${shared.MONGO_DB}`));
    assert.deepEqual(await inspectExactIndexes(db), beforeIndexes);
    assert.equal(await db.collection('transactions').countDocuments(), beforeDocs.transactions);

    const apply = await runReadiness(shared, ['--apply']);
    assert.equal(apply.code, 0, apply.stderr);
    const afterApply = await inspectExactIndexes(db);
    assert.equal(afterApply.transactions, true);
    assert.equal(afterApply.invoices, true);
    assert.equal(afterApply.counters, true);

    const refused = await runReadiness({ ...shared, MONGO_DB: 'webtopup' }, ['--apply']);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr + refused.stdout, /webtopup_task14_dev|refusing/i);

    await db.collection('settings').bulkWrite([
      { updateOne: { filter: { key: 'refIdPrefix' }, update: { $set: { key: 'refIdPrefix', value: 'REF' } }, upsert: true } },
      { updateOne: { filter: { key: 'refIdDateFormat' }, update: { $set: { key: 'refIdDateFormat', value: 'DDMMYYYY' } }, upsert: true } },
      { updateOne: { filter: { key: 'refIdSequenceDigits' }, update: { $set: { key: 'refIdSequenceDigits', value: 4 } }, upsert: true } },
      { updateOne: { filter: { key: 'refIdSeparator' }, update: { $set: { key: 'refIdSeparator', value: '' } }, upsert: true } },
    ]);
    await db.collection('identifiercounters').deleteMany({ scope: 'transaction-reference' });
    const memberUser = await db.collection('users').findOne(
      { email: member.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    if (memberUser) {
      await db.collection('authsessions').deleteMany({ userId: memberUser._id });
      await db.collection('users').updateOne({ _id: memberUser._id }, { $set: { balance: 100_000 } });
    }
    await db.collection('products').deleteMany({ task14Fixture: true, code: { $regex: /^ID-/ } });
    await db.collection('transactions').deleteMany({ source: { $in: ['web', 'api'] }, target: { $regex: /^08/ } });

    const memberLogin = await jsonRequest(`${nodeBase}/api/v2${member.loginEndpoint}`, {
      method: 'POST',
      headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: member.email,
        password: member.password,
        rememberMe: false,
        deviceName: 'Task14 identifier member',
      }),
    });
    assert.equal(memberLogin.status, 200, memberLogin.text);
    const memberToken = String(memberLogin.body?.accessToken || '');
    assert.ok(memberToken.length > 10);

    await db.collection('products').insertOne({
      _id: productId,
      code: `ID-${marker}`,
      name: 'Identifier fixture product',
      status: true,
      price: { basic: 100, gold: 100, platinum: 100 },
      task14Fixture: true,
    });

    const createMemberTxn = (index: number) => jsonRequest(`${nodeBase}/api/v2/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberToken}`,
        Origin: shared.PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        productId: productId.toHexString(),
        target: `08${String(index).padStart(10, '0')}`,
      }),
    });
    const created = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      let last = await createMemberTxn(index);
      for (let attempt = 0; attempt < 5 && last.status >= 500; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        last = await createMemberTxn(index);
      }
      return last;
    }));
    const okCreates = created.filter((item) => item.status === 201);
    if (okCreates.length !== 50) {
      const failed = created.filter((item) => item.status !== 201).slice(0, 5).map((item) => `${item.status}:${item.text.slice(0, 180)}`);
      assert.equal(okCreates.length, 50, failed.join(' | '));
    }
    const refs = okCreates.map((item) => String(item.body?.transaction?.referenceId || item.body?.referenceId || ''));
    assert.equal(new Set(refs).size, 50);
    assert.ok(refs.every((value) => value.length > 4));
    for (const item of okCreates) {
      const id = item.body?.transaction?._id || item.body?._id;
      if (typeof id === 'string') createdTxnIds.push(new ObjectId(id));
    }

    const keygen = await jsonRequest(`${nodeBase}/api/v2/api/key/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberToken}`,
        Origin: shared.PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(keygen.status, 200, keygen.text);
    const apiKey = String(keygen.body?.apiKey || '');
    const apiSecret = String(keygen.body?.secret || '');
    const memberId = String(keygen.body?.memberId || '');
    assert.ok(apiKey && apiSecret && memberId);
    const customerRefId = `CUST-${marker}`;
    const signature = crypto.createHash('md5').update(`${memberId}:${apiKey}:${apiSecret}:${customerRefId}`).digest('hex');
    const openApi = await jsonRequest(`${nodeBase}/api/v2/api/transaction`, {
      method: 'POST',
      headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        member_id: memberId,
        api_key: apiKey,
        signature,
        product_code: `ID-${marker}`,
        target: '081234567890',
        ref_id: customerRefId,
      }),
    });
    assert.ok(openApi.status === 200 || openApi.status === 201, openApi.text);
    const openApiRef = String(openApi.body?.data?.ref_id || openApi.body?.ref_id || customerRefId);
    assert.equal(openApiRef, customerRefId);
    const openApiTxn = await db.collection('transactions').findOne({ customerRefId });
    assert.ok(openApiTxn);
    assert.ok(openApiTxn.referenceId);
    assert.notEqual(openApiTxn.referenceId, customerRefId);
    if (openApiTxn._id instanceof ObjectId) createdTxnIds.push(openApiTxn._id);

    const settings = db.collection('settings');
    for (const key of ['refIdDateFormat', 'refIdPrefix', 'refIdSequenceDigits', 'invoiceDateFormat', 'invoiceRandomType', 'invoiceRandomLength', 'invoicePrefix']) {
      const doc = await settings.findOne({ key });
      originalSettings.set(key, doc?.value);
    }
    await settings.updateOne({ key: 'refIdDateFormat' }, { $set: { value: 'NONE', key: 'refIdDateFormat' } }, { upsert: true });
    const managerUser = await db.collection('users').findOne({ email: manager.email, task14Fixture: true }, { projection: { _id: 1, email: 1, role: 1 } });
    assert.ok(managerUser);
    const adminAll = await jsonRequest(`${rustBase}/v2/settings/admin/all`, {
      headers: trustedHeaders(nodeSecrets.API_V2_PROXY_SECRET, managerUser._id, manager.email, String(managerUser.role), shared.PUBLIC_ORIGIN),
    });
    assert.equal(adminAll.status, 200);
    assert.equal(adminAll.body?.refIdDateFormat, 'DDMMYYYY');
    const storedNone = await settings.findOne({ key: 'refIdDateFormat' });
    assert.equal(storedNone?.value, 'NONE');
    const dryUnsafe = await runReadiness(shared, []);
    assert.match(dryUnsafe.stdout, /unsafe_ref_id_date_format/);

    const rejectNone = await jsonRequest(`${rustBase}/v2/settings/admin/update`, {
      method: 'PUT',
      headers: {
        ...trustedHeaders(nodeSecrets.API_V2_PROXY_SECRET, managerUser._id, manager.email, String(managerUser.role), shared.PUBLIC_ORIGIN),
        'Idempotency-Key': `sitecfg_none_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      },
      body: JSON.stringify({
        expectedRevision: Number(adminAll.body?.revision || 0),
        changes: { refIdDateFormat: 'NONE' },
      }),
    });
    assert.equal(rejectNone.status, 400);

    const allowInvoiceNone = await jsonRequest(`${rustBase}/v2/settings/admin/update`, {
      method: 'PUT',
      headers: {
        ...trustedHeaders(nodeSecrets.API_V2_PROXY_SECRET, managerUser._id, manager.email, String(managerUser.role), shared.PUBLIC_ORIGIN),
        'Idempotency-Key': `sitecfg_invnone_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      },
      body: JSON.stringify({
        expectedRevision: Number(adminAll.body?.revision || 0),
        changes: { invoiceDateFormat: 'NONE' },
      }),
    });
    assert.ok([200, 409].includes(allowInvoiceNone.status), allowInvoiceNone.text);

    const afterPrefix = await db.collection('identifiercounters').findOne({ scope: 'transaction-reference' });
    const seqBeforePrefix = Number(afterPrefix?.sequence || 0);
    await settings.updateOne({ key: 'refIdPrefix' }, { $set: { value: 'IDX', key: 'refIdPrefix' } }, { upsert: true });
    const afterPrefixChange = await jsonRequest(`${nodeBase}/api/v2/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberToken}`,
        Origin: shared.PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId: productId.toHexString(), target: '081111111111' }),
    });
    assert.equal(afterPrefixChange.status, 201, afterPrefixChange.text);
    const afterPrefixCounter = await db.collection('identifiercounters').findOne({ scope: 'transaction-reference' });
    assert.equal(Number(afterPrefixCounter?.sequence || 0), seqBeforePrefix + 1);
    const prefixTxnId = afterPrefixChange.body?.transaction?._id || afterPrefixChange.body?._id;
    if (typeof prefixTxnId === 'string') createdTxnIds.push(new ObjectId(prefixTxnId));

    await settings.updateOne({ key: 'refIdSequenceDigits' }, { $set: { value: 1, key: 'refIdSequenceDigits' } }, { upsert: true });
    if (afterPrefixCounter?._id) {
      await db.collection('identifiercounters').updateOne({ _id: afterPrefixCounter._id }, { $set: { sequence: 9 } });
    }
    const exhausted = await jsonRequest(`${nodeBase}/api/v2/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberToken}`,
        Origin: shared.PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId: productId.toHexString(), target: '082222222222' }),
    });
    assert.equal(exhausted.status, 409);
    assert.equal(errorCode(exhausted.body), 'REF_ID_SEQUENCE_EXHAUSTED');
    const counterAfterExhaust = await db.collection('identifiercounters').findOne({ scope: 'transaction-reference' });
    assert.equal(Number(counterAfterExhaust?.sequence || 0), 9);
    const service = await fs.readFile(path.join(root, 'rust-api/src/services/identifier_integrity.rs'), 'utf8');
    const guestPublic = await fs.readFile(path.join(root, 'rust-api/src/routes/guest_transactions/public.rs'), 'utf8');
    assert.match(service, /MAX_INVOICE_CANDIDATES/);
    assert.match(guestPublic, /INVOICE_IDENTIFIER_EXHAUSTED/);

    await db.collection('transactions').dropIndex('uniq_transactions_reference_id').catch(() => undefined);
    droppedIndex = true;
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const unavailable = await jsonRequest(`${nodeBase}/api/v2/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberToken}`,
        Origin: shared.PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId: productId.toHexString(), target: '083333333333' }),
    });
    assert.equal(unavailable.status, 503);
    assert.equal(errorCode(unavailable.body), 'IDENTIFIER_INDEX_UNAVAILABLE');
  } catch (error) {
    primary = error;
  } finally {
    try {
      const db = mongo.db(shared.MONGO_DB);
      if (droppedIndex) {
        await runReadiness(shared, ['--apply']).catch(() => undefined);
      }
      if (createdTxnIds.length) await db.collection('transactions').deleteMany({ _id: { $in: createdTxnIds } });
      await db.collection('products').deleteOne({ _id: productId });
      await db.collection('guesttransactions').deleteMany({ fixtureScenario: marker });
      for (const [key, value] of originalSettings) {
        if (value === undefined) await db.collection('settings').deleteOne({ key });
        else await db.collection('settings').updateOne({ key }, { $set: { value } }, { upsert: true });
      }
    } catch { /* ignore cleanup */ }
    await mongo.close().catch(() => undefined);
  }
  if (primary) throw primary;
});

async function inspectExactIndexes(db: ReturnType<MongoClient['db']>) {
  const names = async (collection: string) => {
    try {
      return (await db.collection(collection).indexes()).map((index) => index.name);
    } catch {
      return [];
    }
  };
  const [transactions, invoices, counters] = await Promise.all([
    names('transactions'),
    names('guesttransactions'),
    names('identifiercounters'),
  ]);
  return {
    transactions: transactions.includes('uniq_transactions_reference_id'),
    invoices: invoices.includes('uniq_guest_invoice_number'),
    counters: counters.includes('uniq_identifier_counter_scope_date'),
  };
}

function runReadiness(shared: Env, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(readinessBin, args, {
      cwd: path.join(root, 'rust-api'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MONGO_URI: shared.MONGO_URI,
        MONGO_DB: shared.MONGO_DB,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function jsonRequest(url: string, options: RequestInit) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text };
}

function errorCode(body: any): unknown {
  return body?.error?.code ?? body?.code;
}

function trustedHeaders(secret: string | undefined, userId: ObjectId, email: string, role: string, origin: string) {
  assert.equal(typeof secret, 'string');
  return {
    'x-api-v2-proxy-secret': secret as string,
    'x-webtopup-user-id': userId.toHexString(),
    'x-webtopup-user-role': role,
    'x-webtopup-user-email': email,
    'x-webtopup-step-up-group': 'settings.sensitive',
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

async function readEnv(file: string): Promise<Env> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}
