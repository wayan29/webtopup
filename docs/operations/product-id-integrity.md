# Product ID integrity migration

Stage 1 of admin validation hardening unifies all product creators on a single atomic `productId` allocator (`counters._id = "products.productId"`) and adds a unique index `uniq_products_productId` on `products.productId`.

## Prerequisites

- **Quiesce all writers** that create or update `products.productId` before backup and keep them stopped until migration and post-deploy verification succeed. This includes:
  - Rust API: regular product create, validation product create, **vendor pricelist sync** (`sync_product_items`)
  - Node server: `Product.create` / save paths (admin product controller, **vendor sync** in `vendorController`), catalog clone script
  - Dev-only seeds: `seed.ts` and `seed-products.ts` (the latter uses explicit counter allocation because `insertMany` skips Mongoose hooks)
  - Manual Mongo updates or deprecated scripts (do not run `assign-product-ids.ts`)
- Only positive **Int32/Int64** `productId` values are valid. Missing, null, string, double, decimal, zero, or negative values must be fixed manually before migration.
- Resolve any duplicate `productId` values in `products` before migration. The operator binary aborts if duplicates exist and does not delete data.
- Take a backup before changing indexes or counters.

## Rollout sequence

```bash
# 1. Stop application and any scripts that write productId
mongodump --uri="$MONGO_URI" --db="$MONGO_DB" --out="backup-product-id-$(date +%F-%H%M%S)"
cd rust-api
cargo run --bin ensure_product_id_integrity
# 2. Deploy API build that uses allocate_product_id; verify creates; then start traffic
```

Environment variables match the Rust API: `MONGO_URI` (required), `MONGO_DB` (default `POBB`).

## What the migration does (order matches the binary)

1. Scans all `products` documents and **aborts** if any have missing, null, or non–positive Int32/Int64 `productId` (reports reason, count, sample `_id`s).
2. Detects duplicate `productId` among accepted values; if any exist, prints counts/sample IDs and exits non-zero without deleting documents.
3. Computes max accepted `products.productId` and seeds the counter with `$max: { seq: max }` on `counters/products.productId` (idempotent).
4. Creates unique index `uniq_products_productId` on `{ productId: 1 }` (idempotent if the index already exists with the same definition).
5. Re-reads max `productId`, counter `seq` (strict decode, including Node Double counters when safe/integral), and verifies index name, keys `{ productId: 1 }`, and `unique: true`; exits non-zero if counter `seq` is invalid, `counter.seq < max(productId)`, or verification fails.

The binary is **not** invoked from API startup, route registration, or `main.rs`. Run it manually during deployment.

## Deprecated Node script

`server/src/scripts/assign-product-ids.ts` is a hard-failing wrapper. Do not use max+1 backfill; fix data and run `ensure_product_id_integrity` instead.

## Abort on duplicates or invalid IDs

If the tool reports invalid or duplicate `productId` values, stop rollout. Inspect the listed IDs in MongoDB, fix or reassign IDs manually, then re-run after backup while writers remain quiesced.

## Rollback

1. Stop the application and all `productId` writers.
2. Restore from the `mongodump` backup taken before migration.
3. Do **not** lower the counter manually as a rollback strategy; restoring data and indexes from backup is the supported path.

## Application behavior after deploy

- Rust regular create, validation create, and vendor sync inserts call `allocate_product_id` (atomic `$inc` on `counters/products.productId`).
- Node `Product` pre-save calls the same counter via `allocateProductId()` when `productId` is not set explicitly.

## Counter BSON type and `$inc` interoperability

- Node `Counter` schema uses Mongoose `Number`, so MongoDB typically stores `counters.seq` as **BSON Double** after Node allocations.
- Rust `allocate_product_id` uses `$inc: { seq: 1 }` with an **Int64** increment; MongoDB preserves numeric semantics and the post-update document may remain Double (Node-originated) or Int64 (Rust-only history).
- Both runtimes decode `seq` with the same strict rules (`decode_counter_seq` in Rust, `isValidCounterSeq` in Node): positive **Int32**, **Int64**, or **exactly integral Double** ≤ `9_007_199_254_740_991` (JavaScript `MAX_SAFE_INTEGER`). Fractional, NaN, infinite, non-positive, out-of-range, or string values abort allocation and fail migration verification with a non-zero exit.
- **Product** documents remain **Int32/Int64 only** for `productId`; Double `productId` is never accepted.
- Duplicate `code` on insert returns HTTP 409 with `field: "code"`.
- Duplicate `productId` on insert retries with a new ID up to three attempts; unknown duplicate constraints are logged and return HTTP 500 (not 409 on `code`).