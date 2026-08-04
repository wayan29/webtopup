import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MEMBER_LOGIN_PATH,
    STAFF_LOGIN_PATH,
    allowsRememberMe,
    audienceForProtectedPath,
    audienceForRole,
    loginEndpointForAudience,
    loginPathForAudience,
    loginPathWithReturnTo,
    postLoginPath,
    readReturnTo,
    sanitizeLoginReturnTo,
} from './loginIntent.ts';

test('each audience has one fixed gateway endpoint', () => {
    assert.equal(loginEndpointForAudience('member'), '/auth/member/login');
    assert.equal(loginEndpointForAudience('staff'), '/auth/staff/login');
});

test('each audience has one fixed browser login path', () => {
    assert.equal(loginPathForAudience('member'), MEMBER_LOGIN_PATH);
    assert.equal(loginPathForAudience('staff'), STAFF_LOGIN_PATH);
    assert.equal(MEMBER_LOGIN_PATH, '/login');
    assert.equal(STAFF_LOGIN_PATH, '/staff/login');
});

test('remember me is offered to members only', () => {
    // Rust forces staff rememberMe to false; the UI must not imply otherwise.
    assert.equal(allowsRememberMe('member'), true);
    assert.equal(allowsRememberMe('staff'), false);
});

test('admin destinations send guests to staff login, everything else to member login', () => {
    assert.equal(audienceForProtectedPath('/admin'), 'staff');
    assert.equal(audienceForProtectedPath('/admin/dashboard'), 'staff');
    assert.equal(audienceForProtectedPath('/admin/profile?tab=security'), 'staff');
    assert.equal(audienceForProtectedPath('/dashboard'), 'member');
    assert.equal(audienceForProtectedPath('/'), 'member');
    // Near-miss paths must not be treated as admin surfaces.
    assert.equal(audienceForProtectedPath('/administrator'), 'member');
    assert.equal(audienceForProtectedPath('/x/admin/dashboard'), 'member');
});

test('return paths are rejected when they leave the site or cross audiences', () => {
    for (const hostile of [
        'https://evil.example.com/admin',
        '//evil.example.com/admin',
        'http://evil.example.com',
        '/admin\\evil',
        '/admin\ndashboard',
        'admin/dashboard',
        '',
    ]) {
        assert.equal(sanitizeLoginReturnTo('staff', hostile), null, `staff must reject ${JSON.stringify(hostile)}`);
        assert.equal(sanitizeLoginReturnTo('member', hostile), null, `member must reject ${JSON.stringify(hostile)}`);
    }

    // Cross-audience destinations are refused instead of silently downgraded.
    assert.equal(sanitizeLoginReturnTo('member', '/admin/dashboard'), null);
    assert.equal(sanitizeLoginReturnTo('staff', '/dashboard'), null);
    // Authentication screens are never a post-login destination.
    assert.equal(sanitizeLoginReturnTo('staff', STAFF_LOGIN_PATH), null);
    assert.equal(sanitizeLoginReturnTo('member', MEMBER_LOGIN_PATH), null);
    assert.equal(sanitizeLoginReturnTo('member', '/register'), null);
    assert.equal(sanitizeLoginReturnTo('staff', '/register'), null);
});

test('return paths are kept when they match the audience surface', () => {
    assert.equal(sanitizeLoginReturnTo('staff', '/admin/products?page=2'), '/admin/products?page=2');
    assert.equal(sanitizeLoginReturnTo('member', '/transactions#latest'), '/transactions#latest');
});

test('return paths are rejected when they encode traversal or structural characters', () => {
    // A raw-pathname check is not enough: the browser normalizes %2e%2e before routing, so
    // `/%2e%2e/admin` would pass a member check and then land on an admin surface.
    for (const encoded of [
        '/%2e%2e/admin',
        '/%2E%2E/admin',
        '/.%2e/admin',
        '/admin/%2e%2e/dashboard',
        '/admin/..%2fdashboard',
        '/admin%2f..%2fdashboard',
        '/admin%5cevil',
        '/admin/%00',
        '/%',
        '/%zz/admin',
    ]) {
        assert.equal(sanitizeLoginReturnTo('member', encoded), null, `member must reject ${encoded}`);
        assert.equal(sanitizeLoginReturnTo('staff', encoded), null, `staff must reject ${encoded}`);
    }

    // Plain traversal must not escape the audience either.
    assert.equal(sanitizeLoginReturnTo('member', '/../admin/dashboard'), null);
    assert.equal(sanitizeLoginReturnTo('staff', '/admin/../dashboard'), null);
});

test('a role maps to exactly one audience', () => {
    for (const role of ['owner', 'admin', 'cs']) {
        assert.equal(audienceForRole(role), 'staff', `${role} must be staff`);
    }
    assert.equal(audienceForRole('member'), 'member');
    // Unknown or spoofed roles must not be promoted to the staff channel.
    assert.equal(audienceForRole('staff'), 'member');
    assert.equal(audienceForRole(''), 'member');
    assert.equal(audienceForRole(undefined), 'member');
});

test('guards build a login URL that carries only a safe return path', () => {
    assert.equal(loginPathWithReturnTo('staff', '/admin/products?page=2'), '/staff/login?returnTo=%2Fadmin%2Fproducts%3Fpage%3D2');
    assert.equal(loginPathWithReturnTo('member', '/transactions#latest'), '/login?returnTo=%2Ftransactions%23latest');
    // The landing page needs no round trip, and hostile or cross-audience paths are dropped.
    assert.equal(loginPathWithReturnTo('staff', '/admin/dashboard'), STAFF_LOGIN_PATH);
    assert.equal(loginPathWithReturnTo('member', '/dashboard'), MEMBER_LOGIN_PATH);
    assert.equal(loginPathWithReturnTo('staff', 'https://evil.example.com/admin'), STAFF_LOGIN_PATH);
    assert.equal(loginPathWithReturnTo('staff', '/%2e%2e/admin'), STAFF_LOGIN_PATH);
    assert.equal(loginPathWithReturnTo('member', '/admin/dashboard'), MEMBER_LOGIN_PATH);
});

test('the login screen consumes returnTo only when it survives sanitizing', () => {
    assert.equal(readReturnTo('staff', '?returnTo=%2Fadmin%2Fvendors'), '/admin/vendors');
    assert.equal(readReturnTo('member', '?returnTo=%2Ftransactions'), '/transactions');
    // Cross-audience, hostile, encoded-traversal and absent values all fall back.
    assert.equal(readReturnTo('member', '?returnTo=%2Fadmin%2Fdashboard'), null);
    assert.equal(readReturnTo('staff', '?returnTo=https%3A%2F%2Fevil.example.com'), null);
    assert.equal(readReturnTo('staff', '?returnTo=%2F%252e%252e%2Fadmin'), null);
    assert.equal(readReturnTo('staff', '?returnTo='), null);
    assert.equal(readReturnTo('staff', ''), null);
});

test('post-login destination falls back to the audience landing page', () => {
    assert.equal(postLoginPath('staff', '/admin/vendors'), '/admin/vendors');
    assert.equal(postLoginPath('staff', '/dashboard'), '/admin/dashboard');
    assert.equal(postLoginPath('staff', undefined), '/admin/dashboard');
    assert.equal(postLoginPath('member', '/transactions'), '/transactions');
    assert.equal(postLoginPath('member', '/admin/dashboard'), '/dashboard');
    assert.equal(postLoginPath('member', null), '/dashboard');
});
