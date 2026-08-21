'use strict';

// Secrecy policy for historical Digiflazz/IRS seller data.
// This module is pure: it contains no Mongo connection logic so guards and
// target tables can be verified without a database.

const SELLER_SCRUB_DISPOSABLE_DATABASE = 'webtopup_task14_dev';

const SELLER_RAW_TARGETS = [
  [
    'digiflazzsellerorders',
    { rawRequest: { $exists: true } },
    { $unset: { rawRequest: '' } },
  ],
  ['irssellerorders', { rawRequest: { $exists: true } }, { $unset: { rawRequest: '' } }],
  [
    'webhookeventlogs',
    { provider: { $in: ['digiflazz_seller', 'irs_seller'] }, raw: { $exists: true } },
    { $unset: { raw: '' } },
  ],
];

const SELLER_ORDER_COLLECTIONS = ['digiflazzsellerorders', 'irssellerorders'];

function sellerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isExactSellerRefIdIndex(index) {
  if (!index || typeof index !== 'object') return false;
  const key = index.key || {};
  return (
    Object.keys(key).length === 1 &&
    key.refId === 1 &&
    index.unique === true &&
    index.expireAfterSeconds === undefined &&
    index.partialFilterExpression === undefined
  );
}

function sellerRefIdIndexState(indexes) {
  let drifted = false;
  for (const index of indexes) {
    if (!index || typeof index !== 'object') continue;
    const key = index.key || {};
    if (!Object.prototype.hasOwnProperty.call(key, 'refId')) continue;
    if (isExactSellerRefIdIndex(index)) return { ready: true, drifted: false };
    drifted = true;
  }
  return { ready: false, drifted };
}

function parseSellerScrubArgs(argv) {
  const options = {
    mongoUri: null,
    database: null,
    apply: false,
    allowProtectedDatabase: false,
    confirmDatabase: null,
    backupReference: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--apply':
        options.apply = true;
        break;
      case '--allow-protected-database':
        options.allowProtectedDatabase = true;
        break;
      case '--mongo-uri':
      case '--database':
      case '--confirm-database':
      case '--backup-reference': {
        const value = argv[index + 1];
        if (typeof value !== 'string' || value.startsWith('--')) {
          throw sellerError(`missing value for ${arg}`, 'SELLER_SCRUB_ARGS');
        }
        index += 1;
        if (arg === '--mongo-uri') options.mongoUri = value;
        if (arg === '--database') options.database = value;
        if (arg === '--confirm-database') options.confirmDatabase = value;
        if (arg === '--backup-reference') options.backupReference = value;
        break;
      }
      default:
        throw sellerError(`unsupported argument ${arg}`, 'SELLER_SCRUB_ARGS');
    }
  }

  if (!options.mongoUri || !options.database) {
    throw sellerError('mongo uri and database are required', 'SELLER_SCRUB_ARGS');
  }

  if (options.apply && options.database !== SELLER_SCRUB_DISPOSABLE_DATABASE) {
    const confirmed =
      options.allowProtectedDatabase &&
      options.confirmDatabase === options.database &&
      typeof options.backupReference === 'string' &&
      options.backupReference.trim().length > 0;
    if (!confirmed) {
      throw sellerError('protected database apply is not authorized', 'SELLER_SCRUB_PROTECTED');
    }
  }

  return options;
}

module.exports = {
  SELLER_ORDER_COLLECTIONS,
  SELLER_RAW_TARGETS,
  SELLER_SCRUB_DISPOSABLE_DATABASE,
  isExactSellerRefIdIndex,
  parseSellerScrubArgs,
  sellerRefIdIndexState,
};
