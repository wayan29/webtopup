import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarImageVisible, nextFailedAvatarUrl } from './staffAvatarState.ts';

test('failed avatar stays hidden only for the URL that failed', () => {
    const failed = nextFailedAvatarUrl(null, { type: 'error', avatarUrl: '/uploads/avatars/old.webp' });
    assert.equal(failed, '/uploads/avatars/old.webp');
    assert.equal(avatarImageVisible('/uploads/avatars/old.webp', failed), false);
    assert.equal(avatarImageVisible('/uploads/avatars/new.webp', failed), true);
});

test('clearing the avatar resets failed-image state for unmount and later reuse', () => {
    const failed = nextFailedAvatarUrl(null, { type: 'error', avatarUrl: '/uploads/avatars/avatar.webp' });
    const cleared = nextFailedAvatarUrl(failed, { type: 'reset' });
    assert.equal(cleared, null);
    assert.equal(avatarImageVisible(undefined, cleared), false);
    assert.equal(avatarImageVisible('/uploads/avatars/avatar.webp', cleared), true);
});
