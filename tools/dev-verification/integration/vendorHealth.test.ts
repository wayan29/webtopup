import { expect, test } from '@playwright/test';
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
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: fixture.email,
      password: fixture.password,
      rememberMe: false,
      deviceName: 'Task vendor health authorization',
    }),
  });
  expect(response.status, `login ${fixture.email}`).toBe(200);
  const accessToken = response.body?.accessToken;
  expect(typeof accessToken).toBe('string');
  return accessToken as string;
}

function bearerHeaders(accessToken: string, origin: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

test.describe.configure({ timeout: 180_000 });

test('vendor health permission, honesty, persistence, and export step-up', async ({ page }) => {
  const shared = await readEnv(path.join(stateDir, 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');
  expect(shared.MONGO_URI).toMatch(/replicaSet=rs0/);

  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const mongo = new MongoClient(shared.MONGO_URI!);
  const fixtureUserIds: ObjectId[] = [];
  const vendorIds: ObjectId[] = [];
  let safeToCleanup = false;
  let primary: unknown = null;
  const cleanupErrors: unknown[] = [];

  const denied = await loginFixture('vendor-health-denied');
  const manager = await loginFixture('vendor-health-manager');

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
    const fixtureRunId = String(managerRow!.fixtureRunId);

    const deniedRow = await db.collection('users').findOne(
      { email: denied.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    expect(deniedRow).toBeTruthy();
    fixtureUserIds.push(deniedRow!._id);

    // Loopback port 1 is intentionally unreachable: probes fail locally and
    // can never contact an external provider from a verification run.
    const insertedVendors = await db.collection('vendors').insertMany([
      {
        name: 'Digiflazz', slug: 'digiflazz', status: true,
        apiBaseUrl: 'http://127.0.0.1:1',
        config: { username: `task14-${fixtureRunId}`, apiKey: 'synthetic-unreachable' },
        lowBalanceThreshold: 100_000, task14Fixture: true, fixtureRunId,
        createdAt: new Date(), updatedAt: new Date(), __v: 0,
      },
      {
        name: 'Tokovoucher', slug: 'tokovoucher', status: false,
        apiBaseUrl: 'http://127.0.0.1:1',
        config: { memberCode: `task14-${fixtureRunId}`, secret: 'synthetic-unreachable' },
        lowBalanceThreshold: 100_000, task14Fixture: true, fixtureRunId,
        createdAt: new Date(), updatedAt: new Date(), __v: 0,
      },
    ]);
    vendorIds.push(...Object.values(insertedVendors.insertedIds));

    const anonymous = await jsonRequest(`${nodeBase}/api/v2/vendors/health`, {
      headers: { Origin: shared.PUBLIC_ORIGIN },
    });
    expect(anonymous.status).toBe(401);

    const deniedToken = await loginAtGateway(nodeBase, denied, shared.PUBLIC_ORIGIN);
    for (const endpoint of ['/vendors/health', '/vendors/health-snapshot', '/vendors/health/export']) {
      const response = await jsonRequest(`${nodeBase}/api/v2${endpoint}`, {
        headers: bearerHeaders(deniedToken, shared.PUBLIC_ORIGIN),
      });
      expect(response.status, endpoint).toBe(403);
      expect(response.body?.error?.code || response.body?.code).toBe('PERMISSION_DENIED');
    }

    // Manager step-up requires a live browser session so grants bind to SID.
    await db.collection('authsessions').deleteMany({ userId: managerRow!._id });
    await page.goto(manager.loginPath);
    await page.getByLabel('Email').fill(manager.email);
    await page.getByLabel('Password').fill(manager.password);
    await page.getByRole('button', { name: 'Masuk sekarang' }).click();
    await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 15_000 });
    const managerOtp = await fixtureOtp('vendor-health-manager');
    await page.getByLabel('Kode OTP').fill(managerOtp);
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });

    const realtime = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        const response = await api.get('/vendors/health', { _skipAuthRefresh: true });
        return { status: response.status, body: response.data };
      } catch (error: any) {
        return { status: error?.response?.status ?? 0, body: error?.response?.data ?? null };
      }
    });
    expect(realtime.status).toBe(200);
    expect(typeof realtime.body?.ok).toBe('boolean');
    expect(typeof realtime.body?.partial).toBe('boolean');
    expect(Array.isArray(realtime.body?.issues)).toBe(true);
    expect(typeof realtime.body?.snapshotPersisted).toBe('boolean');
    expect(Array.isArray(realtime.body?.vendors)).toBe(true);
    expect(realtime.body?.seller && typeof realtime.body.seller).toBe('object');

    const digiflazz = realtime.body.vendors.find((vendor: any) => vendor.key === 'digiflazz');
    const tokovoucher = realtime.body.vendors.find((vendor: any) => vendor.key === 'tokovoucher');
    expect(digiflazz).toBeTruthy();
    expect(digiflazz.active).toBe(true);
    expect(digiflazz.configured).toBe(true);
    expect(digiflazz.balanceOk).toBe(false);
    expect(digiflazz.balance).toBe(null);
    expect(digiflazz.health).toBe('critical');
    expect(realtime.body.partial).toBe(true);
    expect(
      realtime.body.issues.map((issue: any) => issue.code),
    ).toContain('DIGIFLAZZ_BALANCE_UNAVAILABLE');
    expect(tokovoucher).toBeTruthy();
    expect(tokovoucher.active).toBe(false);
    expect(tokovoucher.health).toBe('disabled');
    expect(JSON.stringify(realtime.body)).not.toContain('synthetic-unreachable');
    expect(JSON.stringify(realtime.body)).not.toContain('apiKey');

    const diagnostics = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        const response = await api.get('/vendors/health-snapshot', { _skipAuthRefresh: true });
        return { status: response.status, body: response.data };
      } catch (error: any) {
        return { status: error?.response?.status ?? 0, body: error?.response?.data ?? null };
      }
    });
    expect(diagnostics.status).toBe(200);
    expect(typeof diagnostics.body?.ok).toBe('boolean');
    expect(typeof diagnostics.body?.partial).toBe('boolean');
    expect(Array.isArray(diagnostics.body?.vendors)).toBe(true);
    expect(typeof diagnostics.body?.generated_at).toBe('string');

    const persisted = await db.collection('settings').findOne({ key: 'vendorHealthSnapshot' });
    expect(persisted).toBeTruthy();
    const persistedVendors: any[] = persisted!.value?.vendors ?? [];
    const persistedDigiflazz = persistedVendors.find((vendor: any) => vendor.key === 'digiflazz');
    expect(persistedDigiflazz).toBeTruthy();
    for (const field of ['key', 'label', 'balanceOk', 'lowBalance', 'balanceMessage', 'balance', 'lowBalanceThreshold']) {
      expect(field in persistedDigiflazz, `persisted vendor field ${field}`).toBe(true);
    }
    expect(JSON.stringify(persisted)).not.toContain('synthetic-unreachable');
    expect(JSON.stringify(persisted)).not.toContain('apiKey');

    const exportWithoutGrant = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        await api.get('/vendors/health/export', { responseType: 'blob', _skipAuthRefresh: true });
        return { status: 200, code: null, group: null };
      } catch (error: any) {
        let data = error?.response?.data;
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          const text = await data.text();
          try { data = JSON.parse(text); } catch { data = { message: text }; }
        }
        return {
          status: error?.response?.status ?? 0,
          code: data?.error?.code ?? data?.code ?? null,
          group: data?.error?.actionGroup ?? data?.actionGroup ?? null,
        };
      }
    });
    expect(exportWithoutGrant.status).toBe(403);
    expect(exportWithoutGrant.code).toBe('AUTH_STEP_UP_REQUIRED');
    expect(exportWithoutGrant.group).toBe('exports.sensitive');

    const freshOtp = await fixtureOtp('vendor-health-manager');
    const stepUp = await page.evaluate(async ({ password, otp }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.post('/auth/step-up', {
        password,
        otp,
        actionGroup: 'exports.sensitive',
      }, { _skipAuthRefresh: true });
      return {
        status: response.status,
        grantToken: response.data?.grantToken ?? null,
        group: response.data?.actionGroup ?? null,
      };
    }, { password: manager.password, otp: freshOtp });
    expect(stepUp.status).toBe(200);
    expect(typeof stepUp.grantToken).toBe('string');

    const exportWithGrant = await page.evaluate(async ({ grantToken }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/vendors/health/export', {
        responseType: 'blob',
        headers: { 'X-Step-Up-Token': grantToken },
        _skipAuthRefresh: true,
      });
      const bytes = new Uint8Array(await response.data.arrayBuffer());
      const text = await response.data.text();
      return {
        status: response.status,
        contentType: String(response.headers['content-type'] || ''),
        disposition: String(response.headers['content-disposition'] || ''),
        bom: Array.from(bytes.slice(0, 3)),
        text,
      };
    }, { grantToken: stepUp.grantToken });
    expect(exportWithGrant.status).toBe(200);
    expect(exportWithGrant.contentType).toContain('text/csv');
    expect(exportWithGrant.disposition).toMatch(/vendor-health-/);
    expect(exportWithGrant.bom).toEqual([0xef, 0xbb, 0xbf]);
    const header = exportWithGrant.text.trimStart().split(/\r?\n/u)[0]!;
    expect(header).toContain('Partial');
    expect(header).toContain('Snapshot Persisted');
    expect(header).toContain('Issue Codes');
    expect(exportWithGrant.text).toContain('DIGIFLAZZ_BALANCE_UNAVAILABLE');
    expect(exportWithGrant.text).not.toContain('synthetic-unreachable');
    expect(exportWithGrant.text).not.toContain('apiKey');
  } catch (error) {
    primary = error;
  } finally {
    if (safeToCleanup) {
      try {
        const db = mongo.db(shared.MONGO_DB);
        if (vendorIds.length > 0) {
          await db.collection('vendors').deleteMany({ _id: { $in: vendorIds } });
        }
        await db.collection('vendors').deleteMany({ task14Fixture: true, fixtureRunId: String((await db.collection('users').findOne({ email: manager.email, task14Fixture: true }, { projection: { fixtureRunId: 1 } }))?.fixtureRunId ?? '') });
        await db.collection('settings').deleteMany({ key: 'vendorHealthSnapshot' });
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
    throw new AggregateError([primary, ...cleanupErrors], 'vendor health integration and cleanup failed');
  }
  if (primary) throw primary;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'vendor health integration cleanup failed');
});
