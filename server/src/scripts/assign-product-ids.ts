/**
 * Deprecated: this script previously assigned productId via max+1 and is unsafe
 * with the atomic counter and unique index. Use the Rust operator migration instead.
 */
import dotenv from 'dotenv';

dotenv.config();

const MONGO_DB = process.env.MONGO_DB || 'POBB';

function main(): void {
    console.error(
        'assign-product-ids.ts is deprecated and refuses to run: it used unsafe max+1 writes.'
    );
    console.error(
        'Quiesce all product writers, then run the Rust operator migration:'
    );
    console.error('');
    console.error('  mongodump --uri="$MONGO_URI" --db="$MONGO_DB" --out="backup-product-id-$(date +%F-%H%M%S)"');
    console.error('  cd rust-api');
    console.error('  cargo run --bin ensure_product_id_integrity');
    console.error('');
    console.error(
        `Environment: MONGO_URI (required), MONGO_DB (default ${MONGO_DB}).`
    );
    console.error(
        'Documents with missing or invalid productId must be fixed manually; the migration does not assign IDs.'
    );
    process.exit(1);
}

main();