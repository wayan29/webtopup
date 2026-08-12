# Admin Audit Logs Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure audit metadata against new and historical credential disclosure and turn `/admin/audit-logs` into a deterministic, accessible investigation surface with verified authorization, export, filtering, dialog, and disposable cleanup behavior.

**Architecture:** Node remains the generic pre-persistence audit writer, Rust remains the database-backed list/export authority, and both layers enforce the existing permission and step-up boundaries. A pure client query module owns canonical URL behavior, a focused dialog component owns keyboard-modal behavior, a dry-run-first script owns historical cleanup, and isolated disposable integration plus Playwright checks prove the complete path without production data or successful financial mutations.

**Tech Stack:** React 19, React Router 7, TypeScript, Axios, Zustand, Fastify, Mongoose, Node test runner, Rust/Axum/MongoDB BSON, Playwright, MongoDB replica set, disposable verification harness.

## Global Constraints

- Work inline on the existing `main` checkout only because that is the approved execution mode; do not create a worktree without renewed consent.
- Use TDD for every behavior change: create the failing test, run it and observe the intended failure, implement the minimum production change, rerun focused tests, then commit.
- Do not weaken or reorder authentication, active-account enforcement, database-backed permissions, step-up, CSRF, credential cookies, refresh semantics, trusted proxy admission, direct-Rust rejection, rate limits, 2FA enrollment restrictions, finance idempotency, or audit-writer failure isolation.
- Audit list/detail remains `viewTeam`; audit export remains `manageTeam` plus `exports.sensitive` at both Node and Rust.
- Only sanitized metadata may leave Rust list/export responses. Client rendering and copy actions are never a sanitization boundary.
- The exact redaction marker is `[redacted]`. Sensitive values, fixture credentials, MongoDB URIs, cookie contents, grants, OTP values, and source secrets must never appear in test names, assertion messages, reports, screenshots, diffs, or scrubber output.
- The scrubber defaults to dry-run. `--apply` without protected-database overrides is allowed only for exact database `webtopup_task14_dev`. Automated verification must never pass `--allow-protected-database`.
- Disposable database mutations are limited to marked synthetic fixtures in `webtopup_task14_dev`; clean synthetic sessions and audit rows in `finally` paths.
- Do not use successful financial mutations to generate audit records.
- Preserve gateway and Rust domain records as separate rows; show source/correlation instead of deduplicating.
- Keep legacy `server/src/routes/adminAuditRoutes.ts` and `server/src/controllers/adminAuditController.ts` inactive; add closure coverage rather than activating or broadly refactoring them.
- No TTL, retention deletion, archive policy, new text/search index, Atlas Search, SIEM, WORM storage, production scrub, production deployment, production restart, or GitHub push is authorized.
- `cargo fmt --check` remains blocked unless `rustfmt` is installed with explicit approval; report this limitation instead of installing packages.
- Specification authority: `docs/superpowers/specs/2026-08-12-admin-audit-logs-hardening-design.md`.

---

## File structure and responsibility map

**Create:**

- `server/src/services/adminAuditService.test.ts` — focused behavioral tests for Node sanitization and writer dependency seams.
- `rust-api/src/routes/audit_logs/sanitize.rs` — recursive BSON disclosure sanitizer shared by list and export.
- `client/src/lib/auditLogQuery.ts` — pure URL parsing, validation, serialization, page correction, and range helpers.
- `client/src/lib/auditLogQuery.test.ts` — pure query-contract tests.
- `scripts/security/audit-secret-policy.js` — scrubber-side normalized sensitive-key and recursive transformation functions.
- `scripts/security/scrub-admin-audit-secrets.js` — guarded dry-run/apply CLI.
- `scripts/security/scrub-admin-audit-secrets.test.js` — CLI/policy tests with no source-secret output.
- `client/src/components/admin/AuditLogDetailDialog.tsx` — accessible detail presentation, focus lifecycle, source/correlation details, and copy feedback.
- `tools/dev-verification/integration/auditLogs.test.ts` — real-session disposable authorization, writer, reader, filter, export, and scrub verification.
- `tools/dev-verification/e2e/audit-logs.spec.ts` — desktop/mobile user-flow and accessibility verification, created RED with the dialog task and extended with page behavior before matrix registration.

**Modify:**

- `server/src/services/adminAuditService.ts` — exact PIN aliases, exported sanitizer policy, and injectable writer dependencies for tests.
- `rust-api/src/routes/audit_logs.rs` — register sanitizer, strict pagination, sanitized list/export path, and 5,001-row truncation detection.
- `rust-api/src/routes/audit_logs/filters.rs` — fail-closed validation, bounded search/resource, and trace-ID search.
- `rust-api/src/routes/audit_logs/mappers.rs` — sanitize metadata before JSON mapping.
- `rust-api/src/routes/audit_logs/export.rs` — sanitize metadata and expose truncation headers.
- `rust-api/src/routes/audit_logs/types.rs` — stable pagination/query/item contract.
- `client/src/pages/admin/AuditLogs.tsx` — applied-URL orchestration, result states, structured layout, pagination, and export status.
- `tools/dev-verification/seed.ts` — denied/viewer/manager audit fixtures.
- `tools/dev-verification/unit/seed.test.ts` — fixture contract.
- `tools/dev-verification/e2e/fixtures.ts` — reuse existing real fixture login/TOTP contract without exposing credentials.
- `tools/dev-verification/verificationMatrix.ts` — mandatory isolated audit integration and desktop/mobile checks.
- `tools/dev-verification/unit/verificationMatrix.test.ts` — matrix contract.
- `tools/dev-verification/unit/staffLoginSeparation.test.ts` — legacy-route closure and login-exclusion source contract.
- `scripts/smoke/api-v2-mutation-smoke.js` — correct the unreachable invalid-export-date expectation.
- `package.json` — include script-level secret-policy tests in the canonical unit command.

---

### Task 1: Harden the Node audit writer before persistence

**Files:**
- Modify: `server/src/services/adminAuditService.ts`
- Create: `server/src/services/adminAuditService.test.ts`
- Modify: `tools/dev-verification/unit/staffLoginSeparation.test.ts`

