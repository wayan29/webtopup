import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    TEAM_PERMISSION_KEYS,
    getEffectiveTeamAccess,
    normalizeTeamPermissions,
    resolveEffectiveTeamPermissions,
    summarizeEffectiveTeamAccess,
    type EffectiveTeamAccess,
} from '../../../client/src/lib/teamAccess.ts';

test('auth store delegates permission resolution to the canonical client helper', () => {
    const root = path.resolve(process.cwd());
    const source = fs.readFileSync(path.join(root, 'client/src/store/useAuthStore.ts'), 'utf8');
    assert.match(source, /normalizeTeamPermissions/);
    assert.doesNotMatch(source, /const hasResolvedPermission/);
});

test('sparse permissions fail closed and canonical implications are applied', () => {
    const sparse = normalizeTeamPermissions({
        approveDeposits: true,
        viewDeposits: false,
        manageProducts: true,
        viewUsers: 'true',
        manageTeam: 1,
    });

    assert.equal(sparse.approveDeposits, true);
    assert.equal(sparse.viewDeposits, true);
    assert.equal(sparse.manageProducts, true);
    assert.equal(sparse.viewProducts, true);
    assert.equal(sparse.manageVouchers, true);
    assert.equal(sparse.viewUsers, false);
    assert.equal(sparse.manageTeam, false);
    assert.equal(Object.keys(sparse).length, TEAM_PERMISSION_KEYS.length);
});

test('null, undefined, and malformed permission documents fail closed', () => {
    for (const input of [null, undefined, {}, { manageProducts: 'true' }, { manageProducts: 1 }, { manageProducts: null }]) {
        const normalized = normalizeTeamPermissions(input);
        assert.equal(Object.values(normalized).some(Boolean), false, JSON.stringify(input));
    }
});

test('owner override returns a complete permission map', () => {
    const owner = resolveEffectiveTeamPermissions('owner', null);
    assert.equal(Object.keys(owner).length, TEAM_PERMISSION_KEYS.length);
    assert.ok(Object.values(owner).every(Boolean));
});

test('active read-only CS receives catalog reads but not catalog mutations', () => {
    const readOnly = getEffectiveTeamAccess({
        role: 'cs',
        active: true,
        permissions: { viewDashboard: true, viewProducts: true },
    });

    assert.equal(readOnly.find((entry) => entry.id === 'catalog.read')?.status, 'available');
    assert.equal(readOnly.find((entry) => entry.id === 'catalog.manage')?.status, 'unavailable');
    assert.equal(readOnly.find((entry) => entry.id === 'catalog.margin-data')?.status, 'available');
    assert.equal(readOnly.find((entry) => entry.id === 'catalog.margin-manage')?.status, 'unavailable');
    assert.equal(readOnly.find((entry) => entry.id === 'campaigns.vouchers')?.status, 'unavailable');
});

test('active owner receives all owner and operational entries', () => {
    const owner = getEffectiveTeamAccess({ role: 'owner', active: true, permissions: null });
    assert.ok(owner.length > 0);
    assert.equal(owner.some((entry) => entry.status === 'unavailable'), false);
    assert.equal(owner.some((entry) => entry.status === 'role-limited'), false);
    assert.ok(owner.some((entry) => entry.status === 'step-up'));
});

test('inactive owner has configured full access but no currently available access', () => {
    const suspendedOwner = getEffectiveTeamAccess({ role: 'owner', active: false, permissions: null });

    assert.ok(suspendedOwner.some((entry) => entry.status === 'suspended'));
    assert.equal(suspendedOwner.some((entry) => entry.status === 'available'), false);
    assert.equal(summarizeEffectiveTeamAccess(suspendedOwner).availableCount, 0);
});

test('team role boundaries distinguish CS management from owner-only operations', () => {
    const manager = getEffectiveTeamAccess({
        role: 'admin',
        active: true,
        permissions: { viewTeam: true, manageTeam: true },
    });

    assert.equal(manager.find((entry) => entry.id === 'team.view')?.status, 'available');
    assert.equal(manager.find((entry) => entry.id === 'team.manage-cs')?.status, 'available');
    assert.equal(manager.find((entry) => entry.id === 'team.manage-admin')?.status, 'owner-only');
    assert.equal(manager.find((entry) => entry.id === 'team.login-logs-cs')?.status, 'available');
    assert.equal(manager.find((entry) => entry.id === 'team.login-logs-admin')?.status, 'owner-only');
    assert.equal(manager.find((entry) => entry.id === 'team.reset-2fa')?.status, 'owner-only');
});

