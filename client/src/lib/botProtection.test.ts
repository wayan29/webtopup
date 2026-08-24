import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_PROTECTION_FAILED_MESSAGE,
  BOT_PROTECTION_UNAVAILABLE_MESSAGE,
  shouldRenderTurnstile,
  turnstileSiteKey,
} from './botProtection.ts';

test('bot protection messages are the exact generic strings', () => {
  assert.equal(
    BOT_PROTECTION_FAILED_MESSAGE,
    'Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.',
  );
  assert.equal(
    BOT_PROTECTION_UNAVAILABLE_MESSAGE,
    'Verifikasi keamanan sedang tidak tersedia. Coba beberapa saat lagi.',
  );
});

test('shouldRenderTurnstile is true only for enabled flag plus a trimmed non-empty site key', () => {
  const cases: Array<{
    settings: { botProtectionEnabled?: unknown; turnstileSiteKey?: unknown };
    expected: boolean;
  }> = [
    { settings: { botProtectionEnabled: true, turnstileSiteKey: 'site-key' }, expected: true },
    { settings: { botProtectionEnabled: true, turnstileSiteKey: '  site-key  ' }, expected: true },
    { settings: { botProtectionEnabled: true, turnstileSiteKey: '' }, expected: false },
    { settings: { botProtectionEnabled: true, turnstileSiteKey: '   ' }, expected: false },
    { settings: { botProtectionEnabled: true, turnstileSiteKey: null }, expected: false },
    { settings: { botProtectionEnabled: true }, expected: false },
    { settings: { botProtectionEnabled: false, turnstileSiteKey: 'site-key' }, expected: false },
    { settings: { botProtectionEnabled: 'true', turnstileSiteKey: 'site-key' }, expected: false },
    { settings: { botProtectionEnabled: 1, turnstileSiteKey: 'site-key' }, expected: false },
    { settings: { turnstileSiteKey: 'site-key' }, expected: false },
    { settings: {}, expected: false },
    { settings: { botProtectionEnabled: true, turnstileSiteKey: 123 }, expected: false },
  ];

  for (const { settings, expected } of cases) {
    assert.equal(
      shouldRenderTurnstile(settings),
      expected,
      `shouldRenderTurnstile(${JSON.stringify(settings)})`,
    );
  }
});

test('turnstileSiteKey returns a trimmed string or null', () => {
  assert.equal(turnstileSiteKey({ turnstileSiteKey: 'site-key' }), 'site-key');
  assert.equal(turnstileSiteKey({ turnstileSiteKey: '  site-key  ' }), 'site-key');
  assert.equal(turnstileSiteKey({ turnstileSiteKey: '' }), null);
  assert.equal(turnstileSiteKey({ turnstileSiteKey: '   ' }), null);
  assert.equal(turnstileSiteKey({}), null);
  assert.equal(turnstileSiteKey({ turnstileSiteKey: null }), null);
  assert.equal(turnstileSiteKey({ turnstileSiteKey: 123 }), null);
});
