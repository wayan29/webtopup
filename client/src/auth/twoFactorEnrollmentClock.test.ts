import assert from 'node:assert/strict';
import test from 'node:test';
import {
    formatEnrollmentReminderMessage,
    shouldShowEnrollmentReminder,
} from './twoFactorEnrollmentClock.ts';

const DAY_MS = 86_400_000;
const staff = (overrides: Record<string, unknown> = {}) => ({
    role: 'owner',
    twoFactorEnabled: false,
    twoFactorEnrollmentRequiredAt: '2026-08-05T00:00:00.000Z',
    serverTime: '2026-07-29T00:00:00.000Z',
    ...overrides,
});

// Authoritative "now" is client clock + offset. Keep the offset at 0 so clientNowMs is the wall clock.
const nowMs = Date.parse('2026-07-29T00:00:00.000Z');
const show = (user: unknown, dismissed = false, offset: number | null = 0) => shouldShowEnrollmentReminder({
    user: user as never,
    clientNowMs: nowMs,
    serverTimeOffsetMs: offset,
    dismissed,
});

test('staff inside the grace window sees the reminder', () => {
    assert.equal(show(staff()), true);
});

test('enabling 2FA hides the reminder even when a deadline is still stored', () => {
    assert.equal(show(staff({ twoFactorEnabled: true })), false);
});

test('dismissing hides it for this visit only; the caller resets on remount', () => {
    assert.equal(show(staff(), true), false);
});

test('members are never nagged about staff enrollment', () => {
    assert.equal(show(staff({ role: 'member' })), false);
    assert.equal(show(staff({ role: 'cs' })), true);
    assert.equal(show(staff({ role: 'admin' })), true);
});

test('accounts without a deadline are not reminded', () => {
    assert.equal(show(staff({ twoFactorEnrollmentRequiredAt: null })), false);
    assert.equal(show(null), false);
});

test('an overdue deadline still shows the reminder', () => {
    // Server enforcement redirects overdue staff, but the copy must not silently vanish.
    assert.equal(show(staff({ twoFactorEnrollmentRequiredAt: '2026-07-28T00:00:00.000Z' })), true);
});

test('an untrusted server clock fails closed to showing the reminder', () => {
    assert.equal(show(staff(), false, null), true);
});

test('reminder copy counts whole days, then hours near the deadline', () => {
    assert.equal(formatEnrollmentReminderMessage(7 * DAY_MS), 'Aktifkan 2FA dalam 7 hari.');
    assert.equal(formatEnrollmentReminderMessage(90 * 60_000), 'Aktifkan 2FA dalam 2 jam.');
    assert.equal(
        formatEnrollmentReminderMessage(0),
        'Batas aktivasi 2FA telah lewat. Aktifkan 2FA untuk melanjutkan.'
    );
    // Null remaining (unknown clock) must still produce actionable copy, never an empty dialog.
    assert.equal(formatEnrollmentReminderMessage(null), 'Aktifkan 2FA untuk mengamankan akun staf Anda.');
});
