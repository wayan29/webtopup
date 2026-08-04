import { expect, test, type Page } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

const AUTH_COOKIE_NAMES = ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery', 'wb_csrf'] as const;

async function login(page: Page, alias: string): Promise<void> {
  const fixture = await loginFixture(alias);
  await page.goto(fixture.loginPath);
  await page.locator('#email').fill(fixture.email);
  await page.locator('#password').fill(fixture.password);
  await page.getByRole('button', { name: /masuk sekarang/i }).click();
  await expect.poll(async () => (await page.context().cookies()).length).toBe(3);
}

const authCookies = async (page: Page) => (await page.context().cookies())
  .filter(({ name }) => AUTH_COOKIE_NAMES.includes(name as typeof AUTH_COOKIE_NAMES[number]));

test('explicit production logout clears every auth cookie', async ({ page }, testInfo) => {
  await login(page, `staff-disposition-terminal-${testInfo.project.name === 'chromium-mobile' ? 'mobile' : 'desktop'}`);
  const status = await page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice('wb_csrf='.length);
    if (!csrf) return 0;
    const response = await fetch('/api/v2/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
      body: '{}',
    });
    return response.status;
  });
  expect(status).toBe(200);
  await expect.poll(async () => (await authCookies(page)).length).toBe(0);
});

test('network-failed bootstrap preserves every credential cookie', async ({ page }, testInfo) => {
  await login(page, `staff-disposition-recoverable-${testInfo.project.name === 'chromium-mobile' ? 'mobile' : 'desktop'}`);
  const before = await authCookies(page);
  expect(before).toHaveLength(3);

  await page.route('**/api/v2/auth/refresh', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Koneksi tidak stabil' })).toBeVisible();

  const after = await authCookies(page);
  expect(after).toHaveLength(3);
  const unchangedByName = Object.fromEntries(AUTH_COOKIE_NAMES.map((name) => [
    name,
    before.find((cookie) => cookie.name === name)?.value === after.find((cookie) => cookie.name === name)?.value,
  ]));
  expect(unchangedByName).toEqual(Object.fromEntries(AUTH_COOKIE_NAMES.map((name) => [name, true])));
});
