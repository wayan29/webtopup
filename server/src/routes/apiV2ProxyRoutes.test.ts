import test from 'node:test';
import assert from 'node:assert/strict';
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

