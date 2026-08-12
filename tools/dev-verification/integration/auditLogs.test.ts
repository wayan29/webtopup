import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { fixtureOtp, loginFixture, type FixtureLogin } from '../e2e/fixtures.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;

const envFile = async (file: string): Promise<Env> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

async function staffLogin(page: Page, fixture: FixtureLogin, otp?: string) {
  await page.goto(fixture.loginPath);
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  if (otp) {
    await expect(page.getByText('Verifikasi 2FA')).toBeVisible();
    await page.getByLabel('Kode OTP').fill(otp);
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
  }
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
}

async function apiCall(page: Page, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return page.evaluate(async ({ method, url, body, headers }) => {
    const api = (await import('/src/api/index.ts')).apiV2 as any;
    try {
      const response = await api.request({
        method,
        url,
        data: body,
        headers,
        validateStatus: () => true,
        responseType: url.includes('/export') ? 'blob' : 'json',
      });
      let data = response.data;
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data = {
          __blob: true,
          text: await data.text(),
          type: data.type,
        };
      }
      return {
        status: response.status,
        data,
        headers: response.headers,
      };
    } catch (error: any) {
      return {
        status: error?.response?.status ?? 0,
        data: error?.response?.data ?? { message: String(error) },
        headers: error?.response?.headers ?? {},
      };
    }
  }, { method, url, body, headers });
}

test.describe.configure({ timeout: 180_000 });

