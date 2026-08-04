import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUnlockFailurePhase, shouldAttemptUnlockResponseRecovery } from './authErrors.ts';
import { buildUnlockPayload } from './unlockPayload.ts';

test('unlock sends the Rust camelCase otpCode field and never the ignored otp field', () => {
    assert.deepEqual(buildUnlockPayload('secret-password', ' 123 456 '), {
        password: 'secret-password',
        otpCode: '123456',
    });
    assert.equal('otp' in buildUnlockPayload('secret-password', '123456'), false);
});

test('unlock omits otpCode when the optional value is blank', () => {
    assert.deepEqual(buildUnlockPayload('secret-password', '   '), {
        password: 'secret-password',
    });
});

test('unlock 429 enters the non-retrying phase while credential errors stay locked', () => {
    assert.equal(
        resolveUnlockFailurePhase({ status: 429, message: 'Terlalu banyak percobaan' }),
        'rate-limited'
    );
    assert.equal(
        resolveUnlockFailurePhase({ status: 400, code: 'REAUTH_OTP_INVALID', message: 'Kode OTP tidak valid' }),
        'locked'
    );
});

test('only ambiguous unlock transport outcomes attempt refresh recovery', () => {
    assert.equal(shouldAttemptUnlockResponseRecovery({ message: 'Network Error' }), true);
    assert.equal(shouldAttemptUnlockResponseRecovery({ status: 500, message: 'Internal Server Error' }), true);
    assert.equal(shouldAttemptUnlockResponseRecovery({ status: 502, message: 'Bad Gateway' }), true);
    assert.equal(shouldAttemptUnlockResponseRecovery({ status: 503, message: 'Unavailable' }), true);
    assert.equal(shouldAttemptUnlockResponseRecovery({ status: 504, message: 'Gateway Timeout' }), true);
    assert.equal(shouldAttemptUnlockResponseRecovery({ status: 400, code: 'REAUTH_PASSWORD_INVALID', message: 'Password tidak valid' }), false);
    assert.equal(shouldAttemptUnlockResponseRecovery({ status: 429, message: 'Terlalu banyak percobaan' }), false);
});
