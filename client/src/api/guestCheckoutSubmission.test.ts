import assert from 'node:assert/strict';
import test from 'node:test';

import {
    guestCheckoutSubmissionTransition,
    type GuestCheckoutSubmissionState,
} from './guestCheckoutSubmission';

const keyed: GuestCheckoutSubmissionState = {
    key: 'checkout-key-1',
    fingerprint: 'fingerprint-1',
    reconciliationVisible: true,
};

test('guest checkout lifecycle preserves key through ambiguity and in-progress until recovered success', () => {
    const ambiguous = guestCheckoutSubmissionTransition(keyed, { type: 'ambiguous' });
    assert.deepEqual(ambiguous, keyed);
    const inProgress = guestCheckoutSubmissionTransition(ambiguous, { type: 'in-progress' });
    assert.deepEqual(inProgress, keyed);
    const recovered = guestCheckoutSubmissionTransition(inProgress, { type: 'success' });
    assert.deepEqual(recovered, { key: null, fingerprint: null, reconciliationVisible: false });
});

test('guest checkout definite conflict clears the old key and reconciliation controls', () => {
    assert.deepEqual(
        guestCheckoutSubmissionTransition(keyed, { type: 'conflict' }),
        { key: null, fingerprint: null, reconciliationVisible: false },
    );
});
