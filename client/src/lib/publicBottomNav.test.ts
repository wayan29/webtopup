import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PUBLIC_BOTTOM_TABS,
    accountPathForAuth,
    activePublicBottomTab,
    pathForPublicBottomTab,
} from './publicBottomNav.ts';

test('public bottom nav exposes exactly four primary tabs', () => {
    assert.deepEqual(
        PUBLIC_BOTTOM_TABS.map((tab) => tab.id),
        ['home', 'products', 'check', 'account'],
    );
    assert.deepEqual(
        PUBLIC_BOTTOM_TABS.map((tab) => tab.label),
        ['Beranda', 'Produk', 'Cek', 'Akun'],
    );
});

test('account destination depends on authentication', () => {
    assert.equal(accountPathForAuth(false), '/login');
    assert.equal(accountPathForAuth(true), '/dashboard');
    assert.equal(pathForPublicBottomTab('account', false), '/login');
    assert.equal(pathForPublicBottomTab('account', true), '/dashboard');
});

test('active tab is path-based for the four primary surfaces', () => {
    assert.equal(activePublicBottomTab('/'), 'home');
    assert.equal(activePublicBottomTab('/products'), 'products');
    assert.equal(activePublicBottomTab('/products/foo'), 'products');
    assert.equal(activePublicBottomTab('/check-transaction'), 'check');
    assert.equal(activePublicBottomTab('/check-transaction/detail'), 'check');
    assert.equal(activePublicBottomTab('/login'), 'account');
    assert.equal(activePublicBottomTab('/register'), 'account');
    assert.equal(activePublicBottomTab('/dashboard'), 'account');
    assert.equal(activePublicBottomTab('/dashboard/deposit'), 'account');
    assert.equal(activePublicBottomTab('/transactions'), 'account');
});

test('near-miss paths do not steal the products or check tabs', () => {
    assert.equal(activePublicBottomTab('/products-public'), 'home');
    assert.equal(activePublicBottomTab('/check-transaction-public'), 'home');
    assert.equal(activePublicBottomTab('/administrator'), 'home');
});
