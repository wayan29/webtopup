import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolvePublicCommand } from '../cliContract.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

test('public routes gate has a canonical tracked spec and thin compatibility import', () => {
  const canonical = fs.readFileSync(path.join(root, 'tools/dev-verification/e2e/public-routes.spec.ts'), 'utf8');
  const compatibility = fs.readFileSync(path.join(root, 'tests/e2e/public-routes.spec.ts'), 'utf8');
  assert.match(canonical, /tracked public behavior/u);
  assert.match(canonical, /public response resilience/u);
  assert.match(compatibility, /import '\.\.\/\.\.\/tools\/dev-verification\/e2e\/public-routes\.spec\.ts'/u);
});

test('public routes checked-in commands use both projects, serial workers, and guaranteed cleanup', () => {
  const runner = fs.readFileSync(path.join(root, 'tools/dev-verification/publicRoutes.ts'), 'utf8');
  assert.equal(resolvePublicCommand('public-routes'), 'public-routes');
  assert.equal(resolvePublicCommand('public-routes-list'), 'public-routes-list');
  assert.match(runner, /--project=chromium-desktop/u);
  assert.match(runner, /--project=chromium-mobile/u);
  assert.match(runner, /--workers=1/u);
  assert.match(runner, /finally/u);
  assert.match(runner, /stopHostProcesses/u);
  assert.match(runner, /infrastructureDown/u);
  assert.doesNotMatch(runner, /ignoreHTTPSErrors|auth-setup|gmail/iu);
});

test('public routes config uses the generated certificate SPKI pin instead of TLS bypass', () => {
  const config = fs.readFileSync(path.join(root, 'tools/dev-verification/playwright.config.ts'), 'utf8');
  assert.match(config, /--ignore-certificate-errors-spki-list=\$\{certificateSpki\}/u);
  assert.doesNotMatch(config, /ignoreHTTPSErrors|--ignore-certificate-errors(?:[,'"`\s]|$)/u);
});