**Interfaces:**
- Produces: `export const ADMIN_AUDIT_REDACTION = '[redacted]'`.
- Produces: `export function normalizeAuditMetadataKey(key: string): string`.
- Produces: `export function isSensitiveAuditMetadataKey(key: string): boolean`.
- Preserves: `export function sanitizeAuditMetadataValue(value: unknown): unknown`.
- Produces: `export type AdminAuditWriterDependencies` with `findActor(id)` and `createAuditLog(document)` seams.
- Preserves: `recordAdminAuditLog(request, statusCode)` for `server/src/app.ts`; a third optional dependency argument is test-only and defaults to the real Mongoose implementation.

- [ ] **Step 1: Write failing sanitizer and writer tests**

Create `server/src/services/adminAuditService.test.ts` with Node test cases that import the public functions and assert exact behavior:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_AUDIT_REDACTION,
  isSensitiveAuditMetadataKey,
  normalizeAuditMetadataKey,
  recordAdminAuditLog,
  sanitizeAuditMetadataValue,
} from './adminAuditService';

test('audit sanitizer redacts exact normalized credential keys without PIN false positives', () => {
  assert.equal(normalizeAuditMetadataKey('Merchant-PIN'), 'merchantpin');
  for (const key of ['pin', 'merchant_pin', 'Transaction PIN', 'security-pin', 'API-Key', 'csrf_token']) {
    assert.equal(isSensitiveAuditMetadataKey(key), true, key);
  }
  for (const key of ['shipping', 'mapping', 'pinned', 'opinion']) {
    assert.equal(isSensitiveAuditMetadataKey(key), false, key);
  }
  assert.deepEqual(sanitizeAuditMetadataValue({
    pin: 'fixture-value',
    nested: [{ merchant_pin: 'fixture-value', shipping: 'visible' }],
  }), {
    pin: ADMIN_AUDIT_REDACTION,
    nested: [{ merchant_pin: ADMIN_AUDIT_REDACTION, shipping: 'visible' }],
  });
});
```

Add cases for depth 8, array cap 50, object cap 100, string cap 500, mixed punctuation/case, and all exact keys from the specification. Use generated strings such as `'x'.repeat(600)`; do not place realistic secrets in source.

Add a writer test with fake dependencies that proves a `400` authenticated staff mutation still records the actual status and sanitized body, while a rejected fake `createAuditLog` is swallowed and logged rather than thrown to the caller. The fake request must contain only synthetic marker values.

- [ ] **Step 2: Extend login-route source-contract tests and run RED**

In `tools/dev-verification/unit/staffLoginSeparation.test.ts`, retain the existing staff/member login exclusions and add assertions for registration exclusion and that `pin` appears in the exact sensitive-key policy rather than a broad `/pin/i` fallback.

Run:

```bash
npm --prefix server run build
node --test server/dist/services/adminAuditService.test.js
node --import tsx --test tools/dev-verification/unit/staffLoginSeparation.test.ts
```

Expected RED: PIN/alias assertions fail and writer dependency injection is unavailable.

- [ ] **Step 3: Implement exact normalized-key sanitization**

In `server/src/services/adminAuditService.ts`, export the policy functions and add exact normalized PIN aliases:

```ts
export const ADMIN_AUDIT_REDACTION = '[redacted]';

const EXACT_SENSITIVE_AUDIT_KEYS = new Set([
  'password', 'currentpassword', 'newpassword', 'confirmpassword',
  'pin', 'merchantpin', 'transactionpin', 'securitypin',
  'apikey', 'secret', 'vendorsecret', 'twofactorsecret',
  'twofactorpendingsecret', 'otp', 'code', 'token', 'authorization',
  'cookie', 'csrftoken', 'accesstoken', 'refreshtoken', 'recoverytoken',
  'ciphertext', 'nonce', 'digest', 'sessiontokenhashsecret',
]);

export const normalizeAuditMetadataKey = (key: string) =>
  key.replace(/[^a-z0-9]/gi, '').toLowerCase();

export const isSensitiveAuditMetadataKey = (key: string) => {
  const normalized = normalizeAuditMetadataKey(key);
  return EXACT_SENSITIVE_AUDIT_KEYS.has(normalized)
    || /(token|password|secret|apikey|authorization|cookie|ciphertext|otp|csrf|nonce|digest)/i.test(normalized);
};
```

Replace sensitive values with `ADMIN_AUDIT_REDACTION`. Keep the existing depth/entry/string limits and verify negative PIN-like keys remain visible.

- [ ] **Step 4: Add injectable writer dependencies without changing runtime admission**

Define:

```ts
export type AdminAuditWriterDependencies = {
  findActor(id: string): Promise<{ _id: unknown; name?: string; email: string; role: string } | null>;
  createAuditLog(document: Record<string, unknown>): Promise<unknown>;
};
```

Use real Mongoose defaults internally, then accept `dependencies: AdminAuditWriterDependencies = defaultAdminAuditWriterDependencies` as the third `recordAdminAuditLog` argument. Preserve `shouldAuditRequest`, login exclusions, trusted correlation/IP resolution, authenticated owner/admin/CS admission, and the catch/log/no-throw behavior.

- [ ] **Step 5: Run focused GREEN verification**

Run:

```bash
npm --prefix server run build
node --test server/dist/services/adminAuditService.test.js
node --import tsx --test tools/dev-verification/unit/staffLoginSeparation.test.ts
git diff --check
```

Expected: all new tests pass and build output contains no sensitive fixture value.

- [ ] **Step 6: Commit Task 1**

```bash
git add -f server/src/services/adminAuditService.test.ts
git add server/src/services/adminAuditService.ts tools/dev-verification/unit/staffLoginSeparation.test.ts
git commit -m "fix: redact audit credentials before persistence"
```

---

### Task 2: Sanitize Rust disclosures and make export truncation observable

**Files:**
- Create: `rust-api/src/routes/audit_logs/sanitize.rs`
- Modify: `rust-api/src/routes/audit_logs.rs`
- Modify: `rust-api/src/routes/audit_logs/mappers.rs`
- Modify: `rust-api/src/routes/audit_logs/export.rs`
- Modify: `rust-api/src/routes/audit_logs/types.rs`

**Interfaces:**
- Produces: `pub const AUDIT_REDACTION: &str = "[redacted]"`.
- Produces: `pub fn sanitize_audit_document(document: &Document) -> Document`.
- Produces: `pub fn sanitize_audit_bson(value: &Bson, depth: usize) -> Bson`.
- Changes: `csv_response(items: &[Document], truncated: bool) -> Response`.
- Preserves: list requires `viewTeam`; export requires `manageTeam` and trusted `exports.sensitive` step-up.

- [ ] **Step 1: Write failing Rust sanitizer, mapper, and CSV tests**

Add `#[cfg(test)]` cases in `sanitize.rs`, `mappers.rs`, and `export.rs` that construct BSON entirely in memory:

