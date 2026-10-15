import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = serverRequire('pg');

async function main() {
  const database = process.env.PGDATABASE;
  if (!database || process.env.MIGRATION_DATABASE !== database
      || !/^webtopup_(?:ci_[a-z0-9_]+|backup_[a-z0-9_]+)$/.test(database)) {
    throw new Error('Migration target rejected: explicit disposable MIGRATION_DATABASE and matching PGDATABASE required');
  }
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--directory')) {
    throw new Error('Usage: node migrate.mjs [--directory migration-directory]');
  }
  const directory = args.length
    ? path.resolve(args[1])
    : fileURLToPath(new URL('../../rust-api/migrations/', import.meta.url));
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!names.length) throw new Error('Migration directory contains no SQL migrations');
  const migrations = await Promise.all(names.map(async (version) => {
    const sql = await readFile(path.join(directory, version), 'utf8');
    return { version, sql, checksum: Buffer.from(sql).toString('base64url') };
  }));
  const client = new Client({ database, connectionTimeoutMillis: 2000, query_timeout: 10000 });
  try {
    await client.connect();
    const target = await client.query('SELECT current_database() AS database');
    if (target.rows[0].database !== database) throw new Error('Connected migration database differs from target');
    // A session lock serializes both initial tracking-table creation and migration application.
    await client.query('SELECT pg_advisory_lock(74029136)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = await client.query('SELECT version, checksum FROM schema_migrations');
    const checksums = new Map(migrations.map(({ version, checksum }) => [version, checksum]));
    for (const row of applied.rows) {
      if (!checksums.has(row.version)) throw new Error(`Applied migration missing from directory: ${row.version}`);
      if (checksums.get(row.version) !== row.checksum) throw new Error(`Migration changed after apply: ${row.version}`);
    }
    const appliedVersions = new Set(applied.rows.map(({ version }) => version));
    for (const { version, sql, checksum } of migrations) {
      if (appliedVersions.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log(`Migrations verified: ${database}, ${migrations.length} files`);
  } finally {
    // Disconnect releases the advisory lock even when a migration fails.
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.code ? 'Migration database operation failed' : error.message);
  process.exitCode = 1;
});
