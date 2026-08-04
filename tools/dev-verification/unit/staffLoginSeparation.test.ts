import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Source contracts for the staff/member login separation.
 *
 * Enforcement lives in Rust and the gateway: each audience has one fixed endpoint pair and a
 * wrong-channel credential is refused upstream. These assertions cover the client-side risks
 * that no runtime test would catch: a generic login endpoint coming back, the staff surface
 * being advertised on the public page, or an admin guard sending staff to the member form.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const readClient = (relativePath: string) => fs.readFileSync(path.join(root, 'client/src', relativePath), 'utf8');

const readRepo = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

/** Slice a single guard body so an assertion cannot be satisfied by a different guard. */
const guardBody = (source: string, guardName: string) => {
    const start = source.indexOf(`function ${guardName}(`);
    assert.notEqual(start, -1, `guard ${guardName} not found`);
    const next = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
};

test('the auth store drives login through fixed audience endpoints', () => {
    const source = readClient('store/useAuthStore.ts');

    // A single generic endpoint is exactly what the separation removes; Rust no longer serves it.
    assert.doesNotMatch(source, /['"]\/auth\/login['"]/, 'store still posts to the removed generic login endpoint');
    assert.match(source, /loginEndpointForAudience/, 'store must resolve the endpoint from the audience');
    assert.match(source, /login:\s*\(\s*audience:\s*LoginAudience/, 'login action must take an explicit audience');
    assert.match(
        source,
        /verifyTwoFactorLogin:\s*\(\s*audience:\s*LoginAudience/,
        '2FA continuation must stay on the audience that started the challenge'
    );
    assert.match(
        source,
        /completeDeviceSelection:\s*\(\s*audience:\s*LoginAudience/,
        'device selection must stay on the audience that started the challenge'
    );
    // Staff sessions have a fixed upstream ceiling; the client must not ask for persistence.
    assert.match(source, /allowsRememberMe\(audience\)/, 'store must gate rememberMe on the audience');
});

test('logout and guards return each audience to its own login surface', () => {
    const store = readClient('store/useAuthStore.ts');
    assert.match(store, /loginPathForAudience/, 'logout must resolve the login path from the session audience');

    const app = readClient('App.tsx');
    assert.match(app, /STAFF_LOGIN_PATH/, 'admin guards must redirect guests to the staff login path');
    assert.match(app, /path=\{STAFF_LOGIN_PATH\}/, 'the staff login route must exist');
    assert.match(app, /<StaffLogin\s*\/>/, 'the staff login route must render the staff login screen');

    // Admin guards previously bounced unauthenticated staff to the member form. Assert per guard:
    // each guard must resolve its own channel, and never hardcode the other channel's surface.
    for (const guardName of ['AdminRoute', 'AdminPermissionRoute']) {
        const body = guardBody(app, guardName);
        assert.match(body, /!isAuthenticated\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*return <Navigate to=\{loginPathWithReturnTo\(\s*'staff'/, `${guardName} must send guests to staff login`);
        assert.doesNotMatch(body, /to="\/login"/, `${guardName} must not send staff to the member login form`);
        assert.doesNotMatch(body, /loginPathWithReturnTo\(\s*'member'/, `${guardName} must not resolve the member channel`);
    }
    const memberGuard = guardBody(app, 'ProtectedRoute');
    assert.match(memberGuard, /return <Navigate to=\{loginPathWithReturnTo\(\s*'member'/, 'member guard must keep the member login surface');
    assert.doesNotMatch(memberGuard, /loginPathWithReturnTo\(\s*'staff'/, 'member guard must not resolve the staff channel');
});

test('admin audit keeps credential bodies out of the log for both login channels', () => {
    const source = readRepo('server/src/services/adminAuditService.ts');
    // The exclusion was written for the removed generic path. If it is not widened, staff
    // logins become auditable writes and their request bodies reach the audit log.
    assert.match(source, /\/api\/v2\/auth\/member\/login|\/api\/v2\/auth\//, 'audit must still exclude login paths');
    for (const loginPath of ['/api/v2/auth/member/login', '/api/v2/auth/staff/login']) {
        const excluded = /path\.startsWith\('\/api\/v2\/auth\/'\)/.test(source)
            || source.includes(`'${loginPath}'`);
        assert.equal(excluded, true, `audit must exclude ${loginPath}`);
    }
});

/**
 * Files that must still name the removed endpoint carry this marker, so a closure assertion
 * stays legal while an actual login call site does not.
 */
const LEGACY_REFERENCE_MARKER = 'staff-login-separation:allow-legacy-reference';

test('no call site still posts to the removed generic login endpoint', () => {
    const offenders: string[] = [];
    const roots = ['client/src', 'server/src', 'tools/dev-verification'];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const relative = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                walk(relative);
                continue;
            }
            if (!/\.(ts|tsx)$/.test(entry.name)) continue;
            if (relative.endsWith('staffLoginSeparation.test.ts')) continue;
            const source = fs.readFileSync(path.join(root, relative), 'utf8');
            if (source.includes(LEGACY_REFERENCE_MARKER)) continue;
            // Only API v2 is separated. Legacy v1 still serves its own /auth/login, so match the
            // removed v2 endpoint by full path or by an apiV2 client call.
            if (/\/api\/v2\/auth\/login|apiV2\.post\(\s*['"`]\/auth\/login['"`]/.test(source)) offenders.push(relative);
        }
    };
    for (const dir of roots) walk(dir);
    assert.deepEqual(offenders, [], `these files still target the removed generic login endpoint: ${offenders.join(', ')}`);
});

test('guards preserve the attempted destination and the login screen consumes it', () => {
    const app = readClient('App.tsx');
    // A bare redirect drops the destination, so an interrupted staff deep link silently
    // becomes the dashboard. Guards must carry a sanitized returnTo instead.
    assert.match(app, /loginPathWithReturnTo/, 'guards must build a login URL with returnTo');
    for (const guardName of ['AdminRoute', 'AdminPermissionRoute']) {
        const body = guardBody(app, guardName);
        assert.match(body, /loginPathWithReturnTo\(\s*'staff'/, `${guardName} must preserve the staff destination`);
    }
    assert.match(guardBody(app, 'ProtectedRoute'), /loginPathWithReturnTo\(\s*'member'/, 'member guard must preserve its destination');

    const login = readClient('pages/Login.tsx');
    assert.match(login, /readReturnTo/, 'the login screen must consume returnTo');
});

test('challenge continuity refuses a session from the other channel', () => {
    const source = readClient('store/useAuthStore.ts');
    // 2FA verify and device selection share one route pair, so the browser must check the
    // installed envelope's role against the audience that started the flow.
    assert.match(source, /audienceForRole/, 'store must derive the audience of the returned session');
    assert.doesNotMatch(source, /void audience;/, 'device selection must not discard its audience');
    const assertions = source.match(/assertAudienceMatches|audienceForRole\(\s*user\.role\s*\)/g) ?? [];
    assert.ok(assertions.length >= 3, `login, 2FA and device selection must all verify the audience (found ${assertions.length})`);
});

test('challenge continuity validates the audience before installing credentials', () => {
    const store = readClient('store/useAuthStore.ts');
    // applyLoginResponse installs immediately: it stores the access token, marks the coordinator
    // authenticated, schedules refresh and broadcasts to other tabs. Validating after that point
    // means a wrong-channel session is live before it is refused, so the three login paths must
    // parse first, check the audience, and only then install.
    assert.doesNotMatch(store, /applyLoginResponse\(/, 'login paths must not install before validating');
    assert.match(store, /parseValidatedLoginResponse/, 'login paths must parse the envelope first');
    const installs = store.match(/applyValidatedLoginResponse\(/g) ?? [];
    assert.ok(installs.length >= 3, `login, 2FA and device selection must install explicitly (found ${installs.length})`);

    const runtime = readClient('auth/sessionRuntime.ts');
    assert.match(runtime, /export function parseValidatedLoginResponse/, 'runtime must expose a parse-only step');
});

test('the public login page keeps the staff surface unadvertised', () => {
    const login = readClient('pages/Login.tsx');
    assert.match(login, /audience/, 'the shared login screen must be audience-parameterized');
    // Discoverability is not the control, but the public page must not point at it either.
    assert.doesNotMatch(login, /\/staff\/login/, 'public login must not link to the staff login path');
    assert.doesNotMatch(login, /login\s+staf|staff\s+login|admin\s+login/i, 'public login must not mention staff login');
});
