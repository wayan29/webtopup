# Site Config Security and Correctness Foundation Design

**Date:** 2026-08-12
**Status:** Approved for implementation planning
**Scope:** Security and correctness foundation for `/admin/site-config`, shared image uploads, transaction Ref IDs, guest invoices, versioned Site Config mutation, and public settings freshness

## Goal

Harden `/admin/site-config` and the shared primitives it controls so that image uploads contain only validated images, transaction identifiers remain unique under concurrency, Site Config changes are transaction-only, permanently idempotent, revision-checked, step-up protected when sensitive, atomically audited, and immediately revalidated by public clients without weakening existing authentication, active-account, permission, CSRF, trusted-proxy, rate-limit, or production controls.

## Approved scope and decisions

The following product and security decisions are fixed for this design:

- Implement the security and correctness foundation before the broader Site Config UX or product-feature work.
- Use one trusted step-up action group: `settings.sensitive`.
- Use one global Site Config revision, stored internally as reserved settings metadata.
- Fail closed for every Site Config PUT when MongoDB transactions are unavailable:
  `503 SETTINGS_TRANSACTIONS_UNAVAILABLE`.
- Require an `Idempotency-Key` for every bulk Site Config PUT.
- Keep Site Config idempotency claims permanently; do not add a TTL.
- Bind a claim to the operator, expected revision, and canonical payload digest.
- Use conservative commit-unknown recovery; never rerun a mutation whose outcome cannot be proven.
- Validate uploads by content, fully decode and re-encode them, and never trust the client MIME, extension, or filename.
- Accept new JPEG, PNG, and WebP uploads. Reject new GIF uploads. Existing GIF files are not migrated or deleted.
- Preserve the detected image format while stripping unneeded metadata.
- Enforce input and output limits of 5 MiB, maximum dimensions of 4096 by 4096, and at most 16,777,216 decoded pixels.
- Apply the hardened upload pipeline to `icons`, `covers`, `popups`, and `instructions` without changing their permission mappings.
- Reject deletion of a managed upload that is still referenced, using `409 ASSET_IN_USE`.
- Generate transaction Ref IDs from an atomic counter scoped to each WIB calendar date. Changing the display format does not reset the counter.
- Separate the immutable internal transaction Ref ID from `vendorTrxId`; `vendorTrxId` remains the provider's identifier.
- Require invoice random length 8–12 for alphanumeric identifiers and 10–12 for numeric identifiers.
- Retry only invoice duplicate-key collisions, with at most five candidates.
- Add a dry-run readiness checker for identifier data and required indexes. Do not rename or deduplicate historical identifiers automatically.
- Remove the Node response-body cache for public settings.
- Serve public settings with `Cache-Control: no-cache` and an ETag derived from the authoritative revision.
- Preserve top-level settings response compatibility, adding only `revision` metadata.
- Disable the active single-setting PUT route; all changes use one versioned bulk mutation contract.
- Automated mutation, index creation, and integration verification are restricted to the marked disposable database `webtopup_task14_dev`.
- This design does not authorize a production readiness scan, index creation, data repair, deployment, restart, push, or any other production mutation.

## Current architecture and confirmed problems

### Active Site Config path

The active path is:

