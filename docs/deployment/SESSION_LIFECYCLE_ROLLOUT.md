# Session Lifecycle Security Rollout Runbook

Operator procedure for refresh-backed sessions, security audits, metrics gates, and rollback.

**Scope:** Node gateway + Rust API v2 + MongoDB session collections.
**Atomicity:** Mongo standalone deployments do **not** provide multi-document atomicity. Do not claim multi-document transactions unless the deployment is a replica set/sharded cluster with `MONGO_TRANSACTIONS_ENABLED=true` and verified support. Session rotation, device selection, global revoke, security-change, and idempotency recovery are designed as **idempotent state machines** with compensating paths—not multi-document atomic commits.

**Live smoke status:** **PENDING** (not executed in Task 13). Label any unexecuted live smoke as PENDING, never passed.

The `auth_parallel_waiter` metric is unavailable/PENDING until a trusted coordinator exporter exists. It is excluded from rollout gates and denominators. Rust's `auth_refresh_outcome` is the authoritative refresh denominator; Node gateway metrics are operationally informative only and are excluded from that denominator.

---

## 1. Prerequisites (cookie / TLS / secrets)

### Cookie and TLS

| Requirement | Value |
|---|---|
| Public origin | Exact `PUBLIC_APP_URL` / `API_V2_ALLOWED_ORIGIN` (scheme + host + non-default port); no wildcard |
| Refresh cookie | `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/api/v2/auth`, no `Domain` |
| Recovery cookie | Same flags/path as refresh |
| CSRF cookie | Double-submit companion on auth mutations; Origin + content-type validated on Node |
| TLS | Terminate TLS at the public edge; Node→Rust may stay on loopback HTTP with shared proxy secret |

### Secrets (rotate independently; never reuse across roles)

| Secret | Owner | Notes |
|---|---|---|
| `JWT_SECRET` | Node + Rust | Access JWT signing; ≥32 chars |
| `SESSION_TOKEN_HASH_SECRET` | Node + Rust | Independent of JWT; digests only |
| `API_V2_PROXY_SECRET` | Node + Rust | Exact match; strips direct browser access |
| `SESSION_ROTATION_KEYS` / active ID | Rust | base64url no-pad 32-byte keys |
| `SESSION_RECOVERY_ENCRYPTION_KEYS` / active ID | Rust | Separate AEAD ring; retain retired keys through recovery windows |

**Rotation procedure (high level):**

1. Add new key ID to the ring; set active ID only after both processes can load it.
2. Deploy Rust first (can verify with old + new), then Node if it reads the same ring.
3. Retain retired keys until every unexpired recovery/migration window ends.
4. Never log key material, digests, ciphertext, nonces, cookies, passwords, OTP, or CSRF values.

### Indexes (verify before enabling cohorts)

Rust readiness creates:

- `authsessions`: unique `sessionId`; unique owned-slot `(userId, slot)` with fixed name; status/expiry scan indexes; cleanup TTL eligibility only when documented terminal + cleanup complete.
- `authdevicechallenges`: unique `nonce`; user/status/expiry scan.
- `authsecurityaudits`: append-only security audit events (bounded fields).
- `legacy_session_migrations`, `idempotencyrecords`: as Tasks 6/12.

Verify with Mongo:

```bash
# Example — adjust DB name
mongosh "$MONGO_URI" --eval 'db.getSiblingDB("POBB").authsessions.getIndexes()'
mongosh "$MONGO_URI" --eval 'db.getSiblingDB("POBB").authsecurityaudits.getIndexes()'
```

### Mongo standalone caveats

- Do **not** document or operate as if multi-document transactions always succeed.
- Global logout, security-change, and financial idempotency use recoverable markers; retries must reconcile domain markers.
- If `MONGO_TRANSACTIONS_ENABLED=false`, keep standalone-safe recovery paths enabled and tested.

---

## 2. Exact rollout sequence

Execute **in order**. Pause at every gate. If any stop threshold trips, stop cohort expansion and evaluate rollback (Section 4).

### Step 1 — Deploy indexes / session code dark

