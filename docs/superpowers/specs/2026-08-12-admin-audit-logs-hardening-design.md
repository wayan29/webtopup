# Admin Audit Logs Security and Investigation UX Design

**Date:** 2026-08-12
**Status:** Approved for implementation planning
**Scope:** Security hardening and investigation UX for `/admin/audit-logs`, including a dry-run-first historical secret scrubber

## Goal

Make `/admin/audit-logs` a secure, deterministic, accessible investigation surface while preserving the existing Node gateway and Rust defense-in-depth authorization model. The implementation must prevent new credentials from entering audit metadata, prevent historical credentials from leaving the API or CSV export, provide an explicit and testable workflow for scrubbing historical records, and improve filtering, navigation, detail inspection, and error states without weakening authentication, permissions, step-up, CSRF, trusted proxy, rate-limit, or production controls.

## Approved product decisions

The following decisions are fixed for this design:

- Implement the complete security and UX scope, not only a minimal sanitizer patch.
- Add a historical audit-secret scrubber. It is dry-run by default, mutates only with an explicit apply flag, and is tested only against `webtopup_task14_dev`.
- Use explicit filter application. Editing a field does not fetch; **Terapkan filter** or Enter applies the draft once.
- Keep the export button visible but disabled for a viewer without `manageTeam`, with persistent explanatory text rather than a tooltip-only explanation.
- A user with `viewTeam` may inspect all audit metadata returned by the API after mandatory defense-in-depth sanitization. Export remains restricted to `manageTeam` plus `exports.sensitive` step-up.
- Use the structured investigation-panel layout with persistent labels and a clearly separated results section.
- Preserve gateway and domain audit events as separate rows. Do not deduplicate them. Show their source and correlation fields so an operator can relate them.
- Do not add TTL retention, a new search engine, SIEM integration, WORM storage, or production scrub execution in this scope.

## Current architecture and verified constraints

### Active request path

The active audit read and export path is:

```text
React `/admin/audit-logs`
  → Node `/api/v2/audit-logs*`
  → authentication and gateway authorization
  → trusted proxy context
  → Rust `/v2/audit-logs*`
  → database-backed authorization
  → MongoDB `adminauditlogs`
```

The active authorization contract is:

| Operation | Client route eligibility | Node gateway | Rust | Step-up |
|---|---|---|---|---|
| List and inspect sanitized metadata | `viewTeam` | `viewTeam` | `viewTeam` | None |
| Export CSV | Button eligibility from `manageTeam` | `manageTeam` | `manageTeam` | `exports.sensitive` at Node and Rust |

The client is explanatory only. Node and Rust remain authoritative. A direct untrusted request to Rust must continue to fail.

### Active audit writers

Node registers `recordAdminAuditLog` in the global `onResponse` hook. It records authenticated owner/admin/CS write requests after the response completes. The record includes the actor, action, resource, method, path, status, IP, user agent, summary, request params/body, and trusted correlation data. Login and registration credential routes are excluded.

Some Rust domains also write domain-level records into the same collection. These records may coexist with the Node gateway record for one mutation. That is an intentional two-event representation:

- the gateway row proves the HTTP mutation attempt and result;
- the domain row describes a domain-specific state change.

The UI must not hide either record. When available, `traceId` links them.

### Confirmed security issue

The Node sanitizer currently redacts common passwords, tokens, secrets, API keys, OTP values, cookies, and related values, but it does not recognize the IRS Seller `pin` field. A successful authenticated settings write can therefore persist plaintext `metadata.body.pin`. List access currently returns stored metadata to a `viewTeam` user, so preventing only future writes is insufficient. Runtime reads and exports must sanitize historical metadata before disclosure.

### Existing positive controls

The implementation must preserve these controls:

- list authorization is independently checked at Node and Rust;
- export requires `manageTeam` and trusted `exports.sensitive` step-up at both layers;
- Rust escapes free-text regex input;
- Rust date filters use WIB day boundaries and reject malformed or inverted ranges;
- CSV values are quoted and spreadsheet formulas beginning with `=`, `+`, `-`, or `@`, including after leading whitespace/control characters, are neutralized;
- export currently has a 5,000-row cap;
- client request IDs prevent an older response from replacing a newer result;
- audit-writer failure is logged but does not convert an otherwise successful business operation into a failure.

## Design

### 1. Three-layer secret protection

