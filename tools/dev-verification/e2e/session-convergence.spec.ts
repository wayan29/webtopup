import { expect, test, type Route } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

const CALLERS = 10;

test('ten concurrent safe GET callers converge on one production refresh', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-convergence-${mobile ? 'mobile' : 'desktop'}`);
  let initialRequests = 0;
  let replayRequests = 0;
  let refreshRequests = 0;
  const authorizationPresent: boolean[] = [];
  const baselineAuthorizationByCaller = new Map<string, string | undefined>();
  const replayAuthorizationRotated: boolean[] = [];
  const attemptsByCaller = new Map<string, number>();
  const pendingInitialRoutes: Route[] = [];
  let initialRequestsAtRefresh = -1;
  const authOutcomes: Array<{ path: string; status: number; code: string | null }> = [];
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname;
    if (path !== `/api/v2${fixture.loginEndpoint}` && path !== '/api/v2/auth/refresh') return;
    let code: string | null = null;
    try { const body = await response.json(); code = body?.error?.code ?? body?.code ?? null; } catch { /* bounded status/path remain */ }
    authOutcomes.push({ path, status: response.status(), code });
  });

  await page.route('**/api/v2/auth/refresh', async (route) => {
    expect(route.request().method()).toBe('POST');
    refreshRequests += 1;
    initialRequestsAtRefresh = initialRequests;
    await route.continue();
  });
  await page.route('**/api/v2/auth/sessions*', async (route) => {
    expect(route.request().method()).toBe('GET');
    const authorization = route.request().headers().authorization;
    authorizationPresent.push(typeof authorization === 'string');
    const parsed = new URL(route.request().url());
    if (parsed.pathname !== '/api/v2/auth/sessions') { await route.continue(); return; }
    const caller = parsed.searchParams.get('caller') ?? '';
    const attempt = (attemptsByCaller.get(caller) ?? 0) + 1;
    attemptsByCaller.set(caller, attempt);
    if (attempt === 1) {
      initialRequests += 1;
      baselineAuthorizationByCaller.set(caller, authorization);
      pendingInitialRoutes.push(route);
      if (pendingInitialRoutes.length === CALLERS) {
        await Promise.all(pendingInitialRoutes.map((pending) => pending.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUTH_ACCESS_EXPIRED', message: 'synthetic typed expiry' } }) })));
      }
      return;
    }
    replayRequests += 1;
    const baseline = baselineAuthorizationByCaller.get(caller);
    replayAuthorizationRotated.push(Boolean(baseline && authorization && baseline !== authorization));
    await route.continue();
  });

  await page.goto('/vite.svg');
  let outcome: { statuses: number[]; envelopesValid: boolean; refreshingCount: number };
  try { outcome = await page.evaluate(async ({ email, password, loginEndpoint, callers }) => {
    const [{ apiV2 }, runtime] = await Promise.all([import('/src/api/index.ts'), import('/src/auth/sessionRuntime.ts')]);
    const phases: string[] = [];
    const dispose = runtime.initAuthSessionRuntime(apiV2, { setPhase: (phase) => phases.push(phase), onAuthenticated: () => undefined, onTerminal: () => undefined });
    let primaryFailed = false;
    try {
      const login = await apiV2.post(loginEndpoint, { email, password, rememberMe: false }, { _skipAuthRefresh: true } as never);
      runtime.applyLoginResponse(login.data as Record<string, unknown>);
      runtime.getAuthCoordinator()?.cancelProactive();
      const results = await Promise.all(Array.from({ length: callers }, (_, index) => apiV2.get(`/auth/sessions?caller=${index}`)));
      return { statuses: results.map(({ status }) => status), envelopesValid: results.every(({ data }) => Array.isArray((data as { sessions?: unknown }).sessions)), refreshingCount: phases.filter((phase) => phase === 'refreshing').length };
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      try { await apiV2.post('/auth/logout', {}, { _skipAuthRefresh: true } as never); }
      catch (cleanupError) { if (!primaryFailed) throw cleanupError; }
      finally { dispose(); }
    }
  }, { ...fixture, callers: CALLERS }); }
  catch { throw new Error(`convergence auth outcomes ${JSON.stringify(authOutcomes)}`); }

  expect(outcome.statuses).toEqual(Array(CALLERS).fill(200));
  expect(outcome.envelopesValid).toBe(true);
  expect(initialRequests).toBe(CALLERS);
  expect(replayRequests).toBe(CALLERS);
  expect(refreshRequests).toBe(1);
  expect(initialRequestsAtRefresh).toBe(CALLERS);
  expect(outcome.refreshingCount).toBe(1);
  expect(authorizationPresent).toHaveLength(CALLERS * 2);
  expect(replayAuthorizationRotated).toEqual(Array(CALLERS).fill(true));
  expect([...attemptsByCaller.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual(Array.from({ length: CALLERS }, (_, index) => [String(index), 2]));
});
