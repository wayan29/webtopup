import assert from 'node:assert/strict';
import test from 'node:test';
import {
    captureGuestAuthEntry,
    guestRouteShouldRedirect,
    type GuestAuthEntry,
} from './guestAuthIntent.ts';

test('newly completed login stays mounted for Login to consume returnTo', () => {
    let entry = captureGuestAuthEntry('pending', false, false);
    assert.equal(entry, 'guest-on-entry');
    assert.equal(guestRouteShouldRedirect(entry, true), false);
});

test('already authenticated entry redirects without rendering login', () => {
    const entry = captureGuestAuthEntry('pending', false, true);
    assert.equal(entry, 'authenticated-on-entry');
    assert.equal(guestRouteShouldRedirect(entry, true), true);
});

test('loading keeps entry pending until the authenticated state settles', () => {
    let entry: GuestAuthEntry = 'pending';
    entry = captureGuestAuthEntry(entry, true, false);
    assert.equal(entry, 'pending');
    entry = captureGuestAuthEntry(entry, false, true);
    assert.equal(entry, 'authenticated-on-entry');
});

test('loading keeps entry pending until the guest state settles', () => {
    let entry: GuestAuthEntry = 'pending';
    entry = captureGuestAuthEntry(entry, true, false);
    assert.equal(entry, 'pending');
    entry = captureGuestAuthEntry(entry, false, false);
    assert.equal(entry, 'guest-on-entry');
});

test('the first settled entry never changes afterward', () => {
    assert.equal(captureGuestAuthEntry('guest-on-entry', false, true), 'guest-on-entry');
    assert.equal(captureGuestAuthEntry('guest-on-entry', true, true), 'guest-on-entry');
    assert.equal(captureGuestAuthEntry('authenticated-on-entry', false, false), 'authenticated-on-entry');
    assert.equal(captureGuestAuthEntry('authenticated-on-entry', true, false), 'authenticated-on-entry');
});

test('redirect is owned only by an authenticated-on-entry route', () => {
    assert.equal(guestRouteShouldRedirect('pending', true), false);
    assert.equal(guestRouteShouldRedirect('guest-on-entry', true), false);
    assert.equal(guestRouteShouldRedirect('authenticated-on-entry', false), false);
    assert.equal(guestRouteShouldRedirect('authenticated-on-entry', true), true);
});
