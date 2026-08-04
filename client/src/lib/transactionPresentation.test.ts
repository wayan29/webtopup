import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canRecheckVendor,
    isDeferredValidation,
    transactionBalanceCopy,
    type TransactionPresentationInput,
} from './transactionPresentation.ts';

const DEFERRED_COPY =
    'Provider validasi belum memberikan hasil pasti. Saldo ditahan sementara dan belum direfund.';

function base(
    overrides: Partial<TransactionPresentationInput> = {},
): TransactionPresentationInput {
    return {
        status: 'pending',
        refunded: false,
        ...overrides,
    };
}

test('deferred validation pending with status note is detected and explains hold', () => {
    const input = base({
        statusUpdateNote:
            'Validasi otomatis tertunda: Layanan validasi sedang mengalami gangguan. Coba lagi beberapa saat.',
        message: 'Layanan validasi sedang mengalami gangguan. Coba lagi beberapa saat.',
        vendorName: 'Validation',
    });

    assert.equal(isDeferredValidation(input), true);
    assert.equal(transactionBalanceCopy(input), DEFERRED_COPY);
    assert.equal(canRecheckVendor(input), false);
});

test('ordinary pending vendor is not deferred and keeps default unpaid copy', () => {
    const input = base({
        vendorName: 'Digiflazz',
        message: 'Menunggu status vendor',
        statusUpdateNote: '',
    });

    assert.equal(isDeferredValidation(input), false);
    assert.equal(transactionBalanceCopy(input), 'Saldo belum direfund');
    assert.equal(canRecheckVendor(input), true);
});

test('processing non-validation vendor remains eligible for recheck', () => {
    const input = base({
        status: 'processing',
        vendorName: 'Tokovoucher',
        message: 'Sedang diproses vendor',
    });

    assert.equal(isDeferredValidation(input), false);
    assert.equal(transactionBalanceCopy(input), 'Saldo belum direfund');
    assert.equal(canRecheckVendor(input), true);
});

test('failed refunded preserves refunded balance copy', () => {
    const input = base({
        status: 'failed',
        refunded: true,
        vendorName: 'Validation',
        statusUpdateNote: 'Validasi otomatis gagal: User ID tidak valid',
    });

    assert.equal(isDeferredValidation(input), false);
    assert.equal(transactionBalanceCopy(input), 'Saldo sudah direfund');
    assert.equal(canRecheckVendor(input), false);
});

test('success keeps non-refunded balance copy and never rechecks', () => {
    const input = base({
        status: 'success',
        refunded: false,
        vendorName: 'Digiflazz',
        message: 'Sukses',
    });

    assert.equal(isDeferredValidation(input), false);
    assert.equal(transactionBalanceCopy(input), 'Saldo belum direfund');
    assert.equal(canRecheckVendor(input), false);
});

test('case and whitespace normalization still detect deferred validation', () => {
    const input = base({
        statusUpdateNote:
            '  validasi otomatis tertunda:  layanan validasi sedang mengalami gangguan.  ',
        vendorName: '  validation  ',
    });

    assert.equal(isDeferredValidation(input), true);
    assert.equal(transactionBalanceCopy(input), DEFERRED_COPY);
    assert.equal(canRecheckVendor(input), false);
});

test('misleading message without validation evidence is not deferred', () => {
    const input = base({
        vendorName: 'Digiflazz',
        message: 'Perlu validasi manual dari operator toko',
        statusUpdateNote: 'Cek ulang ke vendor Digiflazz',
    });

    assert.equal(isDeferredValidation(input), false);
    assert.equal(transactionBalanceCopy(input), 'Saldo belum direfund');
    assert.equal(canRecheckVendor(input), true);
});

test('authoritative Validation vendor marker alone is enough for deferred pending', () => {
    const input = base({
        vendorName: 'Validation',
        message: 'Layanan validasi sedang mengalami gangguan. Coba lagi beberapa saat.',
    });

    assert.equal(isDeferredValidation(input), true);
    assert.equal(transactionBalanceCopy(input), DEFERRED_COPY);
    assert.equal(canRecheckVendor(input), false);
});

test('validation-product transactions never expose vendor recheck even when processing', () => {
    const input = base({
        status: 'processing',
        vendorName: 'Validation',
        statusUpdateNote: 'Validasi otomatis tertunda: timeout provider',
    });

    assert.equal(isDeferredValidation(input), false);
    assert.equal(canRecheckVendor(input), false);
});

test('refunded wins over deferred validation balance copy', () => {
    const input = base({
        refunded: true,
        vendorName: 'Validation',
        statusUpdateNote: 'Validasi otomatis tertunda: outage',
    });

    assert.equal(isDeferredValidation(input), true);
    assert.equal(transactionBalanceCopy(input), 'Saldo sudah direfund');
});

test('exact deferred note suppresses recheck when vendorName is missing', () => {
    const input = base({
        status: 'pending',
        statusUpdateNote:
            'Validasi otomatis tertunda: Layanan validasi sedang mengalami gangguan. Coba lagi beberapa saat.',
        message: 'Layanan validasi sedang mengalami gangguan. Coba lagi beberapa saat.',
        // vendorName intentionally omitted — note alone is enough to hide unsupported recheck.
    });

    assert.equal(isDeferredValidation(input), true);
    assert.equal(transactionBalanceCopy(input), DEFERRED_COPY);
    assert.equal(canRecheckVendor(input), false);
});