Audit metadata is protected before storage, during every disclosure, and through an explicit historical cleanup tool.

#### Layer A: sanitize before Node persistence

`server/src/services/adminAuditService.ts` remains the generic gateway writer. Before any `params` or `body` value reaches `AdminAuditLog.create`, it passes through one canonical recursive Node sanitizer.

The sanitizer must:

- normalize a key by removing non-alphanumeric characters and converting to lowercase;
- redact only a reviewed exact-key set and narrowly reviewed credential patterns;
- recurse through objects and arrays;
- cap recursion depth at 8;
- cap arrays at 50 entries;
- cap object processing at 100 entries per object;
- truncate non-sensitive strings after 500 characters;
- replace sensitive leaf values with the exact string `[redacted]`;
- never include the original sensitive value in thrown errors or logs.

The minimum normalized exact-key contract is:

```text
password
currentpassword
newpassword
confirmpassword
pin
merchantpin
transactionpin
securitypin
apikey
secret
vendorsecret
twofactorsecret
twofactorpendingsecret
otp
code
token
authorization
cookie
csrftoken
accesstoken
refreshtoken
recoverytoken
refresh_token
recovery_token
ciphertext
nonce
digest
sessiontokenhashsecret
```

Normalization means underscore, dash, spaces, punctuation, and letter case cannot bypass an exact key. For example, `merchant_pin`, `Merchant-PIN`, and `merchant pin` normalize to `merchantpin`.

The reviewed fallback credential pattern continues to cover token/password/secret/API-key/authorization/cookie/ciphertext/OTP/CSRF/nonce/digest forms. The generic substring `pin` must not be added to the fallback pattern because it would incorrectly redact ordinary keys such as `shipping`, `mapping`, `pinned`, and `opinion`. PIN protection uses exact normalized keys and explicit aliases.

Login and registration route exclusions remain mandatory. Tests must prove that staff and member login bodies can never enter the audit writer.

#### Layer B: sanitize at every Rust disclosure

Rust must treat stored `metadata` as untrusted historical content. Before metadata leaves through list JSON or CSV export, it passes through a Rust sanitizer with the same observable contract as the Node sanitizer:

```text
stored metadata
  → recursive disclosure sanitizer
  → API item or CSV metadata
```

This guarantees that a historical plaintext PIN cannot be disclosed before the scrubber is approved and run. The Rust implementation may use Rust-native BSON traversal, but parity tests must lock the same sensitive keys, normalization, limits, redaction marker, and negative examples.

The list mapper must return only sanitized metadata. CSV generation must serialize only sanitized metadata. No alternative audit list, export, or detail endpoint may return the raw `metadata` document.

Sanitization does not replace authorization: list still requires `viewTeam`; export still requires `manageTeam` and `exports.sensitive` step-up.

#### Layer C: scrub historical records explicitly

Create:

```text
scripts/security/scrub-admin-audit-secrets.js
```

The tool scans only the explicitly named MongoDB database and the `adminauditlogs` collection. It uses the same normalized sensitive-key contract and replaces only sensitive leaf values with `[redacted]`. It preserves all non-sensitive metadata and document identity.

Required command contract:

```bash
node scripts/security/scrub-admin-audit-secrets.js \
  --mongo-uri "$MONGO_URI" \
  --database webtopup_task14_dev
```

This is a dry-run. It must perform no updates.

Disposable apply mode is:

```bash
node scripts/security/scrub-admin-audit-secrets.js \
  --mongo-uri "$MONGO_URI" \
  --database webtopup_task14_dev \
  --apply
```

Safety rules are exact:

- `--mongo-uri` and `--database` are required; environment fallback is not allowed for this tool.
- The URI, credentials, raw metadata, document bodies, field values, and secret values are never printed.
- Dry-run is the default even when affected records exist.
- `--apply` is allowed without another override only for the exact disposable database `webtopup_task14_dev`.
- Applying to any other database is rejected unless both `--allow-protected-database` and `--confirm-database <exact-database-name>` are supplied.
- The implementation plan and automated verification must never use `--allow-protected-database`.
- Running against production, even in dry-run mode, is a separate operational action requiring explicit user approval. This design and its implementation do not authorize it.
- The tool uses targeted updates and reports only aggregate counts.
- Running apply a second time is idempotent and reports zero newly affected sensitive fields.

Machine-readable output contains only:

