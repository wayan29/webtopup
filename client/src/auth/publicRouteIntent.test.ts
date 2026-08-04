import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicAppPath, publicBootstrapFailureView } from './publicRouteIntent.ts';

const publicPaths = [
    '/',
    '/products',
    '/products/',
    '/order',
    '/order/mobile-legends',
    '/order/mobile-legends/diamonds',
    '/check-transaction',
    '/leaderboard',
    '/articles',
    '/articles/how-to-top-up',
    '/login',
    '/register',
    '/staff/login',
];

const protectedPaths = [
    '/dashboard',
    '/dashboard/history',
    '/admin',
    '/admin/dashboard',
    '/redeem-voucher',
    '/credits',
    '/transactions',
    '/transactions/history',
    '/mutations',
    '/reports',
    '/settings',
    '/account',
    '/security/sessions',
    '/deposit',
    '/deposits',
];

test('canonical public routes settle anonymous on bootstrap throttling', () => {
    for (const path of publicPaths) {
        assert.equal(isPublicAppPath(path), true, path);
        assert.equal(publicBootstrapFailureView(path, 429), 'anonymous', path);
    }
});

test('protected routes retain the rate-limited bootstrap view', () => {
    for (const path of protectedPaths) {
        assert.equal(isPublicAppPath(path), false, path);
        assert.equal(publicBootstrapFailureView(path, 429), 'rate-limited', path);
    }
});

test('classification is segment-safe and malformed pathnames fail closed', () => {
    for (const path of [
        '/administrator',
        '/dashboardish',
        '/transactions-public',
        '/orders',
        '/article',
        '/staff/login/extra',
        '//evil.example/products',
        'products',
        '/%2Fproducts',
        '/products%2Fprivate',
        '/products/private',
        '/leaderboard/private',
        '/login/private',
        '/products/../admin',
        '/products?next=/admin',
        '/products#admin',
    ]) {
        assert.equal(isPublicAppPath(path), false, path);
    }
});

test('a surviving valid session wins over public/protected throttle classification', () => {
    assert.equal(publicBootstrapFailureView('/', 429, true), 'preserve-session');
    assert.equal(publicBootstrapFailureView('/dashboard', 429, true), 'preserve-session');
});

test('cold tokenless public throttles settle anonymous while protected stays rate-limited', () => {
    assert.equal(publicBootstrapFailureView('/', 429, false), 'anonymous');
    assert.equal(publicBootstrapFailureView('/dashboard', 429, false), 'rate-limited');
    assert.equal(publicBootstrapFailureView('/', 503), 'rate-limited');
});
