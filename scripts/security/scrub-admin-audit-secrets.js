#!/usr/bin/env node
'use strict';

const { MongoClient } = require('mongodb');
const {
  redactAuditMetadata,
} = require('./audit-secret-policy');

const DISPOSABLE_DATABASE = 'webtopup_task14_dev';
const COLLECTION = 'adminauditlogs';

function parseArgs(argv) {
  const options = {
    mongoUri: null,
    database: null,
    apply: false,
    allowProtectedDatabase: false,
    confirmDatabase: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--allow-protected-database') {
      options.allowProtectedDatabase = true;
      continue;
    }
    if (arg === '--mongo-uri') {
      options.mongoUri = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg === '--database') {
      options.database = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg === '--confirm-database') {
      options.confirmDatabase = argv[index + 1] || null;
      index += 1;
      continue;
    }
    const error = new Error('unsupported argument');
    error.code = 'AUDIT_SCRUB_ARGS';
    throw error;
  }

  if (!options.mongoUri || !options.database) {
    const error = new Error('mongo uri and database are required');
    error.code = 'AUDIT_SCRUB_ARGS';
    throw error;
  }

  if (options.apply && options.database !== DISPOSABLE_DATABASE) {
    if (!options.allowProtectedDatabase || options.confirmDatabase !== options.database) {
      const error = new Error('protected database apply is not authorized');
      error.code = 'AUDIT_SCRUB_PROTECTED';
      throw error;
    }
  }

  return options;
}

async function scrubAdminAuditSecrets(options) {
  const client = new MongoClient(options.mongoUri, {
    maxPoolSize: 2,
  });

  let scannedDocuments = 0;
  let affectedDocuments = 0;
  let affectedFields = 0;
  let modifiedDocuments = 0;

  try {
    await client.connect();
    const collection = client.db(options.database).collection(COLLECTION);
    const cursor = collection.find(
      { metadata: { $exists: true } },
      { projection: { _id: 1, metadata: 1 } },
    );

    for await (const document of cursor) {
      scannedDocuments += 1;
      const redacted = redactAuditMetadata(document.metadata);
      if (redacted.affectedFields <= 0) {
        continue;
      }
      affectedDocuments += 1;
      affectedFields += redacted.affectedFields;
      if (!options.apply) {
        continue;
      }
      const result = await collection.updateOne(
        { _id: document._id, metadata: document.metadata },
        { $set: { metadata: redacted.value } },
      );
      if (result.modifiedCount > 0) {
        modifiedDocuments += 1;
      }
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  return {
    database: options.database,
    collection: COLLECTION,
    scannedDocuments,
    affectedDocuments,
    affectedFields,
    modifiedDocuments,
    applied: options.apply === true,
  };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const report = await scrubAdminAuditSecrets(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'AUDIT_SCRUB_ARGS' || code === 'AUDIT_SCRUB_PROTECTED' || code === 'AUDIT_METADATA_CYCLE') {
      process.stderr.write('audit secret scrubber rejected the request\n');
      process.exitCode = 2;
      return;
    }
    process.stderr.write('audit secret scrubber failed\n');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  scrubAdminAuditSecrets,
  main,
};
