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
