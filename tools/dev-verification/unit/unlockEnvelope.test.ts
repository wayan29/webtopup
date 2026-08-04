import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.resolve('rust-api/src/routes/auth/session_handlers.rs'), 'utf8');

test('successful unlock returns explicit authoritative staff session metadata', () => {
  const start = source.indexOf('async fn unlock_success_response');
  const end = source.indexOf('fn map_refresh_to_unlock_handler', start);
  assert.ok(start >= 0 && end > start);
  const unlockSuccess = source.slice(start, end);
  assert.match(unlockSuccess, /"session": \{[\s\S]*?"sid": sid\.to_hex\(\)[\s\S]*?"roleClass": "staff"[\s\S]*?"accessExpiresAt":/u);
});
