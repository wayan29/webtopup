import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { expect, test, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { loginFixture, type FixtureLogin } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const cookieNames = ['__Secure-wb_refresh', '__Secure-wb_rotation_recovery', 'wb_csrf'];
const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const remainingCookies = async (context: BrowserContext) => (await context.cookies()).filter(({ name, domain }) => cookieNames.includes(name) && domain === 'webtopup.local.test').map(({ name }) => name).sort();
const sidFromCookies = async (context: BrowserContext): Promise<ObjectId> => {
  const value = (await context.cookies()).find(({ name }) => name === '__Secure-wb_refresh')?.value;
  if (!value) throw new Error('refresh credential is unavailable');
  return new ObjectId(value.split('.')[0]);
};
function decodeBase32(secret: string): Buffer {
  let bits = 0; let value = 0; const output: number[] = [];
  for (const character of secret) {
    const digit = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character.toUpperCase());
    if (digit < 0) throw new Error('invalid synthetic TOTP secret');
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { output.push((value >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(output);
}
function currentOtp(secret: string): string {
  const counter = Math.floor(Date.now() / 30_000);
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(input).digest();
  const offset = digest[19]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}
async function initializeAndLogin(page: Page, fixture: FixtureLogin, otp: string): Promise<{ status: number; stage: string; code: string | null }> {
  await page.goto('/vite.svg');
  return page.evaluate(async ({ email, password, loginEndpoint, otp }) => {
    const [{ apiV2 }, runtime, tokenModule] = await Promise.all([import('/src/api/index.ts'), import('/src/auth/sessionRuntime.ts'), import('/src/auth/accessToken.ts')]);
    const state = { phases: [] as string[], terminalCodes: [] as string[] };
    const dispose = runtime.initAuthSessionRuntime(apiV2, { setPhase: (phase) => state.phases.push(phase), onAuthenticated: () => undefined, onTerminal: (code) => state.terminalCodes.push(code) });
    let response;
    let stage = 'primary-login';
    try {
      const login = await apiV2.post(loginEndpoint, { email, password, rememberMe: false }, { _skipAuthRefresh: true });
      const challenge = (login.data as { requiresTwoFactor?: boolean; challengeToken?: string });
      if (challenge.requiresTwoFactor && typeof challenge.challengeToken === 'string') {
        stage = '2fa-verify';
        response = await apiV2.post('/auth/2fa/login-verify', { challengeToken: challenge.challengeToken, code: otp, rememberMe: false }, { _skipAuthRefresh: true });
      } else response = login;
    } catch (error) {
      const failed = (error as { response?: { status?: number; data?: { error?: { code?: string } } } }).response;
      return { status: failed?.status ?? 0, stage, code: failed?.data?.error?.code ?? null };
    }
    runtime.applyLoginResponse(response.data);
    runtime.getAuthCoordinator()?.cancelProactive();
    Object.assign(window, { __allLogout: { apiV2, runtime, tokenStore: tokenModule.accessTokenStore, state, dispose } });
    return { status: response.status, stage: 'complete', code: null };
  }, { ...fixture, otp });
}

test('step-up protected all-device logout revokes every session family', async ({ browser }, testInfo) => {
  const mobile = testInfo.project.name === 'chromium-mobile';
  const fixture = await loginFixture(`staff-logout-all-${mobile ? 'mobile' : 'desktop'}`);
  const shared = await envFile(path.join(root, '.dev-verification/env/shared.env'));
  const mongo = new MongoClient(shared.MONGO_URI!);
  const options = testInfo.project.use as BrowserContextOptions;
  let actorContext: BrowserContext | null = null; let peerContext: BrowserContext | null = null;
  let actor: Page | null = null; let peer: Page | null = null; let primaryFailed = false;
  let actorSid: ObjectId | null = null; let peerSid: ObjectId | null = null; let userId: ObjectId | null = null;
  const capturedSids: ObjectId[] = [];
  try {
    await mongo.connect();
    actorContext = await browser.newContext(options); peerContext = await browser.newContext(options);
    actor = await actorContext.newPage(); peer = await peerContext.newPage();
    const seededUser = await mongo.db(shared.MONGO_DB).collection('users').findOne({ email: fixture.email }, { projection: { _id: 1, sessionVersion: 1, twoFactorSecret: 1 } });
    expect({ found: Boolean(seededUser?._id), version: seededUser?.sessionVersion, secretPresent: typeof seededUser?.twoFactorSecret === 'string' }).toEqual({ found: true, version: 0, secretPresent: true });
    userId = seededUser!._id;
    const loginOtp = currentOtp(seededUser!.twoFactorSecret as string);
    expect(await initializeAndLogin(actor, fixture, loginOtp)).toEqual({ status: 200, stage: 'complete', code: null });
    actorSid = await sidFromCookies(actorContext); capturedSids.push(actorSid);
    expect(await initializeAndLogin(peer, fixture, loginOtp)).toEqual({ status: 200, stage: 'complete', code: null });
    peerSid = await sidFromCookies(peerContext); capturedSids.push(peerSid);
    if (mobile) {
      expect({ narrow: actor.viewportSize()!.width < 600, touch: await actor.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
      expect({ narrow: peer.viewportSize()!.width < 600, touch: await peer.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
    }
    expect(actorSid.equals(peerSid)).toBe(false);
    const user = seededUser;

    const gate = await actor.evaluate(async () => {
      const runtime = (window as never as { __allLogout: any }).__allLogout;
      try { await runtime.apiV2.post('/auth/sessions/revoke-all', {}, { _skipAuthRefresh: true }); return { status: 200, code: null, group: null }; }
      catch (error) { const response = (error as { response?: { status?: number; data?: { error?: { code?: string; actionGroup?: string } } } }).response; return { status: response?.status ?? 0, code: response?.data?.error?.code ?? null, group: response?.data?.error?.actionGroup ?? null }; }
    });
    expect(gate).toEqual({ status: 403, code: 'AUTH_STEP_UP_REQUIRED', group: 'security.sessions_all' });

    const otp = currentOtp(user!.twoFactorSecret as string);
    const grant = await actor.evaluate(async ({ password, otp }) => {
      const runtime = (window as never as { __allLogout: any }).__allLogout;
      const response = await runtime.apiV2.post('/auth/step-up', { password, otp, actionGroup: 'security.sessions_all' });
      const payload = response.data as { grantToken?: string; actionGroup?: string; expiresAt?: number };
      if (typeof payload.grantToken === 'string') Object.assign(window, { __allLogoutGrant: payload.grantToken });
      return { status: response.status, grantPresent: typeof payload.grantToken === 'string', group: payload.actionGroup, expiryPresent: typeof payload.expiresAt === 'number' };
    }, { password: fixture.password, otp });
    expect(grant).toEqual({ status: 200, grantPresent: true, group: 'security.sessions_all', expiryPresent: true });

    const revoked = await actor.evaluate(async () => {
      const runtime = (window as never as { __allLogout: any }).__allLogout;
      const token = (window as never as { __allLogoutGrant?: string }).__allLogoutGrant;
      const response = await runtime.apiV2.post('/auth/sessions/revoke-all', {}, { headers: { 'X-Step-Up-Token': token }, _skipAuthRefresh: true });
      return { status: response.status, ok: response.data?.ok === true };
    });
    expect(revoked).toEqual({ status: 200, ok: true });
    expect(await remainingCookies(actorContext)).toEqual([]);

    const rows = await mongo.db(shared.MONGO_DB).collection('authsessions').find({ sessionId: { $in: [actorSid, peerSid] } }, { projection: { sessionId: 1, status: 1, ownsSlot: 1 } }).toArray();
    expect(rows).toHaveLength(2);
    const familyStates = new Map(rows.map((row) => [row.sessionId.toHexString(), { status: row.status, ownsSlot: row.ownsSlot }]));
    expect(familyStates.size).toBe(2);
    expect(familyStates.get(actorSid.toHexString())).toEqual({ status: 'revoked', ownsSlot: false });
    expect(familyStates.get(peerSid.toHexString())).toEqual({ status: 'revoked', ownsSlot: false });
    const versioned = await mongo.db(shared.MONGO_DB).collection('users').findOne({ _id: user!._id }, { projection: { sessionVersion: 1, globalRevocationPending: 1 } });
    expect({ version: versioned?.sessionVersion, pendingAbsent: versioned ? !Object.prototype.hasOwnProperty.call(versioned, 'globalRevocationPending') : false }).toEqual({ version: 1, pendingAbsent: true });

    const peerTerminal = await peer.evaluate(async () => {
      const runtime = (window as never as { __allLogout: any }).__allLogout;
      let status = 0; let code: string | null = null;
      try { await runtime.runtime.getAuthCoordinator()?.refreshOnce('global-revocation-verification'); }
      catch (error) { const response = (error as { response?: { status?: number; data?: { error?: { code?: string } } } }).response; status = response?.status ?? 0; code = response?.data?.error?.code ?? null; }
      return { tokenPresent: Boolean(runtime.tokenStore.get()), phase: runtime.state.phases.at(-1), terminalCodes: runtime.state.terminalCodes, status, code };
    });
    expect(peerTerminal).toEqual({ tokenPresent: false, phase: 'revoked', terminalCodes: ['AUTH_SESSION_POLICY_CHANGED'], status: 401, code: 'AUTH_SESSION_POLICY_CHANGED' });
    expect(await remainingCookies(peerContext)).toEqual([]);
  } catch (error) { primaryFailed = true; throw error; }
  finally {
    if (primaryFailed && userId && capturedSids.length > 0) {
      try {
        await mongo.db(shared.MONGO_DB).collection('authsessions').updateMany(
          { userId, sessionId: { $in: capturedSids }, status: { $in: ['active', 'locked'] } },
          { $set: { status: 'revoked', ownsSlot: false, revokeReason: 'verification_cleanup' } },
        );
      } catch { /* preserve primary verification failure */ }
    }
    await Promise.allSettled([actor?.evaluate(() => (window as never as { __allLogout?: any }).__allLogout?.dispose()), peer?.evaluate(() => (window as never as { __allLogout?: any }).__allLogout?.dispose())]);
    const closes = await Promise.allSettled([actorContext?.close(), peerContext?.close()]);
    let mongoError: unknown = null; try { await mongo.close(); } catch (error) { mongoError = error; }
    if (!primaryFailed) {
      const closeError = closes.find((result) => result.status === 'rejected');
      if (closeError?.status === 'rejected') throw closeError.reason;
      if (mongoError) throw mongoError;
    }
  }
});
