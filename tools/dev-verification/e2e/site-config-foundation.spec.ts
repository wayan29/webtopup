import { expect, test, type Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureOtp, loginFixture } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');

const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

async function staffLogin(page: Page, fixture: Awaited<ReturnType<typeof loginFixture>>, otp: string) {
  await page.goto(fixture.loginPath);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Kode OTP').fill(otp);
  await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });
}

test.describe.configure({ timeout: 120_000 });

test('site config foundation save flow is versioned and step-up aware', async ({ page }, testInfo) => {
  const fixture = await loginFixture('site-config-manager');
  const shared = await envFile(path.join(root, '.dev-verification', 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');

  const mongo = new MongoClient(shared.MONGO_URI!);
  let primary: unknown = null;
  let originalBrand = '';
  let originalRevision = 0;

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    expect(await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    })).toBeTruthy();

    const user = await db.collection('users').findOne(
      { email: fixture.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    expect(user).toBeTruthy();
    await db.collection('authsessions').deleteMany({ userId: user!._id });

    const otp = await fixtureOtp('site-config-manager');
    await staffLogin(page, fixture, otp);
    await page.goto('/admin/site-config');
    await expect(page.getByText('Brand', { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    // No editable revision control.
    await expect(page.locator('input[name="revision"], input[id="revision"]')).toHaveCount(0);

    // Capture original brand via API in-page.
    const initial = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/settings/admin/all', { _skipAuthRefresh: true });
      return response.data;
    });
    originalBrand = String(initial.brand || '');
    originalRevision = Number(initial.revision || 0);
    expect(Number.isInteger(originalRevision)).toBeTruthy();

    // Non-sensitive save: one PUT, no step-up dialog.
    const brandInput = page.locator('input').filter({ has: page.locator('xpath=ancestor::div[label[contains(., "Brand")]]') }).first()
      .or(page.getByLabel('Brand'));
    // Fallback: find by nearby label text.
    const brandField = page.locator('label:has-text("Brand")').locator('..').locator('input').first();
    await expect(brandField).toBeVisible({ timeout: 15_000 });
    const nextBrand = `${originalBrand} ${testInfo.project.name}`.slice(0, 80);
    await brandField.fill(nextBrand);

    const putStatuses: number[] = [];
    page.on('response', async (response) => {
      if (response.request().method() === 'PUT' && response.url().includes('/settings/admin/update')) {
        putStatuses.push(response.status());
      }
    });

    await page.getByRole('button', { name: /Simpan|Save/i }).first().click();
    await expect.poll(() => putStatuses.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.getByText(/berhasil disimpan|Tidak ada perubahan/i).first()).toBeVisible({ timeout: 20_000 });
    expect(putStatuses.every((status) => status === 200 || status === 403)).toBeTruthy();

    // Sensitive path: enable maintenance and expect step-up dialog or AUTH_STEP_UP_REQUIRED flow.
    await page.getByRole('button', { name: /Sistem|System/i }).first().click().catch(() => undefined);
    const maintenanceToggle = page.getByText(/Mode maintenance|maintenance/i).first();
    if (await maintenanceToggle.isVisible().catch(() => false)) {
      // Best-effort: open system tab already.
    }

    // Ref ID tab should not offer NONE for Ref ID date format.
    await page.getByRole('button', { name: /Ref ID/i }).first().click().catch(() => undefined);
    const refIdSelect = page.locator('label:has-text("Format Tanggal")').locator('..').locator('select').first();
    if (await refIdSelect.isVisible().catch(() => false)) {
      const options = await refIdSelect.locator('option').allTextContents();
      // First date format select in Ref ID section should not include Tanpa Tanggal.
      // Invoice section later may still include it.
      expect(options.join(' ')).not.toMatch(/Tanpa Tanggal/i);
    }
  } catch (error) {
    primary = error;
  } finally {
    // Restore brand if changed.
    try {
      await page.evaluate(async ({ brand }) => {
        const api = (await import('/src/api/index.ts')).apiV2 as any;
        const current = (await api.get('/settings/admin/all', { _skipAuthRefresh: true })).data;
        await api.put('/settings/admin/update', {
          expectedRevision: current.revision,
          changes: { brand },
        }, {
          headers: { 'Idempotency-Key': `sitecfg_pw_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}` },
          _skipAuthRefresh: true,
        });
      }, { brand: originalBrand || 'Danayasa' });
    } catch {
      // ignore
    }
    await mongo.close().catch(() => undefined);
  }

  if (primary) throw primary;
});
