import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ADMIN_AUDIT_REDACTION,
    isSensitiveAuditMetadataKey,
    normalizeAuditMetadataKey,
    recordAdminAuditLog,
    sanitizeAuditMetadataValue,
    type AdminAuditWriterDependencies,
} from './adminAuditService';

const EXACT_KEYS = [
    'password',
    'currentPassword',
    'newPassword',
    'confirmPassword',
    'pin',
    'merchant_pin',
    'Transaction PIN',
    'security-pin',
    'API-Key',
    'secret',
    'vendorSecret',
    'twoFactorSecret',
    'twoFactorPendingSecret',
    'otp',
    'code',
    'token',
    'authorization',
    'cookie',
    'csrf_token',
    'accessToken',
    'refreshToken',
    'recoveryToken',
    'ciphertext',
    'nonce',
    'digest',
    'sessionTokenHashSecret',
] as const;

test('audit sanitizer redacts exact normalized credential keys without PIN false positives', () => {
    assert.equal(normalizeAuditMetadataKey('Merchant-PIN'), 'merchantpin');

    for (const key of EXACT_KEYS) {
        assert.equal(isSensitiveAuditMetadataKey(key), true, key);
    }

    for (const key of ['shipping', 'mapping', 'pinned', 'opinion']) {
        assert.equal(isSensitiveAuditMetadataKey(key), false, key);
    }

    assert.deepEqual(sanitizeAuditMetadataValue({
        pin: 'fixture-value',
        nested: [{ merchant_pin: 'fixture-value', shipping: 'visible' }],
    }), {
        pin: ADMIN_AUDIT_REDACTION,
        nested: [{ merchant_pin: ADMIN_AUDIT_REDACTION, shipping: 'visible' }],
    });
});

test('audit sanitizer applies depth array object and string limits', () => {
    const deep: Record<string, unknown> = { leaf: 'ok' };
    let cursor: Record<string, unknown> = deep;
    for (let depth = 0; depth < 10; depth += 1) {
        const next: Record<string, unknown> = { leaf: 'ok' };
        cursor.child = next;
        cursor = next;
    }

    const sanitizedDeep = sanitizeAuditMetadataValue(deep) as Record<string, unknown>;
    let walker: unknown = sanitizedDeep;
    for (let depth = 0; depth < 8; depth += 1) {
        assert.equal(typeof walker, 'object');
        walker = (walker as Record<string, unknown>).child;
    }
    assert.equal(walker, '[depth-limited]');

    const longArray = Array.from({ length: 60 }, (_, index) => index);
    assert.deepEqual(
        sanitizeAuditMetadataValue(longArray),
        Array.from({ length: 50 }, (_, index) => index),
    );

    const wideObject = Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [`k${index}`, index]),
    );
    const sanitizedWide = sanitizeAuditMetadataValue(wideObject) as Record<string, unknown>;
    assert.equal(Object.keys(sanitizedWide).length, 100);
    assert.equal(sanitizedWide.k0, 0);
    assert.equal(sanitizedWide.k99, 99);
    assert.equal(sanitizedWide.k100, undefined);

    const longString = 'x'.repeat(600);
    assert.equal(
        sanitizeAuditMetadataValue(longString),
        `${'x'.repeat(500)}...`,
    );
});

test('audit writer records failed mutation status with sanitized body and swallows insert failures', async () => {
    const created: Array<Record<string, unknown>> = [];
    const errors: unknown[] = [];
    const dependencies: AdminAuditWriterDependencies = {
        findActor: async () => ({
            _id: 'actor-id',
            name: 'Audit Fixture',
            email: 'audit-fixture@task14.invalid',
            role: 'cs',
        }),
        createAuditLog: async (document) => {
            created.push(document);
            throw new Error('synthetic insert failure');
        },
    };

    const request = {
        method: 'POST',
        url: '/api/v2/categories/admin/create?probe=1',
        ip: '127.0.0.1',
        raw: { socket: { remoteAddress: '127.0.0.1' } },
        user: {
            id: 'actor-id',
            role: 'cs',
            authMode: 'refresh-session',
            sessionId: 'session-id',
        },
        params: { marker: 'params-marker' },
        body: {
            verificationMarker: 'writer-marker',
            pin: 'fixture-value',
            merchant_pin: 'fixture-value',
            shipping: 'visible',
        },
        headers: {
            'user-agent': 'task14-audit-writer-test',
        },
        log: {
            error: (payload: unknown) => {
                errors.push(payload);
            },
        },
    };

    await assert.doesNotReject(async () => {
        await recordAdminAuditLog(request as never, 400, dependencies);
    });

    assert.equal(created.length, 1);
    const document = created[0]!;
    assert.equal(document.statusCode, 400);
    assert.equal(document.method, 'POST');
    assert.equal(document.path, '/api/v2/categories/admin/create');
    assert.equal(document.resource, 'Product Categories');
    assert.equal(document.action, 'create');
    assert.equal(document.summary, 'POST /api/v2/categories/admin/create');

    const metadata = document.metadata as Record<string, unknown>;
    assert.equal(metadata.auditSource, 'node_gateway');
    assert.deepEqual(metadata.params, { marker: 'params-marker' });
    assert.deepEqual(metadata.body, {
        verificationMarker: 'writer-marker',
        pin: ADMIN_AUDIT_REDACTION,
        merchant_pin: ADMIN_AUDIT_REDACTION,
        shipping: 'visible',
    });
    assert.equal(errors.length, 1);
});