```rust
#[test]
fn disclosure_sanitizer_redacts_pin_aliases_without_false_positives() {
    let input = doc! {
        "pin": "fixture-value",
        "Merchant-PIN": "fixture-value",
        "shipping": "visible",
        "nested": [{ "api_key": "fixture-value", "mapping": "visible" }],
    };
    let output = sanitize_audit_document(&input);
    assert_eq!(output.get_str("pin").unwrap(), AUDIT_REDACTION);
    assert_eq!(output.get_str("Merchant-PIN").unwrap(), AUDIT_REDACTION);
    assert_eq!(output.get_str("shipping").unwrap(), "visible");
}
```

Add parity cases for the complete exact-key set, depth 8, array 50, object 100, string 500, and negative keys. Add cases proving non-sensitive BSON scalar types such as `DateTime`, `ObjectId`, binary, booleans, integers, and null remain the same type/value. Add a mapper test proving historical raw `metadata.pin` becomes `[redacted]` in `AuditLogItem`.

Add export tests asserting:

```text
x-export-limit = 5000
x-export-truncated = false or true
```

and that CSV metadata contains `[redacted]` but not the synthetic source value. Retain formula neutralization assertions for values beginning with whitespace/control characters followed by `=`, `+`, `-`, or `@`.

- [ ] **Step 2: Run Rust RED tests**

Run:

```bash
(cd rust-api && cargo test routes::audit_logs --no-fail-fast)
```

Expected RED: `sanitize` module/functions and truncation header contract do not exist.

- [ ] **Step 3: Implement BSON disclosure sanitizer**

Create `sanitize.rs` with the same exact normalized-key policy as Task 1. Normalize keys using ASCII alphanumeric lowercase characters. Recursively transform only BSON documents and arrays, preserve every other BSON scalar type/value, cap at the approved limits, and return `[depth-limited]` at depth 8. Truncate non-sensitive strings at 500 characters with the established `...` suffix.

Register the module in `audit_logs.rs`:

```rust
mod sanitize;
```

In `mappers.rs`, replace raw metadata cloning with:

```rust
metadata: document
    .get_document("metadata")
    .ok()
    .map(sanitize_audit_document),
```

- [ ] **Step 4: Sanitize export and detect the 5,001st record**

In `export.rs`, change the response contract:

```rust
pub fn csv_response(items: &[Document], truncated: bool) -> Response
```

Sanitize each document's metadata before JSON serialization. Always set:

```rust
response_headers.insert("x-export-limit", HeaderValue::from_static("5000"));
response_headers.insert(
    "x-export-truncated",
    HeaderValue::from_static(if truncated { "true" } else { "false" }),
);
```

In `export_audit_logs`, query `AUDIT_EXPORT_LIMIT + 1`, compute `truncated = items.len() > 5000`, truncate the vector to 5,000, and pass the boolean to `csv_response`.

- [ ] **Step 5: Run focused GREEN verification**

Run:

```bash
(cd rust-api && cargo test routes::audit_logs --no-fail-fast)
(cd rust-api && cargo test security_hardening_checks --bin webtopup-rust-api --no-fail-fast)
git diff --check
```

Expected: audit sanitizer/CSV tests and existing defense-in-depth checks pass. Existing compiler warnings may remain but no new warning should be introduced by these files.

- [ ] **Step 6: Commit Task 2**

```bash
git add rust-api/src/routes/audit_logs.rs rust-api/src/routes/audit_logs/
git commit -m "fix: sanitize audit disclosures"
```

---

### Task 3: Define one fail-closed query contract in Rust and the client

**Files:**
- Create: `client/src/lib/auditLogQuery.ts`
- Create: `client/src/lib/auditLogQuery.test.ts`
- Modify: `rust-api/src/routes/audit_logs/filters.rs`
- Modify: `rust-api/src/routes/audit_logs/types.rs`
- Modify: `rust-api/src/routes/audit_logs.rs`

**Interfaces:**
- Produces the exact TypeScript types and functions approved in the spec: `AuditAction`, `AuditLogAppliedQuery`, `AuditLogFilterDraft`, `AuditQueryValidation`, `AuditDraftValidation`, `parseAuditLogSearchParams`, `serializeAuditLogQuery`, `validateAuditLogDraft`, `auditPaginationRange`, and `auditPageCorrection`.
- Changes Rust `parse_positive_i64` into a supplied-value validator returning `Result<i64, Response>`.
- Preserves client request limit at 25 and Rust maximum limit at 100.

- [ ] **Step 1: Write client query tests first**

Create `client/src/lib/auditLogQuery.test.ts` with Node tests for exact canonical behavior:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditPageCorrection,
  auditPaginationRange,
  parseAuditLogSearchParams,
  serializeAuditLogQuery,
  validateAuditLogDraft,
} from './auditLogQuery.ts';

test('audit query serializes in canonical order and omits page one', () => {
  const params = serializeAuditLogQuery({
    search: 'products', action: 'update', resource: 'Products',
    startDate: '2026-08-01', endDate: '2026-08-12', page: 1,
  });
  assert.equal(params.toString(), 'q=products&action=update&resource=Products&startDate=2026-08-01&endDate=2026-08-12');
});

