# API v2 Points Adjust Review

Last updated: 2026-05-01

## Scope

This review covers the admin points adjustment endpoint:

- `POST /points/adjust`

It does not cover automatic points awarded/revoked by transaction status changes, reward redemption, voucher redemption, or user balance adjustment.

## Current v1 Behavior

Route source: `server/src/routes/pointsRoutes.ts`.

- Route: `POST /points/adjust`.
- Middleware: `authenticate` and `hasPermission('manageProducts')`.
- Controller: `adjustUserPoints` in `server/src/controllers/pointsController.ts`.
- Payload fields:
  - `userId: string`
  - `points: number`
  - `description: string`
- It loads the target user with `User.findById(userId)`.
- Missing user returns `404 { message: 'User not found' }`.
- Computes `newPoints = user.points + points`.
- If `newPoints < 0`, returns `400 { message: 'Insufficient points' }`.
- Saves `user.points = newPoints`.
- Creates a `PointTransaction` document:
  - `user: userId`
  - `type: 'admin_adjustment'`
  - `points`
  - `description`
- Success response: `{ message: 'Points adjusted successfully', newPoints: user.points }`.
- Unhandled errors return `500 { message: 'Internal Server Error' }`.

## Collections And Fields

Written collections:

- `users`: updates `points` and Mongoose-managed `updatedAt`.
- `pointtransactions`: inserts an admin adjustment history row with timestamps.

Read collections:

- `users`: target user lookup.

No user balance, deposits, transactions, vouchers, rewards stock, provider, or payment gateway collections are written by this endpoint.

## Risk Notes

- v1 uses a read-modify-save pattern instead of an atomic conditional update. Two simultaneous adjustments can race and overwrite one another.
- v1 has no rollback if `PointTransaction.create` fails after saving the user points. Rust v2 should improve this with either a Mongo transaction or a compensation rollback.
- Negative adjustments must not allow points below zero.
- `description` is required by the Mongoose schema, but v1 does not validate it before insert. A missing/empty description can surface as a `500`. Preserve this unless a deliberate validation improvement is approved.
- `points` is not explicitly validated as a finite non-zero number in v1. Rust should avoid accepting non-numeric JSON, but should otherwise keep response compatibility as much as practical.
- Gateway permission must stay `manageProducts`, matching v1 and the existing v2 wildcard.

## Suggested Rust v2 Implementation

Recommended approach: use atomic update plus compensation rollback.

1. Add `adjust_user_points` in `rust-api/src/routes/rewards.rs` or a points-specific module if split later.
2. Require proxy context with `require_proxy_context`.
3. Deserialize payload with `userId`, `points`, and `description`.
4. Validate `userId` as ObjectId; v1 invalid ids fall through to Mongoose behavior, but Rust should return a controlled `404 User not found` or `400` only if we intentionally tighten behavior. Prefer `404 User not found` for missing/invalid targets to match the effective user-not-found outcome.
5. For negative adjustments, update with filter `{ _id: userId, points: { $gte: abs(points) } }` and `$inc: { points }`.
6. For positive adjustments, update with filter `{ _id: userId }` and `$inc: { points }`.
7. If no user matched, check user existence:
   - no user: `404 User not found`
   - user exists but insufficient points: `400 Insufficient points`
8. Insert `pointtransactions` with `type: 'admin_adjustment'`, payload points/description, and timestamps.
9. If insert fails after the user update, compensate with `$inc: { points: -points }` and log rollback failure if compensation fails.
10. Return `{ message: 'Points adjusted successfully', newPoints }`.

## Smoke Strategy

Default mutation smoke should keep points adjust disabled unless Mongo fixture access is available.

Mongo-backed optional smoke can safely cover this endpoint by:

- Reading the smoke user's current points.
- Calling `POST /api/v2/points/adjust` with a small positive adjustment and a unique description marker.
- Verifying `newPoints` increased.
- Calling a negative adjustment to return points to the original value, or directly restoring points in Mongo during cleanup.
- Deleting marked `pointtransactions` created by the smoke run.
- Restoring the smoke user's original points in a `finally` block.

## Recommendation

Implemented in API v2 after review.

- Rust route: `POST /v2/points/adjust`.
- Gateway route: `POST /api/v2/points/adjust`, covered by the existing `/points/*` gateway rule with `manageProducts`.
- Smoke coverage:
  - direct Rust without proxy context returns `403`.
  - missing user returns `404`.
  - optional Mongo-backed e2e snapshots/restores the smoke user's points and deletes marked point transaction rows.
