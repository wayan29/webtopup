#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const base = process.env.API_V2_DIRECT_URL || 'http://127.0.0.1:9010';
const databaseUrl = process.env.DATABASE_URL || '';
const database = decodeURIComponent((databaseUrl.split('?')[0].split('/').pop() || ''));
const forbidden = new Set(['pobb', 'ppob', 'webtopup', 'webtopup_pg_dev']);
if (!databaseUrl || forbidden.has(database) || !/^webtopup_ci_[a-z0-9_]+$/.test(database)) {
  console.error(`refusing financial smoke for database ${database || '(missing)'}`);
  process.exit(2);
}
function psql(args, input) {
  return spawnSync('docker', ['exec', '-i', 'webtopup-pg-migration-postgres-1', 'psql', '-h', '127.0.0.1', '-p', '55432', '-U', 'migration_admin', '-d', database, ...args], { input, encoding: 'utf8' });
}
for (const name of fs.readdirSync('rust-api/migrations').filter((file) => file.endsWith('.sql')).sort()) {
  const seeded = psql(['-v', 'ON_ERROR_STOP=1'], fs.readFileSync(`rust-api/migrations/${name}`));
  if (seeded.status !== 0) { console.error(seeded.stderr || seeded.stdout); process.exit(seeded.status || 1); }
}
const fixture = psql(['-v', 'ON_ERROR_STOP=1', '-c', "INSERT INTO categories (slug,name) VALUES ('pulsa','Pulsa'); INSERT INTO operators (category_id,slug,name) SELECT id,'telkomsel','Telkomsel' FROM categories; INSERT INTO products (code,name,operator_id,price_basic) SELECT 'SKU1','Pulsa',id,1500 FROM operators; INSERT INTO users (email,password_hash,name,role,balance,role_updated_at,policy_updated_at) VALUES ('member@example.test','hash','Member','member',5000,now(),now());"]);
if (fixture.status !== 0) { console.error(fixture.stderr || fixture.stdout); process.exit(fixture.status || 1); }
const user = psql(['-Atc', "SELECT id FROM users WHERE email = 'member@example.test'"]);
const userId = user.stdout.trim();
async function checkout(key, digest) {
  const response = await fetch(`${base}/v2/orders/sql/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, key, digest, productCode: 'SKU1', level: 'basic', databaseUrl }) });
  return { status: response.status, body: await response.json() };
}
(async () => {
  const first = await checkout('order-1', 'digest-1');
  const replay = await checkout('order-1', 'digest-1');
  const conflict = await checkout('order-1', 'digest-2');
  const memberDenied = psql(['-Atc', "SELECT count(*) FROM users WHERE role = 'member' AND balance <> 3500"]);
  if (first.status !== 200 || first.body.balance !== 3500 || replay.status !== 200 || replay.body.balance !== 3500 || conflict.status !== 409 || memberDenied.stdout.trim() !== '0') {
    console.error(JSON.stringify({ first, replay, conflict, permission: memberDenied.stdout.trim() }));
    process.exit(1);
  }
  console.log(JSON.stringify({ database, checkout: 'passed', balance: 3500, idempotent: true, conflict: 409, permission: 'member-only' }));
})();
