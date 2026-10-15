const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../../server/package.json'));
const bcrypt = serverRequire('bcrypt');
const { Client } = serverRequire('pg');

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
assert.match(databaseName, /^webtopup_ci_[a-z0-9_]+$/u, 'refusing non-disposable database');

function runBootstrap(email, password, name) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../create-owner.js')], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PGDATABASE: databaseName,
      BOOTSTRAP_DATABASE: databaseName,
      OWNER_EMAIL: email,
      OWNER_PASSWORD: password,
      OWNER_NAME: name,
    },
  });
}

async function main() {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const ids = [];
  const suffix = crypto.randomUUID();
  const ownerEmail = `owner-smoke-${suffix}@example.test`;
  const ownerPassword = `OwnerSmoke-${crypto.randomBytes(20).toString('hex')}!`;
  const memberEmail = `existing-member-smoke-${suffix}@example.test`;
  const memberPassword = `ExistingMember-${crypto.randomBytes(20).toString('hex')}!`;

  try {
    await client.connect();
    const target = await client.query('SELECT current_database() AS database');
    assert.equal(target.rows[0].database, databaseName);

    const owner = runBootstrap(ownerEmail, ownerPassword, 'Smoke Owner');
    assert.equal(owner.status, 0, `create owner: ${owner.stderr}`);
    assert.match(owner.stdout, /Owner created/u);
    assert.ok(!owner.stdout.includes(ownerPassword));
    assert.ok(!owner.stderr.includes(ownerPassword));
    const repeated = runBootstrap(ownerEmail, ownerPassword, 'Changed Name');
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /Existing account rejected/u);
    assert.ok(!repeated.stdout.includes(ownerPassword));
    assert.ok(!repeated.stderr.includes(ownerPassword));

    const ownerRow = await client.query(
      'SELECT id, name, role, active, balance, points, password_hash, two_factor_enrollment_required_at FROM users WHERE normalized_email=$1',
      [ownerEmail],
    );
    assert.equal(ownerRow.rowCount, 1);
    ids.push(ownerRow.rows[0].id);
    assert.equal(ownerRow.rows[0].name, 'Smoke Owner');
    assert.equal(ownerRow.rows[0].role, 'owner');
    assert.equal(ownerRow.rows[0].active, true);
    assert.equal(ownerRow.rows[0].balance, '0');
    assert.equal(ownerRow.rows[0].points, '0');
    assert.ok(await bcrypt.compare(ownerPassword, ownerRow.rows[0].password_hash));
    const deadline = new Date(ownerRow.rows[0].two_factor_enrollment_required_at).getTime();
    assert.ok(deadline > Date.now() + 6 * 24 * 60 * 60 * 1000);
    assert.ok(deadline < Date.now() + 8 * 24 * 60 * 60 * 1000);

    const memberHash = await bcrypt.hash(memberPassword, 12);
    const existing = await client.query(
      `INSERT INTO users (email, password_hash, name, role, active, balance, points, role_updated_at, policy_updated_at)
       VALUES ($1, $2, 'Preserved Member', 'member', FALSE, 375, 16, now(), now()) RETURNING id`,
      [memberEmail, memberHash],
    );
    const memberId = existing.rows[0].id;
    ids.push(memberId);
    const refused = runBootstrap(memberEmail, `Different-${crypto.randomBytes(20).toString('hex')}!`, 'Must Not Promote');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Existing account rejected/u);
    const preserved = await client.query(
      'SELECT name, role, active, balance, points, password_hash FROM users WHERE id=$1',
      [memberId],
    );
    assert.equal(preserved.rowCount, 1);
    assert.equal(preserved.rows[0].name, 'Preserved Member');
    assert.equal(preserved.rows[0].role, 'member');
    assert.equal(preserved.rows[0].active, false);
    assert.equal(preserved.rows[0].balance, '375');
    assert.equal(preserved.rows[0].points, '16');
    assert.equal(preserved.rows[0].password_hash, memberHash);

    console.log(JSON.stringify({
      database: databaseName,
      createOnlyOwner: 'passed',
      duplicateBootstrapRefused: 'passed',
      existingDisabledMemberPreserved: 'passed',
      passwordAndEnrollmentDeadline: 'passed',
    }));
  } finally {
    if (ids.length) await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
