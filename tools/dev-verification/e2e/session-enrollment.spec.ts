import { expect, test } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

async function login(page: import('@playwright/test').Page, alias: string) {
  const fixture = await loginFixture(alias);
  await page.goto(fixture.loginPath);
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
}

test.describe.configure({ timeout: 60_000 });

test('staff enrollment grace permits dashboard and shows bounded setup guidance', async ({ page }, testInfo) => {
  await login(page, `staff-grace-${testInfo.project.name === 'chromium-mobile' ? 'mobile' : 'desktop'}`);
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  // Guidance is a dismissible dashboard dialog, not a layout-wide banner.
  const reminder = page.getByRole('dialog', { name: 'Aktifkan autentikasi dua faktor' });
  await expect(reminder).toBeVisible();
  await expect(reminder.getByText(/Aktifkan 2FA dalam \d+ hari/)).toBeVisible();
  await expect(reminder.getByRole('link', { name: 'Aktifkan sekarang' })).toHaveAttribute('href', '/admin/security');
  await reminder.getByRole('button', { name: 'Nanti saja' }).click();
  await expect(reminder).toHaveCount(0);
  // Dismissal is per-visit: returning to the dashboard shows the reminder again.
  await page.goto('/admin/transactions');
  await page.goto('/admin/dashboard');
  await expect(page.getByRole('dialog', { name: 'Aktifkan autentikasi dua faktor' })).toBeVisible();
  if (testInfo.project.name === 'chromium-mobile') expect({ narrow: page.viewportSize()!.width < 600, touch: await page.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
});

test('overdue staff is redirected to the authoritative profile security surface', async ({ page }, testInfo) => {
  await login(page, `staff-overdue-${testInfo.project.name === 'chromium-mobile' ? 'mobile' : 'desktop'}`);
  await expect(page).toHaveURL(/\/admin\/profile$/);
  await expect(page.getByRole('status').filter({ hasText: '2FA wajib untuk akun staf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mulai setup 2FA' })).toBeEnabled();
  await page.goto('/admin/dashboard');
  await expect(page).toHaveURL(/\/admin\/profile$/);
  if (testInfo.project.name === 'chromium-mobile') expect({ narrow: page.viewportSize()!.width < 600, touch: await page.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
});

test('member navigation is unaffected by staff enrollment deadlines', async ({ page }, testInfo) => {
  await login(page, `member-enrollment-${testInfo.project.name === 'chromium-mobile' ? 'mobile' : 'desktop'}`);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(/2FA wajib untuk akun staf/)).toHaveCount(0);
  if (testInfo.project.name === 'chromium-mobile') expect({ narrow: page.viewportSize()!.width < 600, touch: await page.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
});
