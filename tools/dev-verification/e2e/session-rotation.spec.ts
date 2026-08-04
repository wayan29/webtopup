import { expect, test, type Page } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

const credentialNames = ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery'] as const;

async function loginWithoutClientRuntime(page: Page, alias: string): Promise<void> {
  const fixture = await loginFixture(alias);
  await page.goto('/vite.svg');
  const status = await page.evaluate(async ({ email, password, loginEndpoint }) => (await fetch(`/api/v2${loginEndpoint}`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, rememberMe: false }),
  })).status, fixture);
  expect(status).toBe(200);
  await expect.poll(async () => (await page.context().cookies()).length).toBe(3);
}

const cookieSnapshot = async (page: Page) => Object.fromEntries((await page.context().cookies())
  .filter(({ name }) => credentialNames.includes(name as typeof credentialNames[number]))
  .map(({ name, value, path, secure, httpOnly, sameSite }) => [name, { value, path, secure, httpOnly, sameSite }]));

test('current-binary refresh rotates both credential cookies without changing their contracts', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  await loginWithoutClientRuntime(page, `staff-rotation-${mobile ? 'mobile' : 'desktop'}`);
  const before = await cookieSnapshot(page);

  const outcome = await page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice('wb_csrf='.length);
    if (!csrf) return { status: 0, sidPresent: false };
    const response = await fetch('/api/v2/auth/refresh', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: '{}',
    });
    const payload = await response.json() as { accessToken?: string; error?: { code?: string } };
    let sidPresent = false;
    try {
      const segment = payload.accessToken?.split('.')[1];
      if (segment) sidPresent = typeof JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/'))).sid === 'string';
    } catch { /* sanitized boolean only */ }
    return { status: response.status, code: payload.error?.code ?? null, sidPresent };
  });
  expect(outcome).toEqual({ status: 200, code: null, sidPresent: true });

  const after = await cookieSnapshot(page);
  expect(Object.keys(after).sort()).toEqual([...credentialNames].sort());
  const rotated = Object.fromEntries(credentialNames.map((name) => [name, before[name]?.value !== after[name]?.value]));
  expect(rotated).toEqual(Object.fromEntries(credentialNames.map((name) => [name, true])));
  for (const name of credentialNames) {
    const { value: _beforeValue, ...beforeContract } = before[name]!;
    const { value: _afterValue, ...afterContract } = after[name]!;
    expect(afterContract).toEqual(beforeContract);
  }
});
