import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

const cookieMetadata = async (context: BrowserContext) => (await context.cookies()).map(({ name, httpOnly, secure, sameSite, path, domain }) => ({
  name, httpOnly, secure, sameSite, path, hostOnly: domain === 'webtopup.local.test',
}));

async function login(page: Page, alias: string, rememberMe: boolean): Promise<string[][]> {
  const fixture = await loginFixture(alias);
  await page.goto(fixture.loginPath);
  await page.locator('#email').fill(fixture.email);
  await page.locator('#password').fill(fixture.password);
  if (rememberMe) {
    // Staff sessions have a fixed upstream ceiling, so the staff form deliberately has no
    // remember-me control. Assert that absence instead of pretending the option exists.
    if (fixture.audience === 'staff') await expect(page.locator('input[name="rememberMe"]')).toHaveCount(0);
    else await page.locator('input[name="rememberMe"]').check();
  }
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v2${fixture.loginEndpoint}`);
  await page.getByRole('button', { name: /masuk sekarang/i }).click();
  const response = await responsePromise;
  await expect.poll(async () => (await page.context().cookies()).length).toBe(3);
  return (await response.headersArray())
    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
    .map(({ value }) => value.split(';').slice(1).map((attribute) => attribute.trim()));
}

for (const rememberMe of [false, true]) {
  test(`trusted HTTPS login installs exact ${rememberMe ? 'remembered' : 'session'} cookie metadata`, async ({ page, context }, testInfo) => {
    const mobile = testInfo.project.name === 'chromium-mobile';
    const alias = mobile ? (rememberMe ? 'staff-session-d' : 'staff-session-c') : (rememberMe ? 'staff-session-b' : 'staff-session-a');
    const setCookieAttributes = await login(page, alias, rememberMe);
    expect(setCookieAttributes).toHaveLength(3);
    for (const attributes of setCookieAttributes) {
      expect(attributes.some((attribute) => /^domain=/iu.test(attribute))).toBe(false);
    }
    expect(await cookieMetadata(context)).toEqual([
      { name: '__Secure-wb_refresh', httpOnly: true, secure: true, sameSite: 'Lax', path: '/api/v2/auth', hostOnly: true },
      { name: '__Secure-wb_rotation_recovery', httpOnly: true, secure: true, sameSite: 'Lax', path: '/api/v2/auth', hostOnly: true },
      { name: 'wb_csrf', httpOnly: false, secure: true, sameSite: 'Lax', path: '/', hostOnly: true },
    ]);
  });
}
