import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { expect, test, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { loginFixture, type FixtureLogin } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const cookieNames = ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery', 'wb_csrf'];
const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const credentialCount = async (context: BrowserContext) => (await context.cookies()).filter(({ name, domain }) => cookieNames.includes(name) && domain === 'webtopup.local.test').length;
const sidFromCookies = async (context: BrowserContext): Promise<ObjectId> => {
  const value = (await context.cookies()).find(({ name }) => name === '__Secure-wb_refresh')?.value;
  if (!value) throw new Error('refresh credential is unavailable');
  return new ObjectId(value.split('.')[0]);
};
async function initializeAndLogin(page: Page, fixture: FixtureLogin, deviceName: string): Promise<number> {
  await page.goto('/vite.svg');
  return page.evaluate(async ({ fixture, deviceName }) => {
    const [{ apiV2 }, runtime, tokenModule] = await Promise.all([import('/src/api/index.ts'), import('/src/auth/sessionRuntime.ts'), import('/src/auth/accessToken.ts')]);
    const state = { phases: [] as string[], terminalCodes: [] as string[] };
    const dispose = runtime.initAuthSessionRuntime(apiV2, { setPhase: (phase) => state.phases.push(phase), onAuthenticated: () => undefined, onTerminal: (code) => state.terminalCodes.push(code) });
    const response = await apiV2.post(fixture.loginEndpoint, { email: fixture.email, password: fixture.password, rememberMe: false, deviceName }, { _skipAuthRefresh: true });
    runtime.applyLoginResponse(response.data); runtime.getAuthCoordinator()?.cancelProactive();
    Object.assign(window, { __targetRevoke: { apiV2, runtime, tokenStore: tokenModule.accessTokenStore, state, dispose } });
    return response.status;
  }, { fixture, deviceName });
}

test('session listing and targeted revocation terminate only the selected device family', async ({ browser }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-target-revoke-${mobile ? 'mobile' : 'desktop'}`);
  const foreignFixture = await loginFixture(`staff-target-foreign-${mobile ? 'mobile' : 'desktop'}`);
  const shared = await envFile(path.join(root, '.dev-verification/env/shared.env'));
  const mongo = new MongoClient(shared.MONGO_URI!); const options = testInfo.project.use as BrowserContextOptions;
  let actorContext: BrowserContext | null = null; let peerContext: BrowserContext | null = null; let foreignContext: BrowserContext | null = null;
  let actor: Page | null = null; let peer: Page | null = null; let foreign: Page | null = null; let primaryFailed = false; let userId: ObjectId | null = null; let foreignUserId: ObjectId | null = null;
  const capturedSids: ObjectId[] = []; let foreignCapturedSid: ObjectId | null = null; let cleanupError: unknown = null;
  try {
    await mongo.connect();
    actorContext = await browser.newContext(options); peerContext = await browser.newContext(options); foreignContext = await browser.newContext(options);
    actor = await actorContext.newPage(); peer = await peerContext.newPage(); foreign = await foreignContext.newPage();
    const users = await mongo.db(shared.MONGO_DB).collection('users').find({ email: { $in: [fixture.email, foreignFixture.email] } }, { projection: { _id: 1, email: 1 } }).toArray();
    userId = users.find((user) => user.email === fixture.email)?._id ?? null; foreignUserId = users.find((user) => user.email === foreignFixture.email)?._id ?? null;
    expect({ actorFound: Boolean(userId), foreignFound: Boolean(foreignUserId), distinct: Boolean(userId && foreignUserId && !userId.equals(foreignUserId)) }).toEqual({ actorFound: true, foreignFound: true, distinct: true });
    expect(await initializeAndLogin(actor, fixture, 'Target actor')).toBe(200); const actorSid = await sidFromCookies(actorContext); capturedSids.push(actorSid);
    expect(await initializeAndLogin(peer, fixture, 'Target peer')).toBe(200); const peerSid = await sidFromCookies(peerContext); capturedSids.push(peerSid);
    expect(await initializeAndLogin(foreign, foreignFixture, 'Foreign target')).toBe(200); const foreignSid = await sidFromCookies(foreignContext); foreignCapturedSid = foreignSid;
    expect({ actorPeerDistinct: !actorSid.equals(peerSid), foreignDistinct: !foreignSid.equals(actorSid) && !foreignSid.equals(peerSid) }).toEqual({ actorPeerDistinct: true, foreignDistinct: true });
    if (mobile) expect(await Promise.all([actor, peer, foreign].map(async (page) => ({ narrow: page.viewportSize()!.width < 600, touch: await page.evaluate(() => navigator.maxTouchPoints > 0) })))).toEqual([{ narrow: true, touch: true }, { narrow: true, touch: true }, { narrow: true, touch: true }]);

    const listed = await actor.evaluate(async () => {
      const response = await (window as never as { __targetRevoke: any }).__targetRevoke.apiV2.get('/auth/sessions');
      const sessions = response.data.sessions as Array<Record<string, unknown>>;
      const current = sessions.find((session) => session.current === true); const peer = sessions.find((session) => session.current === false);
      if (typeof peer?.sessionId === 'string') Object.assign(window, { __targetPeerSid: peer.sessionId });
      const allowedKeys = ['createdAt', 'current', 'deviceLabel', 'ipContext', 'lastUsedAt', 'sessionId', 'userAgentSummary'];
      const summariesExact = sessions.every((session) => JSON.stringify(Object.keys(session).sort()) === JSON.stringify(allowedKeys));
      const valueSafe = (entry: unknown): boolean => typeof entry !== 'string' || (!/Bearer\s+\S+/i.test(entry) && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(entry) && !/^[a-f0-9]{24}\.[A-Za-z0-9_-]{20,}$/.test(entry));
      const summaryValuesSafe = sessions.every((session) => Object.values(session).every(valueSafe));
      return { status: response.status, count: sessions.length, currentCount: sessions.filter((session) => session.current === true).length, peerCount: sessions.filter((session) => session.current === false).length, summariesExact, summaryValuesSafe, idsWellFormed: sessions.every((session) => typeof session.sessionId === 'string' && /^[a-f0-9]{24}$/.test(session.sessionId as string)), currentPresent: Boolean(current), peerPresent: Boolean(peer) };
    });
    expect(listed).toEqual({ status: 200, count: 2, currentCount: 1, peerCount: 1, summariesExact: true, summaryValuesSafe: true, idsWellFormed: true, currentPresent: true, peerPresent: true });

    const foreignAttempt = await actor.evaluate(async (sessionId) => {
      try { await (window as never as { __targetRevoke: any }).__targetRevoke.apiV2.post('/auth/sessions/revoke-device', { sessionId }, { authRetrySafe: false }); return { status: 200, code: null }; }
      catch (error) { const response = (error as { response?: { status?: number; data?: { error?: { code?: string } } } }).response; return { status: response?.status ?? 0, code: response?.data?.error?.code ?? null }; }
    }, foreignSid.toHexString());
    expect(foreignAttempt).toEqual({ status: 404, code: 'AUTH_SESSION_NOT_FOUND' });
    const foreignStillActive = await mongo.db(shared.MONGO_DB).collection('authsessions').countDocuments({ userId: foreignUserId, sessionId: foreignSid, status: 'active', ownsSlot: true });
    expect(foreignStillActive).toBe(1);

    const revoked = await actor.evaluate(async () => { const target = (window as never as { __targetPeerSid?: string }).__targetPeerSid; const response = await (window as never as { __targetRevoke: any }).__targetRevoke.apiV2.post('/auth/sessions/revoke-device', { sessionId: target }, { authRetrySafe: false }); return { status: response.status, ok: response.data?.ok === true }; });
    expect(revoked).toEqual({ status: 200, ok: true });
    const relisted = await actor.evaluate(async () => { const sessions = (await (window as never as { __targetRevoke: any }).__targetRevoke.apiV2.get('/auth/sessions')).data.sessions as Array<{ current: boolean }>; return { count: sessions.length, currentCount: sessions.filter((session) => session.current).length }; });
    expect(relisted).toEqual({ count: 1, currentCount: 1 });
    const rows = await mongo.db(shared.MONGO_DB).collection('authsessions').find({ userId, sessionId: { $in: [actorSid, peerSid] } }, { projection: { sessionId: 1, status: 1, ownsSlot: 1, refreshGeneration: 1 } }).toArray();
    const actorRow = rows.find((row) => row.sessionId.equals(actorSid)); const peerRow = rows.find((row) => row.sessionId.equals(peerSid));
    expect({ count: rows.length, actorActive: actorRow?.status === 'active' && actorRow?.ownsSlot === true && actorRow?.refreshGeneration === 0, peerRevoked: peerRow?.status === 'revoked' && peerRow?.ownsSlot === false && peerRow?.refreshGeneration === 0 }).toEqual({ count: 2, actorActive: true, peerRevoked: true });

    const peerTerminal = await peer.evaluate(async () => {
      const testRuntime = (window as never as { __targetRevoke: any }).__targetRevoke; const coordinator = testRuntime.runtime.getAuthCoordinator();
      if (!coordinator) return { coordinatorPresent: false, tokenPresent: true, phase: null, terminalCodes: [], status: 0, code: null };
      let status = 0; let code: string | null = null; try { await coordinator.refreshOnce('target-device-revocation'); } catch (error) { const response = (error as { response?: { status?: number; data?: { error?: { code?: string } } } }).response; status = response?.status ?? 0; code = response?.data?.error?.code ?? null; }
      return { coordinatorPresent: true, tokenPresent: Boolean(testRuntime.tokenStore.get()), phase: testRuntime.state.phases.at(-1), terminalCodes: testRuntime.state.terminalCodes, status, code };
    });
    expect(peerTerminal).toEqual({ coordinatorPresent: true, tokenPresent: false, phase: 'revoked', terminalCodes: ['AUTH_SESSION_REVOKED'], status: 401, code: 'AUTH_SESSION_REVOKED' }); expect(await credentialCount(peerContext)).toBe(0);
    const actorRefresh = await actor.evaluate(async () => { const coordinator = (window as never as { __targetRevoke: any }).__targetRevoke.runtime.getAuthCoordinator(); if (!coordinator) return { coordinatorPresent: false, tokenPresent: false }; await coordinator.refreshOnce('actor-remains-active'); return { coordinatorPresent: true, tokenPresent: Boolean((window as never as { __targetRevoke: any }).__targetRevoke.tokenStore.get()) }; });
    const actorRotated = await mongo.db(shared.MONGO_DB).collection('authsessions').countDocuments({ userId, sessionId: actorSid, status: 'active', ownsSlot: true, refreshGeneration: 1 });
    expect({ ...actorRefresh, mongoGenerationOne: actorRotated === 1 }).toEqual({ coordinatorPresent: true, tokenPresent: true, mongoGenerationOne: true });
  } catch (error) { primaryFailed = true; throw error; }
  finally {
    if (capturedSids.length > 0 && userId) try { await mongo.db(shared.MONGO_DB).collection('authsessions').updateMany({ userId, sessionId: { $in: capturedSids }, status: { $in: ['active', 'locked'] } }, { $set: { status: 'revoked', ownsSlot: false, revokeReason: 'verification_cleanup' } }); } catch (error) { cleanupError = error; }
    if (foreignUserId && foreignCapturedSid) try { await mongo.db(shared.MONGO_DB).collection('authsessions').updateMany({ userId: foreignUserId, sessionId: foreignCapturedSid, status: { $in: ['active', 'locked'] } }, { $set: { status: 'revoked', ownsSlot: false, revokeReason: 'verification_cleanup' } }); } catch (error) { cleanupError ??= error; }
    const disposals = await Promise.allSettled([actor?.evaluate(() => (window as never as { __targetRevoke?: any }).__targetRevoke?.dispose()), peer?.evaluate(() => (window as never as { __targetRevoke?: any }).__targetRevoke?.dispose()), foreign?.evaluate(() => (window as never as { __targetRevoke?: any }).__targetRevoke?.dispose())]);
    const closes = await Promise.allSettled([actorContext?.close(), peerContext?.close(), foreignContext?.close()]); let mongoError: unknown = null; try { await mongo.close(); } catch (error) { mongoError = error; }
    if (!primaryFailed) { if (cleanupError) throw cleanupError; const disposalError = disposals.find((result) => result.status === 'rejected'); if (disposalError?.status === 'rejected') throw disposalError.reason; const closeError = closes.find((result) => result.status === 'rejected'); if (closeError?.status === 'rejected') throw closeError.reason; if (mongoError) throw mongoError; }
  }
});
