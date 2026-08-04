import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { expect, test, type Page } from '@playwright/test';
import { activateFault, readFaultEvidence } from '../faults.ts';
import { loginFixture } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));

async function initialize(page: Page): Promise<void> {
  await page.goto('/vite.svg');
  await page.evaluate(async () => {
    const [{ apiV2 }, runtime, tokenModule] = await Promise.all([import('/src/api/index.ts'), import('/src/auth/sessionRuntime.ts'), import('/src/auth/accessToken.ts')]);
    const state = { authenticated: 0, terminal: 0, phases: [] as string[] };
    const dispose = runtime.initAuthSessionRuntime(apiV2, {
      setPhase: (phase) => state.phases.push(phase),
      onAuthenticated: () => { state.authenticated += 1; },
      onTerminal: () => { state.terminal += 1; },
    });
    Object.assign(window, { __refreshRace: { apiV2, runtime, tokenStore: tokenModule.accessTokenStore, state, dispose } });
  });
}

const runtimeSnapshot = (page: Page) => page.evaluate(() => {
  const race = (window as never as { __refreshRace: any }).__refreshRace;
  return { tokenPresent: Boolean(race.tokenStore.get()), phase: race.state.phases.at(-1), terminal: race.state.terminal };
});

async function browserTokensMatch(pageA: Page, pageB: Page): Promise<boolean> {
  const channelName = `refresh-race-compare-${crypto.randomUUID()}`;
  const waiting = pageA.evaluate((name) => new Promise<boolean>((resolve) => {
    const channel = new BroadcastChannel(name);
    const timer = setTimeout(() => { channel.close(); resolve(false); }, 2_000);
    channel.onmessage = (event) => {
      clearTimeout(timer);
      const local = (window as never as { __refreshRace: any }).__refreshRace.tokenStore.get();
      channel.close();
      resolve(Boolean(local && typeof event.data === 'string' && local === event.data));
    };
  }), channelName);
  await pageB.evaluate((name) => {
    const channel = new BroadcastChannel(name);
    channel.postMessage((window as never as { __refreshRace: any }).__refreshRace.tokenStore.get());
    channel.close();
  }, channelName);
  return waiting;
}

