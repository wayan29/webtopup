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

test('slider gateway inventory keeps every new mutation behind the complete gateway gate', () => {
    const sourcePath = join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const mutationRoutes = [
        ['post', '/sliders/admin/create'],
        ['put', '/sliders/admin/:id'],
        ['post', '/sliders/admin/:id/archive'],
        ['post', '/sliders/admin/:id/restore'],
        ['put', '/sliders/admin/reorder'],
    ] as const;

    for (const [method, path] of mutationRoutes) {
        const route = `app.${method}('${path}'`;
        const position = source.indexOf(route);
        assert.ok(position >= 0, `${route} route is missing`);
        const nextRoute = source.indexOf('\n    app.', position + route.length);
        const block = source.slice(position, nextRoute < 0 ? source.length : nextRoute);
        assert.match(block, /authenticate/, `${route} must authenticate`);
        assert.match(block, /hasPermission\('manageSettings'\)/, `${route} must manage settings`);
        assert.match(block, /requireSliderIdempotencyKey/, `${route} must require slider idempotency`);
        assert.match(block, /acceptOptionalStepUp\('settings\.sensitive'\)/, `${route} must accept exact optional step-up`);
        assert.match(block, /bodyLimit:\s*64\s*\*\s*1024/, `${route} must cap JSON at 64 KiB`);
        assert.match(block, /proxyRequest/, `${route} must forward after gates`);
    }

    const archive = source.indexOf("app.post('/sliders/admin/:id/archive'");
    const restore = source.indexOf("app.post('/sliders/admin/:id/restore'");
    const update = source.indexOf("app.put('/sliders/admin/:id'");
    assert.ok(archive < update, 'archive route must precede the dynamic update route');
    assert.ok(restore < update, 'restore route must precede the dynamic update route');
    assert.match(source.slice(source.indexOf("app.put('/sliders/admin/sort-order'"), update), /405/);
    assert.match(source.slice(source.indexOf("app.delete('/sliders/admin/:id'"), source.length), /405/);
});

test('slider gateway strips browser capability headers and signs only the two canonical admin reads', () => {
    const sourcePath = join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts');
    const source = readFileSync(sourcePath, 'utf8');
    for (const header of [
        'x-webtopup-slider-contract-version',
        'x-webtopup-slider-contract-timestamp',
        'x-webtopup-slider-contract-assertion',
    ]) {
        assert.match(source, new RegExp(`['\\"]${header}['\\"]`), `${header} must be named explicitly`);
    }
    assert.match(source, /createHmac\(['"]sha256['"]/);
    assert.match(source, /slider-contract-capability\/v1/);
    assert.match(source, /join\(['"]\\n['"]\)/);
    assert.match(source, /\/v2\/sliders\/admin\/all/);
    assert.match(source, /\/v2\/sliders\/admin\/archived/);
    assert.match(source, /filterUpstreamResponseHeaders[\s\S]*SLIDER_CAPABILITY/);
});

test('public sliders forward validators and never cache a response body, while app exposes ETag', () => {
    const routePath = join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts');
    const appPath = join(__dirname, '..', '..', 'src', 'app.ts');
    const source = readFileSync(routePath, 'utf8');
    const appSource = readFileSync(appPath, 'utf8');
    const routeStart = source.indexOf("app.get('/sliders'");
    assert.ok(routeStart >= 0);
    const routeEnd = source.indexOf("const proxyPublicSettingsRequest", routeStart);
    const route = source.slice(source.indexOf('const proxyPublicSliderRequest'), routeEnd);
    assert.match(route, /proxyPublicSliderRequest/);
    assert.match(source, /if-none-match/);
    assert.match(route, /304/);
    assert.match(route, /no-cache/);
    assert.match(appSource, /exposedHeaders:[\s\S]*['"]ETag['"]/);
});

test('legacy slider controller is not registered in the gateway app', () => {
    const appSource = readFileSync(join(__dirname, '..', '..', 'src', 'app.ts'), 'utf8');
    assert.doesNotMatch(appSource, /sliderRoutes/);
});

test('vendor health reads and export retain exact permission and step-up boundaries', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts'), 'utf8');
    assert.match(source, /app\.get\('\/vendors\/health', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\)\] \}/);
    assert.match(source, /app\.get\('\/vendors\/health-snapshot', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\)\] \}/);
    assert.match(source, /app\.get\('\/vendors\/health\/export', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\), requireStepUp\('exports\.sensitive'\)\] \}/);

    const rust = readFileSync(join(__dirname, '..', '..', '..', 'rust-api', 'src', 'routes', 'vendors', 'health.rs'), 'utf8');
    assert.match(rust, /require_trusted_step_up_group\(&headers, "exports\.sensitive"\)/);
});

test('legacy vendor routes are not registered in the gateway app', () => {
    const appSource = readFileSync(join(__dirname, '..', '..', 'src', 'app.ts'), 'utf8');
    assert.doesNotMatch(appSource, /vendorRoutes/);
});

test('seller center summary keeps exact permissions and public prepaid order', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts'), 'utf8');
    assert.match(source, /app\.get\('\/digiflazz-seller\/center-summary', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\)\] \}/u);
    assert.match(source, /app\.get\('\/digiflazz-seller\/orders\/admin', \{ preHandler: \[authenticate, hasPermission\('viewTransactions'\)\] \}/u);
    assert.match(source, /app\.get\('\/irs-seller\/orders\/admin', \{ preHandler: \[authenticate, hasPermission\('viewTransactions'\)\] \}/u);
    assert.match(source, /app\.post\('\/digiflazz-seller\/settings', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\), requireStepUp\('integrations\.credentials'\)\] \}/u);
    assert.match(source, /app\.post\('\/irs-seller\/settings', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\), requireStepUp\('integrations\.credentials'\)\] \}/u);

    const summaryAt = source.indexOf("app.get('/digiflazz-seller/center-summary'");
    const digiflazzCatchAllAt = source.indexOf("app.all('/digiflazz-seller/*'");
    assert.ok(summaryAt > -1 && summaryAt < digiflazzCatchAllAt, 'summary must register before the protected catch-all');

    for (const prepaidLine of ["app.post('/digiflazz-seller/prepaid'", "app.post('/irs-seller/prepaid'"]) {
        const lineAt = source.indexOf(prepaidLine);
        const lineEnd = source.indexOf('\n', lineAt);
        const line = source.slice(lineAt, lineEnd);
        assert.ok(!line.includes('authenticate'), `${prepaidLine} must stay public`);
    }
    const irsPrepaidAt = source.indexOf("app.post('/irs-seller/prepaid'");
    const irsCatchAllAt = source.indexOf("app.all('/irs-seller/*'");
    assert.ok(irsPrepaidAt < irsCatchAllAt, 'public IRS prepaid must register before the catch-all');
});

test('legacy node seller controllers stay unregistered', () => {
    const appSource = readFileSync(join(__dirname, '..', '..', 'src', 'app.ts'), 'utf8');
    assert.doesNotMatch(appSource, /digiflazzSellerRoutes/);
    assert.doesNotMatch(appSource, /irsSellerRoutes/);
});
