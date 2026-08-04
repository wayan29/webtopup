import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { loginFixture } from '../e2e/fixtures.ts';
import path from 'node:path';

const exec = promisify(execFile); const root = path.resolve(__dirname, '..', '..', '..');
const command = async (name: string) => (await exec(process.execPath, ['--import', 'tsx', 'tools/dev-verification/cli.ts', name], { cwd: root, env: process.env })).stdout.trim();
const restoreDisabled = async () => {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await command('host-up'); return; } catch (error) { last = error; await command('host-down').catch(() => undefined); }
  }
  throw last;
};
async function login(page: Page, alias: string) { const fixture = await loginFixture(alias); const outcomes: Array<{ status: number; code: string | null }> = []; page.on('response', async (response) => { if (new URL(response.url()).pathname !== `/api/v2${fixture.loginEndpoint}`) return; let code: string | null = null; try { const body = await response.json(); code = body?.error?.code ?? body?.code ?? null; } catch { /* sanitized */ } outcomes.push({ status: response.status(), code }); }); await page.goto(fixture.loginPath); await page.getByLabel('Email').fill(fixture.email); await page.getByLabel('Password').fill(fixture.password); await page.getByRole('button', { name: 'Masuk sekarang' }).click(); await expect.poll(() => outcomes.length).toBe(1); return { fixture, outcome: outcomes[0]! }; }

test.describe.configure({ timeout: 180_000 });
test('real rollout transition preserves existing refresh drain and closes legacy fallback', async ({ browser }, testInfo) => {
  let csContext: BrowserContext | null = null; let legacyContext: BrowserContext | null = null; let rejectedContext: BrowserContext | null = null; let primary: unknown = null; const cleanupErrors: unknown[] = [];
  try {
    await command('host-up-session-rollout-pre-cutoff');
    csContext = await browser.newContext(testInfo.project.use); legacyContext = await browser.newContext(testInfo.project.use);
    const cs = await csContext.newPage(); expect((await login(cs, 'staff-session-a')).outcome.status).toBe(200); await expect(cs).toHaveURL(/\/admin\/dashboard$/); expect((await csContext.cookies()).some(({ name }) => name === '__Secure-wb_refresh')).toBe(true);
    const legacy = await legacyContext.newPage(); const legacyLogin = await login(legacy, 'member-enrollment-desktop'); if (legacyLogin.outcome.status !== 200) throw new Error(`legacy login ${JSON.stringify(legacyLogin.outcome)}`); await expect(legacy).toHaveURL(/\/dashboard$/); expect((await legacyContext.cookies()).some(({ name }) => name === '__Secure-wb_refresh')).toBe(false);
    await command('host-down'); await command('host-up-session-rollout-post-cutoff');
    rejectedContext = await browser.newContext(testInfo.project.use); const rejected = await rejectedContext.newPage(); const rejectedLogin = await login(rejected, 'member-enrollment-mobile'); expect(rejectedLogin.outcome).toEqual({ status: 503, code: null }); await expect(rejected).toHaveURL(/\/login$/); expect((await rejectedContext.cookies()).some(({ name }) => name === '__Secure-wb_refresh')).toBe(false);
    const refresh = await cs.evaluate(async () => { const api = (await import('/src/api/index.ts')).apiV2; try { const response = await api.post('/auth/refresh', {}, { _skipAuthRefresh: true }); return { status: response.status, accessPresent: typeof response.data?.accessToken === 'string' }; } catch (error) { const response = (error as any).response; return { status: response?.status ?? 0, accessPresent: false }; } });
    expect(refresh).toEqual({ status: 200, accessPresent: true });
  } catch (error) { primary = error; }
  for (const close of [() => csContext?.close(), () => legacyContext?.close(), () => rejectedContext?.close(), () => command('host-down')]) try { await close(); } catch (error) { cleanupErrors.push(error); }
  try { await restoreDisabled(); const status = JSON.parse(await command('status')); expect(status.rollout).toEqual({ enabled: false, member: 0, cs: 0, admin: 0, owner: 0 }); } catch (error) { cleanupErrors.push(error); }
  try { await command('host-down'); } catch (error) { cleanupErrors.push(error); }
  if (primary && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], 'rollout transition and restoration failed'); if (primary) throw primary; if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'rollout restoration failed');
});
