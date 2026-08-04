import assert from 'node:assert/strict';
import test from 'node:test';
import {
    bootstrapScreenAllowsRetry,
    lockedSessionMayRequireOtp,
    resolveAppBootstrapScreen,
    shouldRefreshOnVisibility,
} from './authIntent.ts';

test('a cold-bootstrap lock offers OTP until enrollment status is known', () => {
    assert.equal(lockedSessionMayRequireOtp(undefined), true);
    assert.equal(lockedSessionMayRequireOtp(true), true);
    assert.equal(lockedSessionMayRequireOtp(false), false);
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
    token: 'access-token',
    isAuthenticated: true,
    isAuthLoading: false,
    authPhase: 'authenticated' as const,
    ...overrides,
} as never);

test('a live session refreshes when the tab comes back', () => {
    assert.equal(shouldRefreshOnVisibility(snapshot()), true);
});

test('a guest mid-login is never refreshed', () => {
    // Leaving /login to fetch a 2FA code backgrounds the tab. On return there is no session to
    // refresh, and starting one drives the phase to "refreshing", which renders the blocking
    // "Memuat sesi..." screen over the login form.
    assert.equal(shouldRefreshOnVisibility(snapshot({
        token: null,
        isAuthenticated: false,
        authPhase: 'unauthenticated',
    })), false);
});

test('a revoked session is not silently retried', () => {
    assert.equal(shouldRefreshOnVisibility(snapshot({
        token: null,
        isAuthenticated: false,
        authPhase: 'revoked',
    })), false);
});

test('an in-flight bootstrap or refresh is not stacked on top of', () => {
    assert.equal(shouldRefreshOnVisibility(snapshot({ authPhase: 'initializing', isAuthLoading: true })), false);
    assert.equal(shouldRefreshOnVisibility(snapshot({ authPhase: 'refreshing', isAuthLoading: true })), false);
    assert.equal(shouldRefreshOnVisibility(snapshot({ isAuthLoading: true })), false);
});

test('recoverable connection states with a surviving token still refresh', () => {
    assert.equal(shouldRefreshOnVisibility(snapshot({ authPhase: 'offline-stale', isAuthenticated: false })), true);
    assert.equal(shouldRefreshOnVisibility(snapshot({ authPhase: 'bootstrap-retry', isAuthenticated: false })), true);
});

test('a locked session never refreshes when Android returns from the authenticator', () => {
    // Refresh cannot unlock the session; the server deterministically answers 423. Retrying on
    // visibility both hides the unlock form behind a transient refreshing phase and spends the
    // auth rate-limit budget every time the user switches apps to read an OTP.
    assert.equal(shouldRefreshOnVisibility(snapshot({ authPhase: 'locked' })), false);
});

test('a rate-limited bootstrap neither auto-refreshes nor offers an immediate retry', () => {
    const state = snapshot({ authPhase: 'rate-limited', isAuthenticated: false });
    assert.equal(shouldRefreshOnVisibility(state), false);
    assert.equal(resolveAppBootstrapScreen('rate-limited'), 'rate-limited');
    assert.equal(bootstrapScreenAllowsRetry('rate-limited'), false);
    assert.equal(bootstrapScreenAllowsRetry('offline-stale'), true);
});

test('no token means nothing to refresh, whatever the phase claims', () => {
    assert.equal(shouldRefreshOnVisibility(snapshot({ token: null, authPhase: 'offline-stale' })), false);
    assert.equal(shouldRefreshOnVisibility(snapshot({ token: '' })), false);
});
