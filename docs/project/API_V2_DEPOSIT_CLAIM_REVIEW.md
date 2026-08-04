# API v2 Deposit Claim/Release Review

Last updated: 2026-05-01

## Scope

This review covers only the admin deposit assignment lock endpoints:

- `POST /deposits/:id/claim`
- `POST /deposits/:id/release-claim`

It does not cover deposit creation, approval, rejection, balance mutation, payment proof handling, or payment/provider integrations.

## Current v1 Behavior

The v1 routes are registered in `server/src/routes/depositRoutes.ts` with `authenticate` and `hasPermission('approveDeposits')`.

### Claim

Controller: `claimDeposit` in `server/src/controllers/depositController.ts`.

- Validates `id` with `mongoose.Types.ObjectId.isValid`.
- Uses authenticated `request.user!.id` as `actorId`.
- Performs one atomic `Deposit.findOneAndUpdate` with this filter:
  - `_id: id`
  - `status: 'pending'`
  - `$or` allowing no `assignedTo`, `assignedTo: null`, or `assignedTo` equal to actor id.
- Updates:
  - `$set.assignedTo = actorId`
  - `$set.assignedAt = new Date()`
- Returns `409` with `Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain` when no document matches.
- Returns `200` with `{ message: 'Deposit claimed', deposit: populatedDeposit }` on success.

### Release Claim

Controller: `releaseDepositClaim` in `server/src/controllers/depositController.ts`.

- Validates `id` with `mongoose.Types.ObjectId.isValid`.
- Uses authenticated `request.user!.id` as `actorId` and `request.user!.role === 'owner'` as owner override.
- Builds a filter with `buildAssignmentAccessFilter(id, actorId, isOwner)`:
  - `_id: id`
  - `status: 'pending'`
  - for non-owner only, `$or` allowing unassigned or assigned to actor id.
  - owner can match any pending deposit regardless of assignment.
- Performs one atomic `Deposit.findOneAndUpdate` with `$unset.assignedTo` and `$unset.assignedAt`.
- Returns `409` with `Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain` when no document matches.
- Returns `200` with `{ message: 'Deposit claim released', deposit: populatedDeposit }` on success.

## Collections And Fields

Primary collection: `deposits`.

Written fields:

- claim: `assignedTo`, `assignedAt`, and Mongoose-managed `updatedAt`.
- release: unset `assignedTo`, unset `assignedAt`, and Mongoose-managed `updatedAt`.

Read/populated collections:

- `users` for `user`, `assignedTo`, and `processedBy` population.
- `paymentmethods` for `paymentMethod` population.

No user balance, transaction, payment, provider, points, voucher, or notification collections are written by claim/release.

## Parity Requirements For Rust v2

- Use `require_proxy_context` in Rust and keep Node as the auth/permission authority.
- Add explicit Node gateway routes for `POST /api/v2/deposits/:id/claim` and `POST /api/v2/deposits/:id/release-claim` with `hasPermission('approveDeposits')`.
- Do not route these mutations through the current `/deposits/*` wildcard because it only requires `viewDeposits`.
- Match ObjectId validation and return `400 { message: 'ID deposit tidak valid' }` for invalid ids.
- Preserve the exact `409` message used by v1 for already processed, missing, or locked deposits.
- Preserve claim atomicity with a single `find_one_and_update` and the same assignment filter.
- Preserve owner override on release, while non-owner release remains limited to unassigned or self-assigned pending deposits.
- Preserve populated deposit response shape used by v2 admin deposit list/detail serializers where possible.
- Ensure `updatedAt` is explicitly updated in Rust because Mongoose timestamps will not run.

## Race And Idempotency Notes

- Claim is intentionally idempotent for the same actor: claiming an already self-assigned pending deposit succeeds and refreshes `assignedAt`.
- Claim by a different actor must fail with `409` while the deposit is assigned.
- Claim must fail with `409` once status is no longer `pending`.
- Release by owner can release another admin's pending assignment.
- Release by non-owner should succeed for unassigned pending deposits under v1 behavior because the filter allows unassigned; this is odd but must be preserved unless a breaking change is approved.
- Release must fail with `409` once status is no longer `pending`.

## Suggested Rust Implementation Steps

1. Add `claim_deposit` and `release_deposit_claim` handlers in `rust-api/src/routes/deposits.rs`.
2. Reuse existing deposit serialization/population helpers where possible to avoid response drift.
3. Add routes in `rust-api/src/routes/mod.rs` for `/v2/deposits/{id}/claim` and `/v2/deposits/{id}/release-claim`.
4. Add explicit gateway routes before the existing `/deposits/*` wildcard in `server/src/routes/apiV2ProxyRoutes.ts` with `approveDeposits` permission.
5. Keep frontend on `/v1` until mutation smoke covers disposable claim/release flow.

## Smoke Strategy

Default mutation smoke may cover claim/release only if it creates an isolated disposable pending deposit and deletes/restores it safely.

Minimum safe smoke cases:

- invalid deposit id via gateway returns `400`.
- direct Rust call without proxy context returns `403`.
- create disposable pending deposit fixture or locate an explicitly marked smoke fixture.
- claim disposable deposit returns `200` and sets `assignedTo`.
- repeat claim by the same actor returns `200`.
- release claim returns `200` and clears assignment.
- claim or release an already processed disposable fixture returns `409`, if such fixture can be created without balance/payment side effects.

Do not include deposit approval/rejection, balance update, or payment/provider calls in this smoke step.

## Open Questions Before Implementation

- Should release of an unassigned pending deposit by a non-owner remain a `200` no-op to preserve v1, or should it be tightened later as a deliberate behavior change?
- Should `assignedAt` refresh on repeat claim by the same actor, matching v1, or should repeat claim be treated as a no-op in a future product decision?
- What disposable deposit fixture should mutation smoke use without creating real payment instructions?
