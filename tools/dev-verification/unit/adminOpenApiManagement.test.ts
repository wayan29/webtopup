import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Source contracts for Open API P1 admin management:
 * - admin list exposes presence-only hasOpenApiKey + optional memberCode
 * - force-revoke endpoint does not deactivate the account
 * - gateway proxies DELETE /users/:id/openapi-key behind manageUsers
 * - Users admin UI shows badge + confirm revoke action
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('admin UserItem serializes Open API presence without secrets', () => {
    const types = read('rust-api/src/routes/users/types.rs');
    const mappers = read('rust-api/src/routes/users/mappers.rs');
    const queries = read('rust-api/src/routes/users/queries.rs');

    assert.match(types, /hasOpenApiKey/);
    assert.match(types, /memberCode/);
    assert.doesNotMatch(types, /apiSecret/);
    assert.match(mappers, /has_open_api_key:\s*!api_key\.is_empty\(\)/);
    assert.match(mappers, /never expose apiKey\/apiSecret/i);
    assert.match(queries, /"apiKey":\s*1/);
    assert.match(queries, /"memberCode":\s*1/);
});

test('admin force-revoke reuses credential clear update and stays on manageUsers', () => {
    const admin = read('rust-api/src/routes/users/admin.rs');
    const modRoutes = read('rust-api/src/routes/mod.rs');
    const usersMod = read('rust-api/src/routes/users.rs');

    assert.match(admin, /pub async fn revoke_open_api_key/);
    assert.match(admin, /require_permission\(&headers, &state, "manageUsers"\)/);
    assert.match(admin, /open_api_credentials_clear_update\(\)/);
    assert.match(admin, /Open API key member berhasil dicabut/);
    // Force-revoke must not flip active=false (deactivate is a separate path).
    const revokeStart = admin.indexOf('pub async fn revoke_open_api_key');
    const revokeEnd = admin.indexOf('pub async fn update_user', revokeStart);
    const revokeBody = admin.slice(revokeStart, revokeEnd === -1 ? admin.length : revokeEnd);
    assert.doesNotMatch(revokeBody, /"active"\s*:/);
    assert.doesNotMatch(revokeBody, /active:\s*false/);

    assert.match(modRoutes, /\/v2\/users\/\{id\}\/openapi-key/);
    assert.match(modRoutes, /delete\(users::revoke_open_api_key\)/);
    assert.match(usersMod, /revoke_open_api_key/);
});

test('gateway proxies admin openapi-key revoke with manageUsers', () => {
    const proxy = read('server/src/routes/apiV2ProxyRoutes.ts');
    assert.match(
        proxy,
        /app\.delete\('\/users\/:id\/openapi-key',\s*\{\s*preHandler:\s*\[authenticate,\s*hasPermission\('manageUsers'\)\]/
    );
});

test('Users admin UI shows Open API badge and force-revoke action', () => {
    const usersPage = read('client/src/pages/admin/Users.tsx');
    assert.match(usersPage, /hasOpenApiKey\?:/);
    assert.match(usersPage, /memberCode\?:/);
    assert.match(usersPage, /Open API/);
    assert.match(usersPage, /Cabut Open API/);
    assert.match(usersPage, /apiV2\.delete\(`\/users\/\$\{user\._id\}\/openapi-key`\)/);
    assert.match(usersPage, /confirmRevokeOpenApiUser/);
    // Account stays active messaging.
    assert.match(usersPage, /Akun tetap aktif/);
});
