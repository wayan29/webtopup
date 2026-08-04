import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import { clearFaultEvidence, readFaultEvidence, withFault } from '../faults.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');
const readEnv = async (file: string): Promise<Record<string, string>> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);
const digestStoredKey = (secret: string, raw: string): string => {
  const mac = crypto.createHmac('sha256', secret);
  mac.update('guest-idempotency:v2');
  const part = (value: string) => { const bytes = Buffer.from(value); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); mac.update(length); mac.update(bytes); };
  part('idempotency-key.storage');
  part(raw);
  return mac.digest('base64url');
};

test.describe.configure({ timeout: 120_000 });
test('real replica-set guest checkout recovers response loss and mutates stock/document exactly once', async ({ request }) => {
  const [env, rustEnv, nodeEnv] = await Promise.all([
    readEnv(path.join(stateDir, 'env', 'shared.env')),
    readEnv(path.join(stateDir, 'env', 'rust.env')),
    readEnv(path.join(stateDir, 'env', 'node.env')),
  ]);
  expect(env.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(env.MONGO_DB).toBe('webtopup_task14_dev');
  expect(env.MONGO_URI).toContain('replicaSet=rs0');
  const mongo = new MongoClient(env.MONGO_URI!);
  const verificationRunId = `guest-checkout-${crypto.randomUUID()}`;
  const verificationMarker = { verificationRunId };
  const productId = new ObjectId(); const paymentCategoryId = new ObjectId(); const paymentMethodId = new ObjectId(); const flashSaleId = new ObjectId();
  const productCode = `VERIFY-${crypto.randomUUID()}`;
  const keys = [crypto.randomUUID(), crypto.randomUUID()];
  const storedKeys = keys.map((key) => digestStoredKey(rustEnv.SESSION_TOKEN_HASH_SECRET!, key));
  // Playwright's APIRequestContext does not use Chromium launch arguments (including the scoped
  // SPKI pin), so this API-only test talks to the loopback Node gateway directly.
  const apiBase = `http://127.0.0.1:${env.NODE_PORT}`;
  let primary: unknown;
  try {
    await mongo.connect(); const db = mongo.db(env.MONGO_DB); const hello = await mongo.db('admin').command({ hello: 1 });
    expect(hello.setName).toBe('rs0'); expect(hello.isWritablePrimary).toBe(true);
    const indexes = await db.collection('guesttransactions').indexes();
    const markerIndex = indexes.find((index) => index.name === 'uniq_guest_idempotency_marker');
    expect(markerIndex?.unique).toBe(true);
    expect(markerIndex?.key).toEqual({ idempotencyRoute: 1, idempotencyKey: 1, idempotencyRequestDigest: 1 });
    expect(markerIndex?.partialFilterExpression).toEqual({
      idempotencyRoute: 'guest_transactions.create',
      idempotencyKey: { $type: 'string' },
      idempotencyRequestDigest: { $type: 'string' },
    });
    const now = new Date();
    await db.collection('products').insertOne({ _id: productId, code: productCode, name: 'Verification Product', status: true, price: { basic: 10_000, gold: 9_000, platinum: 8_000 }, verificationRunId });
    await db.collection('paymentcategories').insertOne({ _id: paymentCategoryId, name: 'Bank Transfer', slug: 'bank-transfer', status: 'active', verificationRunId });
    await db.collection('paymentmethods').insertOne({ _id: paymentMethodId, name: 'Verification Bank', category: paymentCategoryId, accountNumber: '000000', accountName: 'Verification', adminFee: 0, adminPercent: 0, minAmount: 1, maxAmount: 10_000_000, operationalStart: '00:00', operationalEnd: '23:59', status: 'active', verificationRunId });
    await db.collection('flashsales').insertOne({ _id: flashSaleId, name: 'Verification Flash', isActive: true, startDate: new Date(now.getTime() - 60_000), endDate: new Date(now.getTime() + 3_600_000), products: [{ productId, stock: 10, soldCount: 0, discountType: 'fixed', discountValue: 1000 }], verificationRunId });

    const payload = { productCode, target: '123456789', serverId: '1', whatsapp: '081234567890', paymentMethodId: paymentMethodId.toHexString(), useFlashSale: true };
    const send = (key: string, body = payload) => request.post(`${apiBase}/api/v2/guest-transactions`, { headers: { 'Idempotency-Key': key }, data: body });
    const parallel = await Promise.all(Array.from({ length: 6 }, (_, index) => request.post(`${apiBase}/api/v2/guest-transactions`, {
      headers: { 'Idempotency-Key': keys[0]!, 'x-forwarded-for': `127.0.0.${index + 2}` }, data: payload,
    })));
    expect(parallel.filter((response) => response.status() === 201)).toHaveLength(1);
    expect(parallel.every((response) => [201, 409].includes(response.status()))).toBe(true);
    const original = parallel.find((response) => response.status() === 201)!;
    const originalBody = await original.text();
    const replay = await send(keys[0]!); expect(replay.status()).toBe(201); expect(await replay.text()).toBe(originalBody);
    const conflict = await send(keys[0]!, { ...payload, target: 'changed-target' }); expect(conflict.status()).toBe(409); expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const lost = await withFault({ stateDir, capability: nodeEnv.LOCAL_DESTRUCTIVE_CAPABILITY!, scenario: 'guest_checkout_response_loss_after_commit', ttlMs: 5_000 }, async () => {
      try { const response = await send(keys[1]!); return { status: response.status(), body: await response.text() }; } catch { return { status: 0, body: '' }; }
    });
    expect(lost.status).toBe(503);
    await expect.poll(async () => await readFaultEvidence(stateDir)).toEqual(expect.objectContaining({
      scenario: 'guest_checkout_response_loss_after_commit',
      mongoTransactionCommitted: true,
      guestMarkerDurable: true,
      idempotencyCompleteSkipped: true,
      consumed: true,
    }));
    const beforeRecovery = await mongo.db(env.MONGO_DB).collection('idempotencyrecords').findOne({ routeKey: 'guest_transactions.create', idempotencyKey: storedKeys[1] });
    expect(beforeRecovery?.status).toBe('started');
    expect(beforeRecovery?.responseBody).toBeUndefined();
    const durableMarker = await mongo.db(env.MONGO_DB).collection('guesttransactions').findOne({ product: productId, idempotencyKey: storedKeys[1] });
    expect(durableMarker).toEqual(expect.objectContaining({
      idempotencyRoute: 'guest_transactions.create',
      idempotencyKey: storedKeys[1],
      idempotencyResponseStatus: 201,
    }));
    expect(typeof durableMarker?.idempotencyRequestDigest).toBe('string');
    expect(typeof durableMarker?.idempotencyResponseBody).toBe('string');
    expect(JSON.parse(durableMarker!.idempotencyResponseBody)).toEqual(expect.objectContaining({ transaction: expect.any(Object), paymentInfo: expect.any(Object) }));
    const recovered = await send(keys[1]!); expect(recovered.status()).toBe(201);
    const recoveredBody = await recovered.text();
    const recoveredSnapshot = await mongo.db(env.MONGO_DB).collection('idempotencyrecords').findOne({ routeKey: 'guest_transactions.create', idempotencyKey: storedKeys[1] });
    expect(recoveredSnapshot?.status).toBe('completed');
    expect(recoveredSnapshot?.responseStatus).toBe(201);
    expect(recoveredSnapshot?.responseBody).toBe(recoveredBody);

    const created = await db.collection('guesttransactions').find({ product: productId }).toArray(); expect(created).toHaveLength(2);
    expect(new Set(created.map((row) => row.invoiceNumber)).size).toBe(2);
    const flash = await db.collection('flashsales').findOne({ _id: flashSaleId }); expect(flash!.products[0].soldCount).toBe(2);
    expect(await db.collection('guesttransactions').countDocuments({ idempotencyKey: { $in: keys } })).toBe(0);
    expect(await db.collection('idempotencyrecords').countDocuments({ idempotencyKey: { $in: keys } })).toBe(0);
    expect(await db.collection('idempotencyrecords').countDocuments({ actorId: new ObjectId('000000000000000000000000'), routeKey: 'guest_transactions.create', idempotencyKey: { $in: storedKeys } })).toBe(2);
  } catch (error) { primary = error; }
  const cleanupErrors: unknown[] = [];
  try {
    const db = mongo.db(env.MONGO_DB);
    const marker = await db.collection('__localVerification').findOne({ kind: 'webtopup-local-dev-verification', databaseName: 'webtopup_task14_dev' });
    if (!marker) throw new Error('refusing guest checkout cleanup without disposable database marker');
    await db.collection('idempotencyrecords').deleteMany({ $or: [verificationMarker, { actorId: new ObjectId('000000000000000000000000'), routeKey: 'guest_transactions.create', idempotencyKey: { $in: storedKeys } }] });
    await db.collection('guesttransactions').deleteMany({ $or: [verificationMarker, { product: productId, idempotencyKey: { $in: storedKeys } }] });
    for (const collection of ['flashsales', 'paymentmethods', 'paymentcategories', 'products', 'users', 'authsessions', 'credentials', 'browserprofiles']) {
      await db.collection(collection).deleteMany(verificationMarker);
    }
    await clearFaultEvidence(stateDir);
  } catch (error) { cleanupErrors.push(error); }
  try { await mongo.close(); } catch (error) { cleanupErrors.push(error); }
  if (primary && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], 'guest checkout verification and cleanup failed');
  if (primary) throw primary;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'guest checkout cleanup failed');
});
