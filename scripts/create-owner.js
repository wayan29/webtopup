#!/usr/bin/env node
const path = require('node:path');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../server/package.json'));
const bcrypt = serverRequire('bcrypt');
const { Client } = serverRequire('pg');

async function main() {
  const database = process.env.PGDATABASE;
  if (!database || process.env.BOOTSTRAP_DATABASE !== database || !/^webtopup_ci_[a-z0-9_]+$/.test(database)) {
    throw new Error('Bootstrap target rejected: explicit disposable database required');
  }
  const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || '';
  const name = (process.env.OWNER_NAME || 'Owner').trim();
  if (!email || !email.includes('@') || !name || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('OWNER_EMAIL, OWNER_NAME and a 12-character minimum password (maximum 72 bytes) required');
  }
  const client = new Client({ connectionTimeoutMillis: 2000, query_timeout: 5000 });
  try {
    await client.connect();
    const target = await client.query('SELECT current_database() AS database');
    if (target.rows[0].database !== database) throw new Error('Bootstrap connection target mismatch');
    const hash = await bcrypt.hash(password, 12);
    const result = await client.query(
      `INSERT INTO users (email, password_hash, name, role, active, balance, points,
        session_version, two_factor_enabled, role_updated_at, policy_updated_at,
        two_factor_enrollment_required_at)
       VALUES ($1, $2, $3, 'owner', TRUE, 0, 0, 0, FALSE, now(), now(), now() + interval '7 days')
       ON CONFLICT (normalized_email) DO NOTHING RETURNING id`,
      [email, hash, name],
    );
    if (!result.rowCount) throw new Error('Existing account rejected: bootstrap never resets or promotes users');
    console.log('Owner created; two-factor enrollment required within 7 days');
  } finally {
    await client.end();
  }
}
main().catch((error) => {
  console.error(error.code ? 'Owner bootstrap database operation failed' : error.message);
  process.exitCode = 1;
});
