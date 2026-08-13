import assert from 'node:assert/strict';
import test from 'node:test';
import { verificationMatrix } from '../verificationMatrix.ts';

test('aggregate matrix names every required evidence group exactly once', () => {
  const matrix = verificationMatrix(); const names = matrix.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length); assert.ok(matrix.every(({ required }) => required));
  for (const name of ['unit', 'client-build', 'server-build', 'rust-build', 'mongo', 'public-origin', 'login-return-to-desktop', 'team-access-desktop', 'team-access-mobile', 'catalog-permissions', 'audit-logs-integration', 'audit-logs-desktop', 'audit-logs-mobile', 'finance-idempotency', 'rollout-transition', 'diff-check', 'report-secrecy', 'stopped-state']) assert.ok(names.includes(name));
  for (const platform of ['desktop', 'mobile']) for (const spec of ['session-cookies', 'session-lifecycle', 'session-multitab', 'session-device-replacement', 'session-enrollment', 'session-step-up']) assert.ok(names.includes(`${spec}-${platform}`));
  assert.equal(matrix.find(({ name }) => name === 'session-cookies-desktop')?.profile, 'session-cs');
  for (const name of ['team-access-desktop', 'team-access-mobile', 'catalog-permissions', 'audit-logs-integration', 'audit-logs-desktop', 'audit-logs-mobile']) {
    assert.equal(matrix.find(({ name: candidate }) => candidate === name)?.profile, 'session-cs');
    assert.equal(matrix.find(({ name: candidate }) => candidate === name)?.isolated, true);
  }
  assert.equal(matrix.find(({ name }) => name === 'public-origin')?.profile, 'session-device-policy');
  assert.equal(matrix.find(({ name }) => name === 'session-refresh-race-desktop')?.profile, 'session-cs-fault');
  assert.equal(matrix.find(({ name }) => name === 'session-response-loss-mobile')?.profile, 'session-cs-fault');
  assert.equal(matrix.find(({ name }) => name === 'session-enrollment-desktop')?.profile, 'session-device-policy');
  assert.deepEqual(matrix.find(({ name }) => name === 'login-return-to-desktop'), {
    name: 'login-return-to-desktop', required: true, profile: 'session-device-policy', isolated: true,
    command: 'npx', args: ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'login-return-to.spec.ts', '--project=chromium-desktop', '--workers=1'],
  });
  assert.equal(matrix.find(({ name }) => name === 'finance-idempotency')?.profile, 'session-finance-fault');
  assert.equal(matrix.find(({ name }) => name === 'giveaway-atomic')?.profile, 'session-finance-policy');
  assert.deepEqual(matrix.find(({ name }) => name === 'upload-security'), {
    name: 'upload-security', required: true, profile: 'session-cs', isolated: true,
    command: 'node', args: ['--import', 'tsx', '--test', 'tools/dev-verification/integration/uploadSecurity.test.ts'],
  });
  assert.deepEqual(matrix.find(({ name }) => name === 'identifier-integrity'), {
    name: 'identifier-integrity', required: true, profile: 'session-device-policy', isolated: true,
    command: 'node', args: ['--import', 'tsx', '--test', 'tools/dev-verification/integration/identifierIntegrity.test.ts'],
  });
  assert.deepEqual(matrix.find(({ name }) => name === 'site-config-foundation'), {
    name: 'site-config-foundation', required: true, profile: 'session-cs-fault', isolated: true,
    command: 'node', args: ['--import', 'tsx', '--test', 'tools/dev-verification/integration/siteConfigFoundation.test.ts'],
  });
  assert.deepEqual(matrix.find(({ name }) => name === 'site-config-foundation-desktop'), {
    name: 'site-config-foundation-desktop', required: true, profile: 'session-cs-fault', isolated: true,
    command: 'npx', args: ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'site-config-foundation.spec.ts', '--project=chromium-desktop', '--workers=1'],
  });
  assert.deepEqual(matrix.find(({ name }) => name === 'site-config-foundation-mobile'), {
    name: 'site-config-foundation-mobile', required: true, profile: 'session-cs-fault', isolated: true,
    command: 'npx', args: ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'site-config-foundation.spec.ts', '--project=chromium-mobile', '--workers=1'],
  });
  assert.equal(matrix.find(({ name }) => name === 'rollout-transition')?.profile, 'self-managed');
  assert.equal(matrix.at(-1)?.name, 'stopped-state');
  assert.equal(matrix.at(-1)?.profile, 'stopped');
  assert.ok(matrix.filter(({ profile }) => profile === 'session-cs' || profile === 'session-device-policy').every(({ isolated }) => isolated));
});

test('browser matrix uses trusted configs and serial workers without TLS bypass', () => {
  const serialized = JSON.stringify(verificationMatrix());
  assert.match(serialized, /playwright\.config\.ts/); assert.match(serialized, /chromium-desktop/); assert.match(serialized, /chromium-mobile/);
  assert.doesNotMatch(serialized, /ignoreHTTPSErrors/); assert.doesNotMatch(serialized, /--workers=[2-9]/);
});