test('pagination range and correction are deterministic', () => {
  assert.deepEqual(auditPaginationRange(2, 25, 237), { start: 26, end: 50 });
  assert.equal(auditPageCorrection(999, 10, 237), 10);
  assert.equal(auditPageCorrection(2, 0, 0), 1);
  assert.equal(auditPageCorrection(1, 0, 0), null);
});
```

Add invalid cases: one-character search, 121-character search, 121-character resource, unknown action, impossible date `2026-02-30`, inverted range, `Infinity`, fractions, zero, negative, and page 10,001. Add round-trip and stable ordering tests.

- [ ] **Step 2: Add Rust validation RED tests**

In `filters.rs`, add table-driven tests asserting supplied malformed action/search/resource/page/limit/date values return `400`, while absent optional values use defaults. Add a filter-shape test asserting the escaped search `$or` contains `metadata.traceId` in addition to actor/resource/path/IP fields.

Run:

```bash
node --import tsx --test client/src/lib/auditLogQuery.test.ts
(cd rust-api && cargo test routes::audit_logs::filters --no-fail-fast)
```

Expected RED: client module does not exist and Rust silently defaults/ignores invalid values.

- [ ] **Step 3: Implement the pure client query module**

Use exact calendar validation rather than regex alone: parse `YYYY-MM-DD`, reconstruct UTC year/month/day, and reject normalization to another date. Return canonical query strings and field-specific Indonesian messages. Do not read React state, location, or network APIs inside this module.

Implement canonical serialization with explicit insertion order and omit empty fields plus `page=1`.

- [ ] **Step 4: Implement strict Rust query validation**

Make supplied invalid values return `BAD_REQUEST` with stable messages. Empty optional values remain absent. Apply bounds before building Mongo filters. Add `metadata.traceId` to the escaped `$or` search array.

In `audit_logs.rs`, handle page/limit validation errors before querying Mongo. Preserve WIB boundaries and reversed-range rejection.

- [ ] **Step 5: Run focused GREEN verification**

Run:

```bash
node --import tsx --test client/src/lib/auditLogQuery.test.ts
(cd rust-api && cargo test routes::audit_logs::filters --no-fail-fast)
npm --prefix client run build
git diff --check
```

Expected: pure query and Rust filter tests pass; client build remains green.

- [ ] **Step 6: Commit Task 3**

```bash
git add client/src/lib/auditLogQuery.ts client/src/lib/auditLogQuery.test.ts rust-api/src/routes/audit_logs.rs rust-api/src/routes/audit_logs/filters.rs rust-api/src/routes/audit_logs/types.rs
git commit -m "feat: define audit query contract"
```

---

### Task 4: Add a guarded, idempotent historical secret scrubber

**Files:**
- Create: `scripts/security/audit-secret-policy.js`
- Create: `scripts/security/scrub-admin-audit-secrets.js`
- Create: `scripts/security/scrub-admin-audit-secrets.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `normalizeAuditSecretKey`, `isSensitiveAuditSecretKey`, and `redactAuditMetadata(value)` from `audit-secret-policy.js`.
- Produces CLI flags: `--mongo-uri`, `--database`, `--apply`, `--allow-protected-database`, and `--confirm-database`.
- Produces one aggregate JSON object with `database`, `collection`, `scannedDocuments`, `affectedDocuments`, `affectedFields`, `modifiedDocuments`, and `applied`.

- [ ] **Step 1: Write failing pure policy and CLI guard tests**

Create tests that invoke exported parsing/policy functions directly and spawn the CLI only for argument-guard behavior. Cases must prove:

- no arguments fail without printing environment or URI values;
- dry-run is default;
- `--apply --database webtopup_task14_dev` is permitted by guard logic;
- apply against another database fails unless both protected flags match exactly;
- a mismatched confirmation fails;
- output object contains only approved aggregate keys;
- PIN aliases redact and negative keys remain unchanged;
- non-sensitive strings longer than 500 characters, arrays longer than 50 entries, objects with more than 100 keys, and nesting deeper than 8 are preserved byte-for-byte/value-for-value by the scrubber;
- non-sensitive BSON scalar types remain unchanged;
- applying the transform twice reports no newly affected fields.

Use a fake URI string only in child input and assert it does not appear in stdout/stderr.

- [ ] **Step 2: Run RED scrubber tests**

Run:

```bash
node --test scripts/security/scrub-admin-audit-secrets.test.js
```

Expected RED: files and exports do not exist.

- [ ] **Step 3: Implement the shared script policy**

Implement normalized exact-key and narrow fallback behavior identical to Node/Rust. `redactAuditMetadata(value)` returns:

```js
{
  value: sanitizedValue,
  affectedFields: number
}
```

It must recurse through the complete arrays and plain/BSON documents without applying runtime truncation limits; preserve non-sensitive strings, every array entry, every object key, arbitrary stored BSON nesting, and non-plain BSON scalar instances such as `Date`, `ObjectId`, binary, decimal, booleans, numbers, and null; replace only values whose key is sensitive; detect/reject cyclic in-memory inputs without partial transformation; and treat an existing `[redacted]` as already clean so a second run has zero affected fields.

- [ ] **Step 4: Implement guarded Mongo scanning and targeted updates**

Parse arguments without logging raw argv. Connect with the supplied URI, select exact database and `adminauditlogs`, iterate documents with metadata, transform metadata, and update only changed documents using `_id` plus current metadata equality as a conservative fence. Dry-run calculates counts but performs no update.

On success print exactly one JSON line. On error print a fixed non-secret message and exit nonzero. Always close the client in `finally`.

- [ ] **Step 5: Run unit and disposable scrubber verification**

First run pure tests:

```bash
node --test scripts/security/scrub-admin-audit-secrets.test.js
```

When disposable Mongo is running, insert one tagged raw audit fixture containing synthetic values, then run:

```bash
node scripts/security/scrub-admin-audit-secrets.js --mongo-uri "$DISPOSABLE_MONGO_URI" --database webtopup_task14_dev
node scripts/security/scrub-admin-audit-secrets.js --mongo-uri "$DISPOSABLE_MONGO_URI" --database webtopup_task14_dev --apply
node scripts/security/scrub-admin-audit-secrets.js --mongo-uri "$DISPOSABLE_MONGO_URI" --database webtopup_task14_dev --apply
```

