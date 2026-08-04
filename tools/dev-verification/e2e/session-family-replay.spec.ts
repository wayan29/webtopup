import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId, MongoClient } from 'mongodb';
import { expect, test, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { loginFixture, type FixtureLogin } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const refreshName = '__Secure-wb_refresh';
const recoveryName = '__Secure-wb_rotation_recovery';
const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));

async function login(page: Page, fixture: FixtureLogin): Promise<{ status: number; code: string | null }> {
  await page.goto('/vite.svg');
  return page.evaluate(async ({ email, password, loginEndpoint }) => {
    const response = await fetch(`/api/v2${loginEndpoint}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, rememberMe: false }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: { code?: string } };
    return { status: response.status, code: payload.error?.code ?? null };
  }, fixture);
}

async function refresh(page: Page): Promise<{ status: number; code: string | null }> {
  return page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice('wb_csrf='.length);
    if (!csrf) return { status: 0, code: 'MISSING_CSRF' };
    const response = await fetch('/api/v2/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: '{}' });
    const payload = await response.json().catch(() => ({})) as { error?: { code?: string } };
    return { status: response.status, code: payload.error?.code ?? null };
  });
}

const credentialCookies = async (context: BrowserContext) => Object.fromEntries((await context.cookies()).filter(({ name }) => name === refreshName || name === recoveryName).map((cookie) => [cookie.name, cookie]));
const sessionIdFromRefresh = (value: string): ObjectId => new ObjectId(value.split('.')[0]);
const invalidRecoveryForSameFamily = (value: string): string => {
  const separator = value.indexOf('.');
  if (separator < 1 || separator === value.length - 1) throw new Error('invalid synthetic recovery credential');
  const secret = value.slice(separator + 1);
  const replacement = secret[0] === 'A' ? 'B' : 'A';
  return `${value.slice(0, separator + 1)}${replacement}${secret.slice(1)}`;
};

test('sequential predecessor replay revokes only the compromised session family', async ({ browser }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-family-replay-${mobile ? 'mobile' : 'desktop'}`);
  const shared = await envFile(path.join(root, '.dev-verification/env/shared.env'));
  const client = new MongoClient(shared.MONGO_URI!);
  const projectContext = testInfo.project.use as BrowserContextOptions;
  const compromisedContext = await browser.newContext(projectContext);
  const healthyContext = await browser.newContext(projectContext);
  const compromised = await compromisedContext.newPage();
  const healthy = await healthyContext.newPage();
  await client.connect();
  try {
    expect(await login(compromised, fixture)).toEqual({ status: 200, code: null });
    expect(await login(healthy, fixture)).toEqual({ status: 200, code: null });
    if (mobile) {
      expect({ narrowViewport: compromised.viewportSize()!.width < 600, touchEnabled: await compromised.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrowViewport: true, touchEnabled: true });
      expect({ narrowViewport: healthy.viewportSize()!.width < 600, touchEnabled: await healthy.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrowViewport: true, touchEnabled: true });
    }
    const predecessor = await credentialCookies(compromisedContext);
    const healthyInitial = await credentialCookies(healthyContext);
    expect(Object.keys(predecessor).sort()).toEqual([recoveryName, refreshName].sort());
    expect(Object.keys(healthyInitial).sort()).toEqual([recoveryName, refreshName].sort());
    const compromisedId = sessionIdFromRefresh(predecessor[refreshName]!.value);
    const healthyId = sessionIdFromRefresh(healthyInitial[refreshName]!.value);
    expect(compromisedId.equals(healthyId)).toBe(false);

    expect(await refresh(compromised)).toEqual({ status: 200, code: null });
    const rotated = await credentialCookies(compromisedContext);
    expect({ refreshChanged: predecessor[refreshName]!.value !== rotated[refreshName]!.value, recoveryChanged: predecessor[recoveryName]!.value !== rotated[recoveryName]!.value }).toEqual({ refreshChanged: true, recoveryChanged: true });
    const afterRotation = await client.db(shared.MONGO_DB).collection('authsessions').findOne({ sessionId: compromisedId }, { projection: { refreshGeneration: 1, status: 1, 'immediatePredecessor.raceGraceUntil': 1 } });
    expect({ generation: afterRotation?.refreshGeneration, status: afterRotation?.status }).toEqual({ generation: 1, status: 'active' });
    const raceGraceUntil = afterRotation?.immediatePredecessor?.raceGraceUntil;
    expect(raceGraceUntil instanceof Date).toBe(true);
    const waitMs = Math.max(0, raceGraceUntil!.getTime() - Date.now() + 1_100);
    expect(waitMs).toBeLessThanOrEqual(7_000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await compromisedContext.addCookies([
      { ...predecessor[refreshName]!, value: predecessor[refreshName]!.value },
      { ...predecessor[recoveryName]!, value: invalidRecoveryForSameFamily(predecessor[recoveryName]!.value) },
    ]);
    expect(await refresh(compromised)).toEqual({ status: 401, code: 'AUTH_REFRESH_REUSED' });
    expect(Object.keys(await credentialCookies(compromisedContext))).toEqual([]);
    expect(Object.keys(await credentialCookies(healthyContext)).sort()).toEqual([recoveryName, refreshName].sort());

    const families = await client.db(shared.MONGO_DB).collection('authsessions').find({ sessionId: { $in: [compromisedId, healthyId] } }, { projection: { sessionId: 1, refreshGeneration: 1, status: 1 } }).toArray();
    const state = new Map(families.map((family) => [family.sessionId.toHexString(), { generation: family.refreshGeneration, status: family.status }]));
    expect(state.get(compromisedId.toHexString())).toEqual({ generation: 1, status: 'revoked' });
    expect(state.get(healthyId.toHexString())).toEqual({ generation: 0, status: 'active' });
    expect(await refresh(healthy)).toEqual({ status: 200, code: null });
    const healthyRotated = await credentialCookies(healthyContext);
    expect({ refreshChanged: healthyInitial[refreshName]!.value !== healthyRotated[refreshName]!.value, recoveryChanged: healthyInitial[recoveryName]!.value !== healthyRotated[recoveryName]!.value }).toEqual({ refreshChanged: true, recoveryChanged: true });
    const healthyAfter = await client.db(shared.MONGO_DB).collection('authsessions').findOne({ sessionId: healthyId }, { projection: { refreshGeneration: 1, status: 1 } });
    expect({ generation: healthyAfter?.refreshGeneration, status: healthyAfter?.status }).toEqual({ generation: 1, status: 'active' });
  } finally {
    const logout = (page: Page) => page.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice(8);
      if (csrf) await fetch('/api/v2/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: '{}' });
    }).catch(() => undefined);
    await Promise.all([logout(compromised), logout(healthy)]);
    await Promise.all([compromisedContext.close(), healthyContext.close()]);
    await client.close();
  }
});
