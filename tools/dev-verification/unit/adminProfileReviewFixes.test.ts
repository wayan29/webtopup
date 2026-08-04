import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('staff password change explicitly ends the initiating browser session', () => {
    const profile = read('client/src/pages/admin/Profile.tsx');
    const handlerStart = profile.indexOf('const handleChangePassword');
    const handlerEnd = profile.indexOf('\n    const messageClass', handlerStart);
    assert.notEqual(handlerStart, -1, 'password handler must exist');
    assert.notEqual(handlerEnd, -1, 'password handler boundary must exist');
    const handler = profile.slice(handlerStart, handlerEnd);

    assert.match(handler, /await logout\(\)/, 'successful password change must clear local auth and return to staff login');
    assert.doesNotMatch(handler, /Sesi di perangkat lain/, 'copy must not claim the current session survives');

    const server = read('rust-api/src/routes/users/staff.rs');
    assert.match(server, /Password berhasil diubah\. Semua sesi telah dicabut\./);
});

test('all admin avatar surfaces render initials underneath a fallible image', () => {
    const avatar = read('client/src/components/admin/StaffAvatar.tsx');
    assert.match(avatar, /<span aria-hidden="true">\{initials\}<\/span>/, 'initials must always be rendered as the structural fallback');
    assert.match(avatar, /useReducer\(nextFailedAvatarUrl/, 'failure must be tracked by React state');
    assert.match(avatar, /onError=/, 'a failed image must reveal initials');
    assert.doesNotMatch(avatar, /\.remove\(\)/, 'React-owned DOM nodes must never be removed imperatively');
    assert.match(avatar, /role="img"/, 'the initials fallback must remain accessible');

    const layout = read('client/src/layouts/AdminLayout.tsx');
    const profile = read('client/src/pages/admin/Profile.tsx');
    assert.ok((layout.match(/<StaffAvatar/g) || []).length >= 2, 'sidebar and account header must share the fallback');
    assert.match(profile, /<StaffAvatar/, 'profile preview must share the fallback');
});
