export type TransactionPresentationInput = {
    status: 'pending' | 'processing' | 'success' | 'failed';
    refunded: boolean;
    vendorName?: string;
    message?: string;
    statusUpdateNote?: string;
};

const DEFERRED_VALIDATION_BALANCE_COPY =
    'Provider validasi belum memberikan hasil pasti. Saldo ditahan sementara dan belum direfund.';

const VALIDATION_VENDOR_MARKER = 'validation';
const DEFERRED_NOTE_MARKER = 'validasi otomatis tertunda';

function normalizeText(value?: string): string {
    return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isValidationVendor(input: TransactionPresentationInput): boolean {
    return normalizeText(input.vendorName) === VALIDATION_VENDOR_MARKER;
}

function hasDeferredValidationEvidence(input: TransactionPresentationInput): boolean {
    if (isValidationVendor(input)) {
        return true;
    }

    const note = normalizeText(input.statusUpdateNote);
    const message = normalizeText(input.message);
    return note.includes(DEFERRED_NOTE_MARKER) || message.includes(DEFERRED_NOTE_MARKER);
}

/**
 * True only for pending transactions with validation-deferred evidence.
 * Does not treat arbitrary pending vendor orders as validation.
 */
export function isDeferredValidation(input: TransactionPresentationInput): boolean {
    if (input.status !== 'pending') {
        return false;
    }
    return hasDeferredValidationEvidence(input);
}

export function transactionBalanceCopy(input: TransactionPresentationInput): string {
    if (input.refunded) {
        return 'Saldo sudah direfund';
    }
    if (isDeferredValidation(input)) {
        return DEFERRED_VALIDATION_BALANCE_COPY;
    }
    return 'Saldo belum direfund';
}

/**
 * Vendor recheck is only for eligible pending/processing non-validation products.
 * Validation products require manual review and are rejected by the backend.
 */
export function canRecheckVendor(input: TransactionPresentationInput): boolean {
    if (input.status !== 'pending' && input.status !== 'processing') {
        return false;
    }
    if (isValidationVendor(input) || hasDeferredValidationEvidence(input)) {
        return false;
    }
    return true;
}
