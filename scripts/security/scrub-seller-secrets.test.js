'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applySellerHygiene,
  inspectSellerHygiene,
} = require('./scrub-seller-secrets');

function fakeCursor(items) {
  return {
    toArray: async () => items,
  };
}

function fakeDb({ scannedByCollection, affectedByCollection, duplicateGroups, indexes }) {
  const updates = [];
  const affected = { ...affectedByCollection };
  return {
    updates,
    collection(name) {
      return {
        async countDocuments(filter) {
          if (filter && Object.keys(filter).length > 0) return affected[name] ?? 0;
          return scannedByCollection[name] ?? 0;
        },
        aggregate() {
          return fakeCursor(duplicateGroups[name] ?? []);
        },
        listIndexes() {
          return fakeCursor(indexes[name] ?? []);
        },
        async updateMany(filter, update) {
          updates.push({ name, filter, update });
          const modified = affected[name] ?? 0;
          affected[name] = 0;
          return { modifiedCount: modified };
        },
      };
    },
  };
}

test('inspectSellerHygiene reports counts only and blocks on duplicates or drifted indexes', async () => {
  const db = fakeDb({
    scannedByCollection: { digiflazzsellerorders: 5, irssellerorders: 3, webhookeventlogs: 9 },
    affectedByCollection: { digiflazzsellerorders: 2, irssellerorders: 1, webhookeventlogs: 4 },
    duplicateGroups: { digiflazzsellerorders: [{ duplicateGroups: 1 }] },
    indexes: {
      digiflazzsellerorders: [{ name: 'refId_1', key: { refId: 1 } }],
      irssellerorders: [{ name: 'ref_unique', key: { refId: 1 }, unique: true }],
    },
  });

  const report = await inspectSellerHygiene(db, 'webtopup_task14_dev');
  const text = JSON.stringify(report);
  assert.equal(report.database, 'webtopup_task14_dev');
  assert.equal(report.applied, false);
  assert.deepEqual(report.collections.digiflazzsellerorders, {
    scanned: 5,
    affected: 2,
    duplicateRefIds: 1,
    uniqueIndexReady: false,
  });
  assert.deepEqual(report.collections.irssellerorders, {
    scanned: 3,
    affected: 1,
    duplicateRefIds: 0,
    uniqueIndexReady: true,
  });
  assert.deepEqual(report.collections.webhookeventlogs, { scanned: 9, affected: 4 });
  assert.equal(report.blocking, true, 'duplicates or drifted index definitions are blocking');
  assert.ok(!text.includes('rawRequest":"'), 'report must not echo raw document values');
});

test('applySellerHygiene only unsets raw fields and reports modified counts', async () => {
  const db = fakeDb({
    scannedByCollection: { digiflazzsellerorders: 5, irssellerorders: 3, webhookeventlogs: 9 },
    affectedByCollection: { digiflazzsellerorders: 2, irssellerorders: 1, webhookeventlogs: 4 },
    duplicateGroups: {},
    indexes: {
      digiflazzsellerorders: [{ name: 'u', key: { refId: 1 }, unique: true }],
      irssellerorders: [{ name: 'u', key: { refId: 1 }, unique: true }],
    },
  });

  const { postReport } = await applySellerHygiene(db, 'webtopup_task14_dev');
  assert.equal(postReport.applied, true);
  assert.equal(postReport.modifiedDocuments, 7);
  assert.equal(postReport.blocking, false);
  assert.deepEqual(
    db.updates.map(({ name, filter }) => [name, filter]),
    [
      ['digiflazzsellerorders', { rawRequest: { $exists: true } }],
      ['irssellerorders', { rawRequest: { $exists: true } }],
      [
        'webhookeventlogs',
        { provider: { $in: ['digiflazz_seller', 'irs_seller'] }, raw: { $exists: true } },
      ],
    ],
  );
  for (const { update } of db.updates) {
    assert.ok(update.$unset, 'apply must only unset raw fields');
    assert.ok(!update.$set && !update.$createIndex, 'apply must never set values or create indexes');
  }
});
