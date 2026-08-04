import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('Playwright maps only the trusted local hostname and pins the generated certificate key', () => {
  const config = fs.readFileSync(path.resolve(import.meta.dirname, '../playwright.config.ts'), 'utf8');
  const certificate = fs.readFileSync(path.resolve(import.meta.dirname, '../certificate.ts'), 'utf8');
  assert.match(config, /testDir: path\.join\(__dirname, 'e2e'\)/u);
  assert.match(config, /--host-resolver-rules=MAP webtopup\.local\.test 127\.0\.0\.1/u);
  assert.doesNotMatch(config, /ignoreHTTPSErrors|--ignore-certificate-errors(?:[,'"`\s]|$)/u);
  assert.match(config, /--ignore-certificate-errors-spki-list=\$\{certificateSpki\}/u);
  assert.match(certificate, /X509Certificate/u);
  assert.match(certificate, /publicKey\.export\(\{ type: 'spki', format: 'der' \}\)/u);
  assert.match(certificate, /createHash\('sha256'\)/u);
  assert.match(config, /outputFile: '\.\.\/\.\.\/\.dev-verification\/reports\/playwright\.json'/u);
  const cookieSpec = fs.readFileSync(path.resolve(import.meta.dirname, '../e2e/session-cookies.spec.ts'), 'utf8');
  assert.match(cookieSpec, /headersArray\(\)/u);
  assert.match(cookieSpec, /expect\(attributes\.some\(\(attribute\) => \/\^domain=\/iu\.test\(attribute\)\)\)\.toBe\(false\)/u);
});
