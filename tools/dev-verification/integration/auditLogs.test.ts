import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { fixtureOtp, loginFixture, type FixtureLogin } from '../e2e/fixtures.ts';

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

async function loginAtGateway(base: string, fixture: FixtureLogin, origin: string): Promise<string> {
  expect(fixture.audience).toBe('staff');
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
      deviceName: 'Task audit authorization',
    }),
  });
  expect(response.status, `login ${fixture.email}`).toBe(200);
  const accessToken = response.body?.accessToken;
  expect(typeof accessToken).toBe('string');
  return accessToken as string;
}

function bearerHeaders(accessToken: string, origin: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
    ...extra,
  };
}

test.describe.configure({ timeout: 180_000 });

test('audit authorization redaction filters export and scrubber boundaries', async ({ page }) => {
  const shared = await readEnv(path.join(stateDir, 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');
  expect(shared.MONGO_URI).toMatch(/replicaSet=rs0/);

  const marker = `audit-int-${Date.now()}`;
  const secretValue = `fixture-secret-${marker}`;
  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const mongo = new MongoClient(shared.MONGO_URI!);
  const fixtureIds: ObjectId[] = [];
  const auditIds: ObjectId[] = [];
  let safeToCleanup = false;
  let primary: unknown = null;
  const cleanupErrors: unknown[] = [];

  const denied = await loginFixture('audit-denied');
  const viewer = await loginFixture('team-access-viewer-desktop');
  const manager = await loginFixture('audit-manager');

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const markerDoc = await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    });
    expect(markerDoc).toBeTruthy();
    safeToCleanup = true;

    for (const fixture of [denied, viewer, manager]) {
      const row = await db.collection('users').findOne(
        { email: fixture.email, task14Fixture: true },
        { projection: { _id: 1 } },
      );
      expect(row).toBeTruthy();
      fixtureIds.push(row!._id);
    }

    const anonymous = await jsonRequest(`${nodeBase}/api/v2/audit-logs`, {
      headers: { Origin: shared.PUBLIC_ORIGIN },
    });
    expect(anonymous.status).toBe(401);

    const deniedToken = await loginAtGateway(nodeBase, denied, shared.PUBLIC_ORIGIN);
    const deniedList = await jsonRequest(`${nodeBase}/api/v2/audit-logs`, {
      headers: bearerHeaders(deniedToken, shared.PUBLIC_ORIGIN),
    });
    expect(deniedList.status).toBe(403);
    expect(deniedList.body?.error?.code || deniedList.body?.code).toBe('PERMISSION_DENIED');

    const viewerToken = await loginAtGateway(nodeBase, viewer, shared.PUBLIC_ORIGIN);
    const viewerList = await jsonRequest(`${nodeBase}/api/v2/audit-logs`, {
      headers: bearerHeaders(viewerToken, shared.PUBLIC_ORIGIN),
    });
    expect(viewerList.status).toBe(200);
    const viewerExport = await jsonRequest(`${nodeBase}/api/v2/audit-logs/export`, {
      headers: bearerHeaders(viewerToken, shared.PUBLIC_ORIGIN),
    });
    expect(viewerExport.status).toBe(403);
    expect(viewerExport.body?.error?.code || viewerExport.body?.code).toBe('PERMISSION_DENIED');

    // Manager step-up requires a live browser session so grant binds to SID.
    // Clear prior sessions and generate OTP immediately before challenge submission.
    const managerUserForLogin = await db.collection('users').findOne(
      { email: manager.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    if (managerUserForLogin?._id) {
      await db.collection('authsessions').deleteMany({ userId: managerUserForLogin._id });
    }
    await page.goto(manager.loginPath);
    await page.getByLabel('Email').fill(manager.email);
    await page.getByLabel('Password').fill(manager.password);
    await page.getByRole('button', { name: 'Masuk sekarang' }).click();
    await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 15_000 });
    const managerOtp = await fixtureOtp('audit-manager');
    await page.getByLabel('Kode OTP').fill(managerOtp);
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });

    const exportWithoutGrant = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        await api.get('/audit-logs/export', { responseType: 'blob', _skipAuthRefresh: true });
        return { status: 200, code: null, group: null, message: null, rawType: null };
      } catch (error: any) {
        let data = error?.response?.data;
        let message: string | null = null;
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          const text = await data.text();
          try { data = JSON.parse(text); } catch { data = { message: text }; }
        }
        if (data && typeof data === 'object') {
          message = typeof data.message === 'string' ? data.message : null;
        }
        return {
          status: error?.response?.status ?? 0,
          code: data?.error?.code ?? data?.code ?? null,
          group: data?.error?.actionGroup ?? data?.actionGroup ?? null,
          message,
          rawType: typeof error?.response?.data,
        };
      }
    });
    expect(exportWithoutGrant.status).toBe(403);
    expect(exportWithoutGrant.code).toBe('AUTH_STEP_UP_REQUIRED');
    expect(exportWithoutGrant.group).toBe('exports.sensitive');

    const freshOtp = await fixtureOtp('audit-manager');
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
    expect((stepUp.grantToken as string).length).toBeGreaterThan(10);

    const exportWithGrant = await page.evaluate(async ({ grantToken }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/audit-logs/export', {
        responseType: 'blob',
        headers: { 'X-Step-Up-Token': grantToken },
        _skipAuthRefresh: true,
      });
      const text = await response.data.text();
      return {
        status: response.status,
        contentType: String(response.headers['content-type'] || ''),
        disposition: String(response.headers['content-disposition'] || ''),
        exportLimit: String(response.headers['x-export-limit'] || ''),
        truncated: String(response.headers['x-export-truncated'] || ''),
        text,
      };
    }, { grantToken: stepUp.grantToken });
    expect(exportWithGrant.status).toBe(200);
    expect(exportWithGrant.contentType).toContain('text/csv');
    expect(exportWithGrant.disposition).toMatch(/admin-audit-logs-/);
    expect(exportWithGrant.exportLimit).toBe('5000');
    expect(['true', 'false']).toContain(exportWithGrant.truncated);
    expect(exportWithGrant.text.includes('Tanggal')).toBe(true);

    const categoriesBefore = await db.collection('categories').countDocuments({});
    const mutation = await page.evaluate(async ({ marker, secretValue }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        const response = await api.post('/categories/admin/create', {
          verificationMarker: marker,
          pin: secretValue,
          merchant_pin: secretValue,
          shipping: 'visible',
        }, { _skipAuthRefresh: true });
        return { status: response.status, body: response.data };
      } catch (error: any) {
        return {
          status: error?.response?.status ?? 0,
          body: error?.response?.data ?? null,
        };
      }
    }, { marker, secretValue });
    expect(mutation.status).toBe(400);
    expect(await db.collection('categories').countDocuments({})).toBe(categoriesBefore);

    const managerUser = await db.collection('users').findOne(
      { email: manager.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    expect(managerUser).toBeTruthy();
    const createdFloor = new Date(Date.now() - 5 * 60 * 1000);
    let gatewayRow: any = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      gatewayRow = await db.collection('adminauditlogs').findOne({
        actor: managerUser!._id,
        path: '/api/v2/categories/admin/create',
        statusCode: 400,
        createdAt: { $gte: createdFloor },
        'metadata.body.verificationMarker': marker,
      });
      if (gatewayRow) break;
      await page.waitForTimeout(200);
    }
    expect(gatewayRow).toBeTruthy();
    auditIds.push(gatewayRow._id);
    expect(gatewayRow.metadata?.body?.pin).toBe('[redacted]');
    expect(gatewayRow.metadata?.body?.merchant_pin).toBe('[redacted]');
    expect(gatewayRow.metadata?.body?.shipping).toBe('visible');
    expect(JSON.stringify(gatewayRow).includes(secretValue)).toBe(false);

    const historical = await db.collection('adminauditlogs').insertMany([
      {
        actor: managerUser!._id,
        actorName: 'Audit Historical Gateway',
        actorEmail: manager.email,
        actorRole: 'admin',
        action: 'update',
        resource: 'Products',
        method: 'PUT',
        path: `/api/v2/products/admin/update/${marker}`,
        statusCode: 200,
        ip: '203.0.113.10',
        userAgent: 'task14-historical',
        summary: `PUT historical gateway ${marker}`,
        metadata: {
          auditSource: 'node_gateway',
          traceId: `trace-${marker}`,
          correlationSource: 'gateway_header',
          pin: secretValue,
          shipping: 'visible',
          verificationMarker: marker,
        },
        createdAt: new Date('2026-08-11T17:00:00.000Z'),
        updatedAt: new Date('2026-08-11T17:00:00.000Z'),
        task14Fixture: true,
      },
      {
        actor: managerUser!._id,
        actorName: 'Audit Historical Domain',
        actorEmail: manager.email,
        actorRole: 'admin',
        action: 'update',
        resource: 'Products',
        method: 'PUT',
        path: `/api/v2/products/admin/update/${marker}`,
        statusCode: 200,
        ip: '203.0.113.10',
        userAgent: 'task14-historical',
        summary: `PUT historical domain ${marker}`,
        metadata: {
          auditSource: 'rust_domain',
          traceId: `trace-${marker}`,
          correlationSource: 'gateway_header',
          pin: secretValue,
          shipping: 'visible',
          verificationMarker: marker,
        },
        createdAt: new Date('2026-08-11T17:00:01.000Z'),
        updatedAt: new Date('2026-08-11T17:00:01.000Z'),
        task14Fixture: true,
      },
      {
        actor: managerUser!._id,
        actorName: 'Audit Formula',
        actorEmail: manager.email,
        actorRole: 'admin',
        action: 'create',
        resource: 'Teams',
        method: 'POST',
        path: `/api/v2/teams/admin/create/${marker}`,
        statusCode: 201,
        ip: '203.0.113.11',
        userAgent: 'task14-formula',
        summary: '\t=1+1',
        metadata: {
          auditSource: 'node_gateway',
          traceId: `formula-${marker}`,
          pin: secretValue,
          verificationMarker: marker,
        },
        createdAt: new Date('2026-08-12T10:00:00.000Z'),
        updatedAt: new Date('2026-08-12T10:00:00.000Z'),
        task14Fixture: true,
      },
    ]);
    auditIds.push(...Object.values(historical.insertedIds));

    const filtered = await page.evaluate(async ({ marker }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/audit-logs', {
        params: {
          search: `trace-${marker}`,
          action: 'update',
          resource: 'Products',
        },
        _skipAuthRefresh: true,
      });
      return { status: response.status, items: response.data?.items ?? [] };
    }, { marker });
    expect(filtered.status).toBe(200);
    expect(filtered.items.length).toBeGreaterThanOrEqual(2);
    for (const item of filtered.items) {
      if (item?.metadata?.pin !== undefined) {
        expect(item.metadata.pin).toBe('[redacted]');
      }
      expect(JSON.stringify(item).includes(secretValue)).toBe(false);
    }
    const sources = new Set(filtered.items.map((item: any) => item?.metadata?.auditSource).filter(Boolean));
    expect(sources.has('node_gateway')).toBe(true);
    expect(sources.has('rust_domain')).toBe(true);

    const invalidAction = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        await api.get('/audit-logs', { params: { action: 'deleted' }, _skipAuthRefresh: true });
        return { status: 200 };
      } catch (error: any) {
        return { status: error?.response?.status ?? 0 };
      }
    });
    expect(invalidAction.status).toBe(400);

    const exportFiltered = await page.evaluate(async ({ marker, grantToken }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/audit-logs/export', {
        params: { search: marker },
        responseType: 'blob',
        headers: { 'X-Step-Up-Token': grantToken },
        _skipAuthRefresh: true,
      });
      return {
        status: response.status,
        text: await response.data.text(),
      };
    }, { marker, grantToken: stepUp.grantToken });
    expect(exportFiltered.status).toBe(200);
    expect(exportFiltered.text.includes('Tanggal')).toBe(true);
    expect(exportFiltered.text.includes('[redacted]')).toBe(true);
    expect(exportFiltered.text.includes(secretValue)).toBe(false);

    const scrubber = path.join(root, 'scripts/security/scrub-admin-audit-secrets.js');
    const runScrubber = (apply: boolean) => spawnSync(process.execPath, [
      scrubber,
      '--mongo-uri', shared.MONGO_URI!,
      '--database', 'webtopup_task14_dev',
      ...(apply ? ['--apply'] : []),
    ], { encoding: 'utf8' });

    const dryRun = runScrubber(false);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout.includes(shared.MONGO_URI!)).toBe(false);
    expect(dryRun.stdout.includes(secretValue)).toBe(false);
    const dryReport = JSON.parse(dryRun.stdout.trim());
    expect(dryReport.applied).toBe(false);
    expect(dryReport.affectedDocuments).toBeGreaterThan(0);
    expect(dryReport.modifiedDocuments).toBe(0);

    const applyOnce = runScrubber(true);
    expect(applyOnce.status).toBe(0);
    expect(applyOnce.stdout.includes(secretValue)).toBe(false);
    const applyReport = JSON.parse(applyOnce.stdout.trim());
    expect(applyReport.applied).toBe(true);
    expect(applyReport.modifiedDocuments).toBeGreaterThan(0);

    const applyTwice = runScrubber(true);
    expect(applyTwice.status).toBe(0);
    const applyTwiceReport = JSON.parse(applyTwice.stdout.trim());
    expect(applyTwiceReport.affectedDocuments).toBe(0);
    expect(applyTwiceReport.modifiedDocuments).toBe(0);

    const scrubbed = await db.collection('adminauditlogs').findOne({ _id: historical.insertedIds[0] });
    expect(scrubbed?.metadata?.pin).toBe('[redacted]');
    expect(JSON.stringify(scrubbed).includes(secretValue)).toBe(false);
  } catch (error) {
    primary = error;
  } finally {
    if (safeToCleanup) {
      try {
        const db = mongo.db(shared.MONGO_DB);
        if (auditIds.length > 0) {
          await db.collection('adminauditlogs').deleteMany({ _id: { $in: auditIds } });
        }
        await db.collection('adminauditlogs').deleteMany({ 'metadata.verificationMarker': marker });
        if (fixtureIds.length > 0) {
          await db.collection('authsessions').deleteMany({ userId: { $in: fixtureIds } });
        }
        await db.collection('categories').deleteMany({ verificationMarker: marker });
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
    throw new AggregateError([primary, ...cleanupErrors], 'audit integration and cleanup failed');
  }
  if (primary) throw primary;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'audit integration cleanup failed');
});
