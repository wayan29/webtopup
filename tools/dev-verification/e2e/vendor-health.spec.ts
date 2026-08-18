import { expect, test, type Page } from '@playwright/test';
import { fixtureOtp, loginFixture } from './fixtures.ts';

test.describe.configure({ timeout: 120_000 });

async function staffLogin(page: Page) {
  const fixture = await loginFixture('vendor-health-manager');
  await page.goto(fixture.loginPath);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Kode OTP').fill(await fixtureOtp('vendor-health-manager'));
  await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });
}

const diagnostics = (generatedAt = String(Math.floor(Date.now() / 1000))) => ({
  ok: true,
  partial: false,
  issues: [],
  generated_at: generatedAt,
  source: 'mongodb-snapshot',
  vendors: [],
  totals: { vendors: 0, healthy: 0, warning: 0, critical: 0, transactions_today: 0 },
});

const health = (name: string, generatedAt = new Date().toISOString()) => ({
  ok: true,
  partial: false,
  issues: [],
  snapshotPersisted: true,
  generatedAt,
  vendors: [{
    key: 'digiflazz',
    label: name,
    configured: true,
    active: true,
    balance: 1_000_000,
    balanceOk: true,
    lowBalanceThreshold: 100_000,
    lowBalance: false,
    balanceMessage: 'OK',
    health: 'healthy',
    transactionsToday: {
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
      successRate: 0,
      amountTotal: 0,
    },
    webhookToday: {
      total: 0,
      rejected: 0,
      failed: 0,
      delivered: 0,
      lastAt: null,
      lastStatus: '',
      lastMessage: '',
    },
  }],
  seller: {
    total: 0,
    pending: 0,
    failed: 0,
    callbackPending: 0,
    callbackDelivered: 0,
    health: 'healthy',
  },
});

test('vendor health is authoritative, refreshable, and honest', async ({ page }, testInfo) => {
  await staffLogin(page);
  let healthRequests = 0;
  let diagnosticsRequests = 0;
  let raceRequests = 0;
  let mode: 'fresh' | 'race' | 'partial' = 'fresh';

  await page.route('**/api/v2/vendors/health', async (route) => {
    healthRequests += 1;
    if (mode === 'race') {
      raceRequests += 1;
      if (raceRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(health('Old Vendor')),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(health('Newest Vendor')),
      });
    }
    if (mode === 'partial') {
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      const body = health('Digiflazz', stale);
      body.partial = true;
      body.snapshotPersisted = false;
      body.issues = [{ code: 'DIGIFLAZZ_BALANCE_UNAVAILABLE', source: 'provider.digiflazz' }];
      body.vendors[0] = {
        ...body.vendors[0]!,
        balance: null,
        balanceOk: false,
        balanceMessage: 'Pemeriksaan saldo tidak tersedia',
        health: 'critical',
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    }
    const responseLabel = 'Digiflazz';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(health(responseLabel)),
    });
  });

  await page.route('**/api/v2/vendors/health-snapshot', async (route) => {
    diagnosticsRequests += 1;
    const generatedAt = mode === 'partial'
      ? String(Math.floor((Date.now() - 10 * 60_000) / 1000))
      : undefined;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(diagnostics(generatedAt)),
    });
  });

  await page.goto('/admin/vendor-health');
  await expect(page.getByRole('button', { name: 'Segarkan Kesehatan Vendor' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh Snapshot' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ekspor CSV kesehatan vendor' })).toBeVisible();
  await expect(page.getByText('Belum ada transaksi')).toBeVisible();
  await expect(page.getByText('Diagnostik API dan MongoDB')).toBeVisible();

  const beforeHealth = healthRequests;
  const beforeDiagnostics = diagnosticsRequests;
  await page.getByRole('button', { name: 'Segarkan Kesehatan Vendor' }).click();
  await expect.poll(() => healthRequests).toBe(beforeHealth + 1);
  await expect.poll(() => diagnosticsRequests).toBe(beforeDiagnostics + 1);

  mode = 'race';
  raceRequests = 0;
  const beforeRace = healthRequests;
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await expect.poll(() => healthRequests, { timeout: 10_000 }).toBe(beforeRace + 2);
  await expect(page.getByText('Newest Vendor')).toBeVisible();
  await expect(page.getByText('Old Vendor')).toHaveCount(0);

  mode = 'partial';
  await page.getByRole('button', { name: 'Segarkan Kesehatan Vendor' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'DIGIFLAZZ_BALANCE_UNAVAILABLE' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: /kedaluwarsa|stale/i })).toBeVisible();
  await expect(page.getByText('Tidak tersedia', { exact: true })).toBeVisible();
  if (testInfo.project.name === 'chromium-mobile') {
    await expect(page.locator('article').filter({ hasText: 'Digiflazz' })).toBeVisible();
  }
});
