import assert from 'node:assert/strict';
import test from 'node:test';
import { hasResolvedPermission } from './authMiddleware';

test('approveDeposits implies viewDeposits but not unrelated access', () => {
    const permissions = { approveDeposits: true } as never;
    assert.equal(hasResolvedPermission(permissions, 'viewDeposits'), true);
    assert.equal(hasResolvedPermission(permissions, 'viewProducts'), false);
});

test('malformed and missing permissions fail closed', () => {
    assert.equal(hasResolvedPermission(undefined, 'viewDeposits'), false);
    assert.equal(hasResolvedPermission({ approveDeposits: false } as never, 'viewDeposits'), false);
    assert.equal(hasResolvedPermission({ approveDeposits: 'true' } as never, 'viewDeposits'), false);
});