Expected aggregate sequence: dry-run affected > 0 and modified 0; first apply modified > 0; second apply affected/modified 0. Remove the tagged fixture afterward. Never echo `$DISPOSABLE_MONGO_URI`.

- [ ] **Step 6: Add audit pure tests to the canonical unit command**

Change root `package.json` only after both new pure test files exist:

```json
"test:dev-verify:unit": "node --import tsx --test tools/dev-verification/unit/*.test.ts client/src/lib/auditLogQuery.test.ts && node --test scripts/security/*.test.js"
```

Run:

```bash
npm run test:dev-verify:unit
git diff --check
```

Expected: verification-unit, pure client query, and scrubber tests all pass in one canonical command.

- [ ] **Step 7: Commit Task 4**

```bash
git add package.json scripts/security/audit-secret-policy.js scripts/security/scrub-admin-audit-secrets.js scripts/security/scrub-admin-audit-secrets.test.js
git commit -m "feat: add guarded audit secret scrubber"
```

---

### Task 5: Extract an accessible audit-detail dialog

**Files:**
- Create: `client/src/components/admin/AuditLogDetailDialog.tsx`
- Modify: `client/src/pages/admin/AuditLogs.tsx`
- Create: `tools/dev-verification/e2e/audit-logs.spec.ts`
- Modify: `tools/dev-verification/unit/adminPageChrome.test.ts`

**Interfaces:**
- Produces exported `AuditLogItem`, `AuditLogMetadata`, and `AuditLogSource` client types in the dialog file or a focused sibling type export.
- Produces `AuditLogDetailDialogProps = { item: AuditLogItem; trigger: HTMLElement | null; onClose(): void }`.
- Consumes only metadata already sanitized by Rust.
- Produces source mapping `node_gateway → Gateway`, `rust_domain → Domain`, unknown/absent → `Tidak diketahui`.

- [ ] **Step 1: Write failing source and browser dialog tests**

In `tools/dev-verification/unit/adminPageChrome.test.ts`, add assertions that `AuditLogs.tsx` imports `AuditLogDetailDialog` and that the component source contains `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-describedby`, `tabIndex={-1}`, Escape handling, backdrop-target equality, focus restoration, `100dvh`, and a polite copy live region.

Create `tools/dev-verification/e2e/audit-logs.spec.ts`. Use the existing `team-access-viewer-desktop` or `team-access-viewer-mobile` fixture, insert one uniquely tagged sanitized audit row directly into marked disposable Mongo, log in through `/staff/login`, open `/admin/audit-logs`, and assert:

- Detail moves focus inside the dialog;
- Tab and Shift+Tab remain inside;
- Escape closes and restores the exact trigger;
- reopening then backdrop close restores the trigger;
- reopening then close-button close restores the trigger;
- copy endpoint announces success without echoing the endpoint in the announcement;
- `[redacted]` explanation is visible;
- the final advanced section and close button are reachable at mobile portrait and landscape dimensions.

Delete only the tagged row and fixture sessions in `finally`, after proving the exact verification database marker.

Run the source test and then, with the canonical disposable `infra-up → db-bootstrap → db-seed → host-up-session` lifecycle, run the browser spec in desktop. Expected RED: component/import is absent and the current inline modal does not satisfy focus/Escape/restoration behavior. Run `host-down → db-reset → infra-down` even after RED.

- [ ] **Step 2: Create the focused dialog component**

Follow `TeamAccessDialog.tsx` behavior exactly for initial focus, Tab/Shift+Tab wrapping, Escape, backdrop close, and connected-trigger restoration. Lock background scrolling during mount and restore the prior body style during cleanup.

Use a flex-column panel with dynamic viewport sizing:

```tsx
className="ui-panel ui-border flex max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border outline-none sm:max-h-[calc(100dvh-3rem)]"
```

Render core values with `<dl>`. Render Params and Body separately. Compute advanced metadata by removing `params` and `body`; keep it collapsed in `<details>`. Explain `[redacted]` in visible copy.

- [ ] **Step 3: Implement sanitized copy actions**

Provide a local `copyValue(label, value)` function using `navigator.clipboard.writeText`. Only enable a copy button when a sanitized value exists. Announce:

```text
<label> berhasil disalin.
<label> gagal disalin.
```

through a `role="status" aria-live="polite"` region. Do not include copied data in the announcement.

- [ ] **Step 4: Replace the inline modal in `AuditLogs.tsx`**

Store both selected item and its exact trigger:

```ts
const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null);
const [detailTrigger, setDetailTrigger] = useState<HTMLElement | null>(null);
```

On Detail click capture `event.currentTarget`, and render the new component. Remove duplicated inline dialog implementation and metadata helper code from the page.

