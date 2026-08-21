#!/usr/bin/env node
'use strict';

// Dry-run-first scrubber for historical Digiflazz/IRS seller secrets.
//
// - Default mode is inspection only (no writes).
// - `--apply` unsets raw fields wholesale; it never creates/drops indexes and
//   never prints raw values.
// - `--apply` is automatic only for the exact disposable database. Protected
//   databases require an explicit opt-in, exact confirmation, and a backup
//   reference. See docs/ops/digiflazz-seller-center-hygiene.md.

const { MongoClient } = require('mongodb');
const {
  SELLER_ORDER_COLLECTIONS,
  SELLER_RAW_TARGETS,
  parseSellerScrubArgs,
  sellerRefIdIndexState,
} = require('./seller-secret-policy');

async function countSellerDuplicateRefIds(collection) {
  const groups = await collection
    .aggregate([
      { $group: { _id: '$refId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'duplicateGroups' },
    ])
    .toArray();
  return groups.length > 0 ? groups[0].duplicateGroups : 0;
}

async function inspectSellerHygiene(db, database) {
  const collections = {};
  let blocking = false;

  for (const [name, filter] of SELLER_RAW_TARGETS) {
    const collection = db.collection(name);
    const scanned = await collection.countDocuments({});
    const affected = await collection.countDocuments(filter);
    if (!SELLER_ORDER_COLLECTIONS.includes(name)) {
      collections[name] = { scanned, affected };
      continue;
    }
    const duplicateRefIds = await countSellerDuplicateRefIds(collection);
    const indexes = await collection.listIndexes().toArray();
    const indexState = sellerRefIdIndexState(indexes);
    if (duplicateRefIds > 0 || indexState.drifted) blocking = true;
    collections[name] = {
      scanned,
      affected,
      duplicateRefIds,
      uniqueIndexReady: indexState.ready,
    };
  }

  return { database, collections, applied: false, modifiedDocuments: 0, blocking };
}

async function applySellerHygiene(db, database) {
  const preReport = await inspectSellerHygiene(db, database);
  let modifiedDocuments = 0;

  for (const [name, filter, update] of SELLER_RAW_TARGETS) {
    const result = await db.collection(name).updateMany(filter, update);
    modifiedDocuments += result.modifiedCount || 0;
  }

  const postReport = await inspectSellerHygiene(db, database);
  postReport.applied = true;
  postReport.modifiedDocuments = modifiedDocuments;
  const residual = Object.values(postReport.collections).reduce(
    (total, entry) => total + (entry.affected || 0),
    0,
  );
  if (residual > 0) postReport.blocking = true;

  return { preReport, postReport };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseSellerScrubArgs(argv);
  } catch (error) {
    if (error && error.code === 'SELLER_SCRUB_ARGS') {
      process.stderr.write('seller secret scrubber arguments are invalid\n');
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const client = new MongoClient(options.mongoUri, { maxPoolSize: 2 });
  try {
    await client.connect();
    const db = client.db(options.database);
    if (options.apply) {
      const { postReport } = await applySellerHygiene(db, options.database);
      process.stdout.write(`${JSON.stringify(postReport)}\n`);
      if (postReport.blocking) process.exitCode = 1;
      return;
    }
    const report = await inspectSellerHygiene(db, options.database);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.blocking) process.exitCode = 1;
  } catch (error) {
    if (error && error.code === 'SELLER_SCRUB_PROTECTED') {
      process.stderr.write('seller secret scrubber refused the protected database\n');
      process.exitCode = 2;
      return;
    }
    process.stderr.write('seller secret scrubber failed\n');
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  applySellerHygiene,
  countSellerDuplicateRefIds,
  inspectSellerHygiene,
  main,
};