```json
{
  "database": "webtopup_task14_dev",
  "collection": "adminauditlogs",
  "scannedDocuments": 0,
  "affectedDocuments": 0,
  "affectedFields": 0,
  "modifiedDocuments": 0,
  "applied": false
}
```

No output field may contain a MongoDB URI or source value.

### 2. Fail-closed audit query contract

Create a shared pure client query model in:

```text
client/src/lib/auditLogQuery.ts
```

The client query types are:

```ts
export type AuditAction = 'create' | 'update' | 'delete' | 'execute';

export type AuditLogAppliedQuery = {
  search: string;
  action: AuditAction | '';
  resource: string;
  startDate: string;
  endDate: string;
  page: number;
};

export type AuditLogFilterDraft = Omit<AuditLogAppliedQuery, 'page'>;

export type AuditQueryValidation =
  | { ok: true; value: AuditLogAppliedQuery; canonicalQueryString: string }
  | { ok: false; message: string; field: keyof AuditLogFilterDraft | 'page' };

export type AuditDraftValidation =
  | { ok: true; value: AuditLogFilterDraft }
  | { ok: false; message: string; field: keyof AuditLogFilterDraft };
```

The module exports pure functions with stable names:

```ts
export function parseAuditLogSearchParams(params: URLSearchParams): AuditQueryValidation;
export function serializeAuditLogQuery(query: AuditLogAppliedQuery): URLSearchParams;
export function validateAuditLogDraft(draft: AuditLogFilterDraft): AuditDraftValidation;
export function auditPaginationRange(page: number, limit: number, total: number): { start: number; end: number };
export function auditPageCorrection(page: number, totalPages: number, total: number): number | null;
```

`auditPageCorrection` returns `null` when no correction is needed, the last available page when `total > 0` and the request is above range, and page 1 when `total == 0` and the requested page is not 1.

Canonical query ordering is:

```text
q → action → resource → startDate → endDate → page
```

Client and Rust validation rules are:

| Field | Contract |
|---|---|
| `q` / search | Empty or trimmed length 2–120 characters |
| `action` | Empty or exactly `create`, `update`, `delete`, `execute` |
| `resource` | Empty or trimmed length 1–120 characters |
| `startDate`, `endDate` | Empty or exact valid calendar date `YYYY-MM-DD` |
| range | When both exist, `startDate <= endDate` |
| `page` | Integer 1–10,000 |
| `limit` | Integer 1–100; client always sends 25 |

A supplied invalid action, date, range, page, limit, search, or resource returns `400` from Rust. Rust must not silently drop an invalid action or convert invalid pagination to a broader default query. Empty optional fields remain valid and are omitted from the serialized URL.

Malformed URL query state is not fetched. The client displays a validation message and offers **Reset filter**. Safe canonical differences, such as surrounding whitespace or an omitted `page=1`, are normalized with `replace` without issuing duplicate requests.

Search continues to use escaped, case-insensitive regex over the existing fields. Search length limits reduce abusive input, but they do not make the unanchored regex indexed. A new text index, Atlas Search, or mandatory date window is outside scope.

Add `metadata.traceId` to free-text search so operators can correlate gateway and domain events. The value remains regex-escaped and subject to the same 120-character search limit.

### 3. Applied URL and explicit filter flow

The applied URL is the single source of truth for fetched data. The form maintains a separate draft initialized from the applied URL.

Interaction rules:

- Typing in search, selecting an action/resource, or changing a date updates only the draft.
- Draft edits do not write the URL and do not fetch.
- Clicking **Terapkan filter** or pressing Enter validates the draft, pushes one canonical URL with `page=1`, and causes exactly one fetch.
- Clicking **Reset** clears the draft, pushes `/admin/audit-logs`, and causes exactly one fetch.
- Previous/next or **Ke halaman** changes only the applied `page`, pushes one canonical URL, and causes exactly one fetch.
- Browser Back/Forward rehydrates the visible draft from the applied URL and fetches the matching result once.
- Reloading or opening the same canonical URL produces the same visible form and request parameters.
- The `admin:refresh-current-page` event refreshes the current applied query once without changing the URL.
- Export always uses applied URL filters, never unsubmitted draft values.

Meaningful filter and page changes use browser history `push`. Canonical cleanup uses `replace`. Synchronization must not produce loops or duplicate requests.

### 4. Result state model

The page distinguishes query intent from background refresh so stale data cannot be presented as matching a failed new query.

Required states are:

