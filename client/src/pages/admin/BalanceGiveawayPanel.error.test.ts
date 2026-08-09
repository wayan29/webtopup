import assert from 'node:assert/strict';
import test from 'node:test';
import { giveawayExecutionErrorMessage } from './BalanceGiveawayPanel';

const error = (status: number, code: string, message = 'raw backend message') => ({
    response: { status, data: { error: { code }, message } },
});

test('maps transaction unavailable without exposing raw backend details', () => {
    assert.match(
        giveawayExecutionErrorMessage(error(503, 'GIVEAWAY_TRANSACTIONS_UNAVAILABLE')),
        /MongoDB transaction belum aktif/u,
    );
});

test('maps ambiguous commit and preserves same-key reconciliation instruction', () => {
    assert.match(
        giveawayExecutionErrorMessage(error(503, 'GIVEAWAY_COMMIT_UNKNOWN')),
        /Idempotency-Key yang sama/u,
    );
});

test('maps payload conflict and in-progress key states', () => {
    assert.match(giveawayExecutionErrorMessage(error(409, 'IDEMPOTENCY_CONFLICT')), /payload berbeda/u);
    assert.match(giveawayExecutionErrorMessage(error(409, 'IDEMPOTENCY_IN_PROGRESS')), /jangan gunakan key baru/iu);
});