```text
React `/admin/site-config`
  → Node `/api/v2/settings/admin/*`
  → authentication, active account, permission, CSRF, trusted proxy context
  → Rust `/v2/settings/admin/*`
  → independent permission and active-account verification
  → MongoDB `settings`
```

The client is explanatory only. Node and Rust remain authoritative. The existing `manageSettings` permission is required at both layers and must not be widened.

The active Rust API stores each setting as a separate document:

```json
{
  "key": "maintenanceMode",
  "value": false
}
```

The implementation currently validates allowlisted setting keys and cross-field invariants, but it does not compare an expected revision. Two admins can therefore save from the same old snapshot and silently overwrite one another.

Rust writes the domain audit event after settings persistence. Audit failure does not roll back the settings mutation. This leaves a possible successful change without its required domain evidence.

The single-setting PUT route creates a second mutation surface that would otherwise need duplicate revision, idempotency, step-up, transaction, and audit rules.

### Public settings path

Public settings are allowlisted and loaded through:

```text
React public layout/register
  → Node `/api/v2/settings/public`
  → Rust `/v2/settings/public`
  → MongoDB `settings`
```

Node currently caches the response body for 30 seconds and sends `public, max-age=30`. Invalidating only the receiving Node instance cannot guarantee freshness across multiple instances, and a browser or intermediary may keep the old response until expiry.

### Shared image-upload path

The active upload path is shared by Site Config, catalog, payment, content, and instruction surfaces:

```text
React ImagePicker
  → Node multipart boundary and folder permission
  → Rust folder permission
  → Rust reads multipart field
  → public UPLOAD_DIR
```

Rust currently trusts the multipart MIME string and preserves the extension from the client filename. It writes the bytes without content decoding. An authorized but compromised staff account can therefore place non-image or malformed content in the public uploads tree.

Deletion currently removes the file without checking whether settings, products, operators, payment resources, or public content still reference it.

### Identifier paths

The balance transaction path currently derives a local Ref ID from `count_documents(today) + 1`. Concurrent requests can observe the same count. The local value is initially stored in `vendorTrxId`, but a later vendor result can overwrite that field with the provider's transaction identifier. A unique index on `vendorTrxId` would therefore protect the wrong semantic value.

Guest invoice generation allows a random length as low as one character. Although `guesttransactions.invoiceNumber` is intended to be unique, the creation flow does not have a bounded duplicate-candidate retry contract.

## Non-negotiable controls

Implementation must preserve all of the following:

- Node authentication and database-backed active-account checks;
- Rust trusted-proxy verification, database-backed user lookup, active status, role, and effective permission checks;
- `manageSettings` at Node and Rust for Site Config admin reads and writes;
- existing upload folder permission mappings at Node and Rust;
- CSRF and credential-cookie semantics;
- browser stripping of trusted step-up and proxy headers;
- trusted `settings.sensitive` step-up stamping only after a real grant;
- request correlation and trace propagation;
- gateway and Rust audit rows as separate evidence where both exist;
- rate limits and route ordering;
- public-setting allowlists;
- fail-closed handling of unknown, reserved, malformed, null, and wrong-type setting values;
- no manual rollback fallback after an ambiguous commit;
- no access to production data for automated verification.

## Architecture

The work is divided into four independently testable milestones:

1. **Shared upload security:** content verification, bounded decode/re-encode, atomic publication, and reference-safe deletion.
2. **Identifier integrity:** immutable transaction references, atomic WIB counters, safe invoice entropy and retry, dry-run readiness, and index gates.
3. **Transactional Site Config:** global revision, optimistic concurrency, permanent idempotency, transaction-only persistence, and atomic audit.
4. **Gateway, client, and public contract:** `settings.sensitive` orchestration, ETag revalidation without Node body caching, conflict/replay handling, and disposable verification.

The storage model remains per-key. This minimizes migration risk and preserves existing read consumers. No compatibility mutation fallback may invoke the inactive legacy Node `settingsController.ts` path.

## 1. Shared image-upload security

### 1.1 Canonical image policy

All four folders use one Rust policy:

```text
folders: icons, covers, popups, instructions
input formats: JPEG, PNG, WebP
input bytes: <= 5,242,880
width: <= 4096
height: <= 4096
pixels: <= 16,777,216
encoded output: <= 5,242,880
```

The Node multipart limit remains 5 MiB. Rust independently performs a bounded read and must reject the request before allocating or retaining an unbounded body.

The policy sequence is:

1. read no more than 5 MiB plus one sentinel byte;
2. detect the format from magic bytes;
3. reject GIF and every format other than JPEG, PNG, and WebP;
4. obtain dimensions through the decoder and reject excessive width, height, or total pixels before allocating the full decoded image where the library permits;
5. fully decode the image;
6. apply display-orientation metadata when supported so metadata removal does not rotate a valid image unexpectedly;
7. re-encode to the same detected format using bounded settings;
8. reject output larger than 5 MiB;
9. write the encoded bytes to a random temporary file on the same filesystem but outside the publicly served upload root;
10. flush the temporary output, then atomically rename it into the final folder;
11. clean every temporary file on success, error, disconnect, panic-safe guard drop, or batch rollback.

Canonical output behavior is:

- JPEG remains JPEG with a fixed reviewed quality setting;
- PNG remains PNG and preserves transparency;
- WebP remains WebP and preserves transparency through a deterministic supported encoder;
- the final extension comes from the detected output format;
- the final basename is generated by the server and does not include the client filename;
- EXIF and unneeded ancillary metadata are not copied to the output.

The implementation must add only a reviewed Rust image-decoding dependency with the minimum JPEG, PNG, and WebP feature set. No native OS package installation is authorized by this design.

### 1.2 Single and multiple upload behavior

Single and multiple uploads call the same validation and encoding primitive. They must not maintain separate MIME or extension logic.

For a multiple upload:

- all files are staged and validated before publication;
- one invalid file fails the entire batch;
- no successful response may contain only a subset of the requested files;
- if publication of a later file fails, any final files published for that batch are removed before the error returns;
- pre-existing files are never removed as part of batch cleanup.

The response remains compatible with the existing picker contract, while errors use the standard envelope.

### 1.3 Upload error taxonomy

The minimum error codes are:

```text
UPLOAD_TOO_LARGE
UNSUPPORTED_IMAGE_FORMAT
INVALID_IMAGE_CONTENT
IMAGE_DIMENSIONS_EXCEEDED
IMAGE_PIXEL_LIMIT_EXCEEDED
ENCODED_IMAGE_TOO_LARGE
UPLOAD_STORAGE_FAILED
```

Invalid content and policy failures return `400`. Storage and atomic-publication failures return `500`. Error messages and logs must not include image bytes or untrusted metadata beyond a bounded safe filename label.

### 1.4 Reference-safe deletion

Rust remains the deletion authority. It normalizes the requested managed URL to exactly:

```text
/uploads/<allowed-folder>/<safe-basename>
```

It rejects path traversal, backslashes, encoded separators, empty names, unknown folders, and any path that does not resolve under the configured upload root.

Before deleting, a registry of known reference locations counts exact URL matches in at least:

| Resource | Fields |
|---|---|
| `settings` | `favicon`, `logo`, `popupBannerImage` |
| `products` | `icon` |
| `operators` | `icon`, `instructionImage` |
| `producttypes` | `icon`, `cover`, `popupInfo.image` |
| `categories` | `icon` when it is a managed upload URL |
| `paymentmethods` | `icon` |
| `paymentcategories` | `icon` |
| `sliders` | `image` |
| `flashsales` | `banner` and embedded managed icon snapshots where applicable |
| `articles` | `image` |
| `rewards` | `imageUrl` |

The implementation task must finish the registry by searching all active Mongo write and read mappings for managed upload fields. This is a bounded source inventory, not permission to add unrelated resources.

A referenced file returns:

```http
409 ASSET_IN_USE
```

```json
{
  "error": {
    "code": "ASSET_IN_USE",
    "message": "Asset masih digunakan",
    "references": [
      { "resource": "Settings", "count": 1 },
      { "resource": "Products", "count": 3 }
    ]
  }
}
```

Only resource category and count are disclosed. IDs, names, credentials, transaction data, and unauthorized resource details are not returned.

The scanner runs again immediately before `remove_file`. Active mutations that accept a managed upload URL must verify that the target exists before committing the reference. This bounds, but does not pretend to eliminate, the filesystem/database race without introducing a new asset-registry service. A future asset registry is outside this scope.

## 2. Identifier integrity

### 2.1 Immutable internal transaction reference

New balance transactions receive an immutable string field:

```text
referenceId
```

`referenceId` is the Site Config-controlled local Ref ID. It is generated once and must never be overwritten by vendor callbacks, manual status edits, rechecks, or refunds.

`vendorTrxId` remains the external provider's transaction identifier. The creation flow no longer stores the local Ref ID in `vendorTrxId`. API mappers may expose both values, but labels must distinguish **Ref ID** from **Ref vendor**.

Historical records are not rewritten automatically. A production reconciliation or backfill for historical `referenceId` values is a separate approved operation.

### 2.2 Atomic WIB daily counter

Use a dedicated collection such as `identifiercounters` with this identity:

```json
{
  "scope": "transaction-reference",
  "dateWib": "2026-08-12",
  "sequence": 184
}
```

Required index:

```text
(scope ASC, dateWib ASC) unique
```

The calendar date is computed in WIB (`Asia/Jakarta`, UTC+07:00). Day changes are not derived from server-local timezone.

For each new balance transaction:

1. load the effective Ref ID format;
2. allocate the next sequence with atomic `$inc` inside a MongoDB transaction;
3. check that the decimal sequence fits the configured `refIdSequenceDigits`;
4. build `referenceId` from prefix, formatted WIB date, separator, and zero-padded sequence;
5. insert the transaction carrying the immutable `referenceId` in the same transaction as the counter increment;
6. commit before any vendor call uses the reference.

Changing prefix, date format, separator, or digit width never creates a new counter for the same WIB date.

If the sequence exceeds the configured width, return:

```text
409 REF_ID_SEQUENCE_EXHAUSTED
```

There is no wrap, reset, truncation, or silent digit extension.

The required unique transaction index is:

```text
transactions.referenceId unique
```

A database whose historical records prevent the reviewed index from being created is not production-ready for activation. This design deliberately does not invent historical identifiers or weaken the index to hide missing legacy data. The readiness report becomes the release gate, and any production reconciliation requires separate approval.

The counter increment and transaction insert form the identifier transaction boundary. If MongoDB transactions are disabled or unavailable, the protected creation path returns `503 IDENTIFIER_TRANSACTIONS_UNAVAILABLE`; it does not fall back to count-based or non-transactional allocation. Existing balance, voucher, and flash-sale behavior outside that boundary is not broadly redesigned by this Site Config scope. If commit outcome is ambiguous, resolution reads the preallocated transaction `_id` and `referenceId`; compensating rollback must not run unless absence is proven. A still-unprovable result returns `503 TRANSACTION_REFERENCE_COMMIT_UNKNOWN` rather than risking a duplicate transaction or incorrect balance restoration.

### 2.3 Safe guest invoice policy

Effective invoice policy is:

```text
alphanumeric: length 8..=12
numeric: length 10..=12
```

The default changes to:

```text
invoiceRandomType = alphanumeric
invoiceRandomLength = 8
```

Node and Rust defaults, readers, validators, Site Config controls, and tests must agree. A malformed or historically weak stored value reads as the safe minimum for its selected type. Storage is normalized only after an explicit admin save; the read path does not silently rewrite MongoDB.

The unique `guesttransactions.invoiceNumber` index remains the final authority.

Guest creation orders duplicate-sensitive work so that candidate insertion is the first write that can fail for an invoice collision before flash-sale, voucher, payment, or other domain side effects are applied. On the exact duplicate-key error for the reviewed invoice index:

1. abort that transaction attempt;
2. generate a new candidate;
3. retry with a fresh transaction attempt;
4. stop after five total candidates.

No other database error is treated as a collision. After five collisions return:

```text
503 INVOICE_IDENTIFIER_EXHAUSTED
```

The existing guest-checkout `Idempotency-Key` remains authoritative. A retry of the same checkout request must replay the same successful invoice rather than create another transaction.

### 2.4 Identifier readiness checker

Add a standalone read-only-by-default tool that reports:

- duplicate non-empty transaction `referenceId` values;
- missing transaction `referenceId` values that block the full unique index;
- malformed local references;
- duplicate, missing, or malformed guest `invoiceNumber` values;
- the existence and exact definitions of the counter and identifier indexes;
- unsafe invoice configuration values;
- whether the database is ready for index creation and route activation.

The default invocation is dry-run and does not create indexes or mutate documents. It prints bounded counts and redacted example document IDs only when needed; it does not dump targets, phone numbers, provider payloads, or full transaction documents.

Automated `--apply` index creation is allowed only when the parsed database name is exactly:

```text
webtopup_task14_dev
```

The tool must refuse protected or ambiguous database names. There is no `--allow-protected-database` path for automated verification.

Production readiness scanning, historical repair, and index creation require separate explicit approval. No automatic identifier rename, merge, or deduplication exists.

### 2.5 Runtime index gate

Transaction and guest-transaction creation verify that required identifier indexes have the exact reviewed key, unique, and filter definition before executing the protected creation path. Index readiness can be cached only for a short bounded process-local interval and must fail closed on inspection errors.

An absent or drifted required index returns:

```text
503 IDENTIFIER_INDEX_UNAVAILABLE
```

Startup may log readiness, but it must not silently create production identifier indexes.

## 3. Versioned transactional Site Config

### 3.1 Revision storage

Keep per-key setting documents and reserve this internal metadata document:

```json
{
  "key": "__site_config_revision__",
  "value": 14
}
```

The reserved key:

- is not part of `siteSettingKeys` or `default_site_settings`;
- is never returned as a normal setting;
- cannot be addressed through the single-setting GET or PUT contract;
- cannot appear inside `changes`;
- is managed only by the transactional Site Config service;
- remains protected by the existing unique `settings.key` index.

A database without the document has revision `0`. The first successful mutation with `expectedRevision: 0` creates the metadata document and commits revision `1`. Under concurrency, only one first writer can succeed.

Admin and public reads require a self-consistent snapshot. Because reads remain available when transactions are disabled, the reader performs a bounded revision-before/settings/revision-after sequence and returns only when both revision reads match. It retries a bounded number of times, then returns an availability error rather than combining settings from one version with the revision from another.

### 3.2 Admin read contract

```http
GET /api/v2/settings/admin/all
```

The existing top-level fields remain compatible, with one top-level metadata property:

```json
{
  "brand": "Danayasa",
  "maintenanceMode": false,
  "invoiceRandomLength": 8,
  "revision": 14
}
```

`revision` is parsed separately by the client and is not inserted into `SettingsForm` or sent as a changed setting.

### 3.3 Bulk mutation contract

```http
PUT /api/v2/settings/admin/update
Idempotency-Key: <validated-key>
Content-Type: application/json
```

Body:

```json
{
  "expectedRevision": 14,
  "changes": {
    "maintenanceMode": true,
    "maintenanceMessage": "Pemeliharaan hingga 02.00 WIB"
  }
}
```

Rules:

- `expectedRevision` is required and is a non-negative integer;
- `changes` is required, is an object, and is non-empty before validation;
- only reviewed Site Config keys are accepted;
- unknown and reserved keys fail closed;
- client-supplied actor, role, revision metadata, audit metadata, trust headers, and idempotency state are rejected or stripped at the proper boundary;
- each value is normalized and validated using the Rust setting contract;
- the effective full snapshot passes all cross-field invariants;
- keys whose normalized value equals the current value are removed from the effective mutation;
- no effective change returns success without increasing revision or writing a new settings audit row;
- even a no-op PUT requires transaction capability and completes its idempotency result consistently;
- one save intent uses one idempotency key across auth refresh, step-up, safe network retry, and replay;
- a new intent uses a new key.

Success:

```json
{
  "success": true,
  "replayed": false,
  "revision": 15,
  "data": {
    "brand": "Danayasa",
    "maintenanceMode": true
  }
}
```

The `data` property contains the complete normalized admin snapshot returned by the original successful mutation, excluding reserved metadata except the separate `revision` property.

Replay returns the frozen original response:

```json
{
  "success": true,
  "replayed": true,
  "revision": 15,
  "data": {
    "brand": "Danayasa",
    "maintenanceMode": true
  }
}
```

The server does not substitute a later settings snapshot into an earlier replay.

### 3.4 Single-setting endpoints

The admin single-setting GET may remain for bounded compatibility:

```http
GET /api/v2/settings/admin/:key
```

It never accepts the revision key and returns the current global `revision` alongside the requested value.

The mutation route is removed from active Node and Rust registration:

```http
PUT /api/v2/settings/admin/:key
```

A request must receive `405 Method Not Allowed` or the explicit inactive-route response chosen consistently by the gateway contract tests. It must never fall through to a weaker legacy Node controller.

### 3.5 Sensitive setting classification

The action group is exactly:

```text
settings.sensitive
```

The sensitive key set is exactly:

```text
maintenanceMode
registrationEnabled
guestCheckoutEnabled
minDeposit
maxDeposit
depositFee
depositFeeType
refIdPrefix
refIdDateFormat
refIdSeparator
refIdSequenceDigits
invoicePrefix
invoiceDateFormat
invoiceSeparator
invoiceRandomLength
invoiceRandomType
```

Branding, contact, footer, legal URLs, analytics placeholders, and popup-banner content are not automatically part of this action group in this foundation.

Rust computes sensitivity from the **effective normalized change set**, not merely submitted keys. A submitted sensitive value that equals the current normalized value is a no-op and does not require step-up.

Node must never accept a browser-provided trusted step-up group. The gateway route strips untrusted group/token headers and can stamp `settings.sensitive` only after validating a real grant. The initial request may reach Rust without a trusted stamp; Rust returns `AUTH_STEP_UP_REQUIRED` only after it has checked permission, revision, validation, and effective sensitivity. The client obtains the grant through the existing step-up orchestrator and retries the same intent with the same idempotency key. On the retry, Node validates the grant and emits the trusted stamp. This preserves effective-change semantics without giving Node direct database authority.

Inactive owner, admin, or CS accounts are denied even if the session contains an old grant.

### 3.6 Permanent idempotency claim

Use a dedicated collection such as:

```text
siteconfigidempotencyclaims
```

The globally unique identifier is the normalized `Idempotency-Key`. Each claim stores at least:

```text
idempotencyKey
operatorId
expectedRevision
payloadDigest
status
claimToken
leaseExpiresAt
transactionStartedAt
commitUnknown
responseStatus
responseBody
resultRevision
createdAt
updatedAt
```

The key is 8–128 safe ASCII characters using the existing reviewed `[A-Za-z0-9._-]` contract. Duplicate HTTP header lines fail closed. Node and Rust both validate the key.

The canonical digest is SHA-256 over canonical JSON containing:

```json
{
  "expectedRevision": 14,
  "changes": {
    "keys": "sorted lexicographically",
    "values": "validated normalized JSON"
  }
}
```

Binding and replay rules:

- same key, operator, expected revision, and digest with a completed claim replays the frozen response;
- the same key with a different operator, expected revision, or digest returns `409 IDEMPOTENCY_CONFLICT`;
- an active matching pre-transaction claim returns `409 IDEMPOTENCY_IN_PROGRESS`;
- a stale pre-transaction claim may be reclaimed only after its five-minute lease expires and only when it has no transaction-started or commit-unknown marker;
- transaction-started or commit-unknown claims are never reclaimed merely because time elapsed;
- completed claims remain permanently and have no TTL.

Permission, active status, body validation, a bounded current-snapshot load, and effective step-up classification happen before a new claim is inserted. The pre-claim phase validates that `expectedRevision` is well formed but does not issue the authoritative revision verdict. The authoritative comparison happens inside the transaction after the fenced claim exists, so a version-conflict response can be frozen and replayed deterministically. `AUTH_STEP_UP_REQUIRED` does not consume the idempotency key, so the same save intent can continue after verification.

Before opening the MongoDB transaction, the service durably marks the fenced claim with `transactionStartedAt` and its claim token. A definitive transaction abort may transition the same fenced claim to an explicit retryable state. An ambiguous outcome cannot be marked retryable.

### 3.7 Transaction boundary

If `MONGO_TRANSACTIONS_ENABLED` is false or transaction capability is unavailable, every Site Config PUT returns:

```text
503 SETTINGS_TRANSACTIONS_UNAVAILABLE
```

No setting, revision, audit event, or idempotency claim is changed in that case.

A successful mutation transaction includes:

1. verify the fenced claim identity and expected in-progress state;
2. load the current revision and normalized settings snapshot in the session;
3. compare the authoritative revision to `expectedRevision`;
4. recompute the effective changes and cross-field validation;
5. recheck trusted `settings.sensitive` step-up for the effective set;
6. upsert only effective setting keys;
7. create or increment `__site_config_revision__` exactly once;
8. write one sanitized Rust domain audit row with previous and new values, changed keys, actor, trace ID, and old/new revision;
9. freeze the bounded response body;
10. finalize the claim as completed with response status/body and result revision;
11. commit.

A no-op transaction finalizes the claim with the unchanged revision and snapshot but does not write settings or an audit row.

A version conflict finalizes the matching claim with the frozen `409` conflict response so a lost conflict response can replay deterministically. It does not change settings, revision, or the settings audit history.

### 3.8 Optimistic conflict response

A stale revision returns:

```http
409 SETTINGS_VERSION_CONFLICT
```

```json
{
  "error": {
    "code": "SETTINGS_VERSION_CONFLICT",
    "message": "Pengaturan telah diubah oleh pengguna lain",
    "expectedRevision": 14,
    "currentRevision": 15,
    "currentSettings": {
      "brand": "Danayasa",
      "maintenanceMode": false
    }
  }
}
```

`currentSettings` is the complete normalized admin snapshot, not raw MongoDB documents. It excludes the reserved revision document and any non-allowlisted data.

The client retains:

- the last saved snapshot it originally loaded;
- the unsaved draft;
- the server's current snapshot and revision.

It classifies server-only changes, draft-only changes, and same-key conflicts. It performs no automatic merge, overwrite, or retry. **Muat versi terbaru** deliberately replaces the draft. **Tinjau ulang draft** retains the draft and displays the conflict. A subsequent save is a new intent with the new revision and a new idempotency key.

### 3.9 Commit-unknown handling

Commit follows the MongoDB driver's transaction contract and retries `commitTransaction` only while the result has `UnknownTransactionCommitResult`, using a bounded attempt/deadline policy.

If the final result remains ambiguous:

- mark the durable claim `commitUnknown: true` when that marker can be persisted without asserting transaction outcome;
- read the claim and result revision with majority semantics;
- if the claim is completed, replay the committed frozen result;
- if completion cannot be proven, return:
  `503 SETTINGS_COMMIT_UNKNOWN`;
- do not run a second mutation;
- do not roll back settings manually;
- do not reclaim the claim;
- a same-key retry performs resolution/replay only and returns `SETTINGS_COMMIT_UNKNOWN` while outcome remains unproven.

The client message must say that the outcome is not yet confirmed. It must direct the operator to inspect the latest revision/snapshot and audit evidence, not claim that the save definitely failed.

## 4. Public settings revalidation

### 4.1 Response contract

```http
GET /api/v2/settings/public
If-None-Match: "site-settings-15"
```

A changed snapshot returns:

```http
200 OK
Cache-Control: no-cache
ETag: "site-settings-16"
```

The public allowlisted settings remain top-level and include:

```json
{
  "brand": "Danayasa",
  "maintenanceMode": false,
  "revision": 16
}
```

An unchanged revision returns:

```http
304 Not Modified
Cache-Control: no-cache
ETag: "site-settings-16"
```

with no response body.

Only the exact strong ETag syntax generated by this service is accepted for a `304` match. Malformed or unrelated validators are treated as a cache miss and receive `200`; they do not broaden data disclosure or fail open to another revision.

### 4.2 Authority and caching

Node removes its response-body cache for `/settings/public`. Every request reaches Rust. Node safely forwards `If-None-Match`, the upstream `ETag`, `304`, `Cache-Control: no-cache`, trace headers, and an empty 304 body. It does not synthesize its own revision.

Rust loads a self-consistent authoritative settings/revision snapshot before comparing the ETag. A browser may retain a response but must revalidate it before reuse.

The CORS response exposure list includes `ETag` if client code or verification needs to read it. Public clients do not need to manually poll: their normal public-settings GET revalidates.

The Site Config copy states that the saved revision is authoritative and that open public pages may need their next revalidation or navigation; it no longer claims an unqualified immediate effect.

## 5. Error contract

All new failures use the active envelope:

```json
{
  "error": {
    "code": "SETTINGS_VERSION_CONFLICT",
    "message": "Pengaturan telah diubah oleh pengguna lain"
  }
}
```

Minimum codes and status classes:

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Missing, duplicate, or malformed Site Config key |
| 400 | `UNSUPPORTED_IMAGE_FORMAT` | Image is not JPEG, PNG, or WebP |
| 400 | `UPLOAD_TOO_LARGE` | Input exceeds 5 MiB |
| 400 | `INVALID_IMAGE_CONTENT` | Content cannot be fully decoded |
| 400 | `IMAGE_DIMENSIONS_EXCEEDED` | Width or height exceeds 4096 |
| 400 | `IMAGE_PIXEL_LIMIT_EXCEEDED` | Decoded pixel count exceeds 16,777,216 |
| 400 | `ENCODED_IMAGE_TOO_LARGE` | Re-encoded output exceeds 5 MiB |
| 403 | `PERMISSION_DENIED` | Effective `manageSettings` or upload permission is absent |
| 403 | `AUTH_STEP_UP_REQUIRED` | Effective sensitive settings change lacks trusted `settings.sensitive` proof |
| 409 | `SETTINGS_VERSION_CONFLICT` | Expected revision is stale |
| 409 | `IDEMPOTENCY_CONFLICT` | Same key is bound to another operator/revision/digest |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Matching claim is actively executing |
| 409 | `ASSET_IN_USE` | Managed upload has active references |
| 409 | `REF_ID_SEQUENCE_EXHAUSTED` | Daily sequence no longer fits configured digits |
| 500 | `UPLOAD_STORAGE_FAILED` | Staging, flush, encode publication, or deletion failed |
| 503 | `SETTINGS_TRANSACTIONS_UNAVAILABLE` | Site Config mutation transaction capability is disabled |
| 503 | `SETTINGS_COMMIT_UNKNOWN` | Site Config commit outcome cannot be proven |
| 503 | `IDENTIFIER_TRANSACTIONS_UNAVAILABLE` | Atomic transaction-reference allocation cannot run |
| 503 | `TRANSACTION_REFERENCE_COMMIT_UNKNOWN` | Counter/transaction commit outcome cannot be proven |
| 503 | `INVOICE_IDENTIFIER_EXHAUSTED` | Five invoice candidates collided |
| 503 | `IDENTIFIER_INDEX_UNAVAILABLE` | A required identifier index is absent or drifted |

Existing auth/session errors retain their current codes and cookie disposition. Error logs must include trace IDs and bounded structural context, not request credentials, image bytes, or secret metadata.

## 6. Minimal client changes in this foundation

This scope does not redesign the entire Site Config page. It adds only behavior required by the new security contract:

- parse `revision` separately from the form;
- generate one bounded random idempotency key when a save intent begins;
- reuse that key for the same step-up or safe retry intent;
- send `{ expectedRevision, changes }`;
- use the existing step-up orchestrator for `settings.sensitive`;
- update form, last-saved snapshot, and revision only from a successful or replayed frozen response;
- preserve draft and display server snapshot on `SETTINGS_VERSION_CONFLICT`;
- provide explicit **Muat versi terbaru** and **Tinjau ulang draft** conflict actions;
- distinguish `SETTINGS_COMMIT_UNKNOWN` from a definitive failure;
- display upload policy errors returned by the API instead of logging them only to the console;
- change invoice length constraints dynamically: 8–12 alphanumeric and 10–12 numeric;
- label local `referenceId` separately from `vendorTrxId` where this milestone exposes both;
- ensure one click/step-up retry results in at most one intended mutation request at a time.

Full unsaved-navigation protection, accessible tab semantics, field-level validation navigation, and complete image-picker modal accessibility are deferred to the Site Config UX plan.

## 7. Audit contract

A successful effective settings mutation writes one Rust domain row inside the mutation transaction. Gateway audit remains a separate row and is not deduplicated.

The domain row includes:

```text
actor id/email/role
action = update
resource = Settings
method = PUT
path = /v2/settings/admin/update
traceId
expectedRevision
previousRevision
resultRevision
changedKeys
changes.<key>.from
changes.<key>.to
idempotencyKey fingerprint, not the raw key when avoidable
createdAt/updatedAt
```

Audit metadata passes the Rust audit sanitizer before persistence even though the current setting allowlist has no credential fields. Future setting additions cannot bypass the generic audit policy.

No-op and version-conflict intents do not write a settings-change domain row. They remain observable through gateway evidence and the permanent idempotency claim without pretending a domain change occurred.

A completed replay writes neither a second settings row nor a second domain audit row and does not increment revision.

## 8. Rollout and operational boundaries

### Milestone A: upload security

- add the reviewed Rust dependency and canonical pipeline;
- keep serving existing JPEG, PNG, WebP, and GIF files;
- reject new GIF and unverified uploads;
- activate guarded deletion only after the reference registry tests cover every active managed field;
- do not scan, rewrite, or delete production files.

### Milestone B: identifier readiness

- add immutable `referenceId` for new balance transactions;
- add the counter service and invoice policy;
- add the dry-run readiness checker;
- create exact indexes only in disposable automation;
- make creation fail closed when required indexes are absent;
- treat production historical `referenceId` reconciliation as a separate release decision.

### Milestone C: transactional settings

- add revision snapshot reads;
- add permanent idempotency claims and indexes;
- add the versioned bulk mutation;
- write settings, revision, audit, and final claim atomically;
- expose transaction capability for verification;
- disable single-setting mutation;
- return `SETTINGS_TRANSACTIONS_UNAVAILABLE` without fallback when disabled.

### Milestone D: gateway, client, and public contract

- validate Site Config idempotency headers at Node;
- add trusted optional step-up stamping and Rust effective enforcement;
- remove the Node public response-body cache;
- forward ETag revalidation correctly;
- add the minimal conflict/replay/commit-unknown client behavior;
- register focused integration and desktop/mobile browser checks in the disposable matrix.

No milestone authorizes production deployment or mutation. Production identifier readiness and any necessary historical reconciliation must be reviewed before release because the new immutable `referenceId` did not previously exist as a stable field.

## 9. Verification strategy

Every implementation task follows strict TDD:

```text
write failing test
→ run and observe the intended failure
→ implement the minimum behavior
→ rerun focused tests
→ commit checkpoint
```

### 9.1 Client and Node unit coverage

Tests must cover:

- revision excluded from `SettingsForm` changes;
- sensitive-key classification parity;
- one key per save intent and reuse across step-up/retry;
- new key after conflict resolution;
- conflict three-way classification;
- commit-unknown copy never says the change definitely failed;
- invoice input minimum changes with random type;
- Node idempotency header normalization, duplicate-header rejection, and route scope;
- stripping untrusted step-up group headers;
- single-setting PUT closure;
- public route has no response-body cache and preserves ETag/304/no-cache;
- cache invalidation is not performed before an upstream mutation result because no body cache remains.

### 9.2 Rust unit and route coverage

Tests must cover:

- JPEG, PNG, and WebP signature detection, decode, re-encode, canonical extension, and transparency where applicable;
- spoofed MIME/extension, truncated data, GIF, excessive bytes, width, height, pixels, and encoded output rejection;
- temporary-file cleanup and all-or-nothing batch cleanup;
- reference classification, bounded disclosure, and `ASSET_IN_USE`;
- daily WIB counter identity and date boundaries;
- format changes do not reset a counter;
- sequence exhaustion;
- immutable `referenceId` not overwritten by vendor updates;
- invoice safe-default normalization and exact duplicate-index retry only;
- readiness findings and protected-database refusal;
- index definition drift detection;
- revision lazy bootstrap;
- two parallel revision-0 writes produce one success and one conflict;
- malformed/reserved setting keys fail closed;
- effective no-op does not require step-up or increment revision;
- sensitive effective changes require trusted `settings.sensitive` proof;
- settings, revision, audit, and completed claim commit atomically;
- disabled transactions return `SETTINGS_TRANSACTIONS_UNAVAILABLE` without a claim or write;
- identical completed request replay;
- operator/revision/digest conflicts;
- stale pre-transaction claim fencing;
- transaction-started and commit-unknown claims never time-reclaim;
- bounded commit retry and conservative unknown result;
- consistent snapshot reader does not combine revisions.

### 9.3 Disposable integration

Use marked synthetic fixtures in:

```text
webtopup_task14_dev
```

Use real staff login, credential cookies, CSRF, refresh behavior, trusted proxy context, MongoDB replica-set transactions, 2FA, and step-up. Never fabricate trusted user or step-up headers.

The required integration scenarios are:

1. user without `manageSettings` cannot read or mutate admin settings;
2. inactive manager is denied;
3. manager reads revision 0 or the seeded revision;
4. non-sensitive save succeeds without step-up;
5. effective sensitive save returns `AUTH_STEP_UP_REQUIRED`;
6. the same intent succeeds after `settings.sensitive` step-up;
7. identical retry replays without a second revision or domain audit row;
8. same key with changed body/revision/operator returns `IDEMPOTENCY_CONFLICT`;
9. stale revision returns the current snapshot and preserves storage;
10. transaction-disabled Rust subprocess returns `SETTINGS_TRANSACTIONS_UNAVAILABLE`;
11. simulated response loss after commit resolves by same-key replay;
12. forced ambiguous commit remains `SETTINGS_COMMIT_UNKNOWN` and does not mutate twice;
13. public settings return ETag, `no-cache`, and correct `304` behavior;
14. spoofed and malformed images are rejected without files;
15. valid JPEG, PNG, and WebP are re-encoded and published with canonical extensions;
16. an invalid multiple-upload batch leaves no batch files;
17. referenced asset deletion returns `ASSET_IN_USE`; unreferenced synthetic asset deletion succeeds;
18. parallel transaction creation yields unique ordered `referenceId` values;
19. sequence exhaustion fails closed;
20. forced invoice collision retries only the candidate and preserves one guest transaction;
21. readiness checker dry-run changes no documents or indexes;
22. disposable apply creates only exact reviewed indexes.

Synthetic financial flows must be isolated, reversible through database reset, and must not invoke real providers. Provider mode remains `mock`.

### 9.4 Desktop and mobile Playwright

Browser coverage proves:

- admin settings load exposes the current revision without rendering it as an editable field;
- non-sensitive save performs one request and updates revision;
- sensitive save opens the existing step-up flow and retries the same intent once;
- simulated response loss uses replay and does not double-save;
- a stale revision preserves the draft and shows current server values;
- conflict actions do not silently merge or overwrite;
- commit-unknown copy is explicitly uncertain;
- invoice length UI enforces the selected type minimum;
- invalid image content produces visible UI feedback;
- public settings revalidation observes the new revision;
- desktop and mobile paths do not issue duplicate save requests.

Full modal/tab accessibility remains deferred, but new conflict controls and errors must have accessible names, persistent text, and keyboard-operable buttons.

### 9.5 Regression and matrix gates

The implementation plan must run focused tests after each task and finish with the existing non-disposable regression suite, Rust binary/library/security tests, provider sandbox, client/server builds, route tests, upload/settings/identifier integration, desktop/mobile Playwright, and the complete disposable verification matrix.

Expected final marker:

```text
LOCAL DEV VERIFIED
```

Teardown must confirm:

```text
processes: []
composeServices: []
serviceCount: 0
```

`cargo fmt --check` remains unavailable while `rustfmt` is not installed. The implementation report must state that limitation and must not install it without approval.

## 10. Non-goals

This foundation does not include:

- a complete Site Config visual redesign;
- unsaved-navigation guards;
- full accessible tab and modal refactoring;
- field-level validation navigation across tabs;
- analytics runtime or consent management;
- public contact, address, social, terms, or privacy rendering;
- preview-before-publish;
- settings history or rollback UI;
- scheduled maintenance or banner activation;
- multi-banner campaigns or audience targeting;
- migration or deletion of existing GIF files;
- automatic repair, rename, or deduplication of production identifiers;
- automatic backfill of historical transaction `referenceId` values;
- a new asset-registry service;
- production readiness scans, index creation, data mutation, deployment, restart, or push;
- activation of inactive legacy Node settings mutation routes.

These items require later specifications after the foundation is verified.

## Success criteria

The foundation is complete only when all of the following are true:

- newly published uploads can only be decoded and re-encoded JPEG, PNG, or WebP within all fixed limits;
- failed uploads and failed batches leave no partial public files;
- referenced managed assets cannot be deleted;
- every new balance transaction has a unique immutable `referenceId` allocated from the WIB daily counter;
- reference allocation fails closed when transactions are unavailable and never compensates an unproven commit outcome;
- provider identifiers can no longer overwrite the local reference;
- every new guest invoice satisfies the minimum entropy policy and duplicate collisions are bounded;
- identifier creation fails closed without exact required indexes;
- Site Config PUT is unavailable without MongoDB transactions;
- successful effective settings changes atomically update settings, increment one global revision, write one domain audit row, and finalize one permanent claim;
- stale revisions cannot overwrite newer settings;
- identical keys replay while changed bindings conflict;
- ambiguous commits cannot trigger a second mutation;
- effective sensitive changes require trusted `settings.sensitive` proof;
- public settings are revalidated against the authoritative revision without Node body-cache staleness;
- focused tests, disposable integration, desktop/mobile browser checks, and the complete matrix pass;
- all disposable processes and services are stopped;
- no production action has occurred.