1. **Initial loading**
   - No prior rows are shown.
   - The results region has `aria-busy="true"`.
   - A `role="status"` message says `Memuat log audit…`.
   - Skeletons are hidden from assistive technology and respect reduced-motion preferences.

2. **Successful result**
   - Rows, total, range, and effective page are shown.
   - A polite live region announces the displayed range and page.

3. **Background refresh**
   - Prior rows remain visible because they still represent the same applied query.
   - A status says `Memperbarui log audit…`.

4. **Initial or new-query failure**
   - Prior-query rows are not shown as results for the failed query.
   - An element with `role="alert"` reports the failure.
   - A keyboard-accessible **Coba lagi** action retries the exact applied query.

5. **Same-query refresh failure**
   - Prior rows may remain visible with the explicit banner:
     `Pembaruan gagal. Data yang ditampilkan adalah hasil sebelumnya.`
   - The banner has **Coba lagi**.

6. **Global empty**
   - Used only when no applied filter exists and total is zero.
   - Copy: `Belum ada aktivitas audit.`

7. **Filtered empty**
   - Used when any applied filter exists and total is zero.
   - Copy: `Tidak ada log yang cocok dengan filter.`
   - Includes **Reset filter**.

A request ID or abort mechanism must continue to prevent stale request completion from replacing a newer applied-query result.

### 5. Pagination contract

The client retains the complete server pagination response:

```ts
type AuditPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};
```

The Rust response should expose one canonical camel-case `totalPages` field; the redundant snake-case `total_pages` field is not required by the client and should not be introduced into new contracts. Backward-compatible retention may remain temporarily if an existing consumer requires it, but tests and UI use `totalPages`.

The UI displays:

```text
26–50 dari 237 log
Halaman 2 dari 10
```

Pagination requirements:

- controls are wrapped in `<nav aria-label="Pagination log audit">`;
- previous and next controls remain available;
- a validated **Ke halaman** control appears only when `totalPages > 10`;
- interactive targets are at least 44 CSS pixels high on narrow screens;
- changing pages places focus on the results heading after the new result arrives and announces the new range;
- page controls remain within the layout at 320 CSS pixels width.

If a valid requested page is above the available range:

- when `total > 0`, the client replaces the URL with the last page and performs one corrective fetch;
- when `total == 0`, the client replaces the URL with page 1 and does not loop;
- the UI must never show contradictory copy such as `Halaman 999 dari 4`.

### 6. Structured investigation page layout

`client/src/pages/admin/AuditLogs.tsx` becomes the orchestration page and uses the approved structured layout.

#### Header and export eligibility

The header contains:

- `Log Audit`;
- `Investigasi aktivitas dan perubahan panel admin`;
- the export action and its eligibility explanation.

An owner or staff user with `manageTeam` sees an enabled export action, subject to ordinary loading and filter validity. A `viewTeam` user without `manageTeam` sees the disabled action plus persistent text:

```text
Export CSV membutuhkan izin Kelola Tim dan verifikasi keamanan.
```

Do not rely on a disabled button's `title` attribute. The 5,000-row export warning is shown only to export-eligible users.

#### Filter panel

Each control has a persistent visible label:

- `Cari aktivitas`;
- `Aksi`;
- `Resource`;
- `Tanggal mulai`;
- `Tanggal akhir`.

The search placeholder may provide an example but is not its accessible name. Decorative icons use `aria-hidden="true"`. Invalid controls use `aria-invalid="true"` and `aria-describedby` pointing to the relevant inline validation text. Validation errors use alert semantics.

The panel ends with **Reset** and **Terapkan filter**. On mobile, controls stack without horizontal overflow.

#### Result rows

Each row shows:

- action badge;
- resource badge;
- source badge `Gateway`, `Domain`, or `Tidak diketahui`;
- method and path;
- actor identity;
- HTTP status when present;
- timestamp formatted for WIB;
- summary;
- a clearly named **Detail** action.

Source is derived from sanitized `metadata.auditSource`:

- `node_gateway` → `Gateway`;
- `rust_domain` → `Domain`;
- absent or unknown → `Tidak diketahui`.

The source badge is informational and does not alter authorization or hide records.

### 7. Accessible audit detail dialog

Move dialog behavior and presentation to:

```text
client/src/components/admin/AuditLogDetailDialog.tsx
```

