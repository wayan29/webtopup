import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseVendorHealthDiagnostics,
    parseVendorHealthResponse,
    vendorBalanceLabel,
    vendorFreshness,
    vendorHealthErrorMessage,
    vendorHealthMeta,
    vendorSuccessRateLabel,
} from './vendorHealth.ts';

test('malformed health never upgrades itself to healthy', () => {
    const parsed = parseVendorHealthResponse({ ok: true, vendors: 'invalid' });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.partial, true);
    assert.deepEqual(parsed.issues, [
        { code: 'MALFORMED_VENDOR_HEALTH_RESPONSE', source: 'client.parser' },
    ]);
});

test('snapshot snake case is normalized while Rust transaction fields stay camelCase', () => {
    const parsed = parseVendorHealthDiagnostics({
        ok: true, partial: false, issues: [], generated_at: '1787057000', source: 'mongodb-snapshot',
        vendors: [{
            key: 'digiflazz', label: 'Digiflazz', configured: true, active: true,
            low_balance_threshold: 1000, health: 'healthy', health_reason: 'normal',
            transactions_today: { total: 2, success: 2, failed: 0, pending: 0, successRate: 100, amountTotal: 5000 },
        }],
        totals: { vendors: 1, healthy: 1, warning: 0, critical: 0, transactions_today: 2 },
    });
    assert.equal(parsed.vendors[0]?.transactionsToday.successRate, 100);
    assert.equal(parsed.vendors[0]?.transactionsToday.amountTotal, 5000);
    assert.equal(parsed.vendors[0]?.lowBalanceThreshold, 1000);
    assert.equal(parsed.totals.transactionsToday, 2);
    assert.match(parsed.generatedAt ?? '', /^20\d\d-/);
});

test('freshness and unavailable value labels are explicit', () => {
    assert.equal(vendorFreshness('2026-08-18T12:00:00.000Z', Date.parse('2026-08-18T12:02:00.000Z')).state, 'fresh');
    assert.equal(vendorFreshness('2026-08-18T12:00:00.000Z', Date.parse('2026-08-18T12:02:00.001Z')).state, 'stale');
    assert.equal(vendorFreshness('bad-date').state, 'unknown');
    assert.equal(vendorFreshness(undefined).state, 'unknown');
    assert.equal(vendorBalanceLabel(false, null), 'Tidak tersedia');
    assert.equal(vendorBalanceLabel(true, null), 'Tidak tersedia');
    assert.equal(vendorBalanceLabel(true, 1500000), 'Rp1.500.000');
    assert.equal(vendorSuccessRateLabel(0, 0), 'Belum ada transaksi');
    assert.equal(vendorSuccessRateLabel(4, 75), '75%');
    assert.equal(vendorHealthMeta('disabled').label, 'Dinonaktifkan');
    assert.equal(vendorHealthMeta('unknown').label, 'Tidak diketahui');
    assert.equal(vendorHealthMeta('healthy').label, 'Sehat');
    assert.equal(vendorHealthMeta('warning').label, 'Perlu perhatian');
});

test('error copy reads only the public response message', () => {
    assert.equal(
        vendorHealthErrorMessage({ response: { data: { error: { message: 'Layanan terganggu' } } } }, 'Fallback'),
        'Layanan terganggu',
    );
    assert.equal(
        vendorHealthErrorMessage({ response: { data: { message: 'Layanan terganggu' } } }, 'Fallback'),
        'Layanan terganggu',
    );
    assert.equal(vendorHealthErrorMessage(new Error('mongodb://secret'), 'Fallback'), 'Fallback');
    assert.equal(vendorHealthErrorMessage(undefined, 'Fallback'), 'Fallback');
});

test('issue codes are allowlisted and deduplicated while server failure flags survive', () => {
    const parsed = parseVendorHealthResponse({
        ok: false,
        partial: true,
        snapshotPersisted: true,
        generatedAt: '2026-08-18T12:00:00.000Z',
        issues: [
            { code: 'NOT_A_REAL_CODE', source: 'client.parser' },
            { code: 'DIGIFLAZZ_BALANCE_UNAVAILABLE', source: 'provider.digiflazz' },
            { code: 'DIGIFLAZZ_BALANCE_UNAVAILABLE', source: 'provider.digiflazz' },
        ],
        vendors: [],
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.snapshotPersisted, true);
    assert.deepEqual(parsed.issues, [
        { code: 'DIGIFLAZZ_BALANCE_UNAVAILABLE', source: 'provider.digiflazz' },
    ]);
});

test('unknown health strings normalize to unknown and vendor entries stay honest', () => {
    const parsed = parseVendorHealthResponse({
        ok: true, partial: false, issues: [], snapshotPersisted: false,
        generatedAt: 'not-a-date', vendors: [
            {
                key: 'digiflazz', label: 'Digiflazz', configured: true, active: true,
                balance: null, balanceOk: false, lowBalanceThreshold: 1000, lowBalance: false,
                balanceMessage: 'Pemeriksaan saldo tidak tersedia', health: 'weird-state',
                transactionsToday: { total: 0, success: 0, failed: 0, pending: 0, successRate: 0, amountTotal: 0 },
                webhookToday: { total: 0, rejected: 0, failed: 0, delivered: 0, lastAt: null, lastStatus: '', lastMessage: '' },
            },
        ],
        seller: null,
    });
    assert.equal(parsed.vendors[0]?.health, 'unknown');
    assert.equal(parsed.generatedAt, null);
});

test('diagnostics degrade when the payload shape is invalid', () => {
    const parsed = parseVendorHealthDiagnostics({ ok: true, vendors: [{ key: 42 }] });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.issues, [
        { code: 'MALFORMED_VENDOR_HEALTH_RESPONSE', source: 'client.parser' },
    ]);
});
