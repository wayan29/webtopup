import { expect, test } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

test('typed access expiry performs exactly one refresh and one safe GET replay', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-rotation-get-${mobile ? 'mobile' : 'desktop'}`);
  let getRequests = 0;
  let refreshRequests = 0;
  const authorizationPresent: boolean[] = [];
  let firstAuthorization: string | undefined;
  let replayAuthorizationRotated = false;

  await page.route('**/api/v2/auth/refresh', async (route) => {
    expect(route.request().method()).toBe('POST');
    refreshRequests += 1;
    await route.continue();
  });
  await page.route('**/api/v2/auth/sessions', async (route) => {
    expect(route.request().method()).toBe('GET');
    getRequests += 1;
    const authorization = route.request().headers().authorization;
    authorizationPresent.push(typeof authorization === 'string');
    if (getRequests === 1) {
      firstAuthorization = authorization;
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUTH_ACCESS_EXPIRED', message: 'synthetic typed expiry' } }) });
      return;
    }
    replayAuthorizationRotated = Boolean(firstAuthorization && authorization && firstAuthorization !== authorization);
    await route.continue();
  });

  await page.goto('/vite.svg');
  const outcome = await page.evaluate(async ({ email, password, loginEndpoint }) => {
    const [{ apiV2 }, runtime] = await Promise.all([
      import('/src/api/index.ts'),
      import('/src/auth/sessionRuntime.ts'),
    ]);
    const phases: string[] = [];
    const dispose = runtime.initAuthSessionRuntime(apiV2, {
      setPhase: (phase) => phases.push(phase),
      onAuthenticated: () => undefined,
      onTerminal: () => undefined,
    });
    try {
      const login = await apiV2.post(loginEndpoint, { email, password, rememberMe: false }, { _skipAuthRefresh: true } as never);
      runtime.applyLoginResponse(login.data as Record<string, unknown>);
      const response = await apiV2.get('/auth/sessions');
      const payload = response.data as { sessions?: unknown };
      return { status: response.status, hasSessions: Array.isArray(payload.sessions), phases };
    } finally { dispose(); }
  }, fixture);

  expect(outcome.status).toBe(200);
  expect(outcome.hasSessions).toBe(true);
  expect(getRequests).toBe(2);
  expect(refreshRequests).toBe(1);
  expect(authorizationPresent).toEqual([true, true]);
  expect(replayAuthorizationRotated).toBe(true);
  expect(outcome.phases.filter((phase) => phase === 'refreshing')).toHaveLength(1);
});
