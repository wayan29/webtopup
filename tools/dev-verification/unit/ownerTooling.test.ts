import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

test('create-owner requires an explicit owner email and never falls back to a production identity', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/create-owner.js'), 'utf8');
  assert.match(source, /process\.env\.OWNER_EMAIL/u);
  assert.doesNotMatch(source, /OWNER_EMAIL\s*\|\|\s*['"]owner@danayasa\.biz\.id['"]/u);
  assert.match(source, /if \(!MONGO_URI \|\| !EMAIL \|\| !PASSWORD\)/u);
});

test('sensitive malformed deposit smoke cases expect the step-up guard first', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/smoke/api-v2-mutation-smoke.js'), 'utf8');
  assert.match(source, /function assertStepUpRequired[\s\S]*AUTH_STEP_UP_REQUIRED/u);
  assert.match(source, /assertStepUpRequired\('deposit reject invalid id'/u);
  assert.match(source, /assertStepUpRequired\('deposit approve invalid id'/u);
  assert.match(source, /assertStepUpRequired\('deposit reject missing note'/u);
});
