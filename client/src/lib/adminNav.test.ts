import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ADMIN_NAV_BLUEPRINT,
    formatAdminBadgeCount,
    getAdminNotificationLabel,
    getAdminRoutePermission,
    getAdminRoutePresentation,
    getPreferredAdminLandingPath,
    normalizeAdminBadgeCount,
} from './adminNav.ts';

test('notifications leave the sidebar but retain route access and presentation', () => {
    const sidebarPaths = ADMIN_NAV_BLUEPRINT.flatMap((item) => [
        item.path,
        ...(item.submenu ?? []).map((child) => child.path),
    ]);
    assert.equal(sidebarPaths.includes('/admin/notifications'), false);

    const rule = getAdminRoutePermission('/admin/notifications');
    assert.equal(rule?.id, 'notifications');
    assert.equal(rule?.permission, 'viewDashboard');

    assert.deepEqual(getAdminRoutePresentation('/admin/notifications'), {
        eyebrow: 'Overview',
        title: 'Notifikasi',
        subtitle: 'Alert aktif operasional',
    });
    assert.deepEqual(getAdminRoutePresentation('/admin/notifications/123'), {
        eyebrow: 'Overview',
        title: 'Notifikasi',
        subtitle: 'Alert aktif operasional',
    });
    assert.equal(getAdminRoutePresentation('/admin/dashboard'), undefined);
});

test('profile leaves the sidebar but remains the staff self-service fallback', () => {
    const sidebarPaths = ADMIN_NAV_BLUEPRINT.flatMap((item) => [
        item.path,
        ...(item.submenu ?? []).map((child) => child.path),
    ]);
    assert.equal(sidebarPaths.includes('/admin/profile'), false);

    const rule = getAdminRoutePermission('/admin/profile');
    assert.equal(rule?.id, 'profile');
    assert.equal(rule?.teamMemberOnly, true);
    assert.deepEqual(getAdminRoutePresentation('/admin/profile'), {
        eyebrow: 'Operasional',
        title: 'Akun Saya',
        subtitle: 'Profil, password, dan 2FA',
    });
    assert.equal(getPreferredAdminLandingPath(() => false), '/admin/profile');
});

test('notification badge copy is capped and accessible', () => {
    assert.equal(formatAdminBadgeCount(0), '0');
    assert.equal(formatAdminBadgeCount(1), '1');
    assert.equal(formatAdminBadgeCount(99), '99');
    assert.equal(formatAdminBadgeCount(100), '99+');
    assert.equal(getAdminNotificationLabel(0), 'Notifikasi admin, tidak ada yang belum dibaca');
    assert.equal(getAdminNotificationLabel(7), 'Notifikasi admin, 7 belum dibaca');
});

test('permission matching is exact or descendant only', () => {
    assert.equal(getAdminRoutePermission('/admin/security')?.teamMemberOnly, true);
    assert.equal(getAdminRoutePermission('/admin/security/sessions')?.teamMemberOnly, true);
    assert.equal(getAdminRoutePermission('/admin/security-audit'), undefined);
    assert.equal(getAdminRoutePermission('/admin/users-export'), undefined);
    assert.equal(getAdminRoutePermission('/admin/transactions/manual-review')?.permission, 'viewTransactions');
});

test('different routes retain distinct identities even when permissions match', () => {
    const addons = getAdminRoutePermission('/admin/addons');
    const vendors = getAdminRoutePermission('/admin/vendors');
    assert.equal(addons?.permission, 'manageVendors');
    assert.equal(vendors?.permission, 'manageVendors');
    assert.notEqual(addons?.id, vendors?.id);
});

test('unknown admin paths remain unresolved so guards can fail closed', () => {
    assert.equal(getAdminRoutePermission('/admin/not-registered'), undefined);
});

test('landing selects the first explicitly accessible route', () => {
    assert.equal(
        getPreferredAdminLandingPath((permission) => permission === 'manageSettings'),
        '/admin/site-config'
    );
});

test('badge normalization accepts only finite nonnegative counts', () => {
    assert.equal(normalizeAdminBadgeCount(4), 4);
    assert.equal(normalizeAdminBadgeCount('7'), 7);
    assert.equal(normalizeAdminBadgeCount(1.9), 1);
    assert.equal(normalizeAdminBadgeCount(-1), 0);
    assert.equal(normalizeAdminBadgeCount(Number.NaN), 0);
    assert.equal(normalizeAdminBadgeCount(Number.POSITIVE_INFINITY), 0);
    assert.equal(normalizeAdminBadgeCount('invalid'), 0);
});
