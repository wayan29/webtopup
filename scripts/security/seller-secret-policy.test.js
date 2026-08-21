'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SELLER_RAW_TARGETS,
  SELLER_SCRUB_DISPOSABLE_DATABASE,
  isExactSellerRefIdIndex,
  parseSellerScrubArgs,
  sellerRefIdIndexState,
} = require('./seller-secret-policy');

test('seller scrub apply is disposable-only unless protected confirmation is complete', () => {
  assert.equal(
    parseSellerScrubArgs(['--mongo-uri', 'mongodb://fixture', '--database', 'webtopup_task14_dev', '--apply']).apply,
    true,
  );
  assert.throws(
    () =>
      parseSellerScrubArgs(['--mongo-uri', 'mongodb://fixture', '--database', 'webtopup', '--apply']),
    { code: 'SELLER_SCRUB_PROTECTED' },
  );
  assert.throws(
    () =>
      parseSellerScrubArgs([
        '--mongo-uri',
        'mongodb://fixture',
        '--database',
        'webtopup',
        '--apply',
        '--allow-protected-database',
        '--confirm-database',
        'webtopup',
      ]),
    { code: 'SELLER_SCRUB_PROTECTED' },
    'protected apply without backup reference must be rejected',
  );
  assert.equal(
    parseSellerScrubArgs([
      '--mongo-uri',
      'mongodb://fixture',
      '--database',
      'webtopup',
      '--apply',
      '--allow-protected-database',
      '--confirm-database',
      'webtopup',
      '--backup-reference',
      'backup-2026-08-20',
    ]).database,
    'webtopup',
  );
});

test('parseSellerScrubArgs rejects unknown arguments and missing configuration', () => {
  assert.throws(() => parseSellerScrubArgs([]), { code: 'SELLER_SCRUB_ARGS' });
  assert.throws(
    () => parseSellerScrubArgs(['--mongo-uri', 'mongodb://fixture', '--database', 'x', '--unknown']),
    { code: 'SELLER_SCRUB_ARGS' },
  );
});

test('seller raw targets are exactly the three historical collections', () => {
  assert.deepEqual(SELLER_RAW_TARGETS, [
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
  ]);
});

test('seller refId index semantics accept only exact unique non-TTL non-partial indexes', () => {
  const exact = { name: 'seller_ref_unique_custom', key: { refId: 1 }, unique: true };
  assert.equal(isExactSellerRefIdIndex(exact), true);

  const absence = sellerRefIdIndexState([]);
  assert.deepEqual(absence, { ready: false, drifted: false });

  const present = sellerRefIdIndexState([exact, { name: 'other', key: { createdAt: 1 } }]);
  assert.deepEqual(present, { ready: true, drifted: false });

  for (const drifted of [
    { name: 'refId_1', key: { refId: 1 } },
    { name: 'refId_1', key: { refId: 1 }, unique: true, expireAfterSeconds: 60 },
    { name: 'refId_1', key: { refId: 1 }, unique: true, partialFilterExpression: { a: 1 } },
    { name: 'refId_1', key: { refId: -1 }, unique: true },
    { name: 'refId_1', key: { refId: 1, extra: 1 }, unique: true },
  ]) {
    assert.equal(isExactSellerRefIdIndex(drifted), false, JSON.stringify(drifted));
  }

  const nonUnique = sellerRefIdIndexState([{ name: 'refId_1', key: { refId: 1 } }]);
  assert.deepEqual(nonUnique, { ready: false, drifted: true });
});

test('disposable database name is exact', () => {
  assert.equal(SELLER_SCRUB_DISPOSABLE_DATABASE, 'webtopup_task14_dev');
});
