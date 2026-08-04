import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { expect, test, type Page } from '@playwright/test';
import { loginFixture, type FixtureLogin } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const envFile = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
function decodeBase32(secret: string): Buffer { let bits = 0; let value = 0; const output: number[] = []; for (const character of secret) { const digit = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character.toUpperCase()); if (digit < 0) throw new Error('invalid synthetic TOTP secret'); value = (value << 5) | digit; bits += 5; if (bits >= 8) { output.push((value >> (bits - 8)) & 0xff); bits -= 8; } } return Buffer.from(output); }
function currentOtp(secret: string): string { const counter = Math.floor(Date.now() / 30_000); const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter)); const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(input).digest(); const offset = digest[19]! & 0x0f; const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!; return String(binary % 1_000_000).padStart(6, '0'); }
async function login(page: Page, fixture: FixtureLogin, otp: string) { const outcomes: Array<{ status: number; code: string | null }> = []; page.on('response', async (response) => { if (!response.url().endsWith('/auth/2fa/login-verify')) return; let code: string | null = null; try { code = (await response.json())?.error?.code ?? null; } catch { /* sanitized status remains authoritative */ } outcomes.push({ status: response.status(), code }); }); await page.goto(fixture.loginPath); await page.getByLabel('Email').fill(fixture.email); await page.getByLabel('Password').fill(fixture.password); await page.getByRole('button', { name: 'Masuk sekarang' }).click(); await expect(page.getByText('Verifikasi 2FA')).toBeVisible(); await page.getByLabel('Kode OTP').fill(otp); await page.getByRole('button', { name: 'Verifikasi & masuk' }).click(); await expect.poll(() => outcomes.length).toBe(1); if (outcomes[0]?.status !== 200) throw new Error(`2FA login outcome ${JSON.stringify(outcomes[0])}`); await expect(page).toHaveURL(/\/admin\/dashboard$/); }

test.describe.configure({ timeout: 90_000 });

test('wrong step-up password stays inline before exact protected action succeeds', async ({ page }, testInfo) => {
  const suffix = testInfo.project.name === 'chromium-mobile' ? 'mobile' : 'desktop';
  const fixture = await loginFixture(`staff-step-up-${suffix}`);
  const shared = await envFile(path.join(root, '.dev-verification/env/shared.env'));
  const mongo = new MongoClient(shared.MONGO_URI!);
  let primaryError: unknown = null;
  let userId: import('mongodb').ObjectId | null = null;
  try {
    await mongo.connect();
    const user = await mongo.db(shared.MONGO_DB).collection('users').findOne({ email: fixture.email }, { projection: { twoFactorSecret: 1 } });
    expect({ found: Boolean(user), secretPresent: typeof user?.twoFactorSecret === 'string' }).toEqual({ found: true, secretPresent: true });
    userId = user!._id;
    const otp = currentOtp(user!.twoFactorSecret as string);
    await login(page, fixture, otp);
    await page.goto('/admin/security/sessions');
    const gateOutcomes: Array<{ status: number; code: string | null; group: string | null }> = [];
    page.on('response', async (response) => { if (!response.url().endsWith('/auth/sessions/revoke-all')) return; let payload: any = {}; try { payload = await response.json(); } catch { /* sanitized */ } gateOutcomes.push({ status: response.status(), code: payload?.error?.code ?? null, group: payload?.error?.actionGroup ?? null }); });
    await page.getByRole('button', { name: 'Keluar dari semua perangkat' }).click();
    await page.getByRole('dialog', { name: 'Konfirmasi tindakan sesi' }).getByRole('button', { name: 'Konfirmasi' }).click();
    await expect.poll(() => gateOutcomes.length).toBe(1);
    expect(gateOutcomes[0]).toEqual({ status: 403, code: 'AUTH_STEP_UP_REQUIRED', group: 'security.sessions_all' });
    const dialog = page.getByRole('dialog', { name: 'Verifikasi ulang diperlukan' });
    await expect(dialog).toContainText('cabut semua sesi');
    const stepUpOutcomes: Array<{ status: number; code: string | null; group: string | null; grantPresent: boolean }> = [];
    page.on('response', async (response) => { if (!response.url().endsWith('/auth/step-up')) return; let payload: any = {}; try { payload = await response.json(); } catch { /* sanitized */ } stepUpOutcomes.push({ status: response.status(), code: payload?.error?.code ?? null, group: payload?.actionGroup ?? null, grantPresent: typeof payload?.grantToken === 'string' }); });
    await dialog.getByLabel('Password').fill(`${fixture.password}-wrong`);
    await dialog.getByLabel('Kode OTP').fill(otp);
    await dialog.getByRole('button', { name: 'Lanjutkan' }).click();
    await expect.poll(() => stepUpOutcomes.length).toBe(1);
    const attempts = await mongo.db(shared.MONGO_DB).collection('authsessions').findOne({ userId: user!._id, status: 'active' }, { projection: { stepUpPasswordAttempts: 1, stepUpOtpAttempts: 1 } });
    if (stepUpOutcomes[0]?.code !== 'REAUTH_PASSWORD_INVALID') throw new Error(`step-up outcome ${JSON.stringify({ status: stepUpOutcomes[0]?.status, code: stepUpOutcomes[0]?.code, group: stepUpOutcomes[0]?.group, grantPresent: stepUpOutcomes[0]?.grantPresent, passwordAttempts: attempts?.stepUpPasswordAttempts ?? 0, otpAttempts: attempts?.stepUpOtpAttempts ?? 0 })}`);
    await expect(dialog.getByRole('alert')).toContainText('Password tidak valid');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Password').fill(fixture.password);
    await dialog.getByLabel('Kode OTP').fill(currentOtp(user!.twoFactorSecret as string));
    await dialog.getByRole('button', { name: 'Lanjutkan' }).click();
    await expect.poll(() => stepUpOutcomes.length).toBe(2);
    expect(stepUpOutcomes[1]).toEqual({ status: 200, code: null, group: 'security.sessions_all', grantPresent: true });
    await expect(page).toHaveURL(/\/login$/);
    const state = await mongo.db(shared.MONGO_DB).collection('authsessions').countDocuments({ userId: user!._id, status: { $in: ['active', 'locked'] }, ownsSlot: true });
    expect(state).toBe(0);
    const browserProjection = await page.evaluate(() => ({ urlHasCredentialMaterial: /token|otp|password|sid|grant/i.test(location.search + location.hash), localKeys: Object.keys(localStorage), sessionKeys: Object.keys(sessionStorage) }));
    expect(browserProjection).toEqual({ urlHasCredentialMaterial: false, localKeys: [], sessionKeys: [] });
    expect((await page.context().cookies()).map(({ name }) => name).filter((name) => /token|grant|otp|password|sid/i.test(name))).toEqual([]);
    if (suffix === 'mobile') expect({ narrow: page.viewportSize()!.width < 600, touch: await page.evaluate(() => navigator.maxTouchPoints > 0) }).toEqual({ narrow: true, touch: true });
  } catch (error) { primaryError = error; }
  let teardownError: unknown = null;
  try {
    if (userId) await mongo.db(shared.MONGO_DB).collection('authsessions').updateMany({ userId, status: { $in: ['active', 'locked'] } }, { $set: { status: 'revoked', ownsSlot: false, revokeReason: 'verification_cleanup' } });
    await mongo.close();
  } catch (error) { teardownError = error; }
  if (primaryError && teardownError) throw new AggregateError([primaryError, teardownError], 'step-up verification and cleanup failed');
  if (primaryError) throw primaryError;
  if (teardownError) throw teardownError;
});
