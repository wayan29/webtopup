# API v2 Guest Transaction Review

Last updated: 2026-05-03

## Scope

- Candidate routes under `/guest-transactions`.
- Current public v1 routes:
  - `POST /v1/guest-transactions`.
  - `GET /v1/guest-transactions/check/:invoiceNumber`.
- Current admin v1 routes:
  - `GET /v1/guest-transactions` with `viewTransactions`.
  - `POST /v1/guest-transactions/:id/confirm` with `processManualTransaction`.
  - `POST /v1/guest-transactions/:id/cancel` with `processManualTransaction`.
  - `PUT /v1/guest-transactions/:id/status` with `processManualTransaction`.
- Current public v2 routes:
  - `GET /api/v2/guest-transactions/check/:invoiceNumber` through the Node gateway.
  - `GET /api/v2/guest-transactions` through the Node gateway for admin list.
- Current internal Rust routes:
  - `GET /v2/guest-transactions/check/{invoice_number}`.
  - `GET /v2/guest-transactions`; protected by proxy context.
- This review covers guest/manual payment gateway transactions only. It does not change authenticated saldo transactions, deposits, provider callbacks, or external payment webhooks.

## Current v1 Public Create Behavior

- Reads body fields `productCode`, `target`, `serverId`, `whatsapp`, `email`, `paymentMethodId`, and `useFlashSale`.
- Reads settings `maintenanceMode`, `maintenanceMessage`, and `guestCheckoutEnabled`.
- Returns maintenance `503` with configured runtime message when maintenance is active.
- Returns `403 Guest checkout sedang dinonaktifkan` when guest checkout is disabled.
- Trims `target`, `serverId`, and `email`; normalizes `whatsapp` to digits only.
- Requires `productCode`, `target`, `whatsapp`, and `paymentMethodId`; otherwise returns `400 Missing required fields`.
- Optionally reads bearer JWT. Invalid tokens are ignored and the request proceeds as guest.
- If a valid member token is present, stores `user` and uses the member's `level` for product pricing.
- Looks up product by `code`.
- Returns `404 Product not found` when missing.
- Returns `400 Product is unavailable` when product `status` is false.
- Runs taxonomy purchase checks through `getProductPurchaseIssues` and returns `400 Produk tidak tersedia untuk dibeli: ...` for inactive category/operator/product type issues.
- Loads payment method by id and populates category.
- Returns `404 Payment method not found` when missing.
- Returns `400 Payment method is not available` when method status is not active.
- Returns `400 Payment category is not available` when category is missing or inactive.
- Checks method operational window with local server time and returns `400 Payment method is available only between ...` outside the window.
- Allows guest checkout only for bank transfer categories, detected by `bank` or `transfer` in category name/slug.
- Computes price from `product.price[userLevel]`, defaulting to `basic`.
- If `useFlashSale` is true, applies active flash sale price and reserves flash sale stock by incrementing sold count.
- Computes admin fee as fixed `adminFee` plus `ceil(price * adminPercent / 100)` when `adminPercent > 0`.
- Always adds a random 3 digit unique code from `100` to `999`.
- Rejects total below `paymentMethod.minAmount` or above `paymentMethod.maxAmount`.
- Generates invoice number using settings-backed `generateInvoiceNumber`.
- Sets `expiredAt` to 24 hours from creation.
- Inserts a `guesttransactions` document with `paymentStatus: waiting_payment` and `transactionStatus: pending`.
- Response is `201` with:
  - `message: Transaction created, please complete payment`.
  - `transaction`: populated guest transaction document.
  - `paymentInfo`: bank name, account number, account name, amount, admin fee, unique code, total amount, and expiry.

## Current v1 Public Check Behavior

- Requires query `whatsapp`; normalized to digits only.
- Returns `400 Nomor WhatsApp wajib diisi untuk cek transaksi` when missing after normalization.
- Looks up by exact `invoiceNumber`.
- Populates product `name code` and payment method `name category accountNumber accountName`.
- Returns `404 Transaction not found` when invoice is missing or WhatsApp does not match.
- Returns the populated transaction document on success.

## Current v1 Admin List Behavior

- Requires authentication and `viewTransactions` permission.
- Query supports `page`, `limit`, `search`, `paymentStatus`, `transactionStatus`, `startDate`, `endDate`, and `scope`.
- Default `scope` is `actionable`, which includes waiting payment and paid transactions that are not successful.
- `scope=all` returns all matching records.
- Valid payment statuses are `waiting_payment`, `paid`, `expired`, and `cancelled`.
- Valid transaction statuses are `pending`, `processing`, `success`, and `failed`.
- Date filters parse local day boundaries from `YYYY-MM-DD` input.
- Search matches invoice number, target, WhatsApp, email, vendor transaction id, and SN.
- Sorts by `createdAt` descending.
- Populates product, user, payment method/category, and status updater.
- Returns `items`, `meta`, and `summary` with payment/status counters and total nominal.