- [ ] **Step 5: Run focused GREEN verification**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
npm --prefix client run build
```

Then prepare, reset, and tear down the disposable stack explicitly:

```bash
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.config.ts audit-logs.spec.ts --project=chromium-desktop --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.config.ts audit-logs.spec.ts --project=chromium-mobile --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- infra-down
npm run dev-verify -- infra-status
```

Run cleanup commands even if a Playwright command fails. Expected: source contract, both behavior projects, and client build pass; final service count is zero.

- [ ] **Step 6: Commit Task 5**

```bash
git add client/src/components/admin/AuditLogDetailDialog.tsx client/src/pages/admin/AuditLogs.tsx tools/dev-verification/e2e/audit-logs.spec.ts tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "feat: add accessible audit detail dialog"
```

---

### Task 6: Rebuild the audit page around applied URL state

**Files:**
- Modify: `client/src/pages/admin/AuditLogs.tsx`
- Modify: `tools/dev-verification/e2e/audit-logs.spec.ts`
- Modify: `tools/dev-verification/unit/adminPageChrome.test.ts`
- Consume: `client/src/lib/auditLogQuery.ts`
- Consume: `client/src/components/admin/AuditLogDetailDialog.tsx`

**Interfaces:**
- Applied query is parsed only from `useSearchParams()`.
- Draft type is `AuditLogFilterDraft`.
- List request uses `{ page, limit: 25, search, action, resource, startDate, endDate }` derived from the applied query.
- Result state distinguishes `initial-loading`, `ready`, `initial-error`, `refreshing`, and `refresh-error`.
- Export reads `x-export-truncated` and uses applied filters only.

- [ ] **Step 1: Extend failing source and browser tests for explicit-apply architecture**

In `tools/dev-verification/unit/adminPageChrome.test.ts`, assert that the page imports `parseAuditLogSearchParams`, `serializeAuditLogQuery`, `validateAuditLogDraft`, `auditPaginationRange`, and `auditPageCorrection`; renders visible labels; includes `aria-busy`, status/alert regions, retry/reset actions, pagination nav, persistent export explanation, and does not use placeholder text as the only label.

Extend `tools/dev-verification/e2e/audit-logs.spec.ts` with tagged audit fixtures and response/request counters proving:

- typing and changing selects/dates sends zero list requests;
- Apply, Reset, pagination, retry, and refresh each send exactly one list request;
- applied canonical URL, deep-link hydration, and Back/Forward behavior;
- invalid date association and no broad fetch;
- initial loading/status, initial error/retry, refresh-error stale-data banner, global empty, filtered empty, range copy, and out-of-range correction;
- disabled export plus persistent explanation for the viewer;
- Gateway/Domain source badges and trace details.

Use route interception only for deterministic latency/error states, never to replace authorization responses. Run source and desktop browser tests and observe RED before implementation.

- [ ] **Step 2: Implement applied-query and draft synchronization**

Parse `searchParams` with the pure helper. Initialize and rehydrate draft from each valid applied query. Use a stable canonical query string as the list-fetch dependency. Applying the form pushes a URL with page 1. Reset pushes an empty query. Canonical cleanup replaces the URL.

Do not keep independent applied filter state in addition to the URL. Do not include draft fields in the fetch callback dependency list.

- [ ] **Step 3: Implement one-request fetch lifecycle**

Use request IDs or `AbortController` so only the current request commits. Track whether rows belong to the same applied canonical query. On a new query, clear old rows before loading; on same-query refresh, retain rows and show refreshing status. On failure, apply the initial versus refresh error contracts from the spec.

The `admin:refresh-current-page` event must call one same-query refresh and must not alter URL/draft.

- [ ] **Step 4: Implement structured filter and result layout**

Render persistent labels and associated validation. Show source badge from sanitized `metadata.auditSource`. Show global-empty versus filtered-empty copy. Retain total/page/limit and show the exact range. Use:

```tsx
<nav aria-label="Pagination log audit">
```

Show **Ke halaman** only above 10 total pages. Correct out-of-range pages through `auditPageCorrection` with one replace and one corrective fetch. Focus the result heading after successful page navigation.

- [ ] **Step 5: Implement export eligibility and truncation feedback**

Keep the disabled export button for a `viewTeam` user without `manageTeam`, plus persistent explanation. Show the static 5,000-row warning only to eligible users. Validate the applied query before export, invoke the existing shared step-up orchestrator, and read:

```ts
const truncated = response.headers['x-export-truncated'] === 'true';
```

Announce successful download or truncation without revealing file content. Preserve step-up cancellation and JSON blob error handling.

- [ ] **Step 6: Run focused GREEN verification**

Run:

```bash
node --import tsx --test client/src/lib/auditLogQuery.test.ts tools/dev-verification/unit/adminPageChrome.test.ts
npm --prefix client run build
npm run test:dev-verify:unit
```

Then run both audit Playwright projects with this explicit disposable lifecycle:

```bash
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.config.ts audit-logs.spec.ts --project=chromium-desktop --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.config.ts audit-logs.spec.ts --project=chromium-mobile --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- infra-down
npm run dev-verify -- infra-status
git diff --check
```

Run cleanup even on failure. Expected: query/source/unit tests, page behavior, dialog behavior, and client build pass; final service count is zero.

- [ ] **Step 7: Commit Task 6**

```bash
git add client/src/pages/admin/AuditLogs.tsx tools/dev-verification/e2e/audit-logs.spec.ts tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "feat: structure audit investigation flow"
```

---

### Task 7: Add marked audit fixtures and real-session integration coverage

**Files:**
- Modify: `tools/dev-verification/seed.ts`
- Modify: `tools/dev-verification/unit/seed.test.ts`
- Create: `tools/dev-verification/integration/auditLogs.test.ts`
- Reuse: `tools/dev-verification/e2e/fixtures.ts`

**Interfaces:**
- Reuses existing browser/read fixtures `team-access-viewer-desktop` and `team-access-viewer-mobile`, which already have `viewTeam` without `manageTeam`.
- Adds only fixture aliases `audit-denied` and `audit-manager`.
- `audit-manager` is an admin with `viewTeam`, `manageTeam`, and `manageProducts`, and with 2FA enabled so `fixtureOtp('audit-manager')` works.
- Integration runs under Playwright's desktop project so browser cookies, CSRF, refresh session, and real step-up remain authoritative.

- [ ] **Step 1: Write failing fixture-contract tests**

Extend `tools/dev-verification/unit/seed.test.ts`:

```ts
assert.ok(definitions.some((item) => item.alias === 'audit-denied'
  && item.permissions?.viewTeam !== true));
assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-desktop'
  && item.permissions?.viewTeam === true
  && item.permissions?.manageTeam !== true));
assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-mobile'
  && item.permissions?.viewTeam === true
  && item.permissions?.manageTeam !== true));
assert.ok(definitions.some((item) => item.alias === 'audit-manager'
  && item.role === 'admin'
  && item.twoFactorEnabled === true
  && item.permissions?.manageTeam === true
  && item.permissions?.manageProducts === true));
