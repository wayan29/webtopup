import { expect, test } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

test.describe.configure({ timeout: 120_000 });

test('trusted HTTPS edge serves production React and Node-to-Rust health', async ({ page, baseURL }) => {
  expect(baseURL).toBe('https://webtopup.local.test:9443');
  const anonymousRefreshes: Array<{ status: number; code: unknown }> = [];
  page.on('response', async (refreshResponse) => {
    if (new URL(refreshResponse.url()).pathname !== '/api/v2/auth/refresh') return;
    const payload = await refreshResponse.json() as { code?: unknown; error?: { code?: unknown } };
    anonymousRefreshes.push({ status: refreshResponse.status(), code: payload.error?.code ?? payload.code });
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  const root = page.locator('#root');
  await expect(root).toBeAttached();
  await expect(root).not.toBeEmpty();
  await expect(page.getByText('Verifikasi sesi tertunda')).toHaveCount(0);
  await expect.poll(() => anonymousRefreshes.length).toBeGreaterThan(0);
  expect(anonymousRefreshes.every((item) => item.status === 401 && item.code === 'AUTH_TOKEN_INVALID')).toBe(true);

  const health = await page.evaluate(async () => {
    const response = await fetch('/api/v2/health');
    return { status: response.status, traceId: response.headers.get('x-trace-id'), body: await response.json() as Record<string, unknown> };
  });
  expect(health.status).toBe(200);
  expect(health.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(health.body).toMatchObject({ status: 'ok' });
});

test('at least fifteen fresh anonymous contexts from one IP always reach public content', async ({ browser }, testInfo) => {
  for (let i = 0; i < 15; i += 1) {
    const context = await browser.newContext(testInfo.project.use);
    try {
      const page = await context.newPage();
      const response = await page.goto('/');
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('link', { name: 'Top Up Sekarang' })).toBeVisible();
      await expect(page.getByText('Terlalu banyak percobaan')).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test('a credentialed protected cold load still renders the rate-limit screen', async ({ browser }, testInfo) => {
  const fixture = await loginFixture(`member-enrollment-${testInfo.project.name === 'chromium-mobile' ? 'mobile' : 'desktop'}`);
  const context = await browser.newContext(testInfo.project.use);
  try {
    const page = await context.newPage();
    await page.goto(fixture.loginPath);
    await page.getByLabel('Email').fill(fixture.email);
    await page.getByLabel('Password').fill(fixture.password);
    await page.getByRole('button', { name: 'Masuk sekarang' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.route('**/api/v2/auth/refresh', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' }),
      });
    });
    // Force a true cold load rather than preserving the authenticated in-memory store. The
    // credential cookies survive and exercise protected bootstrap classification.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Terlalu banyak percobaan' })).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/);
  } finally {
    await context.close();
  }
});