test('two real pages converge on one authoritative refresh generation', async ({ context }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-refresh-race-${mobile ? 'mobile' : 'desktop'}`);
  const [shared, node] = await Promise.all([envFile(path.join(root, '.dev-verification/env/shared.env')), envFile(path.join(root, '.dev-verification/env/node.env'))]);
  const client = new MongoClient(shared.MONGO_URI!);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await client.connect();
  try {
    await initialize(pageA);
    await initialize(pageB);
    expect(await pageA.evaluate(() => typeof BroadcastChannel === 'function')).toBe(true);
    expect(await pageB.evaluate(() => typeof BroadcastChannel === 'function')).toBe(true);

    expect(await pageA.evaluate(async ({ email, password, loginEndpoint }) => {
      const race = (window as never as { __refreshRace: any }).__refreshRace;
      try {
        const response = await race.apiV2.post(loginEndpoint, { email, password, rememberMe: false }, { _skipAuthRefresh: true });
        race.runtime.applyLoginResponse(response.data);
        race.runtime.getAuthCoordinator()?.cancelProactive();
        return { status: response.status, code: null };
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: { error?: { code?: string }; code?: string } } }).response;
        return { status: response?.status ?? 0, code: response?.data?.error?.code ?? response?.data?.code ?? null };
      }
    }, fixture)).toEqual({ status: 200, code: null });
    const user = await client.db(shared.MONGO_DB).collection('users').findOne({ email: fixture.email }, { projection: { _id: 1 } });
    expect(Boolean(user?._id)).toBe(true);
    const initialSessions = await client.db(shared.MONGO_DB).collection('authsessions').find({ userId: user!._id, status: 'active' }, { projection: { _id: 1, refreshGeneration: 1, status: 1 } }).toArray();
    expect(initialSessions.map(({ refreshGeneration, status }) => ({ generation: refreshGeneration, status }))).toEqual([{ generation: 0, status: 'active' }]);
    const sessionId = initialSessions[0]!._id;

    await pageB.evaluate(async () => {
      const race = (window as never as { __refreshRace: any }).__refreshRace;
      await race.runtime.getAuthCoordinator()?.bootstrapSession();
      race.runtime.getAuthCoordinator()?.cancelProactive();
    });
    await expect.poll(() => runtimeSnapshot(pageA)).toEqual({ tokenPresent: true, phase: 'authenticated', terminal: 0 });
    await expect.poll(() => runtimeSnapshot(pageB)).toEqual({ tokenPresent: true, phase: 'authenticated', terminal: 0 });

    const bootstrapped = await client.db(shared.MONGO_DB).collection('authsessions').findOne({ _id: sessionId }, { projection: { refreshGeneration: 1, status: 1 } });
    expect({ generation: bootstrapped?.refreshGeneration, status: bootstrapped?.status }).toEqual({ generation: 1, status: 'active' });
    const activationId = await activateFault({ stateDir: path.join(root, '.dev-verification'), capability: node.LOCAL_DESTRUCTIVE_CAPABILITY!, scenario: 'refresh_two_request_barrier', ttlMs: 10_000 });
    const outcomes = await Promise.all([pageA, pageB].map((page) => page.evaluate(async () => {
      const race = (window as never as { __refreshRace: any }).__refreshRace;
      try {
        const result = await race.runtime.getAuthCoordinator()?.refreshOnce('race-verification');
        return { succeeded: Boolean(result?.accessToken), terminal: race.state.terminal };
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: { error?: { code?: string } } } }).response;
        return { succeeded: false, terminal: race.state.terminal, status: response?.status ?? 0, code: response?.data?.error?.code ?? null, errorName: error instanceof Error ? error.name : 'UnknownError' };
      }
    })));

    const succeeded = outcomes.filter((outcome) => outcome.succeeded);
    const superseded = outcomes.filter((outcome) => !outcome.succeeded && outcome.errorName === 'CoordinatorOperationSupersededError' && outcome.status === 0 && outcome.code === null && outcome.terminal === 0);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.length + superseded.length).toBe(2);
    await expect.poll(() => readFaultEvidence(path.join(root, '.dev-verification'))).toEqual({ activationId, scenario: 'refresh_two_request_barrier', queued: 2, released: 2 });
    await expect.poll(() => runtimeSnapshot(pageA)).toEqual({ tokenPresent: true, phase: 'authenticated', terminal: 0 });
    await expect.poll(() => runtimeSnapshot(pageB)).toEqual({ tokenPresent: true, phase: 'authenticated', terminal: 0 });
    await expect.poll(() => browserTokensMatch(pageA, pageB)).toBe(true);
    const session = await client.db(shared.MONGO_DB).collection('authsessions').findOne({ _id: sessionId }, { projection: { refreshGeneration: 1, status: 1, immediatePredecessor: 1 } });
    expect({ generation: session?.refreshGeneration, status: session?.status, predecessorPresent: Boolean(session?.immediatePredecessor) }).toEqual({ generation: 2, status: 'active', predecessorPresent: true });
  } finally {
    try { await pageA.evaluate(async () => { const race = (window as never as { __refreshRace?: any }).__refreshRace; if (race) await race.apiV2.post('/auth/logout', {}, { _skipAuthRefresh: true }); }); }
    catch { /* preserve primary verification outcome */ }
    await Promise.allSettled([
      pageA.evaluate(() => (window as never as { __refreshRace?: any }).__refreshRace?.dispose()),
      pageB.evaluate(() => (window as never as { __refreshRace?: any }).__refreshRace?.dispose()),
    ]);
    await Promise.all([pageA.close(), pageB.close()]);
    await client.close();
  }
});