```

Run:

```bash
node --import tsx --test tools/dev-verification/unit/seed.test.ts
```

Expected RED: aliases are absent.

- [ ] **Step 2: Add marked fixture definitions**

Add only `audit-denied` and `audit-manager` to `fixtureDefinitions`; reuse the two existing team-access viewers. Do not add credentials or TOTP secrets to `PublicFixture`. Rely on the existing private password selection and synthetic TOTP generation for admin fixtures.

- [ ] **Step 3: Write the integration test before matrix registration**

Create `tools/dev-verification/integration/auditLogs.test.ts` with `@playwright/test`, `MongoClient`, `loginFixture`, and `fixtureOtp`. Use browser login paths and the real client `apiV2` module inside `page.evaluate`.

Test phases:

1. Assert `LOCAL_DEV_VERIFICATION=true`, exact database `webtopup_task14_dev`, replica set, and one database marker.
2. Anonymous list returns `401`.
3. Log in as `audit-denied`; list returns `403 PERMISSION_DENIED`.
4. Log in as `team-access-viewer-desktop`; list returns `200`; export returns `403 PERMISSION_DENIED` before step-up.
5. Log in as `audit-manager` with real OTP; export without grant returns `AUTH_STEP_UP_REQUIRED` for `exports.sensitive`.
6. Request a real grant through `/auth/step-up` with fixture password and current fixture OTP, then send the returned grant through `x-step-up-token`; export returns `200`.
7. Through the same manager session, submit an invalid catalog category mutation containing a unique `verificationMarker`, `pin`, nested `merchant_pin`, and non-sensitive `shipping`. Permission passes, Rust validation returns `400`, no category is created, and Node `onResponse` writes one gateway audit row.
8. Poll `adminauditlogs` by actor, path, created-at floor, and marker. Assert stored audit metadata contains `[redacted]`, preserves `shipping`, records status 400, and never serialize/print the source values.
9. Insert tagged historical raw audit rows directly into disposable `adminauditlogs` for filters, exact WIB boundaries, pagination, gateway/domain same trace, and CSV formula defense.
10. Assert list JSON redacts historical PIN, filters action/resource/search/trace/date exactly, returns descending order and correct pagination.
11. With the real grant, assert export content type, disposition, BOM, 13 columns, redacted metadata, formula neutralization, and truncation headers.
12. Run scrubber dry-run/apply/apply using `spawn` with argv arrays and captured aggregate JSON; assert no URI/source secret appears in output.

Use fixed assertion labels and only compare booleans/counts for secrecy checks.

- [ ] **Step 4: Implement cleanup fencing in the integration test**

In `finally`:

- delete only `adminauditlogs` with the unique test marker or the gateway row identified by exact actor/path/time/marker;
- delete `authsessions` only for the marked denied, viewer, and manager fixture user IDs;
- remove any tagged disposable category if an unexpected implementation bug created it;
- restore no shared settings because the test never writes integration settings;
- close Mongo and browser contexts;
- aggregate primary and cleanup errors.

Before cleanup, require the exact database marker; if marker proof is absent, do not mutate and fail closed.

- [ ] **Step 5: Run focused integration RED/GREEN under disposable infrastructure**

Start infrastructure, marked database, fixtures, and the approved session profile as separate canonical lifecycle steps:

```bash
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.integration.config.ts auditLogs.test.ts --project=chromium-desktop --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- infra-down
npm run dev-verify -- infra-status
```

Run cleanup commands in a shell trap or manually even when the test fails. Expected: test passes; `db-reset` removes marked fixtures; final `infra-status` reports zero disposable services. These are internal disposable-harness commands and must never target production systemd units.

- [ ] **Step 6: Commit Task 7**

```bash
git add tools/dev-verification/seed.ts tools/dev-verification/unit/seed.test.ts tools/dev-verification/integration/auditLogs.test.ts
git commit -m "test: verify audit security boundaries"
```

---

### Task 8: Add desktop/mobile browser behavior and mandatory matrix gates

**Files:**
- Modify: `tools/dev-verification/e2e/audit-logs.spec.ts`
- Modify: `tools/dev-verification/verificationMatrix.ts`
- Modify: `tools/dev-verification/unit/verificationMatrix.test.ts`

**Interfaces:**
- Adds required isolated checks `audit-logs-integration`, `audit-logs-desktop`, and `audit-logs-mobile`.
- All three use `session-cs`, which provides the real staff session/2FA contract; integration uses the integration Playwright config and browser checks use the standard config.
- Each browser project has a read-only viewer case and an export-eligible manager case. The manager case proves the real step-up dialog opens for `exports.sensitive`; successful granted CSV export remains the integration test's responsibility.

- [ ] **Step 1: Register missing matrix checks first and observe RED**

Extend the matrix unit contract to require:

```ts
for (const name of [
  'audit-logs-integration',
  'audit-logs-desktop',
  'audit-logs-mobile',
]) {
  const candidate = matrix.find(({ name: current }) => current === name);
  assert.equal(candidate?.profile, 'session-cs');
  assert.equal(candidate?.isolated, true);
}
```

Run:

```bash
node --import tsx --test tools/dev-verification/unit/verificationMatrix.test.ts
```

Expected RED: checks are absent.

- [ ] **Step 2: Register exact isolated commands**

Add:

```ts
check('audit-logs-integration', 'session-cs', 'npx', [
  'playwright', 'test', '--config',
  'tools/dev-verification/playwright.integration.config.ts',
  'auditLogs.test.ts', '--project=chromium-desktop', '--workers=1',
], true)
```

Add desktop/mobile `audit-logs.spec.ts` checks using the standard Playwright config and one worker.

- [ ] **Step 3: Complete the desktop/mobile Playwright spec**

Use `team-access-viewer-desktop` or `team-access-viewer-mobile` based on project for the main read-only case. Log in through `/staff/login`. Consolidate and complete the RED/GREEN coverage created in Tasks 5 and 6. Verify:

- route loads and visible labels are present;
- export is disabled with persistent permission explanation;
- typing/editing draft controls creates no `/api/v2/audit-logs` request;
- **Terapkan filter** creates exactly one list request and canonical URL;
- **Reset** creates exactly one request and page 1;
- deep link hydration and browser Back/Forward restore controls/results;
- invalid date has `aria-invalid`, associated error, and no broad fetch;
- loading/result status and range text are announced;
- global and filtered empty states use distinct copy;
- refresh failure explicitly labels prior rows as previous data and **Coba lagi** issues one request;
- out-of-range URL corrects once and never shows a contradictory page label;
- Gateway/Domain badges and trace ID appear for tagged rows;
- opening Detail places focus inside the dialog;
- Tab and Shift+Tab remain in the dialog;
- Escape, backdrop, and close button each close and restore the exact trigger;
- copy action produces a live success announcement without showing copied content;
- `[redacted]` explanation is visible;
- mobile portrait and landscape can reach the final advanced metadata section and close button without horizontal page overflow.

Add a second test in each project using `audit-manager`: log in through the real staff 2FA flow with `fixtureOtp('audit-manager')`, open `/admin/audit-logs`, verify Export CSV is enabled, click it, observe the gateway's exact `403 AUTH_STEP_UP_REQUIRED` response for `exports.sensitive`, verify the shared `Verifikasi ulang diperlukan` dialog describes sensitive export, then cancel and verify no download occurred. Do not fabricate a grant or trusted group in this browser test; Task 7 proves successful granted export.

Seed tagged audit rows through Mongo at test start and delete them in `finally`. Use separate BrowserContexts/tests for viewer and manager identities so cookies/sessions never cross actors. Use route interception only to create deterministic error/loading states; do not bypass authorization responses for the security assertions.

- [ ] **Step 4: Run browser checks in both projects**

Prepare the disposable stack with this complete lifecycle, stopping any prior host first:

```bash
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.config.ts audit-logs.spec.ts --project=chromium-desktop --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.config.ts audit-logs.spec.ts --project=chromium-mobile --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- infra-down
npm run dev-verify -- infra-status
```

Run cleanup even on failure. Reseed between projects so desktop cleanup cannot influence mobile evidence. If Chromium requires the existing extracted-library wrapper, use the already approved `/tmp` library path without installing OS packages.

- [ ] **Step 5: Run matrix contract and Commit Task 8**

Run:

```bash
npm run test:dev-verify:unit
git diff --check
```

Commit:

```bash
git add tools/dev-verification/e2e/audit-logs.spec.ts tools/dev-verification/verificationMatrix.ts tools/dev-verification/unit/verificationMatrix.test.ts
git commit -m "test: gate audit investigation flow"
```

---

### Task 9: Correct smoke boundaries and complete release-grade verification

**Files:**
- Modify: `scripts/smoke/api-v2-mutation-smoke.js`
- Modify: `tools/dev-verification/unit/staffLoginSeparation.test.ts` if the legacy closure assertion was not completed in Task 1
- Review only: all files changed in Tasks 1–8

**Interfaces:**
- Smoke without a valid grant expects `AUTH_STEP_UP_REQUIRED` for export.
- Invalid export query returns `400` only in the real-grant disposable integration from Task 7.
- Legacy Node audit routes remain unregistered.

- [ ] **Step 1: Write/update the failing smoke/source contracts**

Change the mutation smoke assertion for:

```text
GET /api/v2/audit-logs/export?endDate=bad-date
```

Without step-up, expect `403` and error code `AUTH_STEP_UP_REQUIRED` with action group `exports.sensitive`; do not expect Rust's `400` from an unreachable boundary.

Add/retain a source contract proving `server/src/app.ts` does not import or register `adminAuditRoutes`, and that active `/api/v2/audit-logs/export` registration includes `authenticate`, `hasPermission('manageTeam')`, and `requireStepUp('exports.sensitive')` in that order.

- [ ] **Step 2: Run focused smoke/source verification**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/staffLoginSeparation.test.ts
npm --prefix server run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js
git diff --check
```

