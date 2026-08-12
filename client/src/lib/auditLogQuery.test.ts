import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditPageCorrection,
  auditPaginationRange,
  parseAuditLogSearchParams,
  serializeAuditLogQuery,
  validateAuditLogDraft,
} from './auditLogQuery.ts';

test('audit query serializes in canonical order and omits page one', () => {
  const params = serializeAuditLogQuery({
    search: 'products',
    action: 'update',
    resource: 'Products',
    startDate: '2026-08-01',
    endDate: '2026-08-12',
    page: 1,
  });
  assert.equal(
    params.toString(),
    'q=products&action=update&resource=Products&startDate=2026-08-01&endDate=2026-08-12',
  );
});

test('pagination range and correction are deterministic', () => {
  assert.deepEqual(auditPaginationRange(2, 25, 237), { start: 26, end: 50 });
  assert.deepEqual(auditPaginationRange(1, 25, 0), { start: 0, end: 0 });
  assert.equal(auditPageCorrection(999, 10, 237), 10);
  assert.equal(auditPageCorrection(2, 0, 0), 1);
  assert.equal(auditPageCorrection(1, 0, 0), null);
  assert.equal(auditPageCorrection(3, 10, 237), null);
});

test('draft and URL validation reject malformed filters and pages', () => {
  assert.equal(validateAuditLogDraft({
    search: 'a',
    action: '',
    resource: '',
    startDate: '',
    endDate: '',
  }).ok, false);

  assert.equal(validateAuditLogDraft({
    search: 'x'.repeat(121),
    action: '',
    resource: '',
    startDate: '',
    endDate: '',
  }).ok, false);

  assert.equal(validateAuditLogDraft({
    search: '',
    action: 'deleted' as never,
    resource: '',
    startDate: '',
    endDate: '',
  }).ok, false);

  assert.equal(validateAuditLogDraft({
    search: '',
    action: '',
    resource: 'r'.repeat(121),
    startDate: '',
    endDate: '',
  }).ok, false);

  assert.equal(validateAuditLogDraft({
    search: '',
    action: '',
    resource: '',
    startDate: '2026-02-30',
    endDate: '',
  }).ok, false);

  assert.equal(validateAuditLogDraft({
    search: '',
    action: '',
    resource: '',
    startDate: '2026-08-12',
    endDate: '2026-08-01',
  }).ok, false);

  assert.equal(parseAuditLogSearchParams(new URLSearchParams('page=Infinity')).ok, false);
  assert.equal(parseAuditLogSearchParams(new URLSearchParams('page=1.5')).ok, false);
  assert.equal(parseAuditLogSearchParams(new URLSearchParams('page=0')).ok, false);
  assert.equal(parseAuditLogSearchParams(new URLSearchParams('page=-2')).ok, false);
  assert.equal(parseAuditLogSearchParams(new URLSearchParams('page=10001')).ok, false);
});

test('parse and serialize round-trip with stable canonical ordering', () => {
  const raw = new URLSearchParams('page=2&endDate=2026-08-12&q=products&resource=Products&action=update&startDate=2026-08-01');
  const parsed = parseAuditLogSearchParams(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(
    parsed.canonicalQueryString,
    'q=products&action=update&resource=Products&startDate=2026-08-01&endDate=2026-08-12&page=2',
  );
  assert.deepEqual(parsed.value, {
    search: 'products',
    action: 'update',
    resource: 'Products',
    startDate: '2026-08-01',
    endDate: '2026-08-12',
    page: 2,
  });
});