The dialog consumes an already sanitized `AuditLogItem`, an `onClose` callback, and the exact trigger element used to open it. It must not fetch raw metadata separately.

Required behavior:

- `role="dialog"`;
- `aria-modal="true"`;
- stable `aria-labelledby` and `aria-describedby` references;
- `tabIndex={-1}` on a programmatically focusable dialog container;
- opening moves focus to the close button or dialog container;
- Tab and Shift+Tab wrap only through focusable elements inside the dialog;
- Escape closes;
- pointer activation on the backdrop closes;
- pointer activation inside the panel does not close;
- close button, Escape, and backdrop all restore focus to the exact connected trigger;
- body scrolling behind the dialog is prevented while open and restored on close;
- focus behavior follows the proven `TeamAccessDialog` pattern rather than inventing another incomplete modal implementation.

Mobile layout uses dynamic viewport units and safe-area-aware outer padding. The panel is a flex column with a fixed header and a `min-h-0 flex-1 overflow-y-auto` body. Close remains reachable and all metadata remains scrollable at 320 CSS pixels and in mobile landscape.

Core details use semantic `<dl>`, `<dt>`, and `<dd>` elements:

- actor name and email;
- role;
- timestamp;
- method;
- endpoint;
- status;
- IP;
- user agent;
- audit source;
- trace ID;
- correlation source.

Params and Body are separate readable JSON sections. An advanced metadata section is collapsed by default and excludes duplicate `params` and `body` keys. Missing metadata is distinguished from an empty object. The dialog explains that `[redacted]` means the original value was intentionally hidden.

Copy actions are provided for:

- endpoint;
- IP;
- user agent;
- trace ID;
- Params;
- Body;
- advanced metadata.

Copy success or failure is announced through a polite live region without moving focus. Copying uses only the sanitized value already delivered by Rust.

### 8. Export contract and truncation visibility

Export authorization remains unchanged:

```text
manageTeam + trusted `exports.sensitive` step-up
```

Rust queries at most 5,001 matching records in descending timestamp order:

- rows 1–5,000 are serialized;
- record 5,001 is used only to determine truncation and is not included;
- `x-export-limit: 5000` is always returned;
- `x-export-truncated: true` is returned when a 5,001st match exists, otherwise `false`.

CSV keeps:

- UTF-8 BOM;
- attachment filename;
- the established 13-column order;
- correct quote, comma, and newline escaping;
- formula neutralization after leading whitespace/control characters;
- only sanitized metadata.

The client reads `x-export-truncated`. A truncated successful download produces a live status:

```text
Export dibatasi hingga 5.000 baris. Persempit filter untuk export lengkap.
```

An exact 5,000-row export with no 5,001st match is not labeled truncated. Export progress and outcome are announced accessibly. Step-up cancellation remains non-error cancellation. JSON error blobs continue to be decoded safely.

### 9. Legacy Node route closure

The active application does not register:

```text
server/src/routes/adminAuditRoutes.ts
server/src/controllers/adminAuditController.ts
```

Those files have weaker legacy export authorization and behavior than the active gateway/Rust contract. This scope does not activate or broadly refactor them. Add a source/route closure test proving they remain unregistered. Any future activation must first match:

- `manageTeam` export authorization;
- `exports.sensitive` step-up;
- WIB date boundaries;
- inverted-range validation;
- fail-closed query validation;
- CSV formula safety;
- truncation headers;
- disclosure sanitization.

### 10. Smoke-test correction

The current mutation smoke expects an invalid export date to reach Rust and return `400`, but it does not provide the required `exports.sensitive` step-up grant. The gateway correctly rejects the request before Rust validation.

Correct the test boundary:

- smoke without step-up asserts the step-up-required response;
- invalid export query validation is tested in disposable integration with a real authenticated session and valid trusted step-up grant;
- no fabricated bearer, CSRF, proxy, or step-up headers are accepted as a replacement for the existing authentication contract.

## File and component boundaries

The intended responsibility split is:

```text
client/src/lib/auditLogQuery.ts
  Pure URL parsing, serialization, validation, and pagination range.

client/src/components/admin/AuditLogDetailDialog.tsx
  Accessible modal behavior, sanitized detail presentation, and copy actions.

client/src/pages/admin/AuditLogs.tsx
  Draft/applied state, fetch lifecycle, results, pagination, export orchestration.

server/src/services/adminAuditService.ts
  Generic audit admission and pre-persistence sanitization.

rust-api/src/routes/audit_logs/sanitize.rs
  BSON disclosure sanitization shared by list and export.

rust-api/src/routes/audit_logs/filters.rs
  Fail-closed query validation and Mongo filter construction.

rust-api/src/routes/audit_logs/export.rs
  Sanitized CSV generation, formula defense, and truncation signaling.

scripts/security/scrub-admin-audit-secrets.js
  Dry-run-first targeted historical cleanup.
```