test('sensitive operational entries retain step-up status', () => {
    const owner = getEffectiveTeamAccess({ role: 'owner', active: true, permissions: null });
    const stepUpIds = [
        'transactions.status',
        'transactions.refund',
        'deposits.approve',
        'campaigns.giveaway-execute',
        'payments.credentials',
        'members.balance-adjust',
        'audit.export',
        'vendors.credentials',
        'self.profile-update',
        'self.password',
        'self.sessions-revoke-all',
    ];

    for (const id of stepUpIds) {
        assert.equal(owner.find((entry) => entry.id === id)?.status, 'step-up', id);
    }
});

test('access metadata exposes every stable review entry', () => {
    const ids = new Set(getEffectiveTeamAccess({ role: 'cs', active: true, permissions: {} }).map((entry) => entry.id));
    const expected = [
        'dashboard.view',
        'notifications.view',
        'reports.sales',
        'reports.promo',
        'transactions.view',
        'transactions.guest-view',
        'transactions.manual',
        'transactions.status',
        'transactions.refund',
        'deposits.view',
        'deposits.claim',
        'deposits.approve',
        'catalog.read',
        'catalog.manage',
        'catalog.flash-sales',
        'catalog.rewards',
        'catalog.margin-data',
        'catalog.margin-manage',
        'campaigns.vouchers',
        'campaigns.giveaway-execute',
        'payments.view',
        'payments.manage',
        'payments.credentials',
        'members.view',
        'members.manage',
        'members.balance-adjust',
        'team.view',
        'team.manage-cs',
        'team.manage-admin',
        'team.login-logs-cs',
        'team.login-logs-admin',
        'team.reset-2fa',
        'audit.view',
        'audit.export',
        'settings.manage',
        'settings.validation',
        'vendors.manage',
        'vendors.credentials',
        'vendors.internal-purchase',
        'self.profile-view',
        'self.profile-update',
        'self.password',
        'self.sessions-view',
        'self.sessions-revoke-one',
        'self.sessions-revoke-all',
        'self.two-factor',
    ];

    assert.deepEqual([...ids], expected);
});

test('summary uses deterministic group order and excludes self-service from operational counts', () => {
    const shuffledAccess: EffectiveTeamAccess[] = [
        { id: 'self.password', groupId: 'self', label: 'Keamanan pribadi', detail: '', audience: 'team-member', level: 'action', status: 'step-up', requiresStepUp: true },
        { id: 'catalog.read', groupId: 'catalog', label: 'Produk & Kampanye', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
        { id: 'deposits.view', groupId: 'deposits', label: 'Deposit', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
        { id: 'transactions.refund', groupId: 'transactions', label: 'Transaksi', detail: '', audience: 'permission', level: 'action', status: 'step-up', requiresStepUp: true },
        { id: 'dashboard.view', groupId: 'dashboard-reports', label: 'Dashboard & Laporan', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
        { id: 'transactions.view', groupId: 'transactions', label: 'Transaksi', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
    ];

    const summary = summarizeEffectiveTeamAccess(shuffledAccess);
    assert.deepEqual(summary.labels, ['Dashboard & Laporan', 'Transaksi', 'Deposit']);
    assert.equal(summary.remainingGroupCount, 1);
    assert.equal(summary.availableCount, 5);
    assert.equal(summary.managedCount, 0);
    assert.equal(summary.actionCount, 1);
    assert.equal(summary.stepUpCount, 2);
});

test('summary does not duplicate labels for entries in one group', () => {
    const access = getEffectiveTeamAccess({
        role: 'cs',
        active: true,
        permissions: { viewDashboard: true, viewTransactions: true },
    });

    const summary = summarizeEffectiveTeamAccess(access);
    assert.deepEqual(summary.labels, ['Dashboard & Laporan', 'Transaksi']);
    assert.equal(summary.labels.filter((label) => label === 'Transaksi').length, 1);
});

test('dashboard-only access produces Dashboard saja data', () => {
    const access = getEffectiveTeamAccess({
        role: 'cs',
        active: true,
        permissions: { viewDashboard: true },
    });

    const summary = summarizeEffectiveTeamAccess(access);
    assert.deepEqual(summary.labels, ['Dashboard & Laporan']);
    assert.equal(summary.availableCount, 2);
    assert.equal(summary.remainingGroupCount, 0);
});

test('inactive non-owner access is suspended and has no eligible operational count', () => {
    const access = getEffectiveTeamAccess({
        role: 'cs',
        active: false,
        permissions: { viewDashboard: true, viewTransactions: true },
    });

    assert.equal(access.some((entry) => entry.status === 'available'), false);
    assert.equal(summarizeEffectiveTeamAccess(access).availableCount, 0);
});
