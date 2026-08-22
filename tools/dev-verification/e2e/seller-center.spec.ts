import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { fixtureOtp, loginFixture } from './fixtures.ts';

test.describe.configure({ timeout: 180_000 });

const root = path.resolve(__dirname, '..', '..', '..');

async function resetManagerSessions(email: string) {
  const shared = Object.fromEntries(
    (await fs.readFile(path.join(root, '.dev-verification', 'env', 'shared.env'), 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  if (shared.MONGO_DB !== 'webtopup_task14_dev') {
    throw new Error('seller-center e2e requires the disposable verification database');
  }
  const mongo = new MongoClient(shared.MONGO_URI!);
  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const user = await db.collection('users').findOne(
      { email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    if (user?._id) {
      await db.collection('authsessions').deleteMany({ userId: user._id });
    }
  } finally {
    await mongo.close();
  }
}

async function staffLogin(page: Page) {
  const fixture = await loginFixture('seller-center-manager');
  await resetManagerSessions(fixture.email);
  await page.goto(fixture.loginPath);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Kode OTP').fill(await fixtureOtp('seller-center-manager'));
  await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });
}

type SummaryMode = 'fresh' | 'race' | 'partial' | 'malformed';

const summaryFixture = (label: string, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  partial: false,
  issues: [],
  generatedAt: '2026-08-20T00:00:00.000Z',
  digiflazz: {
    configured: true,
    ready: true,
    status: 'ready',
    orders: { total: 4, pending: 1, failed: 0, callbackPending: 2 },
    ...(overrides.digiflazz as Record<string, unknown> | undefined),
  },
  irs: {
    enabled: true,
    configured: true,
    ready: true,
    status: 'ready',
    orders: { total: 2, pending: 1, failed: 0 },
    ...(overrides.irs as Record<string, unknown> | undefined),
  },
  mappings: { total: 5, active: 3 },
});

const irsSettingsFixture = () => ({
  configured: true,
  ready: true,
  enabled: true,
  merchantId: 'merchant-fixture',
  passwordConfigured: true,
  pinConfigured: true,
  secretConfigured: true,
  endpointUrl: 'https://v1.apigames.id/v2/transaksi-irs',
  allowedIps: [],
  sellerMarginFlat: 0,
  callbackEnabled: false,
  callbackUrl: '',
  prepaidEndpointPath: '/v2/irs-seller/prepaid',
  mappingSummary: { active: 3 },
});

const digiflazzSettingsFixture = () => ({
  configured: true,
  ready: true,
  username: 'seller-fixture',
  apiKeyConfigured: true,
  publicBaseUrl: 'http://127.0.0.1',
  digiflazzCallbackUrl: 'https://api.digiflazz.com/v1/seller/callback',
  serverIp: '127.0.0.1',
  reportedBalance: 0,
  sellerMarginFlat: 250,
  allowedIps: ['52.74.250.133'],
  callbackEnabled: true,
  prepaidEndpointPath: '/api/v2/digiflazz-seller/prepaid',
  prepaidEndpointUrl: 'http://127.0.0.1/api/v2/digiflazz-seller/prepaid',
  mappingSummary: { total: 5, active: 3 },
  orderSummary: { total: 4, pending: 1, callbackPending: 2, callbackDueRetry: 0, callbackHighAttempt: 0 },
  retryQueueHealth: { status: 'never', source: 'unknown', lastRunAt: null, processed: 0, successCount: 0, failedCount: 0, remainingDue: 0, lastError: '' },
});

test('seller center navigation, redirects, add-on card, and section addressing', async ({ page }) => {
  await staffLogin(page);

  await page.route('**/api/v2/digiflazz-seller/center-summary', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summaryFixture('fresh')) });
  });
  await page.route('**/api/v2/digiflazz-seller/settings', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(digiflazzSettingsFixture()) });
  });
  await page.route('**/api/v2/digiflazz-seller/mappings*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 1 }, summary: { totalProducts: 0, mappedProducts: 0, activeMappings: 0 } }),
    });
  });

  // Sidebar has exactly one canonical identity and no standalone IRS entry.
  await page.goto('/admin/addons');
  const sidebar = page.locator('aside, nav').first();
  await expect(sidebar.getByText('Digiflazz Seller Center', { exact: true })).toBeVisible();
  await expect(page.getByText('IRS Seller', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Digiflazz Seller', { exact: true })).toHaveCount(0);

  // Add Ons shows one Digiflazz Seller Center card with both integration rows.
  await expect(page.getByText('DIGIFLAZZ SELLER CENTER', { exact: true })).toBeVisible();
  await expect(page.getByText('Digiflazz API', { exact: true })).toBeVisible();
  await expect(page.getByText('Integrasi IRS', { exact: true })).toBeVisible();

  // Legacy Digiflazz URL redirects to the canonical overview with replace semantics.
  await page.goto('/admin/addons');
  await page.evaluate(() => window.history.pushState({}, '', '/admin/addons/digiflazz-seller'));
  await page.goto('/admin/addons/digiflazz-seller');
  await expect(page).toHaveURL(/\/admin\/addons\/digiflazz-seller-center\?section=overview$/);

  // Legacy IRS URL redirects to the IRS section.
  await page.goto('/admin/addons/irs-seller');
  await expect(page).toHaveURL(/\/admin\/addons\/digiflazz-seller-center\?section=irs$/);

  // Section navigation is keyboard-accessible and URL-addressable.
  await page.goto('/admin/addons/digiflazz-seller-center?section=overview');
  await expect(page.getByRole('navigation', { name: 'Navigasi Digiflazz Seller Center' })).toBeVisible();
  const centerNav = page.getByRole('navigation', { name: 'Navigasi Digiflazz Seller Center' });
  const irsTab = centerNav.getByRole('button', { name: 'Integrasi IRS' });
  await irsTab.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/section=irs$/);

  const mappingsTab = centerNav.getByRole('button', { name: 'Mapping Produk' });
  await mappingsTab.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/section=mappings$/);
});