If implementation reveals a small shared dialog-focus helper is necessary, it may be extracted only when both `TeamAccessDialog` and `AuditLogDetailDialog` can use the same behavior without changing their visible contracts. A broad modal refactor is outside scope.

## Testing strategy

### Node unit and source-contract tests

Add focused tests for:

- every exact sensitive key and alias;
- mixed case, dash, underscore, spaces, and punctuation;
- nested objects and arrays;
- depth, array, object-entry, and string limits;
- negative keys `shipping`, `mapping`, `pinned`, and `opinion` remaining visible;
- staff/member login and registration bodies never being audited;
- path/resource/action/status derivation;
- trusted IP and correlation attribution;
- successful and failed HTTP outcomes being recorded with their actual status;
- missing actor causing no record;
- audit insert failure being logged without changing the original operation;
- active Node route ordering and authorization;
- legacy Node audit routes remaining unregistered.

### Rust tests

Add focused tests for:

- disclosure sanitizer parity with Node;
- historical plaintext PIN being redacted in list mapping and CSV;
- malformed action, date, range, search, resource, page, and limit returning `400`;
- exact WIB start/end boundaries;
- regex escaping and trace-ID search construction;
- descending ordering and pagination response;
- CSV BOM, headers, column order, quotes, commas, newlines, and formula neutralization;
- 5,000 records not being marked truncated when no 5,001st record exists;
- 5,001 records producing only 5,000 rows with `x-export-truncated: true`;
- Node/Rust permission and step-up defense-in-depth remaining intact.

### Pure client tests

Create:

```text
client/src/lib/auditLogQuery.test.ts
```

Test:

- canonical query order;
- omission of empty fields and `page=1`;
- trimming;
- valid/invalid search lengths;
- valid/invalid resource lengths;
- action enum validation;
- actual calendar-date validation;
- inverted ranges;
- finite integer page limits;
- deterministic round-trip parse/serialize;
- pagination range for first, middle, last, and empty pages;
- correction target for an out-of-range page.

### Disposable integration

Add an isolated required integration check using only `webtopup_task14_dev`. Fixtures must be synthetic, marked for cleanup, and never expose credentials through the public fixture manifest.

Required cases:

| Case | Expected result |
|---|---|
| Anonymous list | `401` |
| Active staff without `viewTeam` | `403 PERMISSION_DENIED` |
| Active audit viewer with `viewTeam`, no `manageTeam` | List `200` |
| Audit viewer export | `403 PERMISSION_DENIED` |
| Audit manager export without step-up | Step-up-required response |
| Audit manager with real `exports.sensitive` step-up | CSV `200` |
| Invalid list/export query after proper authorization | `400` |
| Gateway fixture mutation | Corresponding gateway row appears |
| Fixture containing PIN and nested credentials | Its `adminauditlogs` record contains `[redacted]`, never the source secret; the test does not assert against or print the integration's authoritative settings collection |
| Historical raw fixture inserted directly into disposable `adminauditlogs` | List and CSV return `[redacted]` |
| Action/resource/search/trace/date filters | Exact tagged rows only |
| Pagination | Correct total, pages, range inputs, and descending order |
| Related gateway/domain fixtures | Two visible rows with the same trace ID and distinct sources |
| Scrubber dry-run | No database mutation |
| Scrubber apply | Sensitive leaves redacted, non-sensitive values retained |
| Scrubber second apply | Zero newly affected fields/documents |

The integration check must follow the existing real staff login, credential-cookie, refresh, CSRF, session, trusted-proxy, and step-up contracts. It must not bypass them with fabricated credentials or headers. Synthetic sessions and fixture rows are cleaned up in `finally` paths.

The harmless gateway mutation used to prove writer behavior must not be a financial mutation and must not change a production or shared fixture. A disposable-only validation failure may prove failed-write auditing; a successful fixture mutation, if needed, must target a tagged disposable document and restore or remove it.

### Playwright

