import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { fixtureOtp, loginFixture } from '../e2e/fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;
type JsonResult = { status: number; body: any; headers: Record<string, string>; text: string };

const readEnv = async (file: string): Promise<Env> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

async function jsonRequest(url: string, options: RequestInit = {}): Promise<JsonResult> {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, body, headers, text };
}

async function loginAtGateway(base: string, fixture: { email: string; password: string; loginEndpoint: string }, origin: string): Promise<string> {
  const response = await jsonRequest(`${base}/api/v2${fixture.loginEndpoint}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: fixture.email,
      password: fixture.password,
      rememberMe: false,
      deviceName: 'Task seller center authorization',
    }),
  });
  expect(response.status, `login ${fixture.email}`).toBe(200);
  const accessToken = response.body?.accessToken;
  expect(typeof accessToken).toBe('string');
  return accessToken as string;
}

function bearerHeaders(accessToken: string, origin: string) {
  return { Authorization: `Bearer ${accessToken}`, Origin: origin, 'Content-Type': 'application/json' };
}

function runScrubber(args: string[], env: Env) {
  return spawnSync(
    'node',
    [path.join(root, 'scripts/security/scrub-seller-secrets.js'), ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', MONGO_URI: env.MONGO_URI ?? '', MONGO_DB: env.MONGO_DB ?? '' } },
  );
}

function runReadiness(args: string[], env: Env) {
  return spawnSync(
    path.join(root, 'rust-api/target/debug/seller_order_readiness'),
    args,
    { encoding: 'utf8', cwd: path.join(root, 'rust-api'), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', MONGO_URI: env.MONGO_URI ?? '', MONGO_DB: env.MONGO_DB ?? '' } },
  );
}

test.describe.configure({ timeout: 300_000 });

test('seller center permissions, secrecy, hygiene, indexes, and single execution hold', async ({ page }) => {
  const shared = await readEnv(path.join(stateDir, 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');
  expect(shared.MONGO_URI).toMatch(/replicaSet=rs0/);
  expect(shared.PROVIDER_MODE).toBe('mock');

  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const mongo = new MongoClient(shared.MONGO_URI!);
  const scrubSecrets = {
    digiflazzSign: `synthetic-dg-sign-${Date.now()}`,
    irsPass: `synthetic-irs-pass-${Date.now()}`,
    irsPin: '1234',
    irsSecret: `synthetic-irs-secret-${Date.now()}`,
  };
  const legacyRawSecrets = {
    orderRaw: `synthetic-legacy-raworder-${Date.now()}`,
    logRaw: `synthetic-legacy-rawlog-${Date.now()}`,
  };
  const fixtureUserIds: ObjectId[] = [];
  let safeToCleanup = false;
  let primary: unknown = null;
  let fixtureRunId = '';
  let scenarioRefId = '';
  const cleanupErrors: unknown[] = [];

  const denied = await loginFixture('seller-center-denied');
  const manager = await loginFixture('seller-center-manager');

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const markerDoc = await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    });
    expect(markerDoc).toBeTruthy();
    safeToCleanup = true;

    const managerRow = await db.collection('users').findOne(
      { email: manager.email, task14Fixture: true },
      { projection: { _id: 1, fixtureRunId: 1 } },
    );
    expect(managerRow).toBeTruthy();
    fixtureUserIds.push(managerRow!._id);
    fixtureRunId = String(managerRow!.fixtureRunId);
    const deniedRow = await db.collection('users').findOne(
      { email: denied.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    expect(deniedRow).toBeTruthy();
    fixtureUserIds.push(deniedRow!._id);

    // Test-local config/product/mapping fixtures with synthetic secrets.
    await db.collection('settings').updateOne(
      { key: 'digiflazzSellerConfig' },
      {
        $set: {
          key: 'digiflazzSellerConfig',
          value: {
            username: `task14-seller-${fixtureRunId}`,
            apiKey: scrubSecrets.digiflazzSign,
            publicBaseUrl: 'http://127.0.0.1',
            allowedIps: [],
            callbackEnabled: false,
            reportedBalance: 0,
            sellerMarginFlat: 0,
            task14Fixture: true,
            fixtureRunId,
          },
          description: 'Task 14 test-local seller config',
        },
      },
      { upsert: true },
    );
    await db.collection('settings').updateOne(
      { key: 'irsSellerConfig' },
      {
        $set: {
          key: 'irsSellerConfig',
          value: {
            enabled: true,
            merchantId: `task14-irs-merchant-${fixtureRunId}`,
            password: scrubSecrets.irsPass,
            pin: scrubSecrets.irsPin,
            secret: scrubSecrets.irsSecret,
            endpointUrl: 'https://v1.apigames.id/v2/transaksi-irs',
            allowedIps: [],
            formatter: { sn: { start: 'SN:', end: 'Saldo' } },
            task14Fixture: true,
            fixtureRunId,
          },
          description: 'Task 14 test-local IRS config',
        },
      },
      { upsert: true },
    );

    const productId = new ObjectId();
    await db.collection('products').insertOne({
      _id: productId,
      name: `Task14 Seller Product ${fixtureRunId}`,
      code: `task14-sku-${fixtureRunId}`.toLowerCase(),
      brand: 'Task14',
      category: 'Task14',
      status: true,
      costPrice: 1000,
      vendor: { name: 'MockVendor', sku: 'MOCKSKU' },
      task14Fixture: true,
      fixtureRunId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('digiflazzsellerproductmaps').insertOne({
      product: productId,
      pulsaCode: `task14-${fixtureRunId}`.toLowerCase(),
      price: 1500,
      isActive: true,
      task14Fixture: true,
      fixtureRunId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Historical rows that still carry legacy raw payloads.
    await db.collection('digiflazzsellerorders').insertOne({
      refId: `task14-history-dg-${fixtureRunId}`,
      trId: `task14-history-tr-${fixtureRunId}`,
      status: 'failed',
      rc: '07',
      message: 'GAGAL',
      rawRequest: { sign: legacyRawSecrets.orderRaw },
      task14Fixture: true,
      fixtureRunId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('irssellerorders').insertOne({
      refId: `task14-history-irs-${fixtureRunId}`,
      status: 'failed',
      statusCode: '2',
      message: 'GAGAL',
      rawRequest: { password: legacyRawSecrets.orderRaw },
      task14Fixture: true,
      fixtureRunId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('webhookeventlogs').insertOne({
      provider: 'digiflazz_seller',
      event: 'request',
      refId: `task14-history-log-${fixtureRunId}`,
      status: 'failed',
      raw: { sign: legacyRawSecrets.logRaw },
      task14Fixture: true,
      fixtureRunId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 1. Permission and step-up boundaries through the Node gateway.
    const anonymous = await jsonRequest(`${nodeBase}/api/v2/digiflazz-seller/center-summary`, {
      headers: { Origin: shared.PUBLIC_ORIGIN },
    });
    expect(anonymous.status).toBe(401);

    const deniedToken = await loginAtGateway(nodeBase, denied, shared.PUBLIC_ORIGIN);
    for (const endpoint of ['/digiflazz-seller/center-summary']) {
      const response = await jsonRequest(`${nodeBase}/api/v2${endpoint}`, {
        headers: bearerHeaders(deniedToken, shared.PUBLIC_ORIGIN),
      });
      expect(response.status, endpoint).toBe(403);
    }

    // Browser session for the manager so step-up grants bind to SID.
    await db.collection('authsessions').deleteMany({ userId: managerRow!._id });
    await page.goto(manager.loginPath);
    await page.getByLabel('Email').fill(manager.email);
    await page.getByLabel('Password').fill(manager.password);
    await page.getByRole('button', { name: 'Masuk sekarang' }).click();
    await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Kode OTP').fill(await fixtureOtp('seller-center-manager'));
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });

    const summaryFirst = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        const response = await api.get('/digiflazz-seller/center-summary', { _skipAuthRefresh: true });
        return { status: response.status, body: response.data };
      } catch (error: any) {
        return { status: error?.response?.status ?? 0, body: error?.response?.data ?? null };
      }
    });
    expect(summaryFirst.status).toBe(200);
    expect(summaryFirst.body.ok).toBe(true);
    expect(Array.isArray(summaryFirst.body.issues)).toBe(true);
    expect(typeof summaryFirst.body.generatedAt).toBe('string');
    expect(typeof summaryFirst.body.digiflazz.status).toBe('string');
    expect(typeof summaryFirst.body.irs.status).toBe('string');
    expect(typeof summaryFirst.body.mappings.active).toBe('number');
    const summaryText = JSON.stringify(summaryFirst.body);
    for (const secret of Object.values(scrubSecrets)) {
      expect(summaryText).not.toContain(secret);
    }
    expect(summaryText).not.toContain('synthetic-');
    expect(summaryText).not.toContain('username');
    expect(summaryText).not.toContain('merchant');

    // Settings mutations require the exact integrations.credentials step-up.
    for (const endpoint of ['/digiflazz-seller/settings', '/irs-seller/settings']) {
      const withoutGrant = await page.evaluate(async (url) => {
        const api = (await import('/src/api/index.ts')).apiV2 as any;
        try {
          await api.post(url, {}, { _skipAuthRefresh: true });
          return { status: 200, code: null, group: null };
        } catch (error: any) {
          const data = error?.response?.data;
          return {
            status: error?.response?.status ?? 0,
            code: data?.error?.code ?? data?.code ?? null,
            group: data?.error?.actionGroup ?? data?.actionGroup ?? null,
          };
        }
      }, endpoint);
      expect(withoutGrant.status, endpoint).toBe(403);
      expect(withoutGrant.code, endpoint).toBe('AUTH_STEP_UP_REQUIRED');
      expect(withoutGrant.group, endpoint).toBe('integrations.credentials');
    }

    const stepUp = await page.evaluate(async ({ password, otp }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.post('/auth/step-up', {
        password,
        otp,
        actionGroup: 'integrations.credentials',
      }, { _skipAuthRefresh: true });
      return { status: response.status, grantToken: response.data?.grantToken ?? null };
    }, { password: manager.password, otp: await fixtureOtp('seller-center-manager') });
    expect(stepUp.status).toBe(200);
    expect(typeof stepUp.grantToken).toBe('string');

    const settingsUpdate = await page.evaluate(async ({ grantToken, endpoint }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.post(endpoint, {
        username: `task14-seller-updated`,
        publicBaseUrl: 'http://127.0.0.1',
      }, { headers: { 'X-Step-Up-Token': grantToken }, _skipAuthRefresh: true });
      return { status: response.status, body: response.data };
    }, { grantToken: stepUp.grantToken, endpoint: '/digiflazz-seller/settings' });
    expect(settingsUpdate.status).toBe(200);
    expect(settingsUpdate.body?.success).toBe(true);
    expect(settingsUpdate.body?.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(settingsUpdate.body)).not.toContain(scrubSecrets.digiflazzSign);
    expect(settingsUpdate.body?.apiKeyMasked).toBeUndefined();

    // Omitted IRS secrets must be preserved server-side; reads expose booleans only.
    const irsSettingsUpdate = await page.evaluate(async ({ grantToken }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.post('/irs-seller/settings', {
        enabled: true,
        merchantId: 'task14-irs-merchant-renamed',
      }, { headers: { 'X-Step-Up-Token': grantToken }, _skipAuthRefresh: true });
      return { status: response.status, body: response.data };
    }, { grantToken: stepUp.grantToken });
    expect(irsSettingsUpdate.status).toBe(200);
    expect(irsSettingsUpdate.body?.success).toBe(true);

    const irsSettingsRead = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/irs-seller/settings', { _skipAuthRefresh: true });
      return { status: response.status, body: response.data };
    });
    expect(irsSettingsRead.status).toBe(200);
    expect(irsSettingsRead.body?.passwordConfigured).toBe(true);
    expect(irsSettingsRead.body?.pinConfigured).toBe(true);
    expect(irsSettingsRead.body?.secretConfigured).toBe(true);
    const irsSettingsText = JSON.stringify(irsSettingsRead.body);
    for (const secret of [scrubSecrets.irsPass, scrubSecrets.irsSecret, scrubSecrets.irsPin]) {
      expect(irsSettingsText).not.toContain(secret);
    }

    // 2. Public prepaid routes stay authentication-free at the gateway.
    const digiflazzPrepaid = await jsonRequest(`${nodeBase}/api/v2/digiflazz-seller/prepaid`, {
      method: 'POST',
      headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `task14-seller-${fixtureRunId}`,
        ref_id: `task14-prepaid-dg-${fixtureRunId}`,
        pulsa_code: 'unknown',
        hp: '081200000000',
        sign: `bad-${scrubSecrets.digiflazzSign}`,
      }),
    });
    expect(digiflazzPrepaid.status).toBe(200);
    expect(digiflazzPrepaid.body?.data?.rc).toBe('204');

    // 3. New writes keep no raw payloads and admin DTOs use exact allowlists.
    const invalidIrs = await jsonRequest(`${nodeBase}/api/v2/irs-seller/prepaid`, {
      method: 'POST',
      headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: `task14-irs-merchant-${fixtureRunId}`,
        password: `wrong-${scrubSecrets.irsPass}`,
        pin: 'wrong-pin',
        secret: `wrong-${scrubSecrets.irsSecret}`,
        ref_id: `task14-prepaid-irs-bad-${fixtureRunId}`,
        produk: 'unknown',
        tujuan: '081200000000',
      }),
    });
    expect(invalidIrs.status).toBe(200);
    expect(invalidIrs.body?.data?.statuscode).toBe('2');

    for (const collection of ['digiflazzsellerorders', 'irssellerorders']) {
      const leaked = await db.collection(collection).find({
        refId: { $regex: `^task14-prepaid` },
      }).toArray();
      for (const row of leaked) {
        expect('rawRequest' in row, `${collection} new write must not persist rawRequest`).toBe(false);
      }
    }
    const newEventLogs = await db.collection('webhookeventlogs').find({
      provider: { $in: ['digiflazz_seller', 'irs_seller'] },
      refId: { $regex: `^task14-prepaid` },
    }).toArray();
    for (const row of newEventLogs) {
      expect('raw' in row, 'new log writes must not persist raw payloads').toBe(false);
    }

    // Admin reads expose only allowlisted DTO keys.
    const ordersAdmin = await page.evaluate(async (endpoint) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get(endpoint, { _skipAuthRefresh: true });
      return { status: response.status, body: response.data };
    }, '/digiflazz-seller/orders/admin');
    expect(ordersAdmin.status).toBe(200);
    for (const item of ordersAdmin.body?.items ?? []) {
      expect(item.rawRequest).toBeUndefined();
      expect(JSON.stringify(item)).not.toContain(scrubSecrets.digiflazzSign);
    }

    const irsAdminOrders = await page.evaluate(async (endpoint) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get(endpoint, { _skipAuthRefresh: true });
      return { status: response.status, body: response.data };
    }, '/irs-seller/orders/admin');
    expect(irsAdminOrders.status).toBe(200);
    const irsAllowedKeys = ['id', 'refId', 'internalRefId', 'irsCode', 'target', 'status', 'statusCode', 'message', 'sn', 'vendorTrxId', 'requestIp', 'createdAt', 'updatedAt'];
    for (const item of irsAdminOrders.body?.items ?? []) {
      expect(Object.keys(item).sort()).toEqual(irsAllowedKeys.sort());
      expect(JSON.stringify(item)).not.toContain(scrubSecrets.irsPass);
    }

    const irsLogs = await page.evaluate(async (endpoint) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get(endpoint, { _skipAuthRefresh: true });
      return { status: response.status, body: response.data };
    }, '/irs-seller/logs');
    expect(irsLogs.status).toBe(200);
    const irsLogAllowedKeys = ['id', 'timestamp', 'event', 'refId', 'status', 'message', 'verified', 'requestIp'];
    for (const item of irsLogs.body ?? []) {
      expect(Object.keys(item).sort()).toEqual(irsLogAllowedKeys.sort());
    }

    // 4. Historical hygiene: dry-run reports, apply scrubs, indexes stay ready.
    const dry = runScrubber(['--mongo-uri', shared.MONGO_URI!, '--database', shared.MONGO_DB!], shared);
    expect(dry.status).toBe(0);
    const dryReport = JSON.parse(dry.stdout.trim());
    expect(dryReport.applied).toBe(false);
    expect(dryReport.modifiedDocuments).toBe(0);
    expect(dryReport.collections.digiflazzsellerorders.affected).toBeGreaterThan(0);
    expect(dryReport.collections.irssellerorders.affected).toBeGreaterThan(0);
    expect(dryReport.collections.webhookeventlogs.affected).toBeGreaterThan(0);
    for (const artifact of [dry.stdout, dry.stderr]) {
      for (const secret of [...Object.values(scrubSecrets), ...Object.values(legacyRawSecrets)]) {
        expect(artifact).not.toContain(secret);
      }
    }

    const apply = runScrubber(
      ['--mongo-uri', shared.MONGO_URI!, '--database', shared.MONGO_DB!, '--apply'],
      shared,
    );
    expect(apply.status).toBe(0);
    const applyReport = JSON.parse(apply.stdout.trim());
    expect(applyReport.applied).toBe(true);
    expect(applyReport.modifiedDocuments).toBeGreaterThan(0);
    expect(applyReport.blocking).toBe(false);

    const recheck = await db.collection('digiflazzsellerorders').findOne({ refId: `task14-history-dg-${fixtureRunId}` });
    expect(recheck).toBeTruthy();
    expect('rawRequest' in recheck!).toBe(false);
    const irsRecheck = await db.collection('irssellerorders').findOne({ refId: `task14-history-irs-${fixtureRunId}` });
    expect('rawRequest' in irsRecheck!).toBe(false);
    const logRecheck = await db.collection('webhookeventlogs').findOne({ provider: 'digiflazz_seller', refId: `task14-history-log-${fixtureRunId}` });
    expect('raw' in logRecheck!).toBe(false);

    const redry = runScrubber(['--mongo-uri', shared.MONGO_URI!, '--database', shared.MONGO_DB!], shared);
    expect(redry.status).toBe(0);
    const redryReport = JSON.parse(redry.stdout.trim());
    expect(redryReport.collections.digiflazzsellerorders.affected).toBe(0);
    expect(redryReport.collections.irssellerorders.affected).toBe(0);
    expect(redryReport.collections.webhookeventlogs.affected).toBe(0);
    expect(redryReport.blocking).toBe(false);

    // 5. Exact seller order indexes verified by the disposable readiness binary.
    const readiness = runReadiness(['--json'], shared);
    expect(readiness.status).toBe(0);
    const readinessReport = JSON.parse(readiness.stdout.trim());
    expect(readinessReport.database).toBe(shared.MONGO_DB);
    for (const collection of readinessReport.collections) {
      expect(collection.state).toBe('Ready');
      expect(collection.duplicateRefIds).toBe(0);
    }

    // 6. Concurrent IRS fulfillment executes exactly once per refId.
    scenarioRefId = `task14-concurrent-${fixtureRunId}`;
    const validIrsPayload = {
      merchant_id: 'task14-irs-merchant-renamed',
      password: scrubSecrets.irsPass,
      pin: scrubSecrets.irsPin,
      secret: scrubSecrets.irsSecret,
      ref_id: scenarioRefId,
      produk: `task14-${fixtureRunId}`.toLowerCase(),
      tujuan: '081200000001',
    };
    const concurrent = await Promise.all([
      jsonRequest(`${nodeBase}/api/v2/irs-seller/prepaid`, {
        method: 'POST',
        headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(validIrsPayload),
      }),
      jsonRequest(`${nodeBase}/api/v2/irs-seller/prepaid`, {
        method: 'POST',
        headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(validIrsPayload),
      }),
    ]);
    for (const response of concurrent) {
      expect(response.status, 'concurrent IRS prepaid').toBe(200);
      expect(Object.keys(response.body?.data ?? {}).sort()).toEqual(
        ['msg', 'produk', 'ref_id', 'sn', 'statuscode', 'tujuan'].sort(),
      );
      expect(response.body?.data?.ref_id).toBe(scenarioRefId);
      expect(response.body?.data?.produk).toBe(validIrsPayload.produk);
      expect(response.body?.data?.tujuan).toBe(validIrsPayload.tujuan);
    }

    // Wait for the single claimed execution to settle before judging state.
    const deadline = Date.now() + 30_000;
    let executed: any = null;
    while (Date.now() < deadline) {
      executed = await db.collection('irssellerorders').findOne({ refId: scenarioRefId });
      if (executed && executed.executionState === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const executedOrders = await db.collection('irssellerorders').find({ refId: scenarioRefId }).toArray();
    expect(executedOrders.length).toBe(1);
    executed = executedOrders[0]!;
    expect(executed.executionState).toBe('completed');
    expect(executed.executionStartedAt).toBeTruthy();
    expect(executed.internalRefId).toBeTruthy();
    expect(executed.vendorTrxId).toBeTruthy();
    // The persisted state is authoritative: every duplicate may replay the final
    // envelope, and duplicates never trigger a second supplier execution.
    expect(executed.statusCode).toBeTruthy();
    expect('rawRequest' in executed).toBe(false);

    const irsRequestEvents = await db.collection('webhookeventlogs').find({
      provider: 'irs_seller',
      refId: scenarioRefId,
    }).toArray();
    expect(irsRequestEvents.length).toBe(1);
    expect(irsRequestEvents[0]!.verified).toBe(true);
    expect('raw' in irsRequestEvents[0]!).toBe(false);

    // 7. Storage failures become a generic channel-compatible failure envelope
    // with zero provider execution: a read view makes inserts fail while reads
    // still answer, exactly like a degraded but reachable collection.
    const brokenRefId = `task14-broken-store-${fixtureRunId}`;
    const ordersCollection = 'irssellerorders';
    await db.collection(ordersCollection).rename('irssellerorders_backup');
    let restored = false;
    try {
      await db.command({ create: ordersCollection, viewOn: 'irssellerorders_backup', pipeline: [] });
      const broken = await jsonRequest(`${nodeBase}/api/v2/irs-seller/prepaid`, {
        method: 'POST',
        headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validIrsPayload, ref_id: brokenRefId }),
      });
      expect(broken.status).toBe(200);
      expect(broken.body?.data?.statuscode).toBe('2');
      expect(broken.body?.data?.msg).toBe('Layanan IRS Seller tidak tersedia');
    } finally {
      await db.collection(ordersCollection).drop().catch(() => undefined);
      await db.collection('irssellerorders_backup').rename(ordersCollection, { dropTarget: true });
      restored = true;
    }
    expect(restored).toBe(true);
    const ghostOrders = await db.collection(ordersCollection).countDocuments({ refId: brokenRefId });
    expect(ghostOrders).toBe(0);
  } catch (error) {
    primary = error;
  } finally {
    if (safeToCleanup && fixtureRunId) {
      try {
        const db = mongo.db(shared.MONGO_DB);
        await db.collection('settings').deleteMany({ key: { $in: ['digiflazzSellerConfig', 'irsSellerConfig'] }, 'value.task14Fixture': true });
        await db.collection('products').deleteMany({ task14Fixture: true, fixtureRunId });
        await db.collection('digiflazzsellerproductmaps').deleteMany({ task14Fixture: true, fixtureRunId });
        await db.collection('digiflazzsellerorders').deleteMany({ task14Fixture: true, fixtureRunId });
        await db.collection('irssellerorders').deleteMany({ task14Fixture: true, fixtureRunId });
        await db.collection('webhookeventlogs').deleteMany({ task14Fixture: true, fixtureRunId });
        await db.collection('digiflazzsellerorders').deleteMany({ refId: { $regex: `^task14-prepaid` } });
        await db.collection('irssellerorders').deleteMany({ refId: { $in: [scenarioRefId, `task14-broken-store-${fixtureRunId}`, `task14-prepaid-irs-bad-${fixtureRunId}`] } });
        await db.collection('webhookeventlogs').deleteMany({ refId: { $regex: `^task14-` } });
        if (fixtureUserIds.length > 0) {
          await db.collection('authsessions').deleteMany({ userId: { $in: fixtureUserIds } });
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await mongo.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primary && cleanupErrors.length > 0) {
    throw new AggregateError([primary, ...cleanupErrors], 'seller center integration and cleanup failed');
  }
  if (primary) throw primary;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'seller center integration cleanup failed');
});
