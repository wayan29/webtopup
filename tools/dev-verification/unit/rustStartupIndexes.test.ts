import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..', '..', '..');

test('Rust startup gates listener readiness on auth session and device indexes', async () => {
  const source = await fs.readFile(path.join(root, 'rust-api/src/main.rs'), 'utf8');
  assert.match(source, /routes::auth::session_store::ensure_slot_indexes_ready\(&db\)\s*\.await\s*\.context\("auth session indexes failed before listener readiness"\)\?;/u);
  const ensureAt = source.indexOf('routes::auth::session_store::ensure_slot_indexes_ready(&db)');
  const listenAt = source.indexOf('let listener = tokio::net::TcpListener::bind(addr)');
  assert.ok(listenAt > ensureAt, 'listener must bind only after awaited index readiness succeeds');
});