Add required desktop and mobile audit checks. Coverage includes:

- route visibility and access for `viewTeam`;
- disabled export plus persistent explanation without `manageTeam`;
- eligible export opening the real step-up flow;
- one request for apply, reset, pagination, retry, and refresh;
- no request while typing or editing draft controls;
- deep-link hydration;
- Back/Forward restoration;
- malformed URL validation and reset;
- accessible visible labels;
- date error association;
- initial loading and accessible status;
- initial error and retry;
- same-query refresh error with stale-data warning;
- global empty versus filtered empty;
- total/range and out-of-range correction;
- source badges and trace details;
- dialog initial focus, Tab/Shift+Tab containment, Escape, backdrop close, close button, and exact focus restoration;
- copy success announcement;
- `[redacted]` explanation;
- full detail reachability at desktop, mobile portrait, and mobile landscape.

No browser test may depend on production users or production data.

### Verification matrix

Register the audit authorization integration and audit desktop/mobile browser checks as mandatory isolated disposable checks. Matrix contract tests must fail if any required check is removed, renamed, made non-isolated, or assigned an authentication profile that cannot exercise the real session and step-up contract.

At minimum, implementation verification must run:

```bash
npm run test:dev-verify:unit
npm run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js
(cd rust-api && cargo test --bin webtopup-rust-api --no-fail-fast)
(cd rust-api && cargo test --lib --no-fail-fast)
(cd server && npm run test:security)
npm run test:provider-sandbox
git diff --check
```

Then run focused audit integration and Playwright checks, followed by disposable `infra-up`, the full matrix, `infra-down`, and stopped-state checks before claiming completion.

`cargo fmt --check` remains unavailable unless the `rustfmt` component is installed with explicit approval; its absence must be reported rather than silently skipped.

## Security and operational invariants

Do not weaken or reorder:

- staff authentication and active-account enforcement;
- role and database-backed permission resolution;
- Node and Rust authorization checks;
- `exports.sensitive` step-up;
- credential cookies, refresh semantics, and CSRF;
- trusted proxy admission and direct-Rust rejection;
- rate limits;
- 2FA-enrollment restrictions;
- finance idempotency and step-up controls;
- audit-writer failure isolation from business operations.

Do not print or persist fixture credentials, source secrets, production URIs, or historical sensitive values in tests, reports, diffs, logs, screenshots, or scrubber output.

## Rollout sequence

Implementation verification and production execution are separate decisions.

The safe sequence is:

1. Implement and test Node pre-persistence sanitizer.
2. Implement and test Rust list/export disclosure sanitizer.
3. Implement query, UI, dialog, and export improvements.
4. Verify disposable authorization, redaction, export, scrubber, and browser behavior.
5. Run the complete disposable matrix and stop all disposable services.
6. Obtain explicit approval before any production build, restart, deployment, or scrub action.
7. If production scrub is later approved, perform backup and restore-readiness checks first, run a read-only aggregate dry-run without printing secrets, review counts, obtain a second explicit apply approval, execute targeted updates, and perform post-checks.

This design does not authorize steps 6 or 7.

## Non-goals

- No new staff role or permission key.
- No change to `viewTeam`, `manageTeam`, or owner semantics.
- No metadata step-up requirement for ordinary sanitized list/detail access.
- No successful financial mutation in audit tests.
- No audit-event deduplication or grouping.
- No new text index, Atlas Search, search engine, or mandatory date window.
- No TTL index, retention deletion, archival policy, backup policy, WORM storage, or SIEM integration.
- No activation or broad refactor of legacy Node audit routes.
- No production data inspection, scrub, deploy, restart, or GitHub push without explicit approval.
- No broad refactor of unrelated admin pages or dialogs.

## Residual technical debt

- Audit search remains a multi-field unanchored regex and may require collection scans as the collection grows. The 120-character limit and authorization constrain input but do not solve query scalability.
- Node and Rust maintain equivalent sanitizer logic in different languages. Cross-layer parity tests reduce drift; a generated cross-language schema may be considered separately.
- Gateway and domain writers can produce two rows per mutation. This design makes their sources and trace relationship visible but does not create a formal parent-child event schema.
- The collection has no approved retention/archive policy. Indefinite growth must be addressed through a separate operational design before any TTL or deletion is introduced.
- Legacy Node audit reader/export files remain in the repository but inactive. A closure test prevents accidental activation; removal can be planned separately.
