import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CRITICAL_IDEMPOTENT_ROUTE_PATTERNS,
    isCriticalIdempotentMutation,
    normalizeGatewayIdempotencyKey,
    requireCriticalIdempotencyKey,
} from './apiV2ProxyRoutes';

test('critical idempotency contract recognizes giveaway POST routes only', () => {
    assert.equal(CRITICAL_IDEMPOTENT_ROUTE_PATTERNS.has('/vouchers/giveaways'), true);
    assert.equal(CRITICAL_IDEMPOTENT_ROUTE_PATTERNS.has('/api/v2/vouchers/giveaways'), true);
    assert.equal(
        isCriticalIdempotentMutation({
            method: 'POST',
            url: '/vouchers/giveaways',
            routeOptions: { url: '/vouchers/giveaways' },
        } as never),
        true,
    );
    assert.equal(
        isCriticalIdempotentMutation({
            method: 'GET',
            url: '/vouchers/giveaways',
            routeOptions: { url: '/vouchers/giveaways' },
        } as never),
        false,
    );
});

test('gateway idempotency key normalization is bounded and rejects duplicates', async () => {
    assert.equal(normalizeGatewayIdempotencyKey('  giveaway-2026-01  '), 'giveaway-2026-01');
    assert.equal(normalizeGatewayIdempotencyKey('short'), null);
    assert.equal(normalizeGatewayIdempotencyKey('invalid key'), null);
    assert.equal(normalizeGatewayIdempotencyKey('a'.repeat(129)), null);

    const missingRequest = {
        method: 'POST',
        url: '/vouchers/giveaways',
        routeOptions: { url: '/vouchers/giveaways' },
        headers: {},
    };
    const missingReply = {
        statusCode: 0,
        body: undefined as unknown,
        status(code: number) { this.statusCode = code; return this; },
        send(body: unknown) { this.body = body; return this; },
    };
    await requireCriticalIdempotencyKey(missingRequest as never, missingReply as never);
    assert.equal(missingReply.statusCode, 400);
    assert.equal((missingReply.body as { error?: { code?: string } })?.error?.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const duplicateRequest = {
        method: 'POST',
        url: '/vouchers/giveaways',
        routeOptions: { url: '/vouchers/giveaways' },
        headers: { 'idempotency-key': ['giveaway-2026-01', 'giveaway-2026-01'] },
    };
    const duplicateReply = {
        statusCode: 0,
        status(code: number) { this.statusCode = code; return this; },
        send() { return this; },
    };
    await requireCriticalIdempotencyKey(duplicateRequest as never, duplicateReply as never);
    assert.equal(duplicateReply.statusCode, 400);

    const validRequest = {
        method: 'POST',
        url: '/vouchers/giveaways',
        routeOptions: { url: '/vouchers/giveaways' },
        headers: { 'idempotency-key': ' giveaway-2026-01 ' },
    };
    await requireCriticalIdempotencyKey(validRequest as never, duplicateReply as never);
    assert.equal(validRequest.headers['idempotency-key'], 'giveaway-2026-01');
});

test('giveaway read and preview routes precede the voucher catch-all', () => {
    const sourcePath = join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const catchAll = source.indexOf("app.all('/vouchers*'");
    for (const route of [
        "app.get('/vouchers/giveaways'",
        "app.get('/vouchers/giveaways/:id'",
        "app.post('/vouchers/giveaways/preview'",
    ]) {
        const position = source.indexOf(route);
        assert.ok(position >= 0, `${route} route is missing`);
        assert.ok(position < catchAll, `${route} must precede voucher catch-all`);
    }
    const routeStart = source.indexOf("app.get('/vouchers/giveaways'");
    const route = source.slice(routeStart, catchAll);
    assert.match(route, /authenticate/);
    assert.match(route, /hasPermission\('manageVouchers'\)/);
});

test('giveaway execution has dedicated step-up and idempotency gateway route', () => {
    const sourcePath = join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const dedicated = source.indexOf("app.post('/vouchers/giveaways'");
    const catchAll = source.indexOf("app.all('/vouchers*'");

    assert.ok(dedicated >= 0, 'dedicated giveaway route is missing');
    assert.ok(catchAll >= 0, 'voucher catch-all route is missing');
    assert.ok(dedicated < catchAll, 'giveaway route must precede voucher catch-all');

    const route = source.slice(dedicated, catchAll);
    assert.match(route, /hasPermission\('manageVouchers'\)/);
    assert.match(route, /requireStepUp\('finance\.adjust_balance'\)/);
    assert.match(route, /requireCriticalIdempotencyKey/);

    const criticalPatterns = source.slice(
        source.indexOf('const CRITICAL_IDEMPOTENT_ROUTE_PATTERNS'),
        source.indexOf('const isCriticalIdempotentMutation'),
    );
    assert.ok(criticalPatterns.includes("'/vouchers/giveaways'"));
    assert.ok(criticalPatterns.includes("'/api/v2/vouchers/giveaways'"));
});

test('catalog read routes use viewProducts before mutation catch-alls', () => {
    const sourcePath = join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const reads = [
        "app.get('/categories/admin/all'",
        "app.get('/operators/admin/all'",
        "app.get('/operators/admin/:id'",
        "app.get('/product-types/admin/all'",
        "app.get('/product-types/admin/:id'",
        "app.get('/products/admin/all'",
        "app.get('/products/admin/sorting'",
    ];
    const catchAlls = [
        "app.all('/categories/admin/*'",
        "app.all('/operators/admin/*'",
        "app.all('/product-types/admin/*'",
        "app.all('/products/admin/*'",
    ];

    for (const route of reads) {
        const position = source.indexOf(route);
        assert.ok(position >= 0, `${route} route is missing`);
        const nextRoute = source.indexOf('\n    app.', position + route.length);
        const block = source.slice(position, nextRoute < 0 ? source.length : nextRoute);
        assert.match(block, /hasPermission\('viewProducts'\)/, `${route} must use viewProducts`);
    }

    for (const catchAll of catchAlls) {
        const position = source.indexOf(catchAll);
        assert.ok(position >= 0, `${catchAll} route is missing`);
        assert.match(source.slice(position, position + 180), /hasPermission\('manageProducts'\)/);
    }

    const earliestMutationCatchAll = Math.min(...catchAlls.map((route) => source.indexOf(route)));
    for (const route of reads) {
        assert.ok(source.indexOf(route) < earliestMutationCatchAll, `${route} must precede catalog catch-alls`);
    }
});

test('catalog mutations use explicit methods and manageProducts', () => {
    const sourcePath = join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const mutations = [
        "app.post('/categories/admin/create'",
        "app.put('/categories/admin/sort-order'",
        "app.put('/categories/admin/:id'",
        "app.delete('/categories/admin/:id'",
        "app.post('/operators/admin/create'",
        "app.put('/operators/admin/sort-order'",
        "app.put('/operators/admin/:id'",
        "app.delete('/operators/admin/:id'",
        "app.post('/product-types/admin/create'",
        "app.put('/product-types/admin/sort-order'",
        "app.put('/product-types/admin/:id'",
        "app.delete('/product-types/admin/:id'",
        "app.post('/products'",
        "app.put('/products/:id'",
        "app.delete('/products/:id'",
        "app.post('/products/admin/sort-order'",
        "app.post('/products/admin/sort-by-price'",
    ];

    for (const route of mutations) {
        const position = source.indexOf(route);
        assert.ok(position >= 0, `${route} route is missing`);
        const nextRoute = source.indexOf('\n    app.', position + route.length);
        const block = source.slice(position, nextRoute < 0 ? source.length : nextRoute);
        assert.match(block, /hasPermission\('manageProducts'\)/, `${route} must use manageProducts`);
    }

    assert.doesNotMatch(source, /app\.all\('\/(?:categories|operators|product-types)\/admin\/sort-order'/);
    assert.doesNotMatch(source, /app\.all\('\/products\/admin\/sort-(?:order|by-price)'/);
});
