import { expect, test, type Page } from '@playwright/test';
import { MongoClient, ObjectId } from 'mongodb';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureOtp, loginFixture, type FixtureLogin } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');

const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

async function staffLogin(page: Page, fixture: FixtureLogin, otp?: string) {
  await page.goto(fixture.loginPath);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  if (otp !== undefined) {
    await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Kode OTP').fill(otp);
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
  }
  await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });
}

test.describe.configure({ timeout: 120_000 });

test('audit detail dialog is keyboard-accessible on desktop and mobile', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const viewerAlias = mobile ? 'team-access-viewer-mobile' : 'team-access-viewer-desktop';
  const fixture = await loginFixture(viewerAlias);
  const shared = await envFile(path.join(root, '.dev-verification', 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');

  const mongo = new MongoClient(shared.MONGO_URI!);
  const marker = `audit-dialog-${testInfo.project.name}-${Date.now()}`;
  let auditId: ObjectId | null = null;
  let userId: ObjectId | null = null;
  let primary: unknown = null;

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const markerDoc = await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    });
    expect(markerDoc).toBeTruthy();

    const user = await db.collection('users').findOne(
      { email: fixture.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    expect(user).toBeTruthy();
    userId = user!._id;

    const insert = await db.collection('adminauditlogs').insertOne({
      actor: userId,
      actorName: 'Task 14 audit dialog',
      actorEmail: fixture.email,
      actorRole: 'cs',
      action: 'update',
      resource: 'Products',
      method: 'PUT',
      path: '/api/v2/products/admin/update',
      statusCode: 200,
      ip: '127.0.0.1',
      userAgent: 'task14-audit-dialog',
      summary: `PUT /api/v2/products/admin/update ${marker}`,
      metadata: {
        auditSource: 'node_gateway',
        traceId: `trace-${marker}`,
        correlationSource: 'gateway_header',
        pin: '[redacted]',
        shipping: 'visible',
        params: { id: 'product-1' },
        body: { name: 'fixture' },
        verificationMarker: marker,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      task14Fixture: true,
    });
    auditId = insert.insertedId;

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await staffLogin(page, fixture);
    await page.goto('/admin/audit-logs');
    await expect(page.getByRole('button', { name: 'Detail' }).first()).toBeVisible({ timeout: 30_000 });

    const detailTrigger = page.getByRole('button', { name: 'Detail' }).first();
    await detailTrigger.click();

    const dialog = page.getByRole('dialog', { name: 'Detail Log Audit' });
    await expect(dialog).toBeVisible();
    await expect.poll(async () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), { timeout: 10_000 }).toBe(true);
    await expect(dialog.getByRole('code').filter({ hasText: '[redacted]' }).first()).toBeVisible();

    await page.keyboard.press('Tab');
    await expect.poll(async () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), { timeout: 10_000 }).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), { timeout: 10_000 }).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => detailTrigger.evaluate((el) => document.activeElement === el), { timeout: 10_000 }).toBe(true);

    await detailTrigger.click();
    await expect(dialog).toBeVisible();
    await page.locator('div.fixed.inset-0').first().click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => detailTrigger.evaluate((el) => document.activeElement === el), { timeout: 10_000 }).toBe(true);

    await detailTrigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Tutup detail audit log' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => detailTrigger.evaluate((el) => document.activeElement === el), { timeout: 10_000 }).toBe(true);

    await detailTrigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Salin' }).first().click();
    await expect(dialog.getByRole('status')).toContainText('berhasil disalin');
    await expect(dialog.getByRole('status')).not.toContainText('/api/v2/products/admin/update');

    if (mobile) {
      await dialog.getByText('Metadata lanjutan').scrollIntoViewIfNeeded();
      await expect(dialog.getByText('Metadata lanjutan')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Tutup detail audit log' })).toBeVisible();
    }
  } catch (error) {
    primary = error;
  } finally {
    try {
      if (auditId) {
        await mongo.db(shared.MONGO_DB).collection('adminauditlogs').deleteMany({
          $or: [
            { _id: auditId },
            { 'metadata.verificationMarker': marker },
          ],
        });
      }
      if (userId) {
        await mongo.db(shared.MONGO_DB).collection('authsessions').deleteMany({ userId });
      }
      await mongo.close();
    } catch (cleanupError) {
      if (primary) throw new AggregateError([primary, cleanupError], 'audit dialog verification and cleanup failed');
      throw cleanupError;
    }
  }

  if (primary) throw primary;
});

test('export is gated by manageTeam step-up for audit manager', async ({ browser }) => {
  const manager = await loginFixture('audit-manager');
  const shared = await envFile(path.join(root, '.dev-verification', 'env', 'shared.env'));
  const mongo = new MongoClient(shared.MONGO_URI!);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await mongo.connect();
    const managerUser = await mongo.db(shared.MONGO_DB).collection('users').findOne(
      { email: manager.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    if (managerUser?._id) {
      await mongo.db(shared.MONGO_DB).collection('authsessions').deleteMany({ userId: managerUser._id });
    }

    await page.goto(manager.loginPath);
    await expect(page.getByLabel('Email')).toBeVisible();
    await page.getByLabel('Email').fill(manager.email);
    await page.getByLabel('Password').fill(manager.password);
    await page.getByRole('button', { name: 'Masuk sekarang' }).click();
    await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 20_000 });
    const otp = await fixtureOtp('audit-manager');
    await page.getByLabel('Kode OTP').fill(otp);
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });

  await page.goto('/admin/audit-logs');
  const exportButton = page.getByRole('button', { name: 'Export CSV' });
  await expect(exportButton).toBeEnabled();

  // Export uses responseType=blob, so the orchestrator may not auto-open from parseStepUpRequired.
  // Prove the gateway gate via an in-page API call that preserves JSON body parsing.
  const gate = await page.evaluate(async () => {
    const api = (await import('/src/api/index.ts')).apiV2 as any;
    try {
      await api.get('/audit-logs/export', { _skipAuthRefresh: true });
      return { status: 200, code: null, group: null };
    } catch (error: any) {
      return {
        status: error?.response?.status ?? 0,
        code: error?.response?.data?.error?.code ?? error?.response?.data?.code ?? null,
        group: error?.response?.data?.error?.actionGroup ?? error?.response?.data?.actionGroup ?? null,
      };
    }
  });
  expect(gate).toEqual({
    status: 403,
    code: 'AUTH_STEP_UP_REQUIRED',
    group: 'exports.sensitive',
  });
  // UI remains export-eligible for manageTeam users.
  await expect(exportButton).toBeEnabled();
  } finally {
    await context.close();
    await mongo.close().catch(() => undefined);
  }
});
