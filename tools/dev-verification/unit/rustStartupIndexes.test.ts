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

test('Rust startup gates listener readiness on seller order indexes without creating them', async () => {
  const source = await fs.readFile(path.join(root, 'rust-api/src/main.rs'), 'utf8');
  assert.match(source, /services::seller_integrity::ensure_seller_order_indexes_ready\(&db\)\s*\.await\s*\.context\("seller order indexes failed before listener readiness"\)\?;/u);
  const ensureAt = source.indexOf('services::seller_integrity::ensure_seller_order_indexes_ready(&db)');
  const listenAt = source.indexOf('let listener = tokio::net::TcpListener::bind(addr)');
  assert.ok(listenAt > ensureAt, 'listener must bind only after seller order index readiness succeeds');
  assert.doesNotMatch(source, /seller_order_readiness/u);
  assert.doesNotMatch(source, /create_index/u, 'startup must never create seller indexes');
});

test('seller order readiness binary is registered and disposable-only', async () => {
  const cargo = await fs.readFile(path.join(root, 'rust-api/Cargo.toml'), 'utf8');
  assert.match(cargo, /name\s*=\s*"seller_order_readiness"/u);
  const binary = await fs.readFile(path.join(root, 'rust-api/src/bin/seller_order_readiness.rs'), 'utf8');
  assert.match(binary, /webtopup_task14_dev/u);
  assert.match(binary, /seller_apply_allowed/u);
  assert.match(binary, /--apply/u);
  const service = await fs.readFile(path.join(root, 'rust-api/src/services/seller_integrity.rs'), 'utf8');
  assert.match(service, /digiflazzsellerorders/u);
  assert.match(service, /irssellerorders/u);
  assert.match(service, /ensure_seller_order_indexes_ready/u);
});

test('Rust startup gates listener readiness on site config foundation indexes', async () => {
  const source = await fs.readFile(path.join(root, 'rust-api/src/main.rs'), 'utf8');
  assert.match(source, /routes::settings::ensure_site_config_foundation_indexes\(&db\)/u);
  const ensureAt = source.indexOf('routes::settings::ensure_site_config_foundation_indexes(&db)');
  const listenAt = source.indexOf('let listener = tokio::net::TcpListener::bind(addr)');
  assert.ok(listenAt > ensureAt, 'listener must bind only after site config foundation indexes succeed');
  const claim = await fs.readFile(path.join(root, 'rust-api/src/routes/settings/idempotency.rs'), 'utf8');
  assert.match(claim, /uniq_site_config_idempotency_key/u);
  assert.match(claim, /siteconfigidempotencyclaims/u);
  assert.doesNotMatch(claim, /cleanupAt/u);
  assert.match(claim, /expire_after\.is_none\(\)|options\.expire_after/u);
  assert.doesNotMatch(claim, /expire_after\(Some|\.expire_after\(Duration/u);
});