Expected: closure and active-route security contracts pass.

- [ ] **Step 3: Run the complete non-disposable regression suite**

Run exactly:

```bash
npm run test:dev-verify:unit
npm run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js server/dist/services/adminAuditService.test.js
(cd rust-api && cargo test --bin webtopup-rust-api --no-fail-fast)
(cd rust-api && cargo test --lib --no-fail-fast)
(cd server && npm run test:security)
npm run test:provider-sandbox
git diff --check
```

Record pass counts and any pre-existing Rust warnings. Do not claim `cargo fmt --check` ran.

- [ ] **Step 4: Run focused disposable audit verification**

Run audit integration and both browser projects through their registered matrix commands. Confirm:

- source credentials never appear in logs/reports;
- only `webtopup_task14_dev` was mutated;
- audit fixture/session cleanup succeeds;
- scrubber second apply is idempotent;
- no successful financial mutation occurred.

- [ ] **Step 5: Run the complete disposable matrix and stopped-state checks**

Use the repository's canonical lifecycle:

```bash
npm run dev-verify -- infra-up
npm run dev-verify -- test
npm run dev-verify -- infra-down
npm run dev-verify -- status
npm run dev-verify -- infra-status
```

Expected final evidence:

```text
LOCAL DEV VERIFIED
```

and afterward:

```text
processes: []
composeServices: []
serviceCount: 0
```

If the CLI exposes equivalent named lifecycle commands rather than these aliases, use the commands documented by `tools/dev-verification/README.md`; do not start production systemd units.

- [ ] **Step 6: Request a fresh read-only review and resolve findings**

Request independent read-only reviews of:

1. Node/Rust secret handling and authorization;
2. scrubber safety/idempotency/output secrecy;
3. client URL/filter/dialog accessibility;
4. disposable fixtures, cleanup, and matrix isolation.

Fix every confirmed Critical or Important finding with a new failing test before implementation. Re-run affected focused and full verification. Treat stalled reviewers as no signoff.

- [ ] **Step 7: Commit Task 9 final corrections**

```bash
git add scripts/smoke/api-v2-mutation-smoke.js tools/dev-verification/unit/staffLoginSeparation.test.ts
git commit -m "fix: align audit verification boundaries"
```

If review fixes touched other files, stage only reviewed Task 9 changes and use a commit message describing the actual correction.

- [ ] **Step 8: Report completion without production action**

Report:

- commits created;
- changed files by subsystem;
- test/build/matrix evidence and pass counts;
- scrubber tested only on `webtopup_task14_dev`;
- residual regex-scan, retention, dual-writer, and legacy-route debt;
- `rustfmt` limitation;
- clean working tree and zero disposable services;
- explicit statement that no production scrub, deploy, restart, push, or production data mutation occurred.

Do not run production dry-run or apply. Ask for a separate explicit decision before any production action.
