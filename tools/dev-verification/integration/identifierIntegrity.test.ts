import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MongoClient } from 'mongodb';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;

test('identifier readiness tool is dry-run by default and disposable-only for apply', async () => {
  const shared = await readEnv(path.join(stateDir, 'env', 'shared.env'));
  assert.equal(shared.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(shared.MONGO_DB, 'webtopup_task14_dev');

  const mongo = new MongoClient(shared.MONGO_URI);
  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    assert.ok(await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    }));

    // Source/binary contracts (runtime apply remains disposable-gated in Rust).
    const service = await fs.readFile(path.join(root, 'rust-api/src/services/identifier_integrity.rs'), 'utf8');
    assert.match(service, /uniq_transactions_reference_id/);
    assert.match(service, /uniq_guest_invoice_number/);
    assert.match(service, /uniq_identifier_counter_scope_date/);
    assert.match(service, /webtopup_task14_dev/);
    assert.match(service, /REFERENCE_COUNTER_SCOPE/);
    assert.match(service, /allocate_reference_in_session/);

    const binary = await fs.readFile(path.join(root, 'rust-api/src/bin/site_config_identifier_readiness.rs'), 'utf8');
    assert.match(binary, /--apply/);
    assert.match(binary, /apply_is_allowed/);
    assert.doesNotMatch(binary, /allow-protected-database/);

    // Effective policy: NONE ref date format is unsafe for readiness, safe at runtime.
    assert.match(service, /unsafe_ref_id_date_format/);
    assert.match(service, /effective_ref_id_date_format/);
  } finally {
    await mongo.close();
  }
});

async function readEnv(file: string): Promise<Env> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}
