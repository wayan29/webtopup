import Counter, { PRODUCT_ID_COUNTER_KEY } from '../models/Counter';

export { PRODUCT_ID_COUNTER_KEY };

/** Matches Rust `decode_counter_seq` / JS MAX_SAFE_INTEGER for shared counter documents. */
export function isValidCounterSeq(seq: unknown): seq is number {
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0;
}

/**
 * Atomic productId allocation (shared with Rust `allocate_product_id`).
 */
export async function allocateProductId(): Promise<number> {
    const updated = await Counter.findOneAndUpdate(
        { _id: PRODUCT_ID_COUNTER_KEY },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (!updated) {
        throw new Error('product id counter update returned no document');
    }

    const seq = updated.seq;
    if (!isValidCounterSeq(seq)) {
        throw new Error(`invalid product id counter seq: ${String(seq)}`);
    }
    return seq;
}