## Current v1 Admin Confirm Behavior

- Requires authentication and `processManualTransaction` permission.
- Validates id as Mongo ObjectId.
- Requires authenticated `request.user.id` as processor id.
- Accepts optional `note` up to 500 characters.
- Generates an initial guest provider reference id as `GUESTDDMMYYYYXXXX` where `XXXX` is a random uppercase base36 segment.
- Claims only documents with `paymentStatus: waiting_payment` and `transactionStatus: pending`.
- Claim update sets:
  - `paymentStatus: paid`.
  - `paidAt` to now.
  - `transactionStatus: processing`.
  - `vendorTrxId` to generated guest ref id.
  - status updater metadata and note.
- If claim fails, returns specific 404/400 messages for missing, already paid, cancelled, expired, or otherwise invalid transactions.
- Calls `vendorService.topUp` with product vendor SKU/code, target, vendor name, and optional server id.
- On vendor success response, updates local transaction status to vendor status and conditionally stores vendor transaction id and SN.
- On vendor call error, logs the error and keeps the transaction paid/processing with a note that vendor delivery failed and needs follow-up.
- Response is `200` with `message: Pembayaran guest berhasil dikonfirmasi` and populated `transaction`.

## Current v1 Admin Cancel Behavior

- Requires authentication and `processManualTransaction` permission.
- Validates id as Mongo ObjectId.
- Accepts optional `note` up to 500 characters.
- Updates only:
  - waiting payment transactions, or
  - paid transactions whose fulfillment status is failed.
- Sets `paymentStatus: cancelled`, `transactionStatus: failed`, and status updater metadata.
- Rejects missing, already cancelled, expired, paid/processing, paid/success, and otherwise invalid transactions with specific messages.
- Response is `200` with `message: Transaksi guest dibatalkan` and populated `transaction`.

## Current v1 Admin Status Update Behavior

- Requires authentication and `processManualTransaction` permission.
- Validates id as Mongo ObjectId.
- Accepts `transactionStatus`, optional `note`, optional `vendorTrxId`, and optional `sn`.
- Valid statuses are `pending`, `processing`, `success`, and `failed`.
- Enforces payment-status-aware transition rules:
  - waiting payment can only remain pending.
  - paid can become processing, success, or failed.
  - expired or cancelled can only be failed.
- Updates status updater metadata and note.
- Sets or clears `sn` and `vendorTrxId` when fields are provided.
- Response is `200` with `message: Status transaksi guest diperbarui` and populated `transaction`.

## Write Set

- `guesttransactions`:
  - insert on public create.
  - payment/status/vendor/SN/status metadata updates on admin confirm.
  - payment/status/status metadata updates on admin cancel.
  - transaction status/vendor/SN/status metadata updates on admin manual status update.
- `flashsales`:
  - public create can increment product sold count when flash sale is used.
- No `transactions`, `users.balance`, `pointtransactions`, or `userbalanceadjustments` writes are performed by the guest flow itself.
- Admin confirm can create an external provider top-up side effect.

## Current Atomicity Model

- Public create does not use Mongo transactions.
- Flash sale stock can be reserved before payment-method amount validation and before guest transaction insert.
- If amount validation fails after flash sale reservation, v1 does not roll flash sale stock back.
- If invoice generation or guest transaction insert fails after flash sale reservation, v1 does not roll flash sale stock back.
- Invoice number generation is random and the `invoiceNumber` field is unique, but v1 does not retry duplicate invoice insert errors.
- Unique payment code generation is random and not checked for collisions among active invoices.
- Admin confirm claims the row before provider call, which avoids duplicate local confirmation under concurrent admin clicks.
- Admin confirm has no automatic provider compensation. If provider returns success and the following save fails, the external top-up may have happened without complete local metadata.
- Admin cancel uses an atomic guarded update.
- Admin status update loads then saves the document and does not use a guarded update, so concurrent admin edits can last-write-wins.

## Risks

