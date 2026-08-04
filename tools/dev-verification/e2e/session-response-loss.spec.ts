import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { expect, test, type Page } from '@playwright/test';
import { activateFault, readFaultEvidence } from '../faults.ts';
import { loginFixture } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const credentialNames = ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery'] as const;
const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const cookieValues = async (page: Page) => Object.fromEntries((await page.context().cookies()).filter(({ name }) => credentialNames.includes(name as typeof credentialNames[number])).map(({ name, value }) => [name, value]));

async function refresh(page: Page): Promise<{ status: number; code: string | null }> {
  return page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('wb_csrf='))?.slice('wb_csrf='.length);
    if (!csrf) return { status: 0, code: 'MISSING_CSRF' };
    try {
      const response = await fetch('/api/v2/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: '{}' });
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string } };
      return { status: response.status, code: payload.error?.code ?? null };
    } catch { return { status: 0, code: 'NETWORK_LOSS' }; }
  });
}

test('lost refresh response recovers the committed successor without rotating twice', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-response-loss-${mobile ? 'mobile' : 'desktop'}`);
  const [shared, node] = await Promise.all([envFile(path.join(root, '.dev-verification/env/shared.env')), envFile(path.join(root, '.dev-verification/env/node.env'))]);
  const client = new MongoClient(shared.MONGO_URI!);
  await client.connect();
  try {
    await page.goto('/vite.svg');
    const loginStatus = await page.evaluate(async ({ email, password, loginEndpoint }) => (await fetch(`/api/v2${loginEndpoint}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, rememberMe: false }) })).status, fixture);
    expect(loginStatus).toBe(200);
    const before = await cookieValues(page);
    const user = await client.db(shared.MONGO_DB).collection('users').findOne({ email: fixture.email }, { projection: { _id: 1 } });
    expect(Boolean(user?._id)).toBe(true);

    const activationId = await activateFault({ stateDir: path.join(root, '.dev-verification'), capability: node.LOCAL_DESTRUCTIVE_CAPABILITY!, scenario: 'refresh_response_loss_after_commit', ttlMs: 10_000 });
    const lost = await refresh(page);
    expect([0, 502, 503]).toContain(lost.status);
    await expect.poll(() => readFaultEvidence(path.join(root, '.dev-verification'))).toEqual({
      activationId, scenario: 'refresh_response_loss_after_commit', upstreamComplete: true, downstreamDestroyed: true, consumed: true,
    });
    expect(await cookieValues(page)).toEqual(before);

    const committed = await client.db(shared.MONGO_DB).collection('authsessions').findOne({ userId: user!._id }, { projection: { refreshGeneration: 1, status: 1, immediatePredecessor: 1 } });
    expect({ found: Boolean(committed), generation: committed?.refreshGeneration, status: committed?.status, predecessorPresent: Boolean(committed?.immediatePredecessor) }).toEqual({ found: true, generation: 1, status: 'active', predecessorPresent: true });

    expect(await refresh(page)).toEqual({ status: 200, code: null });
    const after = await cookieValues(page);
    expect(Object.fromEntries(credentialNames.map((name) => [name, before[name] !== after[name]]))).toEqual(Object.fromEntries(credentialNames.map((name) => [name, true])));
    const recovered = await client.db(shared.MONGO_DB).collection('authsessions').findOne({ userId: user!._id }, { projection: { refreshGeneration: 1, status: 1 } });
    expect({ generation: recovered?.refreshGeneration, status: recovered?.status }).toEqual({ generation: 1, status: 'active' });
  } finally { await client.close(); }
});