test('audit authorization redaction filters export and scrubber boundaries', async ({ page, browser }) => {
  const shared = await envFile(path.join(stateDir, 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');
  expect(shared.MONGO_URI).toMatch(/replicaSet=rs0/);

  const marker = `audit-int-${Date.now()}`;
  const secretValue = `fixture-secret-${marker}`;
  const mongo = new MongoClient(shared.MONGO_URI!);
  const fixtureIds: ObjectId[] = [];
  const auditIds: ObjectId[] = [];
  let safeToCleanup = false;
  let primary: unknown = null;
  const cleanupErrors: unknown[] = [];

  const denied = await loginFixture('audit-denied');
  const viewer = await loginFixture('team-access-viewer-desktop');
  const manager = await loginFixture('audit-manager');
  const managerOtp = await fixtureOtp('audit-manager');

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
        { projection: { _id: 1, role: 1 } },
      );
      expect(row).toBeTruthy();
      fixtureIds.push(row!._id);
    }

    const anonymous = await page.request.get(`${shared.PUBLIC_ORIGIN}/api/v2/audit-logs`);
    expect(anonymous.status()).toBe(401);

    const deniedContext = await browser.newContext();
    const deniedPage = await deniedContext.newPage();
    await staffLogin(deniedPage, denied);
    const deniedList = await apiCall(deniedPage, 'GET', '/audit-logs');
    expect(deniedList.status).toBe(403);
    expect(deniedList.data?.error?.code || deniedList.data?.code).toBe('PERMISSION_DENIED');
    await deniedContext.close();

    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await staffLogin(viewerPage, viewer);
    const viewerList = await apiCall(viewerPage, 'GET', '/audit-logs');
    expect(viewerList.status).toBe(200);
    const viewerExport = await apiCall(viewerPage, 'GET', '/audit-logs/export');
    expect(viewerExport.status).toBe(403);
    expect(viewerExport.data?.error?.code || viewerExport.data?.code).toBe('PERMISSION_DENIED');
    await viewerContext.close();

    await staffLogin(page, manager, managerOtp);

    const exportWithoutGrant = await apiCall(page, 'GET', '/audit-logs/export');
    expect(exportWithoutGrant.status).toBe(403);
    expect(exportWithoutGrant.data?.error?.code || exportWithoutGrant.data?.code).toBe('AUTH_STEP_UP_REQUIRED');
    expect(exportWithoutGrant.data?.error?.actionGroup || exportWithoutGrant.data?.actionGroup).toBe('exports.sensitive');

    const stepUp = await apiCall(page, 'POST', '/auth/step-up', {
      password: manager.password,
      otp: managerOtp,
      actionGroup: 'exports.sensitive',
    });
    expect(stepUp.status).toBe(200);
    const grantToken = stepUp.data?.grantToken as string;
    expect(typeof grantToken).toBe('string');
    expect(grantToken.length).toBeGreaterThan(10);

    const exportWithGrant = await apiCall(page, 'GET', '/audit-logs/export', undefined, {
      'x-step-up-token': grantToken,
    });
    expect(exportWithGrant.status).toBe(200);
    expect(String(exportWithGrant.headers['content-type'] || '')).toContain('text/csv');
    expect(String(exportWithGrant.headers['content-disposition'] || '')).toMatch(/admin-audit-logs-/);
    expect(String(exportWithGrant.headers['x-export-limit'] || '')).toBe('5000');
    expect(['true', 'false']).toContain(String(exportWithGrant.headers['x-export-truncated'] || ''));
    const exportText = exportWithGrant.data?.text || '';
    expect(exportText.startsWith('\uFEFF') || exportText.includes('Tanggal')).toBeTruthy();
    expect(exportText).toContain('Tanggal');
    expect(exportText).toContain('Metadata');

    const categoriesBefore = await db.collection('categories').countDocuments({});
    const mutation = await apiCall(page, 'POST', '/categories/admin/create', {
      verificationMarker: marker,
      pin: secretValue,
      merchant_pin: secretValue,
      shipping: 'visible',
    });
    expect(mutation.status).toBe(400);
    const categoriesAfter = await db.collection('categories').countDocuments({});
    expect(categoriesAfter).toBe(categoriesBefore);

    const managerUser = await db.collection('users').findOne({ email: manager.email, task14Fixture: true }, { projection: { _id: 1 } });
    expect(managerUser).toBeTruthy();
    const createdFloor = new Date(Date.now() - 5 * 60 * 1000);
    let gatewayRow: any = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      gatewayRow = await db.collection('adminauditlogs').findOne({
        actor: managerUser!._id,
        path: '/api/v2/categories/admin/create',
        statusCode: 400,
        createdAt: { $gte: createdFloor },
        'metadata.body.verificationMarker': marker,
      });
      if (gatewayRow) break;
      await page.waitForTimeout(250);
    }
    expect(gatewayRow).toBeTruthy();
    auditIds.push(gatewayRow._id);
    expect(gatewayRow.metadata?.body?.pin).toBe('[redacted]');
    expect(gatewayRow.metadata?.body?.merchant_pin).toBe('[redacted]');
    expect(gatewayRow.metadata?.body?.shipping).toBe('visible');
    expect(JSON.stringify(gatewayRow)).not.toContain(secretValue);

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

    const filtered = await apiCall(page, 'GET', `/audit-logs?search=${encodeURIComponent(`trace-${marker}`)}&action=update&resource=Products`);
    expect(filtered.status).toBe(200);
    expect(Array.isArray(filtered.data?.items)).toBe(true);
    expect(filtered.data.items.length).toBeGreaterThanOrEqual(2);
    for (const item of filtered.data.items) {
      if (item?.metadata?.pin !== undefined) {
        expect(item.metadata.pin).toBe('[redacted]');
      }
      expect(JSON.stringify(item)).not.toContain(secretValue);
    }
    const sources = new Set(filtered.data.items.map((item: any) => item?.metadata?.auditSource).filter(Boolean));
    expect(sources.has('node_gateway')).toBe(true);
    expect(sources.has('rust_domain')).toBe(true);

    const invalidAction = await apiCall(page, 'GET', '/audit-logs?action=deleted');
    expect(invalidAction.status).toBe(400);

    const exportFiltered = await apiCall(page, 'GET', `/audit-logs/export?search=${encodeURIComponent(marker)}`, undefined, {
      'x-step-up-token': grantToken,
    });
    expect(exportFiltered.status).toBe(200);
    const csv = exportFiltered.data?.text || '';
    expect(csv).toContain('Tanggal');
    expect(csv).toContain('[redacted]');
    expect(csv).not.toContain(secretValue);
    expect(csv.includes("'\\t=1+1") || csv.includes("'\t=1+1") || csv.includes('"=1+1') === false).toBeTruthy();

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
    expect(JSON.stringify(scrubbed)).not.toContain(secretValue);
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
