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

test('Rust API startup does not auto-create production identifier indexes', async () => {
  const source = await fs.readFile(path.join(root, 'rust-api/src/main.rs'), 'utf8');
  assert.doesNotMatch(source, /apply_identifier_indexes/u);
  assert.doesNotMatch(source, /site_config_identifier_readiness/u);
  assert.doesNotMatch(source, /uniq_transactions_reference_id/u);
  assert.doesNotMatch(source, /uniq_guest_invoice_number/u);
  assert.doesNotMatch(source, /uniq_identifier_counter_scope_date/u);
});

test('identifier readiness binary is registered and disposable-only', async () => {
  const cargo = await fs.readFile(path.join(root, 'rust-api/Cargo.toml'), 'utf8');
  assert.match(cargo, /name\s*=\s*"site_config_identifier_readiness"/u);
  const binary = await fs.readFile(path.join(root, 'rust-api/src/bin/site_config_identifier_readiness.rs'), 'utf8');
  assert.match(binary, /webtopup_task14_dev/u);
  assert.match(binary, /apply_is_allowed/u);
  assert.match(binary, /--apply/u);
  const service = await fs.readFile(path.join(root, 'rust-api/src/services/identifier_integrity.rs'), 'utf8');
  assert.match(service, /INDEX_TRANSACTION_REFERENCE/u);
  assert.match(service, /require_identifier_indexes/u);
  assert.match(service, /SUCCESS_CACHE_TTL/u);
});
