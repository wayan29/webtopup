import { expect, test, type Page } from '@playwright/test';
import { fixtureOtp, loginFixture, type FixtureLogin } from './fixtures.ts';

const login = async (page: Page, fixture: FixtureLogin, otp?: string) => {
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  if (otp) {
    await expect(page.getByText('Verifikasi 2FA')).toBeVisible();
    await page.getByLabel('Kode OTP').fill(otp);
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
  }
};

const expectBackSkipsLogin = async (page: Page, finalPath: string) => {
  await page.goBack();
  await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/);
  // A replace navigation may leave no same-origin entry at all (about:blank), or may expose an
  // earlier copy of the protected deep link. Both prove that Back cannot resurrect login.
  if (page.url() !== 'about:blank') {
    await expect(page).toHaveURL(new RegExp(`${finalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  }
};

const loginUrl = (surface: '/login' | '/staff/login', returnTo: string) =>
  `${surface}?returnTo=${encodeURIComponent(returnTo)}`;

test.describe.configure({ timeout: 90_000 });

test('member deep link continues after login and browser back skips login', async ({ page }) => {
  const fixture = await loginFixture('member-login-return-a');
  await page.goto('/transactions');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Ftransactions$/);
  await login(page, fixture);
  await expect(page).toHaveURL(/\/transactions$/);
  await expectBackSkipsLogin(page, '/transactions');
});

test('staff deep link continues after login and browser back skips staff login', async ({ page }) => {
  const fixture = await loginFixture('staff-login-return-a');
  await page.goto('/admin/vendors');
  await expect(page).toHaveURL(/\/staff\/login\?returnTo=%2Fadmin%2Fvendors$/);
  await login(page, fixture);
  await expect(page).toHaveURL(/\/admin\/vendors$/);
  await expectBackSkipsLogin(page, '/admin/vendors');
});

test('2FA completion retains the same staff deep link', async ({ page }) => {
  const alias = 'staff-login-return-2fa';
  const fixture = await loginFixture(alias);
  await page.goto('/admin/vendors');
  await expect(page).toHaveURL(/\/staff\/login\?returnTo=%2Fadmin%2Fvendors$/);
  await login(page, fixture, await fixtureOtp(alias));
  await expect(page).toHaveURL(/\/admin\/vendors$/);
  await expectBackSkipsLogin(page, '/admin/vendors');
});

test('member session cannot continue to a staff destination', async ({ page }) => {
  const fixture = await loginFixture('member-login-return-b');
  await page.goto(loginUrl('/login', '/admin/vendors'));
  await login(page, fixture);
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('staff session cannot continue to a member destination', async ({ page }) => {
  const fixture = await loginFixture('staff-login-return-b');
  await page.goto(loginUrl('/staff/login', '/transactions'));
  await login(page, fixture);
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
});

test('auth-loop, external, and encoded traversal destinations fall back safely', async ({ page }) => {
  const candidates = ['/login', 'https://evil.example.test/transactions', '/%2e%2e/admin/vendors'];
  for (const [index, candidate] of candidates.entries()) {
    const fixture = await loginFixture(`member-login-return-${String.fromCharCode(99 + index)}`);
    await page.goto(loginUrl('/login', candidate));
    await login(page, fixture);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.context().clearCookies();
  }
});

test('authenticated-on-entry redirects without rendering the login form', async ({ page }) => {
  const fixture = await loginFixture('member-login-return-b');
  await page.goto('/login');
  await login(page, fixture);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/login?returnTo=%2Ftransactions');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByLabel('Email')).toHaveCount(0);
});
