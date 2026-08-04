import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verificationMatrix } from '../verificationMatrix.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

test('login returnTo has one canonical disposable implementation', () => {
  const canonical = fs.readFileSync(path.join(root, 'tools/dev-verification/e2e/login-return-to.spec.ts'), 'utf8');
  const compatibility = fs.readFileSync(path.join(root, 'tests/e2e/login-return-to.spec.ts'), 'utf8');
  assert.match(canonical, /from '\.\/fixtures\.ts'/u);
  assert.equal((canonical.match(/test\('/gu) ?? []).length, 7);
  assert.match(compatibility, /import '\.\.\/\.\.\/tools\/dev-verification\/e2e\/login-return-to\.spec\.ts'/u);
  assert.doesNotMatch(compatibility, /test\('/u);
});

test('aggregate disposable runner owns the isolated login continuation gate', () => {
  const check = verificationMatrix().find(({ name }) => name === 'login-return-to-desktop');
  assert.deepEqual(check, {
    name: 'login-return-to-desktop', required: true, profile: 'session-device-policy', isolated: true,
    command: 'npx', args: ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'login-return-to.spec.ts', '--project=chromium-desktop', '--workers=1'],
  });
});
