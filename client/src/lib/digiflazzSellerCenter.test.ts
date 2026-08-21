import assert from 'node:assert/strict';
import test from 'node:test';

import {
    legacySellerCenterDestination,
    parseSellerCenterSection,
    parseSellerCenterSummary,
    SELLER_CENTER_SECTIONS,
} from './digiflazzSellerCenter.ts';

test('seller center sections and legacy routes fail closed to canonical destinations', () => {
    assert.deepEqual(SELLER_CENTER_SECTIONS, ['overview', 'settings', 'mappings', 'orders', 'irs']);
    assert.equal(parseSellerCenterSection('irs'), 'irs');
    assert.equal(parseSellerCenterSection('unknown'), 'overview');
    assert.equal(parseSellerCenterSection(['irs']), 'overview');
    assert.equal(parseSellerCenterSection(null), 'overview');
    assert.equal(
        legacySellerCenterDestination('/admin/addons/digiflazz-seller'),
        '/admin/addons/digiflazz-seller-center?section=overview',
    );
    assert.equal(
        legacySellerCenterDestination('/admin/addons/irs-seller'),
        '/admin/addons/digiflazz-seller-center?section=irs',
    );
    assert.equal(
        legacySellerCenterDestination('/admin/addons/digiflazz-seller-center'),
        '/admin/addons/digiflazz-seller-center',
    );
});

function summaryFixture() {
    return {
        ok: true,
        partial: false,
        issues: [],
        generatedAt: '2026-08-20T00:00:00.000Z',
        digiflazz: {
            configured: true,
            ready: true,
            status: 'ready',
            orders: { total: 3, pending: 1, failed: 0, callbackPending: 2 },
        },
        irs: {
            enabled: false,
            configured: false,
            ready: false,
            status: 'disabled',
            orders: { total: 0, pending: 0, failed: 0 },
        },
        mappings: { total: 4, active: 2 },
    };
}

test('summary parser accepts the exact typed contract', () => {
    const parsed = parseSellerCenterSummary(summaryFixture());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.partial, false);
    assert.equal(parsed.digiflazz.status, 'ready');
    assert.equal(parsed.digiflazz.orders.callbackPending, 2);
    assert.equal(parsed.irs.status, 'disabled');
    assert.equal(parsed.mappings.active, 2);
});

test('malformed summary never becomes ready', () => {
    const parsed = parseSellerCenterSummary({ ok: true, digiflazz: { status: 'ready' } });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.partial, true);
    assert.equal(parsed.digiflazz.status, 'unavailable');
    assert.deepEqual(parsed.issues, [
        { code: 'MALFORMED_SELLER_CENTER_RESPONSE', source: 'client.parser' },
    ]);
});

test('unknown issue codes, bad timestamps, and negative counts are malformed', () => {
    for (const change of [
        (value) => {
            value.issues = [{ code: 'INVENTED_CODE', source: 'client.parser' }];
        },
        (value) => {
            value.generatedAt = 'not-a-date';
        },
        (value) => {
            value.digiflazz.orders.total = -1;
        },
        (value) => {
            value.digiflazz.status = 'perfectly-fine';
        },
        (value) => {
            value.irs.configured = 'yes';
        },
        (value) => {
            value.ok = 'true';
        },
    ]) {
        const value = summaryFixture();
        change(value);
        const parsed = parseSellerCenterSummary(value);
        assert.equal(parsed.ok, false, JSON.stringify(value));
        assert.equal(parsed.digiflazz.status, 'unavailable');
        assert.deepEqual(parsed.issues, [
            { code: 'MALFORMED_SELLER_CENTER_RESPONSE', source: 'client.parser' },
        ]);
    }
});

test('server partial issues parse through with unavailable branch statuses', () => {
    const value = summaryFixture();
    value.partial = true;
    value.issues = [
        { code: 'IRS_ORDER_SUMMARY_UNAVAILABLE', source: 'mongodb.irsSellerOrders' },
    ];
    value.irs.status = 'unavailable';
    value.irs.orders = { total: 0, pending: 0, failed: 0 };
    value.digiflazz.status = 'attention';
    value.digiflazz.ready = false;
    const parsed = parseSellerCenterSummary(value);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.partial, true);
    assert.equal(parsed.issues[0].code, 'IRS_ORDER_SUMMARY_UNAVAILABLE');
    assert.equal(parsed.irs.status, 'unavailable');
    assert.equal(parsed.digiflazz.status, 'attention');
});

test('summary section metadata stays stable for the UI shell', () => {
    assert.equal(typeof SELLER_CENTER_SECTIONS.includes, 'function');
    for (const section of SELLER_CENTER_SECTIONS) assert.equal(typeof section, 'string');
});