1. Deploy Rust + Node with session lifecycle code while flags remain off:
   - `SESSION_REFRESH_ENABLED=false`
   - all cohort percents `0`
   - leave `LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL` set for the compatibility window
2. Confirm readiness: indexes created, process healthy, no cohort issuance.
3. Confirm process identity (Section 5) after restart.

### Step 2 — Staff 2FA deadline dry run and migration (manual)

1. Run the operator-only 2FA deadline command **manually** (never at startup). It selects only active owner/admin/CS users with 2FA disabled and a missing/null deadline; it never reads or prints credentials or TOTP fields:

```bash
cd rust-api
export MONGO_URI='mongodb+srv://REDACTED@host.example/?tls=true'
export MONGO_DB='staging'
# Dry run: count only, no writes.
cargo run --bin ensure_staff_2fa_deadlines -- --dry-run
# After operations approval and a fresh backup, apply once. UTC is computed by the binary
# from DateTime::now() and set to exactly seven days later.
cargo run --bin ensure_staff_2fa_deadlines
# Verify no eligible records remain (repeat dry run; expected matched=0).
cargo run --bin ensure_staff_2fa_deadlines -- --dry-run
```

The update predicate is `active:true`, `role in [owner,admin,cs]`, `twoFactorEnabled != true`, and (`twoFactorEnrollmentRequiredAt` missing OR null); `$set` writes only `twoFactorEnrollmentRequiredAt` and `updatedAt`. The predicate makes apply idempotent. Review the matched/modified counts, obtain approval, and retain the backup before applying. Never place a URI containing real credentials in shell history or runbook text.

2. Review dry-run counts. Apply only after operations approval and backup verification.
3. Confirm login-time fallback still assigns missing staff deadlines without rewriting completed enrollments.

### Step 3 — Enable member cohorts: 1% → 10% → 50% → 100%

At each step, set:

```env
SESSION_REFRESH_ENABLED=true
SESSION_REFRESH_MEMBER_COHORT_PERCENT=<1|10|50|100>
SESSION_REFRESH_CS_COHORT_PERCENT=0
SESSION_REFRESH_ADMIN_COHORT_PERCENT=0
SESSION_REFRESH_OWNER_COHORT_PERCENT=0
```

Restart Node (and Rust if it reads the same env). Wait **at least 15 minutes** of stable traffic before the next increase.

**Gate metrics (required at each member gate):**

- `auth_refresh_outcome` success (`rotated` / recovered success paths) ≥ **99.5%** over 15 minutes
- refresh reuse / forced-login metrics within stop thresholds (Section 3)
- no confirmed false reuse revocations

### Step 4 — Verify refresh / reuse / forced-login metrics at each gate

Inspect low-cardinality logs/metrics only:

| Metric | Labels (bounded) |
|---|---|
| `auth_refresh_outcome` | `outcome` ∈ rotated, recovered, concurrent_predecessor, recovery_expired, reused, invalid, expired, revoked, account_disabled, session_version_mismatch, idle_locked, history_full, recovery_unavailable, store |
| `auth_forced_login` | `reason` ∈ session_expired, session_revoked, refresh_reused, account_disabled, token_invalid, recovery_expired |
| `auth_idle_outcome` | `outcome` ∈ locked, unlocked, unlock_failed, warning, throttled |
| `auth_device_challenge` | `outcome` ∈ created, completed, expired, conflict |
| `auth_two_factor_enrollment` | `outcome` ∈ required, completed, failed |
| `auth_step_up` | `action_group` (allowlisted groups), `outcome` ∈ granted, failed, required |
| `auth_idempotency_duplicate_prevented` | `route` ∈ balance_adjust, refund; `outcome` ∈ replayed, conflict, in_progress (**never** key/digest) |

Never use tokens, cookies, digests, ciphertext, nonces, OTP, passwords, or full bodies as labels.

### Step 5 — Enable CS, admin, then owner restricted cohorts

Only after **idle lock**, **step-up**, and **critical-mutation idempotency** gates are green:

1. `SESSION_REFRESH_CS_COHORT_PERCENT` → small restricted percent, then expand.
2. `SESSION_REFRESH_ADMIN_COHORT_PERCENT` similarly.
3. `SESSION_REFRESH_OWNER_COHORT_PERCENT` last / most restricted.