- `POST /guest-transactions` is high-risk because it combines public checkout, optional authenticated pricing, flash sale mutation, invoice generation, payment-method constraints, and persisted payment instructions.
- Public create does not call provider immediately, but it can mutate flash sale stock and creates payable invoices that users may act on.
- Invoice uniqueness depends on random generation and Mongo unique index. Rust migration should include duplicate-key retry or document parity-preserving no-retry behavior.
- The 3 digit unique code can collide across active bank transfer invoices. Changing this behavior can affect reconciliation and should be deliberate.
- Optional JWT behavior is unusual: invalid token is ignored and valid token changes pricing and ownership. Node gateway auth middleware should not be required for public create unless this behavior is intentionally changed.
- Admin confirm is high-risk because it calls live providers and marks the invoice paid before provider delivery completes.
- Provider top-up retry semantics matter. Retrying confirm after a timeout should not duplicate vendor orders, but local state may already be `paid/processing` and v1 rejects a second confirm.
- Admin status update can mark paid guest orders as success/failed without balance or points effects. This differs from authenticated saldo transactions and must remain intentionally separate.
- Guest orders do not currently support provider recheck in the UI or API. Adding guest recheck during migration would be new behavior.
- Public check returns bank account details for matching invoice plus WhatsApp. This is current behavior, but any new v2 endpoint must preserve the WhatsApp guard.

## API v2 Design Requirements

- Node gateway must keep public create/check unauthenticated if migrated, while still forwarding optional bearer context only when valid and without rejecting invalid guest tokens.
- Rust protected admin endpoints must reject direct Rust access without proxy context with `403 API v2 proxy access required`.
- Node gateway must enforce:
  - `viewTransactions` for admin list.
  - `processManualTransaction` for confirm, cancel, and status update.
- Rust must use forwarded `x-webtopup-user-id` as `statusUpdatedBy` for admin mutations.
- Public create must preserve current response shape and validation messages unless a compatibility change is approved.
- Public create must preserve bank-transfer-only guest checkout and payment method operational window semantics.
- Public create must preserve optional member pricing based on valid bearer token.
- Admin confirm must preserve Node provider semantics exactly and be covered by provider mock/sandbox smoke.
- Admin cancel/status update should return the same populated admin transaction shape as admin list.

## Migration Recommendation

- `POST /guest-transactions` has been migrated after focused review. It remains public through the Node gateway, preserves optional valid bearer token pricing/ownership, ignores invalid bearer tokens as guest, and the order UI now calls API v2 directly after local disposable create smoke and provider sandbox smoke coverage.
- `POST /guest-transactions/:id/confirm` has been migrated after guest-provider mock and sandbox smoke coverage was added for pending/success/failed/provider-error outcomes.
- Admin `POST /guest-transactions/:id/cancel` and `PUT /guest-transactions/:id/status` have been migrated with proxy protection, guarded updates, and existing admin UI v2-first fallback.
- Public check and admin list are implemented in Rust and used by frontend with v2-first fallback.
- Do not add guest recheck as part of parity migration unless explicitly approved, because v1 does not expose this behavior.

## Smoke Strategy

- Default read smoke can cover:
  - public check requires WhatsApp.
  - public check missing invoice returns `404`.
  - admin list requires proxy context on direct Rust.
  - admin list invalid filters return expected `400` messages.
- Mutation smoke covers public create boundary cases, Mongo-backed public create with disposable product/payment fixtures, and admin cancel/status using disposable guest transaction fixtures without provider calls. It also includes boundary checks for confirm that do not call providers.
- Provider smoke for guest confirm is opt-in and separate from default smoke:
  - `RUN_PROVIDER_SMOKE=1`.
  - `PROVIDER_MODE=mock` with explicit backend mock confirmation, or `PROVIDER_MODE=sandbox` with sandbox confirmation.
  - Disposable waiting-payment guest fixture.
  - Confirm outcomes for pending/success/failed/provider-error.
  - Verify direct Rust proxy guard for protected confirm.
  - Cleanup inserted guest transactions and restore flash sale fixture counts if create is tested.
- Public create e2e smoke is opt-in with Mongo fixture access. It creates only disposable inactive/test fixtures, verifies the waiting-payment invoice and persisted references, and deletes the generated guest transaction/product/payment records.
- API v2 smoke scripts now share a suite-level lock at `/tmp/webtopup-api-v2-smoke-suite.lock`; run read, mutation, and provider smoke sequentially because they inspect or mutate shared Mongo fixtures.

## Fallback Removal Readiness

- Guest public create frontend fallback has been removed after sequential local validation of read smoke, mutation smoke, and provider sandbox smoke.
- Keep legacy `/v1/guest-transactions` route available until one staging/production-like checkout dry run verifies invoice creation, payment instructions, optional member pricing, flash-sale behavior, and admin follow-up.
- Authenticated saldo `POST /transactions` should keep frontend v1 fallback until a separate production-like dry run verifies one low-value live/provider transaction and rollback/compensation steps.

## Outcome

Guest transaction parity paths are migrated: public create, public check, admin list, admin confirm, admin cancel, and admin status update are available through API v2. Public create is now v2-only in the order UI; legacy `/v1` remains available as an operational rollback target until a production-like dry run is completed.
