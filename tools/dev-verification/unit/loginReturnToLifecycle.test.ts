import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('standalone login continuation runner always stops, resets, and tears down', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../loginReturnTo.ts'), 'utf8');
  assert.match(source, /finally\s*\{[\s\S]*stopHostProcesses[\s\S]*resetMarkedVerificationDatabase[\s\S]*infrastructureDown/u);
  assert.match(source, /bootstrapFreshVerificationDatabase/u);
  assert.match(source, /seedLoginReturnToVerificationDatabase/u);
  assert.doesNotMatch(source, /(?<!LoginReturnTo)seedVerificationDatabase/u);
  assert.match(source, /startHostProcesses\(config, 'session-device-policy'\)/u);
  assert.match(source, /'login-return-to\.spec\.ts'/u);
  assert.doesNotMatch(source, /auth\.setup|E2E_ADMIN|owner/u);
});