Staff enablement prerequisites:

- idle warning/lock metrics healthy
- step-up grant/failure audits present without secrets
- balance adjust + refund idempotency duplicate-prevention metrics active
- mandatory 2FA enrollment deadlines enforced

### Step 6 — Set and later remove legacy cutoff

1. Keep `LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL` as an explicit UTC instant (`YYYY-MM-DDTHH:MM:SSZ` or `.mmmZ`).
2. Invalid / missing cutoff **fails closed** (no indefinite legacy acceptance).
3. After migration completion and member/staff gates, advance or remove compatibility by setting cutoff to now/past and verifying legacy path rejects.
4. Never extend legacy acceptance into the permanent architecture.

### Step 7 — Rollback issuance without reactivating invalid credentials

See Section 4. Rollback **never** reactivates revoked, expired, or reused refresh credentials.

### Step 8 — Restart Rust with the current binary

```bash
cd rust-api
cargo run --bin webtopup-rust-api
# production: use the release binary path managed by your process supervisor
```

### Step 9 — Verify process identity and current binary before live smoke

1. Confirm the running process matches the intended binary path and build (Section 5).
2. Confirm env flags match the intended cohort stage.
3. Only then run live smoke. If smoke is not executed, mark **PENDING**.

---

## 3. Stop thresholds (initial)

Pause cohort expansion and trigger rollback evaluation if **any** of the following hold:

1. **Refresh success below 99.5%** over a **15-minute** window (`auth_refresh_outcome` success paths vs total refresh attempts).
2. **Forced-login rate above 1% of active sessions** over a **15-minute** window (`auth_forced_login`).
3. **Any confirmed false refresh-reuse revocation** (legitimate multi-tab / concurrent refresh treated as reuse).
4. **Any duplicate critical financial mutation** (balance adjust or refund effect applied twice for the same actor+route+key).

On trip: freeze cohort percents, open incident, evaluate Section 4 rollback.

---

## 4. Rollback

1. Set `SESSION_REFRESH_ENABLED=false` and/or all cohort percents to `0` for affected roles.
2. Keep `LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL` only if still inside an approved compatibility window; do not invent a new indefinite window.
3. **Do not** re-issue, un-revoke, or restore revoked/reused/expired refresh credentials.
4. Existing valid refresh sessions may drain under documented policy or be explicitly revoked (logout-all / device revoke) after security review.
5. Redeploy previous known-good binary only if the defect is in code; still never reactivate invalid credentials.
6. Re-verify indexes, secrets, and process identity before any re-enable.

---

## 5. Process identity and current binary checks

Before live smoke or after every restart:

```bash
# Process command line / binary path (adapt to supervisor)
ps aux | rg 'webtopup-rust-api|pobb-api'
# Or systemd/pm2:
# pm2 show pobb-api-v2
# systemctl status webtopup-rust-api

# Binary identity
readlink -f "$(command -v webtopup-rust-api)" 2>/dev/null || true
ls -l rust-api/target/release/webtopup-rust-api
sha256sum rust-api/target/release/webtopup-rust-api

# Build stamp / version if available in logs at startup
```

Confirm:

- expected path and mtime/hash for this release
- Node gateway points at the intended `API_V2_UPSTREAM_URL`
- proxy secret matches on both sides
- rollout env matches the intended step

---

## 6. Secrets rotation procedure (detail)

1. Generate new secret material offline (`openssl rand -base64 48` or base64url 32-byte keys).
2. Dual-load: deploy config that accepts old + new where the protocol supports key rings.
3. Flip active key ID only after both Node and Rust (as applicable) are healthy.
4. Monitor `recovery_*` / refresh outcomes for key-unavailable spikes.
5. Retire old keys only after windows expire.
6. Secrecy scan: logs, audits, traces, metric labels must never contain key material, digests, ciphertext, nonces, cookies, passwords, OTP, CSRF, or full bodies.

---

## 7. Smoke matrix

