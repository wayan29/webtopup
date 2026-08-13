import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySettingsConflict,
  createSiteConfigIntent,
  invoiceRandomMin,
  parseAdminSettingsResponse,
  rebaseAfterConflict,
  retrySameIntent,
  siteConfigErrorMessage,
} from './siteConfigMutation.ts';

const fixtureSettings = {
  brand: 'Danayasa',
  title: 'Title',
  maintenanceMode: false,
  invoiceRandomType: 'alphanumeric',
  invoiceRandomLength: 8,
};

test('revision metadata never becomes an editable setting', () => {
  const parsed = parseAdminSettingsResponse({ ...fixtureSettings, revision: 14 });
  assert.equal(parsed.revision, 14);
  assert.equal('revision' in parsed.form, false);
});

test('one intent key survives step-up and replay but conflict creates a new intent', () => {
  let n = 0;
  const fixedCrypto = {
    randomUUID: () => {
      n += 1;
      return n === 1 ? '11111111-1111-1111-1111-111111111111' : '22222222-2222-2222-2222-222222222222';
    },
  };
  const intent = createSiteConfigIntent(14, { maintenanceMode: true }, fixedCrypto);
  assert.match(intent.key, /^sitecfg_/);
  assert.equal(retrySameIntent(intent).key, intent.key);
  const rebased = rebaseAfterConflict(intent, 15, { maintenanceMode: true }, fixedCrypto);
  assert.notEqual(rebased.key, intent.key);
  assert.equal(rebased.expectedRevision, 15);
});

test('commit unknown copy is explicitly uncertain', () => {
  const message = siteConfigErrorMessage({
    response: { data: { error: { code: 'SETTINGS_COMMIT_UNKNOWN' } } },
  });
  assert.match(message, /belum dapat dipastikan/i);
  assert.doesNotMatch(message, /gagal disimpan/i);
});

test('three-way conflict classification', () => {
  const base = { brand: 'A', title: 'T', fee: 1 };
  const draft = { brand: 'B', title: 'T', fee: 1 };
  const server = { brand: 'C', title: 'T2', fee: 1 };
  const kinds = classifySettingsConflict(base, draft, server);
  assert.equal(kinds.brand, 'conflict');
  assert.equal(kinds.title, 'server-only');
});

test('invoice random minimum depends on type', () => {
  assert.equal(invoiceRandomMin('alphanumeric'), 8);
  assert.equal(invoiceRandomMin('numeric'), 10);
});
