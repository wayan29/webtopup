import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readClient = (relativePath: string) =>
  fs.readFileSync(path.join(root, 'client/src', relativePath), 'utf8');

test('SiteConfig exposes the master switch and site key without a secret field', () => {
  const source = readClient('pages/admin/SiteConfig.tsx');
  assert.match(source, /botProtectionEnabled/);
  assert.match(source, /turnstileSiteKey/);
  assert.match(source, /Anti-bot Cloudflare \(Turnstile\)/);
  assert.match(source, /TURNSTILE_SECRET_KEY/);
  assert.match(source, /TURNSTILE_DISABLED=1/);
  assert.match(source, /botProtectionKillSwitch/);
  assert.doesNotMatch(source, /type=["']password["'][^>]*(secret|turnstile)/i);
  assert.doesNotMatch(source, /name=["'][^"']*secret[^"']*["']/i);
  assert.doesNotMatch(source, /turnstileSecret/);
  assert.doesNotMatch(source, /TURNSTILE_SECRET[^_]/);
});

test('Login and Order render Turnstile through the shared helper or field', () => {
  const login = readClient('pages/Login.tsx');
  const order = readClient('pages/Order.tsx');
  const widget = /shouldRenderTurnstile|TurnstileField/;
  assert.match(login, widget);
  assert.match(order, widget);
  assert.doesNotMatch(login, /challenges\.cloudflare\.com/);
  assert.doesNotMatch(order, /challenges\.cloudflare\.com/);
});

test('login may send turnstileToken while 2FA verify never does', () => {
  const source = readClient('store/useAuthStore.ts');
  assert.match(source, /rememberMe\?: boolean, turnstileToken\?: string/);
  const loginImplStart = source.indexOf('login: async (audience, email, password, rememberMe = false, turnstileToken)');
  assert.notEqual(loginImplStart, -1);
  const loginImpl = source.slice(loginImplStart, loginImplStart + 1200);
  assert.match(loginImpl, /turnstileToken/);
  const verifyStart = source.indexOf('verifyTwoFactorLogin: async');
  assert.notEqual(verifyStart, -1);
  const verifyBlock = source.slice(verifyStart, verifyStart + 1800);
  assert.doesNotMatch(verifyBlock, /turnstileToken/);
});

test('public settings include the effective bot-protection fields', () => {
  const source = readClient('layouts/MainLayout.tsx');
  assert.match(source, /interface PublicSettings/);
  const publicSettings = source.slice(
    source.indexOf('interface PublicSettings'),
    source.indexOf('}', source.indexOf('interface PublicSettings')) + 1,
  );
  assert.match(publicSettings, /botProtectionEnabled/);
  assert.match(publicSettings, /turnstileSiteKey/);
});

test('guest and member order payloads include turnstileToken near the transaction posts', () => {
  const source = readClient('pages/Order.tsx');
  const guestBlock = source.slice(
    Math.max(0, source.indexOf('/guest-transactions') - 800),
    source.indexOf('/guest-transactions') + 400,
  );
  const memberBlock = source.slice(
    Math.max(0, source.indexOf("'/transactions'") - 800),
    source.indexOf("'/transactions'") + 400,
  );
  assert.match(guestBlock, /turnstileToken/);
  assert.match(memberBlock, /turnstileToken/);
});