| Case | Expected | Live status |
|---|---|---|
| Member login remembered / non-remembered | Session + cookies; bounded audit `login_success` / `session_created` | **PENDING** |
| Refresh rotation | New access/refresh; metric `auth_refresh_outcome=rotated` | **PENDING** |
| Concurrent multi-tab refresh | No false reuse revoke | **PENDING** |
| Sequential reuse | Device family revoke + audit `device_session_revoked` | **PENDING** |
| Staff idle lock / unlock | Lock metric; unlock audit without secrets | **PENDING** |
| Device limit challenge | Challenge created audit + metric | **PENDING** |
| Step-up grant | Audit + `auth_step_up` granted | **PENDING** |
| Logout current / all | Audits `logout_current_device` / `logout_all_devices` | **PENDING** |
| Device revoke | Audit `device_revoked_by_user` | **PENDING** |
| 2FA enrollment | Metric/audit without raw TOTP secret in audits | **PENDING** |
| Balance adjust / refund idempotency | Duplicate prevention metric without key labels | **PENDING** |
| Legacy cutoff fail-closed | Invalid cutoff rejected; post-cutoff legacy rejected | **PENDING** |

Staging smoke entry points (when approved): see `docs/deployment/API_V2_STAGING_VERIFICATION.md`. Task 13 does **not** mark these passed.

---

## 8. Security audit field contract

Collection: `authsecurityaudits` (Rust `auditSource` / `source` = `rust_domain`).

Allowlisted events include: login success/failure, session creation, device challenge, refresh reuse, idle lock/unlock, step-up, logout current/all, device revoke, 2FA enrollment/enable/disable/login outcome.

Allowlisted fields: `event`, `outcome`, `userId`, `sessionId`, `source`, `traceId`, `correlationSource`, `actionGroup`, `device` (`label`, `ipPrefix`, `userAgentFamily`), `reason`, `createdAt`.

Gateway admin audits continue to use `adminauditlogs` with `auditSource=node_gateway` and gateway-owned trace correlation (`otel_span` | `gateway_header` | `absent`).

---

## 9. Config fail-closed semantics (Node + Rust)

| Variable | Valid | Invalid behavior |
|---|---|---|
| `SESSION_REFRESH_ENABLED` | `true` / `false` | throw / parse error (fail closed) |
| `SESSION_REFRESH_*_COHORT_PERCENT` | integer 0–100 | throw / parse error |
| `LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL` | UTC `...Z` instant | throw / parse error; absent ⇒ no legacy acceptance |

Cohort membership is deterministic: `hash = Σ char * 31` (uint32), `hash % 100 < percent`. Same algorithm in Node and Rust.

---

## 10. Disposable local verification

The current-source local stack is an engineering preflight, not staging or deployment evidence. It uses trusted `mkcert` HTTPS at `https://webtopup.local.test:9443`, loopback-only host processes, mock providers, and the guarded `webtopup_task14_dev` Mongo replica set.

Run only through the stable façade:

```bash
make dev-verify-down
make dev-verify-setup
make dev-verify-up
make dev-verify-reset
make dev-verify-seed
make dev-verify-status
make dev-verify-test
make dev-verify-down
make dev-verify-status
```

`dev-verify-test` executes required unit/build, Mongo, desktop/mobile session, finance idempotency, external fault, and rollout-transition checks with fresh scenario isolation. It may emit only `LOCAL DEV VERIFIED` or `LOCAL DEV FAILED`; required `NOT RUN` checks make the aggregate fail. Reports are ignored, atomic, and secrecy-gated beneath `.dev-verification/reports/`.

The test runner always returns host rollout to disabled/all-zero and stops owned host processes. The final `down/status` gate must additionally show no running Compose services. Never translate local success into `DEPLOYMENT VERIFIED`; staging smoke in section 7 remains `PENDING`.

See `tools/dev-verification/README.md` for prerequisites, trusted-CA cleanup, port conflicts, ownership checks, and guarded database recovery.

---

## 11. Review requirements

- Operations + security review required before production cohort expansion.
- Unexecuted live smoke remains **PENDING**.
- Do not claim multi-document atomicity on standalone Mongo.
