import { expect, test, type Page } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

async function initializeRuntime(page: Page): Promise<void> {
  await page.goto('/vite.svg');
  await page.evaluate(async () => {
    const [{ apiV2 }, runtime, tokenModule] = await Promise.all([
      import('/src/api/index.ts'), import('/src/auth/sessionRuntime.ts'), import('/src/auth/accessToken.ts'),
    ]);
    const state = { authenticated: 0, phases: [] as string[], baseline: '', tokenChanged: false };
    const dispose = runtime.initAuthSessionRuntime(apiV2, {
      setPhase: (phase) => state.phases.push(phase),
      onAuthenticated: () => { state.authenticated += 1; state.tokenChanged = Boolean(state.baseline && tokenModule.accessTokenStore.get() !== state.baseline); },
      onTerminal: () => undefined,
    });
    Object.assign(window, { __multitab: { apiV2, runtime, tokenStore: tokenModule.accessTokenStore, state, dispose } });
  });
}

test('real BroadcastChannel propagates a newer winner access credential to the other page', async ({ context }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-multitab-${mobile ? 'mobile' : 'desktop'}`);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await initializeRuntime(pageA);
    await initializeRuntime(pageB);
    expect(await pageA.evaluate(() => typeof BroadcastChannel === 'function')).toBe(true);
    expect(await pageB.evaluate(() => typeof BroadcastChannel === 'function')).toBe(true);
    const login = await pageA.evaluate(async ({ email, password, loginEndpoint }) => {
      const state = (window as never as { __multitab: any }).__multitab;
      const response = await state.apiV2.post(loginEndpoint, { email, password, rememberMe: false }, { _skipAuthRefresh: true });
      state.runtime.applyLoginResponse(response.data);
      state.state.baseline = state.tokenStore.get();
      return { status: response.status, sidPresent: typeof state.runtime.getAuthCoordinator()?.getSessionSid() === 'string' };
    }, fixture);
    expect(login).toEqual({ status: 200, sidPresent: true });

    const winner = await pageB.evaluate(async () => {
      const state = (window as never as { __multitab: any }).__multitab;
      const result = await state.runtime.getAuthCoordinator()?.bootstrapSession();
      return { accessPresent: typeof result?.accessToken === 'string', sidPresent: typeof result?.policy.sid === 'string' };
    });
    expect(winner).toEqual({ accessPresent: true, sidPresent: true });

    await expect.poll(() => pageA.evaluate(() => {
      const state = (window as never as { __multitab: any }).__multitab.state;
      return { authenticated: state.authenticated, tokenChanged: state.tokenChanged, phase: state.phases.at(-1) };
    })).toEqual({ authenticated: 2, tokenChanged: true, phase: 'authenticated' });
  } finally {
    await Promise.all([pageA.close(), pageB.close()]);
  }
});
