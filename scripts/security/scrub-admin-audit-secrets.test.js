'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const {
  AUDIT_REDACTION,
  isSensitiveAuditSecretKey,
  normalizeAuditSecretKey,
  redactAuditMetadata,
} = require('./audit-secret-policy');
const { parseArgs } = require('./scrub-admin-audit-secrets');

const cliPath = path.join(__dirname, 'scrub-admin-audit-secrets.js');

test('policy redacts pin aliases without false positives or truncation', () => {
  assert.equal(normalizeAuditSecretKey('Merchant-PIN'), 'merchantpin');
  assert.equal(isSensitiveAuditSecretKey('pin'), true);
  assert.equal(isSensitiveAuditSecretKey('shipping'), false);
  assert.equal(isSensitiveAuditSecretKey('mapping'), false);
  assert.equal(isSensitiveAuditSecretKey('pinned'), false);
  assert.equal(isSensitiveAuditSecretKey('opinion'), false);

  const longString = 'x'.repeat(600);
  const deep = { leaf: 'ok' };
  let cursor = deep;
  for (let index = 0; index < 12; index += 1) {
    cursor.child = { leaf: 'ok' };
    cursor = cursor.child;
  }
  const input = {
    pin: 'fixture-value',
    shipping: 'visible',
    nested: {
      merchant_pin: 'fixture-value',
      mapping: 'visible',
      long: longString,
      many: Array.from({ length: 60 }, (_, index) => index),
      deep,
    },
  };
  const first = redactAuditMetadata(input);
  assert.equal(first.affectedFields, 2);
  assert.equal(first.value.pin, AUDIT_REDACTION);
  assert.equal(first.value.nested.merchant_pin, AUDIT_REDACTION);
  assert.equal(first.value.shipping, 'visible');
  assert.equal(first.value.nested.mapping, 'visible');
  assert.equal(first.value.nested.long, longString);
  assert.equal(first.value.nested.many.length, 60);
  assert.equal(first.value.nested.deep.child.child.child.leaf, 'ok');

  const second = redactAuditMetadata(first.value);
  assert.equal(second.affectedFields, 0);
});

test('parseArgs enforces dry-run defaults and protected-database guards', () => {
  assert.throws(() => parseArgs([]), /mongo uri and database are required|unsupported argument|AUDIT_SCRUB_ARGS/);
  assert.throws(
    () => parseArgs(['--mongo-uri', 'mongodb://example.invalid', '--database', 'prod-like', '--apply']),
    /protected database apply is not authorized|AUDIT_SCRUB_PROTECTED/,
  );
  assert.throws(
    () => parseArgs([
      '--mongo-uri', 'mongodb://example.invalid',
      '--database', 'prod-like',
      '--apply',
      '--allow-protected-database',
      '--confirm-database', 'wrong-name',
    ]),
    /protected database apply is not authorized|AUDIT_SCRUB_PROTECTED/,
  );

  const dryRun = parseArgs([
    '--mongo-uri', 'mongodb://example.invalid',
    '--database', 'webtopup_task14_dev',
  ]);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.database, 'webtopup_task14_dev');

  const applyDisposable = parseArgs([
    '--mongo-uri', 'mongodb://example.invalid',
    '--database', 'webtopup_task14_dev',
    '--apply',
  ]);
  assert.equal(applyDisposable.apply, true);
});

test('cli rejects missing args without printing uri material', () => {
  const result = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes('mongodb://'), false);
  assert.equal(result.stderr.includes('mongodb://'), false);
  assert.match(result.stderr, /audit secret scrubber rejected the request/);
});
