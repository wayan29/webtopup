import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { expect, test, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { loginFixture, type FixtureLogin } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const credentialNames = ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery', 'wb_csrf'];
const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const authCookies = async (context: BrowserContext) => (await context.cookies()).filter(({ name, domain }) => credentialNames.includes(name) && domain === 'webtopup.local.test').map(({ name, path, secure, httpOnly, sameSite }) => ({ name, path, secure, httpOnly, sameSite })).sort((left, right) => left.name.localeCompare(right.name));
const sessionId = async (context: BrowserContext): Promise<ObjectId> => {
  const refresh = (await context.cookies()).find(({ name }) => name === '__Secure-wb_refresh');
  if (!refresh) throw new Error('refresh credential is unavailable');
  return new ObjectId(refresh.value.split('.')[0]);
};
async function login(page: Page, fixture: FixtureLogin): Promise<number> {
  await page.goto('/vite.svg');
  return page.evaluate(async ({ email, password, loginEndpoint }) => {
    const response = await fetch(`/api/v2${loginEndpoint}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, rememberMe: false }) });
    const payload = await response.json().catch(() => ({})) as { accessToken?: string };
    if (typeof payload.accessToken === 'string') Object.assign(window, { __currentLogoutAccess: payload.accessToken });
    return response.status;
  }, fixture);
}
async function refresh(page: Page): Promise<{ status: number; code: string | null }> {
  return page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice(8);
    if (!csrf) return { status: 0, code: 'MISSING_CSRF' };
    const response = await fetch('/api/v2/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: '{}' });
    const payload = await response.json().catch(() => ({})) as { error?: { code?: string } };
    return { status: response.status, code: payload.error?.code ?? null };
  });
}

test('current-device logout revokes only the calling session family', async ({ browser }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-current-logout-${mobile ? 'mobile' : 'desktop'}`);
  const shared = await envFile(path.join(root, '.dev-verification/env/shared.env'));
  const mongo = new MongoClient(shared.MONGO_URI!);
  const options = testInfo.project.use as BrowserContextOptions;
  let currentContext: BrowserContext | null = null;
  let otherContext: BrowserContext | null = null;
  let current: Page | null = null;
  let other: Page | null = null;
  let primaryFailed = false;
  let otherSid: ObjectId | null = null;
  try {
    await mongo.connect();
    currentContext = await browser.newContext(options);
    otherContext = await browser.newContext(options);
    current = await currentContext.newPage();
    other = await otherContext.newPage();
    expect(await login(current, fixture)).toBe(200);
    expect(await login(other, fixture)).toBe(200);
    if (mobile) {
      expect({ narrow: current.viewportSize()!.width < 600, touch: await current.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
      expect({ narrow: other.viewportSize()!.width < 600, touch: await other.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
    }
    const currentSid = await sessionId(currentContext);
    otherSid = await sessionId(otherContext);
    expect(currentSid.equals(otherSid)).toBe(false);

    const outcome = await current.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice(8);
      if (!csrf) return { status: 0, ok: false };
      const access = (window as never as { __currentLogoutAccess?: string }).__currentLogoutAccess;
      const response = await fetch('/api/v2/auth/sessions/revoke-current', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf), Authorization: `Bearer ${access}` }, body: '{}' });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean };
      return { status: response.status, ok: payload.ok === true };
    });
    expect(outcome).toEqual({ status: 200, ok: true });
    expect(await authCookies(currentContext)).toEqual([]);
    expect(await authCookies(otherContext)).toEqual([
      { name: '__Secure-wb_refresh', path: '/api/v2/auth', secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: '__Secure-wb_rotation_recovery', path: '/api/v2/auth', secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: 'wb_csrf', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
    ]);

    const rows = await mongo.db(shared.MONGO_DB).collection('authsessions').find({ sessionId: { $in: [currentSid, otherSid] } }, { projection: { sessionId: 1, refreshGeneration: 1, status: 1, ownsSlot: 1 } }).toArray();
    const states = new Map(rows.map((row) => [row.sessionId.toHexString(), { generation: row.refreshGeneration, status: row.status, ownsSlot: row.ownsSlot }]));
    expect(states.get(currentSid.toHexString())).toEqual({ generation: 0, status: 'revoked', ownsSlot: false });
    expect(states.get(otherSid.toHexString())).toEqual({ generation: 0, status: 'active', ownsSlot: true });
    expect(await refresh(other)).toEqual({ status: 200, code: null });
    const healthy = await mongo.db(shared.MONGO_DB).collection('authsessions').findOne({ sessionId: otherSid }, { projection: { refreshGeneration: 1, status: 1 } });
    expect({ generation: healthy?.refreshGeneration, status: healthy?.status }).toEqual({ generation: 1, status: 'active' });
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      const cleanupStatus = other ? await other.evaluate(async () => {
        const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice(8);
        if (!csrf) return 0;
        return (await fetch('/api/v2/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: '{}' })).status;
      }) : 0;
      if (!primaryFailed) {
        expect(cleanupStatus).toBe(200);
        const cleaned = otherSid && await mongo.db(shared.MONGO_DB).collection('authsessions').findOne({ sessionId: otherSid }, { projection: { status: 1, ownsSlot: 1 } });
        expect(cleaned && { status: cleaned.status, ownsSlot: cleaned.ownsSlot }).toEqual({ status: 'revoked', ownsSlot: false });
      }
    } catch (cleanupError) { if (!primaryFailed) throw cleanupError; }
    finally {
      const closeResults = await Promise.allSettled([currentContext?.close(), otherContext?.close()]);
      let mongoCloseError: unknown = null;
      try { await mongo.close(); } catch (error) { mongoCloseError = error; }
      if (!primaryFailed) {
        const contextCloseError = closeResults.find((result) => result.status === 'rejected');
        if (contextCloseError?.status === 'rejected') throw contextCloseError.reason;
        if (mongoCloseError) throw mongoCloseError;
      }
    }
  }
});