test('seller center summary refresh, race safety, and degraded honesty', async ({ page }) => {
  await staffLogin(page);

  let summaryRequests = 0;
  let raceRequests = 0;
  let mode: SummaryMode = 'fresh';
  let irsSettingsRequests = 0;
  let irsOrdersRequests = 0;
  let irsLogsRequests = 0;

  await page.route('**/api/v2/digiflazz-seller/center-summary', async (route) => {
    summaryRequests += 1;
    if (mode === 'race') {
      raceRequests += 1;
      if (raceRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const body = summaryFixture('old');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...body, digiflazz: { ...body.digiflazz, orders: { total: 111, pending: 1, failed: 0, callbackPending: 0 } } }),
        });
      }
      const body = summaryFixture('new');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...body, digiflazz: { ...body.digiflazz, orders: { total: 222, pending: 1, failed: 0, callbackPending: 0 } } }),
      });
    }
    if (mode === 'partial') {
      const body = summaryFixture('partial');
      body.partial = true;
      body.issues = [{ code: 'IRS_ORDER_SUMMARY_UNAVAILABLE', source: 'mongodb.irsSellerOrders' }];
      body.irs.status = 'unavailable';
      body.irs.ready = false;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (mode === 'malformed') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, digiflazz: { status: 'ready' } }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summaryFixture('fresh')) });
  });

  await page.route('**/api/v2/irs-seller/settings', async (route) => {
    irsSettingsRequests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(irsSettingsFixture()) });
  });
  await page.route('**/api/v2/irs-seller/orders/admin', async (route) => {
    irsOrdersRequests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await page.route('**/api/v2/irs-seller/logs', async (route) => {
    irsLogsRequests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  // Initial overview load renders authoritative rows.
  await page.goto('/admin/addons/digiflazz-seller-center?section=overview');
  const overview = page.getByTestId('seller-center-overview');
  await expect(overview.getByText('Digiflazz API', { exact: true })).toBeVisible();
  await expect(overview.getByText('Integrasi IRS', { exact: true })).toBeVisible();
  await expect(overview.getByText('Mapping Produk Bersama')).toBeVisible();
  const initialSummary = summaryRequests;
  expect(initialSummary).toBeGreaterThan(0);

  // Global refresh is the only pure refresh affordance and fires exactly one
  // summary reload per event.
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await expect.poll(() => summaryRequests).toBe(initialSummary + 1);

  // On the IRS section, one refresh fans out once to each active source.
  const centerNav = page.getByRole('navigation', { name: 'Navigasi Digiflazz Seller Center' });
  await centerNav.getByRole('button', { name: 'Integrasi IRS' }).click();
  await expect(page).toHaveURL(/section=irs$/);
  // Wait for the section's lazy initial loads to settle before baselining.
  await expect(page.getByRole('heading', { name: 'Konfigurasi Integrasi IRS' })).toBeVisible();
  await expect.poll(() => irsSettingsRequests, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => irsOrdersRequests, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => irsLogsRequests, { timeout: 10_000 }).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const beforeSectionSummary = summaryRequests;
  const beforeSectionSettings = irsSettingsRequests;
  const beforeSectionOrders = irsOrdersRequests;
  const beforeSectionLogs = irsLogsRequests;
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await expect.poll(() => summaryRequests).toBe(beforeSectionSummary + 1);
  await expect.poll(() => irsSettingsRequests).toBe(beforeSectionSettings + 1);
  await expect.poll(() => irsOrdersRequests).toBe(beforeSectionOrders + 1);
  await expect.poll(() => irsLogsRequests).toBe(beforeSectionLogs + 1);

  // A slow stale summary response can never overwrite the newer one.
  await centerNav.getByRole('button', { name: 'Ringkasan' }).click();
  await expect(page).toHaveURL(/section=overview$|digiflazz-seller-center$/);
  mode = 'race';
  raceRequests = 0;
  const beforeRace = summaryRequests;
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await expect.poll(() => summaryRequests, { timeout: 10_000 }).toBe(beforeRace + 2);
  await expect(overview.getByText('222')).toBeVisible();
  await expect(overview.getByText('111')).toHaveCount(0);

  // Partial summaries show the stable issue and never pretend ready.
  mode = 'partial';
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await expect(page.getByRole('alert').filter({ hasText: 'IRS_ORDER_SUMMARY_UNAVAILABLE' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(overview.getByText('Tidak tersedia', { exact: true })).toBeVisible();

  // Malformed payloads fail closed as unavailable, never as healthy.
  mode = 'malformed';
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await expect(page.getByRole('alert').filter({ hasText: 'MALFORMED_SELLER_CENTER_RESPONSE' })).toBeVisible();
});

test('seller center irs integration is write-only, typed, and responsive', async ({ page }, testInfo) => {
  await staffLogin(page);
  const fixtureSecrets = ['fixture-password', 'fixture-pin', 'fixture-secret'];

  await page.route('**/api/v2/digiflazz-seller/center-summary', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summaryFixture('fresh')) });
  });
  await page.route('**/api/v2/irs-seller/settings', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message: 'Konfigurasi IRS Seller berhasil disimpan' }) });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(irsSettingsFixture()) });
  });
  await page.route('**/api/v2/irs-seller/orders/admin', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{
          id: '1',
          refId: 'irs-ref-1',
          internalRefId: 'IRSABC123456D',
          irsCode: 'tsel10',
          target: '081200000000',
          status: 'success',
          statusCode: '1',
          message: 'BERHASIL',
          sn: 'SN-IRS-1',
          vendorTrxId: 'IRSABC123456D',
          requestIp: '127.0.0.1',
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
        }],
      }),
    });
  });
  await page.route('**/api/v2/irs-seller/logs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'log-1',
        timestamp: '2026-08-20T00:00:00.000Z',
        event: 'request',
        refId: 'irs-ref-1',
        status: 'success',
        message: 'BERHASIL',
        verified: true,
        requestIp: '127.0.0.1',
      }]),
    });
  });

  await page.goto('/admin/addons/digiflazz-seller-center?section=irs');
  await expect(page.getByRole('heading', { name: 'Konfigurasi Integrasi IRS' })).toBeVisible();

  // Secret fields start blank, write-only, with boolean configured readiness.
  const secretInputs = page.getByPlaceholder('Tersimpan — isi untuk mengganti');
  await expect(secretInputs).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const input = secretInputs.nth(index);
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('autocomplete', 'new-password');
  }
  await expect(page.getByText('Sudah tersimpan; kosongkan untuk mempertahankan.')).toHaveCount(3);
  for (const secret of fixtureSecrets) {
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  }

  // No pure local Refresh button; save mutation remains and uses step-up.
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Simpan Konfigurasi IRS' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kelola Mapping Produk' })).toBeVisible();

  // Orders/log rows render allowlisted DTO content responsively (desktop table
  // and mobile cards coexist; assert the instance visible in this project).
  await expect(page.getByText('irs-ref-1').filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('SN-IRS-1').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('BERHASIL').filter({ visible: true }).first()).toBeVisible();
  // Internal supplier references are not part of the admin UI DTO surface.
  await expect(page.getByText('IRSABC123456D')).toHaveCount(0);
  if (testInfo.project.name === 'chromium-mobile') {
    await expect(page.getByRole('heading', { name: 'Order IRS Terbaru' })).toBeVisible();
  } else {
    await expect(page.getByRole('table').first()).toBeVisible();
    await expect(page.getByRole('table').first().getByText('tsel10')).toBeVisible();
  }

  // The mapping CTA navigates to the canonical mappings section.
  await page.getByRole('button', { name: 'Kelola Mapping Produk' }).click();
  await expect(page).toHaveURL(/section=mappings$/);
});
