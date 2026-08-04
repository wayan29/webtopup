export type GuestCheckoutSubmissionState = {
    key: string | null;
    fingerprint: string | null;
    reconciliationVisible: boolean;
};

export type GuestCheckoutSubmissionEvent =
    | { type: 'start'; key: string; fingerprint: string }
    | { type: 'ambiguous' }
    | { type: 'in-progress' }
    | { type: 'success' }
    | { type: 'conflict' }
    | { type: 'definite-failure' }
    | { type: 'form-changed' }
    | { type: 'cancel' };

const cleared = (): GuestCheckoutSubmissionState => ({
    key: null,
    fingerprint: null,
    reconciliationVisible: false,
});

export function guestCheckoutSubmissionTransition(
    current: GuestCheckoutSubmissionState,
    event: GuestCheckoutSubmissionEvent,
): GuestCheckoutSubmissionState {
    switch (event.type) {
        case 'start':
            return { key: event.key, fingerprint: event.fingerprint, reconciliationVisible: false };
        case 'ambiguous':
        case 'in-progress':
            return current.key
                ? { ...current, reconciliationVisible: true }
                : cleared();
        case 'success':
        case 'conflict':
        case 'definite-failure':
        case 'form-changed':
        case 'cancel':
            return cleared();
    }
}
