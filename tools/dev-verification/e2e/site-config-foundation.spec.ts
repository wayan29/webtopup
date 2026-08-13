import { expect, test, type Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import crypto from 'node:crypto';
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

async function staffLogin(page: Page, fixture: Awaited<ReturnType<typeof loginFixture>>) {
  await page.goto(fixture.loginPath);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 20_000 });
  const otp = await fixtureOtp('site-config-manager');
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
  let originalMaintenance = false;
  let originalRegistration = true;
  let originalGuestCheckout = true;

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

    await staffLogin(page, fixture);
    await page.goto('/admin/site-config');
    await expect(page.getByText('Brand', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('input[name="revision"], input[id="revision"]')).toHaveCount(0);

    const initial = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/settings/admin/all', { _skipAuthRefresh: true });
      return response.data;
    });
    originalBrand = String(initial.brand || '');
    originalRevision = Number(initial.revision || 0);
    originalMaintenance = Boolean(initial.maintenanceMode);
    originalRegistration = initial.registrationEnabled !== false;
    originalGuestCheckout = initial.guestCheckoutEnabled !== false;
    expect(Number.isInteger(originalRevision)).toBeTruthy();

    const brandField = page.locator('label:has-text("Brand")').locator('..').locator('input').first();
    await expect(brandField).toBeVisible({ timeout: 15_000 });
    const nextBrand = `Danayasa ${testInfo.project.name} ${Date.now().toString().slice(-6)}`.slice(0, 80);
    await brandField.fill(nextBrand);

    const putStatuses: number[] = [];
    const putKeys = new Set<string>();
    page.on('response', (response) => {
      if (response.request().method() === 'PUT' && response.url().includes('/settings/admin/update')) {
        putStatuses.push(response.status());
      }
    });
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/settings/admin/update')) {
        putKeys.add(String(request.headers()['idempotency-key'] || ''));
      }
    });
    await page.getByRole('button', { name: 'Simpan' }).click();
    await expect.poll(() => putStatuses.length, { timeout: 20_000 }).toBe(1);
    expect(putStatuses[0]).toBe(200);
    await expect(page.getByText(/berhasil disimpan/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Verifikasi ulang diperlukan' })).toHaveCount(0);
    expect([...putKeys].filter(Boolean)).toHaveLength(1);

    const afterSave = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      return (await api.get('/settings/admin/all', { _skipAuthRefresh: true })).data;
    });
    expect(Number(afterSave.revision)).toBe(originalRevision + 1);
    expect(String(afterSave.brand)).toBe(nextBrand);

    await page.getByRole('button', { name: 'Pengaturan Sistem' }).click();
    await expect(page.locator('#guestCheckoutEnabled')).toBeVisible({ timeout: 10_000 });
    await page.locator('#guestCheckoutEnabled').uncheck({ force: true });
    await page.getByRole('button', { name: 'Simpan' }).click();
    await expect(page.getByRole('heading', { name: 'Konfirmasi perubahan sensitif' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Simpan perubahan' }).click();
    await expect(page.getByRole('heading', { name: 'Verifikasi ulang diperlukan' })).toBeVisible({ timeout: 20_000 });
    const stepOtp = await fixtureOtp('site-config-manager');
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByLabel('Kode OTP').fill(stepOtp);
    await page.getByRole('button', { name: 'Lanjutkan' }).click();
    await expect(page.getByText(/berhasil disimpan/i).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Ref ID & Invoice' }).click();
    await expect(page.getByText('Format Ref ID', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    const refIdSelect = page.locator('h3:has-text("Format Ref ID")').locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').locator('label:has-text("Format Tanggal")').locator('..').locator('select').first();
    await expect(refIdSelect).toBeVisible({ timeout: 10_000 });
    await expect(refIdSelect.locator('option', { hasText: 'Tanpa Tanggal' })).toHaveCount(0);
    const invoiceSelect = page.locator('h3:has-text("Format Invoice")').locator('xpath=ancestor::div[contains(@class,"rounded-lg")]').locator('label:has-text("Format Tanggal")').locator('..').locator('select').first();
    await expect(invoiceSelect.locator('option', { hasText: 'Tanpa Tanggal' })).toHaveCount(1);
    await expect(page.locator('label:has-text("Panjang Random")').locator('..').locator('input')).toHaveAttribute('min', /8|10/);

    await page.getByRole('button', { name: 'Web Config' }).click();
    await page.getByRole('button', { name: /Pilih Gambar|Ganti Gambar/ }).first().click();
    await expect(page.getByText(/JPEG, PNG, atau WebP/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tinjau ulang draft' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Muat versi terbaru' })).toHaveCount(0);
  } catch (error) {
    primary = error;
  } finally {
    try {
      await page.evaluate(async ({ brand, registrationEnabled, maintenanceMode, guestCheckoutEnabled }) => {
        const api = (await import('/src/api/index.ts')).apiV2 as any;
        const current = (await api.get('/settings/admin/all', { _skipAuthRefresh: true })).data;
        await api.put('/settings/admin/update', {
          expectedRevision: current.revision,
          changes: { brand, registrationEnabled, maintenanceMode, guestCheckoutEnabled },
        }, {
          headers: { 'Idempotency-Key': `sitecfg_pw_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}` },
          _skipAuthRefresh: true,
        });
      }, {
        brand: originalBrand || 'Danayasa',
        registrationEnabled: originalRegistration,
        maintenanceMode: originalMaintenance,
        guestCheckoutEnabled: originalGuestCheckout,
      });
    } catch {
      // ignore restore failures
    }
    await mongo.close().catch(() => undefined);
  }

  if (primary) throw primary;
});
