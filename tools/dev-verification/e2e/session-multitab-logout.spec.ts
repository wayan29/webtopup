import { expect, test, type Page } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

async function initializeStore(page: Page): Promise<void> {
  await page.goto('/vite.svg');
  await page.evaluate(async () => {
    const [storeModule, tokenModule] = await Promise.all([
      import('/src/store/useAuthStore.ts'), import('/src/auth/accessToken.ts'),
    ]);
    storeModule.initAuthStoreRuntime();
    Object.assign(window, { __logoutTab: { store: storeModule.useAuthStore, dispose: storeModule.disposeAuthStoreRuntime, tokenStore: tokenModule.accessTokenStore } });
  });
}

const snapshot = (page: Page) => page.evaluate(() => {
  const runtime = (window as never as { __logoutTab: any }).__logoutTab;
  const state = runtime.store.getState();
  return {
    isAuthenticated: state.isAuthenticated,
    userPresent: state.user !== null,
    stateTokenPresent: state.token !== null,
    memoryTokenPresent: runtime.tokenStore.get() !== null,
    isAdmin: state.isAdmin,
    isOwner: state.isOwner,
    isTeamMember: state.isTeamMember,
    phase: state.authPhase,
  };
});

test('logout in one real tab clears the complete authenticated state in the other tab', async ({ context }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-multitab-logout-${mobile ? 'mobile' : 'desktop'}`);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await initializeStore(pageA);
    await initializeStore(pageB);
    expect(await pageA.evaluate(() => typeof BroadcastChannel === 'function')).toBe(true);
    expect(await pageB.evaluate(() => typeof BroadcastChannel === 'function')).toBe(true);

    await pageA.evaluate(async ({ email, password, audience }) => {
      const store = (window as never as { __logoutTab: any }).__logoutTab.store;
      await store.getState().login(audience, email, password, false);
    }, fixture);
    await pageB.evaluate(async () => {
      const store = (window as never as { __logoutTab: any }).__logoutTab.store;
      await store.getState().checkAuth('/');
    });
    const authenticated = { isAuthenticated: true, userPresent: true, stateTokenPresent: true, memoryTokenPresent: true, isAdmin: false, isOwner: false, isTeamMember: true, phase: 'authenticated' };
    await expect.poll(() => snapshot(pageA)).toEqual(authenticated);
    await expect.poll(() => snapshot(pageB)).toEqual(authenticated);

    const logoutResponse = pageA.waitForResponse((response) => response.url().endsWith('/api/v2/auth/logout') && response.request().method() === 'POST');
    await pageA.evaluate(async () => {
      history.replaceState(null, '', '/login');
      const store = (window as never as { __logoutTab: any }).__logoutTab.store;
      await store.getState().logout();
    });
    expect((await logoutResponse).status()).toBe(200);
    const cleared = { isAuthenticated: false, userPresent: false, stateTokenPresent: false, memoryTokenPresent: false, isAdmin: false, isOwner: false, isTeamMember: false, phase: 'unauthenticated' };
    await expect.poll(() => snapshot(pageB)).toEqual(cleared);
    const remainingAuthCookies = (await context.cookies()).filter(({ name }) => ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery', 'wb_csrf'].includes(name)).map(({ name }) => name);
    expect(remainingAuthCookies).toEqual([]);
  } finally {
    await Promise.all([pageA.close(), pageB.close()]);
  }
});
