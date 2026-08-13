# Slider Management Foundation Design

**Date:** 2026-08-13
**Status:** Approved for implementation planning
**Scope:** Transactional and revisioned slider management, permanent idempotency, effective step-up, shared managed-asset registry foundation, archive/restore lifecycle, public freshness, accessible admin UX, accessible homepage carousel, disposable verification, and approval-gated rollout.

## Goal

Harden `/admin/sliders` and the homepage carousel so that every slider mutation is transaction-only, permanently idempotent, optimistic-concurrency checked, atomically audited, and safe under ambiguous commits; managed cover references cannot race with upload deletion; public content is immediately revalidated through an authoritative revision; and administrators can operate the workflow accessibly on desktop and mobile without weakening existing authentication, active-account, permission, CSRF, credential-cookie, trusted-proxy, rate-limit, or step-up controls.

## Approved product and security decisions

The following decisions are fixed for implementation planning:

- Use a foundation-first implementation sequence: data contracts and tests, managed-asset registry, slider transaction service, gateway/public contract, admin UI, homepage carousel, then disposable verification.
- Require MongoDB transactions for every slider mutation: create, update/status, archive, restore, and reorder.
- Return `503 SLIDER_TRANSACTIONS_UNAVAILABLE` when transaction capability is unavailable. Do not provide a best-effort fallback.
- Require a permanent `Idempotency-Key` for every slider mutation.
- Bind each idempotency claim to operator, action, target, expected revision, contract version, and canonical payload digest.
- Use one global slider revision. Every successful mutation increments it exactly once.
- Return `409 SLIDER_VERSION_CONFLICT` when `expectedRevision` is stale.
- Use trusted step-up action group `settings.sensitive` only when the effective mutation changes public content or destructively removes public content.
- Treat ambiguous commits conservatively. Never rerun a mutation whose outcome cannot be proven. Return `503 SLIDER_COMMIT_UNKNOWN` and permanently fence the claim.
- Build a reusable durable managed-asset registry, but wire full reference-row/count ownership in phase one only to sliders. Upload deletion uses the registry gate.
- Keep the existing database/filesystem reference scan for resource types not yet migrated to reference rows. Every writer that can newly persist a reference in a registry-protected folder must nevertheless participate in the shared asset-state fence before deletion is enabled for that folder; this limited fence participation does not migrate that resource to registry reference rows. If any writer cannot participate, deletion for that folder fails closed.
- Use readiness scanning and explicit migration. Never auto-register or repair production assets at startup.
- Allow automated readiness `--apply` only when the parsed MongoDB database name is exactly `webtopup_task14_dev`.
- New or changed slider images must use a registered, available, canonical `/uploads/covers/<filename>` managed asset.
- New or changed slider links may be empty, a safe canonical internal path, or an HTTPS URL with a valid host and no credentials.
- Preserve legacy slider reads without silently rewriting them. A legacy image may remain on unrelated updates, but changing the image requires a registered cover. A legacy-invalid link must be corrected before that slider can be saved.
- Limit current, non-archived sliders to 20 total and eight active.
- Replace hard delete with archive/restore. Restore always produces a nonactive draft.
- Do not implement permanent purge in this scope.
- Serve public sliders with `Cache-Control: no-cache` and a strong ETag derived from global slider revision.
- Preserve the public response as an array for compatibility while removing internal timestamps, lifecycle, status, and ordering metadata.
- Make the homepage carousel keyboard-safe, pausable, reduced-motion aware, and operable on mobile.
- Make slider dialogs and the shared ImagePicker keyboard-modal and screen-reader accessible.
- Do not implement scheduling, analytics, history/rollback UI, permanent purge, or migration of every managed-resource type in this foundation.
- Production scan, migration, index creation, restart, deployment, and data repair remain separate approval-gated operations.

## Existing architecture and confirmed deficiencies

### Active request path

```text
React `/admin/sliders`
  -> Node `/api/v2/sliders/admin/*`
  -> authenticate + active-account + manageSettings + CSRF/trusted proxy boundary
  -> Rust `/v2/sliders/admin/*`
  -> independent active-account + manageSettings verification
  -> MongoDB `sliders`
```

Public reads flow through:

```text
React homepage
  -> Node `/api/v2/sliders`
  -> Rust `/v2/sliders`
  -> MongoDB `sliders`
```

Uploads flow through the existing hardened JPEG/PNG/WebP upload pipeline and are published beneath `/uploads/<folder>/...`.

### Existing controls to preserve

- Node and Rust both require `manageSettings` for every slider admin route.
- Node and Rust independently revalidate account active state.
- Rust currently rejects unsafe script/data URL schemes, malformed external URLs, protocol-relative paths, and selected unsafe internal paths.
- Managed upload existence is checked during slider writes.
- Slider image paths participate in the current database reference scan used by upload deletion.
- Existing sort validation rejects incomplete lists, unknown IDs, duplicate IDs, duplicate orders, fractional values, and negative values.
- External links rendered in the admin and homepage use protective `rel` attributes.
- Gateway and Rust domain audit rows remain separate records; this design does not deduplicate them.

### Confirmed deficiencies

- Concurrent creates can allocate the same `sortOrder` because allocation is `max + 1` outside a transaction.
- Reorder is a nontransactional multi-document bulk write with no expected revision.
- Delete commits before reindexing; a reindex failure can return `500` after destructive success.
- There is no permanent idempotency or conservative recovery for create, update, delete, or reorder.
- Audit is currently best-effort at the gateway and not atomically coupled to the slider mutation.
- The existence/reference scan and filesystem unlink are not atomically coordinated with slider reference acquisition.
- Rust lacks the intended field-length and collection-count bounds.
- Public slider freshness has no authoritative ETag contract.
- Slider admin dialogs and ImagePicker are not keyboard-modal.
- Form errors can render behind the open slider dialog.
- Failed optimistic reorder can leave an unsaved order on screen.
- Homepage overlays can interfere with banner links, inactive slides can remain focusable, and auto-rotation cannot be paused.
- Mobile admin management relies on a wide table and drag-only ordering.
- Slider-specific permission, concurrency, audit, asset, public-rendering, and accessibility tests are absent.
- Existing mutation smoke uses SVG paths not produced by the hardened upload pipeline and is not a valid clean-room fixture.

## 1. Domain model and invariants

### 1.1 Global slider metadata

Use a dedicated collection, `slidermetadata`, containing exactly one authoritative document:

```json
{
  "_id": "global",
  "revision": 14,
  "updatedAt": "2026-08-13T00:00:00.000Z",
  "updatedBy": "<operator ObjectId>"
}
```

Rules:

- Missing metadata reads as revision `0`.
- The first successful mutation with `expectedRevision: 0` creates revision `1`.
- Every successful create, update/status, archive, restore, or reorder increments revision exactly once.
- Failed validation, permission, step-up, limit, asset, conflict, or transaction attempts do not increment revision.
- Revision is internal metadata and is never represented as an editable slider.
- Admin/public snapshots use at most three revision-before/data/revision-after attempts when not inside a mutation transaction. If a stable snapshot cannot be obtained, return `503 SLIDER_SNAPSHOT_UNSTABLE` rather than mixing revisions.

### 1.2 Slider document

```json
{
  "_id": "<ObjectId>",
  "name": "Promo",
  "image": "/uploads/covers/example.webp",
  "link": "/promo",
  "sortOrder": 3,
  "status": true,
  "lifecycle": "active",
  "createdAt": "...",
  "updatedAt": "...",
  "archivedAt": null,
  "archivedBy": null,
  "__v": 0
}
```

`lifecycle` has exactly two values:

- `active`: the record is current/non-archived. Publication is independently controlled by `status`.
- `archived`: the record is excluded from the main list and public endpoint and is always effectively nonactive.

The potentially confusing name `active` is retained for the lifecycle contract approved during design; code and UI must distinguish `lifecycle == active` from `status == true`.

Invariants:

- A legacy document with missing `lifecycle` is interpreted as current/non-archived on reads and reported by readiness; reads do not persist the default.
- Archived sliders are never public and archive explicitly sets `status: false` while the audit before-state preserves whether it was public.
- A new slider is appended to the current ordering.
- Create may set `status: true` only if active-capacity and step-up requirements are satisfied.
- Archive removes the slider from current ordering and compacts remaining current orders transactionally to `0..n-1`.
- Restore always sets `lifecycle: active`, `status: false`, clears archive actor/time, reacquires its asset reference, and appends it to the end of current ordering.
- Reorder covers every current/non-archived slider and produces exact contiguous order `0..n-1`.
- Archived records retain their historical image path for diagnosis and possible restore, but hold no managed-asset reference.

### 1.3 Collection limits

Authoritative checks occur inside the mutation transaction:

- At most 20 sliders where `lifecycle != archived`.
- At most eight sliders where `lifecycle != archived && status == true`.
- Archived sliders do not consume total capacity.
- Create/restore beyond total capacity returns `409 SLIDER_TOTAL_LIMIT_REACHED`.
- Create/activate beyond public capacity returns `409 SLIDER_ACTIVE_LIMIT_REACHED`.
- Concurrent mutations must serialize through writes to global metadata and relevant asset/slider records so limits cannot be bypassed by races.

## 2. Shared managed-asset registry foundation

### 2.1 Collections

Create reusable collections:

```text
managedassets
managedassetreferences
```

A managed asset record contains:

```json
{
  "_id": "<ObjectId>",
  "canonicalPath": "/uploads/covers/example.webp",
  "folder": "covers",
  "filename": "example.webp",
  "format": "webp",
  "size": 123456,
  "width": 1920,
  "height": 1080,
  "state": "available",
  "referenceCount": 1,
  "acquisitionFenceVersion": 7,
  "publishedAt": "...",
  "deletingAt": null,
  "deletedAt": null,
  "updatedAt": "..."
}
```

Allowed states in this phase:

- `available`: new references may be acquired.
- `deleting`: no new reference may be acquired; filesystem removal is pending or complete.

A reference record contains:

```json
{
  "_id": "<ObjectId>",
  "assetId": "<ObjectId>",
  "canonicalPath": "/uploads/covers/example.webp",
  "resourceType": "slider",
  "resourceId": "<slider ObjectId>",
  "field": "image",
  "createdAt": "..."
}
```

The schema is resource-neutral. Phase one permits slider writes, but does not hard-code slider-specific assumptions into registry helpers.

### 2.2 Upload publication and registration

The existing content-authoritative image pipeline remains authoritative. Successful new uploads must also create a registry record.

Fail-safe ordering:

1. validate, decode, re-encode, and stage the file privately;
2. atomically publish the final filesystem path;
3. insert the unique registry record as `available` with `referenceCount: 0`;
4. return success only after registry insertion succeeds.

If registry insertion fails, attempt idempotent unlink of the newly published file. A failed cleanup leaves an unregistered orphan, which is not referenceable and is reported by readiness. The protocol must never create an `available` registry record before its final file exists.

A manually placed or historical file is not automatically registered.

### 2.3 Slider reference acquisition and release

Inside the same MongoDB transaction as the slider mutation:

- Verify the asset record exists, is `available`, belongs to `covers`, and its canonical path exactly matches the submitted image.
- Verify the final file exists. A missing file is an integrity error and prevents the mutation.
- Insert the unique slider reference and increment `referenceCount` when acquiring.
- For registry-managed slider images, delete the exact slider reference and decrement `referenceCount` when releasing.
- Treat duplicate acquisition of the same exact reference as idempotent only within proven replay/recovery; ordinary contract execution must not mask reference-count drift.
- Reject underflow, missing expected references for a registry-managed image, duplicate reference rows, or count mismatches with `503 MANAGED_ASSET_REGISTRY_UNAVAILABLE` and no domain mutation.

Mutation behavior:

- Create acquires one image reference.
- Update with a changed image acquires the new reference and releases the old reference atomically.
- Update with unchanged image does not alter registry state.
- Archive releases the image reference when the stored image maps to a registered asset or migration evidence marks it registry-managed. For a proven legacy-unmanaged image with no registry record/reference, archive performs no decrement and records `managedReferenceReleased: false` plus the legacy classification in audit. A registered-asset/reference inconsistency remains a fail-closed registry error.
- Restore reacquires the stored image reference and fails if the asset is absent, not registered, missing on disk, or `deleting`.
- Reorder and status/name/link-only changes do not alter references.

### 2.4 Legacy image compatibility

- Legacy image values remain readable in admin and public snapshots.
- Unrelated edits may preserve an unchanged legacy image so administrators are not forced into an unreviewed migration.
- Any explicit image change must choose a registered, available `/uploads/covers/...` asset.
- Restore always requires reference acquisition, so an archived legacy image must be explicitly registered/migrated before restore can succeed.
- Reads never silently register files or create reference rows.

### 2.5 Upload deletion gate

Upload deletion must satisfy both the new registry and the existing legacy reference scan:

1. authorize the upload folder using existing permission mappings;
2. start a MongoDB transaction;
3. load the exact registry record;
4. require `state == available`;
5. require `referenceCount == 0` and no actual reference rows;
6. run the existing database scan for resource types not yet migrated to the registry;
7. atomically transition `available -> deleting`;
8. commit;
9. idempotently unlink the filesystem file;
10. record completion or leave a reconciliation-safe `deleting` record.

A registry reference acquisition and deletion both write the asset record, so MongoDB transaction conflict handling prevents races with migrated writers. The legacy scan alone does not fence concurrent writes by non-migrated resource types. Before registry-backed deletion is enabled for a folder, every active writer that can newly persist a path from that folder—including current cover consumers such as slider/banner/content writers discovered by the readiness inventory—must participate in a shared acquisition gate: in the same transaction as its resource write, it atomically increments the dedicated monotonic `acquisitionFenceVersion` on the corresponding `managedassets` record, conditional on `state == available`. These legacy writers neither create reference rows nor alter `referenceCount` in phase one; the existing scan remains their durable reference evidence. Deletion's conditional `available -> deleting` transition writes the same asset document. A transaction-conflict retry of deletion must restart the transaction and rerun the legacy reference scan; it may not reuse the previous scan result. If any writer for a folder cannot participate transactionally, deletion for that folder returns `503 MANAGED_ASSET_REGISTRY_UNAVAILABLE` until the writer is migrated, disabled, or the folder deletion feature remains disabled.

If a legacy resource already references the path, deletion returns `409 ASSET_IN_USE`. If filesystem unlink fails after the database decision, the asset remains `deleting`, cannot be newly referenced, and appears in the reconciliation backlog.

## 3. Validation policy

### 3.1 Normative normalization

- Text fields use Unicode NFC, never compatibility normalization. Trimming occurs before NFC for fields whose contract trims surrounding whitespace, and all character/byte limits are measured on the persisted NFC value.
- Node performs bounded syntax/type screening but does not rewrite slider strings or compute the authoritative payload digest. Rust performs authoritative normalization, persistence, and canonical-digest construction.
- Image paths are not URL-decoded and re-encoded into canonical form. The submitted trimmed NFC string must already exactly equal the path emitted by the shared Rust managed-path canonicalizer.
- Internal links use trimmed NFC text. Query parameter order, duplicate query parameters, fragment text, and valid non-dangerous percent escapes are preserved byte-for-byte. Percent syntax must be valid; encoded separators, backslashes, control bytes, and literal/encoded dot traversal are rejected. Semantically similar but byte-different safe internal links remain distinct persisted values and distinct idempotency payloads.
- External links are parsed and serialized authoritatively with the pinned Rust `url` crate. The normalized serializer lowercases the scheme/host, removes an explicit default HTTPS port, emits the serializer's canonical path/trailing slash and percent encoding, and preserves query order/duplicates and fragment according to that serializer. The resulting string is persisted and included in the idempotency digest.
- Shared Node/Rust conformance fixtures cover combining characters, multibyte boundaries, percent-escape case, encoded traversal/separators, default HTTPS ports, credentials, duplicate query parameters, empty paths, and trailing slashes. Node may reject an obviously invalid request but must not accept as mutation-authoritative a value Rust rejects.

### 3.2 Name

- Required after Unicode-aware trimming.
- Maximum 120 Unicode scalar values and 480 UTF-8 bytes after normalization.
- Reject NUL and control characters.
- Persist the normalized trimmed value.

### 3.3 Image

For new/changed image values:

- Required.
- Maximum 2048 UTF-8 bytes after normalization.
- Must exactly match canonical form `/uploads/covers/<safe filename>`.
- Reject other upload folders, bundled paths, external URLs, query/fragment components, percent-encoded separators/traversal, backslash, control characters, dot segments, and noncanonical encodings.
- Filename validation reuses the hardened managed-asset canonicalization policy.
- Registry and filesystem checks remain authoritative; syntax alone is insufficient.

### 3.4 Link

Link may be empty, a safe internal path, or an HTTPS URL.

Internal path rules:

- Starts with exactly one `/`.
- Rejects `//`, backslash, control characters, NUL, encoded separators, encoded or literal dot traversal, and malformed percent encoding.
- May include a canonical query and fragment after safe path validation.
- Must not be parsed as an external/protocol-relative URL.

External URL rules:

- Scheme is exactly `https:`.
- Hostname is present and valid.
- Username and password are absent.
- Control characters and malformed encodings are rejected.
- The complete normalized link is at most 2048 UTF-8 bytes.
- `http:`, `javascript:`, `data:`, `file:`, protocol-relative, and malformed URLs are rejected.

Historical invalid/HTTP links remain visible as legacy-invalid in reads, but any save of that slider must submit a valid replacement or empty link.

### 3.5 Status and payload shape

- `status` must be a literal JSON boolean.
- Unknown fields are rejected.
- Object IDs must be exact valid MongoDB ObjectId strings.
- `expectedRevision` must be a nonnegative integer.
- Reorder values must be exact nonnegative integers and exactly cover all current slider IDs once.
- Slider JSON mutation bodies are capped at 64 KiB at Node and Rust. Multipart upload ceilings remain governed by the existing hardened upload policy.
- Reorder contains at most 20 entries because it covers the bounded current collection.

## 4. Admin read contracts and compatibility gate

### 4.1 Main snapshot

```http
GET /api/v2/sliders/admin/all
```

```json
{
  "mutationContract": "slider-revision-v1",
  "revision": 14,
  "sliders": [],
  "limits": {
    "total": 20,
    "active": 8,
    "currentTotal": 8,
    "currentActive": 5,
    "remainingTotal": 12,
    "remainingActive": 3
  }
}
```

Only current/non-archived sliders appear in `sliders`.

### 4.2 Archive snapshot

```http
GET /api/v2/sliders/admin/archived
```

The response uses the same `mutationContract`, revision, and limit metadata and returns only archived records.

Both endpoints:

- require `manageSettings` at Node and Rust;
- return a self-consistent bounded revision snapshot;
- expose lifecycle/archive metadata needed by the archive UI;
- never expose idempotency claims or registry internals.

### 4.3 Split-deploy protection

The exact marker `mutationContract: "slider-revision-v1"` is required before the new client enables mutation controls.

- If an old backend returns a legacy array or lacks the exact marker, the new client may render compatible read-only data but must disable all slider writes.
- The UI displays “Backend slider belum siap untuk mutasi revisioned” rather than attempting a legacy payload.
- The client must not fall back to old create/update/delete/reorder contracts.
- Gateway/Rust readiness is checked before client deployment in rollout.

This prevents a recurrence of a new client being served against an old mutation backend.

## 5. Mutation API contracts

Every mutation requires:

```http
Idempotency-Key: <8..128 chars from A-Za-z0-9._->
Content-Type: application/json
```

### 5.1 Create

```http
POST /api/v2/sliders/admin/create
```

```json
{
  "expectedRevision": 14,
  "slider": {
    "name": "Promo",
    "image": "/uploads/covers/example.webp",
    "link": "/promo",
    "status": false
  }
}
```

### 5.2 Update and status

```http
PUT /api/v2/sliders/admin/:id
```

```json
{
  "expectedRevision": 14,
  "changes": {
    "name": "Promo Baru",
    "image": "/uploads/covers/new.webp",
    "link": "https://partner.example/promo",
    "status": true
  }
}
```

Only explicitly changed fields are submitted. Empty `changes` is rejected as a no-op rather than consuming a revision.

### 5.3 Archive

```http
POST /api/v2/sliders/admin/:id/archive
```

```json
{ "expectedRevision": 14 }
```

Archive removes the public/current record, releases its asset reference, compacts current ordering, writes audit, and increments revision atomically.

### 5.4 Restore

```http
POST /api/v2/sliders/admin/:id/restore
```

```json
{ "expectedRevision": 14 }
```

Restore reacquires the asset reference, restores the record as a nonactive draft, appends it to current ordering, writes audit, and increments revision atomically.

### 5.5 Reorder

```http
PUT /api/v2/sliders/admin/reorder
```

```json
{
  "expectedRevision": 14,
  "orders": [
    { "id": "...", "sortOrder": 0 },
    { "id": "...", "sortOrder": 1 }
  ]
}
```

The payload must exactly cover every current slider and produce contiguous `0..n-1` ordering.

### 5.6 Closed legacy mutation routes

```text
DELETE /api/v2/sliders/admin/:id
  -> 405 SLIDER_HARD_DELETE_DISABLED

PUT /api/v2/sliders/admin/sort-order
  -> 405 SLIDER_LEGACY_REORDER_DISABLED
```

There is no permanent purge endpoint in this scope. Legacy Node slider mutation routes remain inactive and must not be reintroduced as fallback surfaces.

## 6. Permanent idempotency

### 6.1 Claim collection

Use `slideridempotencyclaims` with a permanent unique key index and no TTL.

A claim records:

- normalized key;
- contract version;
- operator ID;
- action: `create | update | archive | restore | reorder`;
- target ID when applicable;
- expected revision;
- canonical payload digest;
- state and lease generation;
- claim token;
- `claimedAt`, `leaseExpiresAt`;
- `transactionStartedAt`;
- `commitUnknown`;
- result status, revision, audit event ID, and frozen response;
- completion timestamps.

Use a five-minute lease for pre-transaction claims. Only stale claims with no `transactionStartedAt` and no `commitUnknown` may be reclaimed. Before setting `transactionStartedAt`, generate and durably store immutable recovery identifiers on the claim: candidate slider ID for create, audit event ID, and candidate result revision `expectedRevision + 1`. Immediately before opening the write transaction, durably fence the claim with `transactionStartedAt`, recovery identifiers, lease generation, and claim token in a majority-acknowledged conditional write. Once this fence is durable, the claim is never reclaimable even if the process fails before the first domain write; recovery must prove completion or preserve a conservative nonretryable outcome.

### 6.2 Canonical binding

The SHA-256 digest covers canonical JSON containing:

- contract version;
- action;
- operator ID;
- target ID or explicit null;
- expected revision;
- normalized mutation payload.

Object keys are sorted; numbers, booleans, nulls, arrays, and normalized strings have one deterministic representation. Raw browser formatting does not affect the digest.

Behavior:

- Same key, same binding, same digest, completed result: replay the frozen result.
- Same key but any binding/digest difference: `409 IDEMPOTENCY_CONFLICT`.
- Same binding with a currently leased pre-transaction claim: `409 IDEMPOTENCY_IN_PROGRESS`.
- Same binding after commit becomes unprovable: `503 SLIDER_COMMIT_UNKNOWN`.

Frozen responses are bounded to 256 KiB. Stored fields include status, revision, data/error, audit ID, and `replayed: false`. Replay changes only derived `replayed` to `true`.

### 6.3 Step-up retry and claims

A missing step-up proof must not cause a new intent/key.

- Before setting `transactionStartedAt`, Rust performs an authoritative read-only transaction that validates `expectedRevision`, loads the relevant state, and computes effective sensitivity.
- If trusted step-up is missing, abort the read-only transaction, leave the claim pre-transaction/resumable, and return `403 AUTH_STEP_UP_REQUIRED` with `actionGroup: settings.sensitive`.
- After proof is supplied, resume the same claim/key, repeat the authoritative read-only preflight, then durably set the transaction-start fence immediately before the write transaction.
- The write transaction revalidates revision and sensitivity. Because every slider mutation increments the global revision, unchanged revision proves the preflight state relevant to sensitivity has not changed. A changed revision returns the frozen version conflict; it must not discover a new step-up requirement after the permanent fence.
- The shared client step-up orchestrator preserves the exact `Idempotency-Key` on retry.

## 7. Transaction and commit protocol

### 7.1 Precondition gates

Before protected writes:

- authenticate and revalidate active account at Node and Rust;
- require `manageSettings` at both layers;
- validate CSRF/credential-cookie and trusted proxy boundaries at Node;
- strip all browser-supplied trusted/step-up headers;
- validate idempotency key and normalized payload;
- verify exact indexes and registry readiness;
- verify MongoDB transaction capability.

Unavailable gates return before any slider, reference, metadata, audit, or final claim result is written.

### 7.2 Transaction sequence

The protocol has two bounded transaction phases under one permanent claim; only the second phase may write domain state:

1. Run the authoritative read-only revision/sensitivity preflight transaction from §6.3. If it returns step-up required or version conflict, no transaction-start fence or domain write occurs.
2. After preflight succeeds with any required proof present, generate/store recovery identifiers and durably set `transactionStartedAt` using a majority-acknowledged conditional fence.
3. Open the single domain write transaction. Within that write transaction:

   1. re-verify the exact claim token, binding, lease generation, recovery identifiers, and durable transaction-start fence;
   2. read global metadata and relevant slider/current-order snapshot in session;
   3. compare authoritative revision to `expectedRevision`;
   4. recompute normalized effective changes and public sensitivity; unchanged revision must reproduce the preflight sensitivity decision;
   5. verify trusted `settings.sensitive` proof when required;
   6. enforce total/active limits;
   7. acquire/release managed-asset references as required;
   8. write slider lifecycle/data/order changes using the preallocated candidate slider ID where applicable;
   9. increment global revision exactly once to the candidate result revision;
   10. write sanitized domain audit with the preallocated audit event ID, claim identifier, before/after, and public impact;
   11. finalize the idempotency claim with bounded frozen result;
   12. commit.

There is no manual rollback fallback and no second execution of the domain mutation.

### 7.3 Optimistic conflict

A stale revision returns:

```http
409 SLIDER_VERSION_CONFLICT
```

```json
{
  "error": {
    "code": "SLIDER_VERSION_CONFLICT",
    "message": "Daftar slider telah berubah",
    "currentRevision": 15,
    "currentSnapshot": {
      "mutationContract": "slider-revision-v1",
      "revision": 15,
      "sliders": [],
      "limits": {}
    }
  },
  "replayed": false
}
```

The conflict is frozen for the current idempotency key. Rebase against a new snapshot creates a new key.

### 7.4 Effective step-up policy

Rust, not the browser, decides sensitivity from the effective in-session state.

Requires `settings.sensitive`:

- create with `status: true`;
- activation from false to true;
- changing name, image, or link while the slider is currently public;
- archive of a currently public slider;
- reorder that changes the relative order of public sliders.

Does not require step-up:

- create as a nonactive draft;
- edit a nonactive slider without activating it;
- deactivate a slider;
- archive a nonactive slider;
- restore as a nonactive draft;
- reorder that changes only draft placement while preserving the relative order of all public sliders.

Unchanged submitted values are no-ops and do not create sensitivity.

### 7.5 Commit ambiguity

Use bounded MongoDB commit retry only for labels/documented conditions where retrying the commit phase is safe. Never rerun the mutation closure blindly.

All domain and audit rows written by the transaction use the claim's preallocated recovery identifiers and include a nonsecret cryptographic claim identifier. Recovery proves the outcome through exact agreement among:

- claim token, binding, and lease generation;
- expected and candidate result revision;
- candidate slider ID/target and action-specific resulting state;
- preallocated audit event ID plus matching claim identifier, action, actor, revision, and target;
- frozen response presence.

After an ambiguous commit, recovery first performs a majority read of the claim. A completed bounded frozen result is primary proof and is replayed. An audit row alone is supporting proof only when all preallocated identity/binding fields and corresponding domain/revision state also match; audit alone never authorizes a new mutation.

If bounded investigation cannot prove the result, marking `commitUnknown` is allowed only through a majority-acknowledged conditional update matching the exact claim token, binding, lease generation, `transactionStartedAt`, incomplete state, and absence of a frozen result. If the conditional update does not match, reread and replay a completed result or continue bounded investigation; never overwrite a completed claim. A crash after the durable fence remains permanently nonreclaimable even when majority reads establish absence of all candidate domain, audit, and revision effects. Such evidence may classify the claim as a proven non-commit for operator reconciliation, but it must never authorize execution of the same claim/key again.

Once marked unknown:

- keep the claim permanently fenced;
- return `503 SLIDER_COMMIT_UNKNOWN`;
- do not allow same-key mutation execution again;
- require operator reconciliation through latest snapshot and audit.

## 8. Audit and observability

### 8.1 Transactional domain audit

Write a Rust domain audit record in the same transaction as the slider mutation. Gateway audit remains a separate row.

Record:

- action and target slider;
- revision before/after;
- normalized before/after state;
- changed fields;
- lifecycle/status and public impact;
- old/new ordering or ordering digest;
- managed references acquired/released;
- hashed idempotency key, never raw key;
- actor ID/role;
- correlation/trace ID;
- audit event ID used by commit recovery;
- result/replay/commit-unknown evidence.

Use the shared Rust audit sanitizer. Never persist authorization headers, cookies, passwords, OTPs, TOTP secrets, step-up grants, raw idempotency keys, or upload file bytes.

### 8.2 Metrics and alerts

Emit bounded metrics/log events for:

- transaction/index/registry unavailable;
- version conflicts;
- idempotency conflicts and in-progress claims;
- commit unknown;
- limit rejections;
- managed reference mismatch/underflow;
- assets stuck deleting;
- unlink reconciliation backlog;
- broken legacy images;
- public snapshot instability.

## 9. Public slider contract and freshness

### 9.1 Response

```http
GET /api/v2/sliders
If-None-Match: "sliders-14"
```

A `200` response remains an array:

```json
[
  {
    "_id": "...",
    "name": "Promo",
    "image": "/uploads/covers/example.webp",
    "link": "/promo"
  }
]
```

Public DTO omits:

- `status`;
- `lifecycle`;
- `sortOrder`;
- `createdAt`/`updatedAt`;
- archive, actor, registry, and audit metadata.

The endpoint returns at most eight current/public sliders, ordered by `sortOrder` and `_id` as a defensive tie-breaker.

### 9.2 ETag

```http
ETag: "sliders-14"
Cache-Control: no-cache
```

- ETag derives only from authoritative global revision.
- Exact strong match returns `304` with ETag/cache headers and no body.
- Parse `If-None-Match` as an HTTP entity-tag list. Return `304` when at least one syntactically valid list member is the exact strong current tag. Weak members, wildcard, malformed members, zero-padded alternatives, and different revisions do not match; malformed list content never broadens a match.
- Node forwards `If-None-Match`, `ETag`, `304`, and `Cache-Control` without response-body caching.
- Every mutation increments global revision, including draft-only changes; an unchanged public array may therefore receive a new ETag. This simplicity is intentional.

### 9.3 Legacy disclosure

Reads do not mutate storage.

- Legacy image values remain in the response to avoid silently removing existing campaigns.
- Invalid/HTTP historical links are disclosed publicly as an empty string and never rendered as anchors.
- Missing/broken images are handled by the client fallback.
- Readiness continues reporting legacy findings until explicit migration/repair.

## 10. Homepage carousel behavior

### 10.1 Interaction layers

- Only the active slide is interactive.
- Inactive slides are `inert`, `aria-hidden="true"`, and absent from sequential focus navigation.
- Decorative overlays use `pointer-events-none`.
- The optional slider destination has a clear banner click layer.
- Generic homepage CTA controls remain above the banner layer and execute only their own action.
- External links use `_blank` with `noopener noreferrer`; internal links stay same-origin.
- Slider name supplies image alt/accessibility labeling.

### 10.2 Rotation and controls

- Default interval is five seconds.
- Pause while pointer hovers or keyboard focus is within the carousel.
- Provide accessible Pause/Play.
- `prefers-reduced-motion: reduce` disables automatic rotation by default.
- Manual previous/next/indicator/swipe navigation resets timing deterministically.
- Previous/next and indicators are usable on desktop and mobile.
- Touch swipe must not block ordinary vertical page scrolling.
- Announce manual/current slide changes through a polite live region without announcing every unattended transition aggressively.
- Normalize `currentSlide` whenever slider count changes.

### 10.3 Failure and fallback

- Fetch failure preserves local default slides.
- A successful empty public array also uses default slides.
- Broken remote/legacy images render a named fallback banner rather than disappearing.
- Invalid links never produce anchors.
- Public response compatibility remains array-based; the carousel does not depend on revision in the response body.

## 11. Admin UX and accessibility

### 11.1 Main and archive views

Provide two views:

```text
Aktif & Draft
Arsip
```

Header/status area shows:

- read-only revision;
- current total/active/nonactive counts;
- remaining total/active capacity;
- stale/conflict state;
- commit-unknown investigation state.

Disable Add when capacity is exhausted and show the reason.

Desktop uses a table. Mobile uses stacked cards with preview, status, target link, order, and visible actions. Mobile exposes Move Up/Down controls; drag may remain an optional reorder mode.

Search/filter disables reorder. The UI explains why and provides Reset. Keyboard drag instructions and position announcements are visible/available to assistive technology.

### 11.2 Form and previews

The add/edit dialog includes:

- name;
- managed cover picker restricted to selecting `covers`;
- empty/internal/HTTPS link;
- active status;
- desktop and mobile crop previews;
- recommended dimensions and safe-area guidance;
- external-link marker;
- explicit summary of public impact.

Client validation provides immediate feedback, but Rust remains authoritative.

### 11.3 Archive and restore

- Archive replaces delete language and explains public/current impact.
- Active archive requires confirmation and step-up.
- Archive releases the asset reference and removes the card from current view only after proven success.
- Archived view exposes Restore.
- Restore explains that the result is always a nonactive draft.
- Restore failure due to missing/unregistered/deleting asset keeps the record archived and gives actionable error text.
- No purge action is shown.

### 11.4 Conflict and uncertain result

On `SLIDER_VERSION_CONFLICT`:

- preserve the draft/dialog;
- compare base, draft, and current server state;
- allow loading latest, reviewing conflicts, applying nonconflicting changes, or discarding the draft;
- use a new key after rebase.

On `SLIDER_COMMIT_UNKNOWN`:

- never show Retry Mutation;
- retain intent only for investigation context;
- display “status belum dapat dipastikan”;
- provide Load Latest Snapshot and Open Audit;
- require a new action/key only after reconciliation.

### 11.5 Errors and synchronization

- Form/API errors render inside the active dialog with `role="alert"`.
- Inputs use `aria-invalid` and `aria-describedby` where applicable.
- Parse nested structured `error.code`/`error.message` and legacy top-level messages during rollout.
- Initial error, stale retained data, empty collection, and no-filter-match are distinct states.
- Successful mutation plus refresh failure is shown as “saved, synchronization failed,” not converted into a false mutation failure.
- Optimistic reorder stores the previous snapshot and rolls back immediately on failure before optional reconciliation fetch.
- Broken image previews show path/filename and an Edit action.

### 11.6 Accessible dialogs and ImagePicker

Every slider dialog:

- has accessible title and description;
- moves initial focus appropriately;
- traps focus;
- closes on Escape unless a protected commit is in progress;
- restores focus to the trigger;
- locks body scroll;
- makes background content inert.

ImagePicker:

- is the sole active modal while open;
- temporarily makes the parent slider dialog inert;
- uses button/radio semantics for image choices;
- announces selection state;
- supports Escape, focus trap, and restoration;
- uses named controls and tabs;
- restricts slider selection to `covers`, even if other folders are browsable;
- surfaces upload/delete errors including `ASSET_IN_USE`;
- replaces generic `confirm()` with a named accessible confirmation dialog.

Icon-only controls receive contextual `aria-label`s. Search/filter have programmatic labels. Loading, saving, reordering, success, and errors use appropriate `aria-busy`, polite status, or assertive alert regions.

## 12. Readiness, migration, and indexes

### 12.1 Readiness tool

Add a dry-run-first binary/command:

```text
slider_managed_asset_readiness
```

Report machine-readable and human-readable findings for:

- cover files without registry records;
- registry records without files;
- duplicate canonical paths;
- current and archived sliders using unregistered assets;
- sliders pointing to missing files;
- legacy/external/wrong-folder/noncanonical images;
- legacy-invalid links;
- missing/duplicate reference rows;
- `referenceCount` mismatch;
- assets stuck `deleting`;
- missing/drifted exact indexes;
- duplicate/invalid slider ordering;
- missing/invalid lifecycle fields;
- missing/malformed global revision;
- more than 20 current or eight public sliders;
- permanent claim integrity findings.

Default is dry-run. Automated `--apply` is allowed only when the parsed database name is exactly `webtopup_task14_dev`. There is no protected-database override in automated verification.

### 12.2 Required indexes

Review and require these semantic indexes:

- `slidermetadata`: the built-in unique `_id` index is the global metadata identity invariant;
- `slideridempotencyclaims`: unique `{ key: 1 }`, with no TTL;
- `slideridempotencyclaims`: nonunique `{ state: 1, leaseExpiresAt: 1 }` for pre-transaction recovery;
- `slideridempotencyclaims`: nonunique `{ commitUnknown: 1, transactionStartedAt: 1 }` for investigation;
- `managedassets`: unique `{ canonicalPath: 1 }`;
- `managedassets`: nonunique `{ state: 1, updatedAt: 1 }` for deletion reconciliation;
- `managedassetreferences`: unique `{ assetId: 1, resourceType: 1, resourceId: 1, field: 1 }`;
- `managedassetreferences`: nonunique `{ resourceType: 1, resourceId: 1, field: 1 }` for release/readiness;
- `managedassetreferences`: nonunique `{ assetId: 1 }` for count verification;
- `sliders`: nonunique `{ lifecycle: 1, status: 1, sortOrder: 1, _id: 1 }` for current/public snapshots.

No unique `sortOrder` index is required: transactionally revision-checked full-list writes and readiness enforce contiguous uniqueness without temporary unique-index collisions during reorder. Existing indexes with the same keys and semantics are accepted regardless of name; incompatible options are reported rather than recreated automatically.

Mutation startup/readiness checks accept semantically equivalent existing indexes where appropriate and must not create production indexes automatically.

Failures:

```text
503 SLIDER_INDEX_UNAVAILABLE
503 SLIDER_TRANSACTIONS_UNAVAILABLE
503 MANAGED_ASSET_REGISTRY_UNAVAILABLE
```

Reads remain available when safe consistent snapshots can still be produced.

### 12.3 Disposable migration sequence

For exact `webtopup_task14_dev` only:

1. run dry-run;
2. upload/register valid JPEG/PNG/WebP cover fixtures through the real pipeline;
3. register eligible historical cover assets explicitly;
4. create slider reference rows for current sliders;
5. reconcile `referenceCount`;
6. create/normalize global metadata at revision zero or reviewed value;
7. create exact indexes;
8. rerun readiness and require clean expected state;
9. enable the new mutation contract.

Do not invent replacement images or links for unsafe historical fixtures. Findings remain until explicitly repaired.

## 13. Test-driven implementation and disposable verification

Every production behavior starts with a failing test and follows RED, GREEN, focused verification, `git diff --check`, and checkpoint commit.

### 13.1 Unit and source-contract tests

Cover:

- name/image/link normalization and limits;
- canonical internal path and HTTPS policy, including shared normalization conformance fixtures;
- canonical payload/digest and claim binding;
- effective sensitivity;
- total/active limits;
- metadata revision and stable snapshots;
- exact ETag matching, including comma-separated lists, weak tags, wildcard, quoted/malformed list members, and zero-padded revisions;
- public DTO/legacy sanitization;
- managed asset/reference transitions, monotonic acquisition-fence increments, and mismatch handling;
- idempotency replay/conflict/in-progress/commit unknown;
- conflict classification and client intent lifecycle;
- nested error mapping;
- homepage carousel state, hidden-slide focus, and reduced motion;
- gateway route order, permission, idempotency, optional step-up, and legacy route closure;
- split-deploy matrix for old/new client, Node, and Rust combinations;
- legacy Node slider mutation routes remain inactive.

### 13.2 Disposable integration

Using marked synthetic fixtures, replica-set MongoDB, real Node/Rust, and hardened real uploads, verify:

- anonymous, denied, inactive, and authorized permission matrix for every admin read/mutation route;
- public read remains anonymous;
- idempotency key required/validated;
- same-key replay and different-digest conflict;
- stale revision conflict with latest snapshot;
- transaction/index/registry unavailable failures with zero domain writes;
- create draft and create active with step-up;
- edit active/nonactive and effective sensitivity;
- activate/deactivate;
- archive/restore and asset reference release/reacquire;
- archive of a proven legacy-unmanaged image without a registry decrement, with audit evidence;
- restore failure for missing/deleting/unregistered asset;
- reorder and draft-only/public-sensitive reorder classification;
- 20/8 limits under concurrency;
- concurrent create/reorder/archive and deterministic contiguous order;
- in-use upload deletion and race closure for slider acquisition plus every discovered active non-slider `covers` writer incrementing `acquisitionFenceVersion`, with at least one real concurrent integration race and deletion retry rerunning the legacy scan;
- fail-closed deletion when any writer for the protected folder cannot participate in the fence;
- transactional domain audit before/after;
- response loss after commit followed by same-key replay;
- ambiguous create using its preallocated candidate ID;
- completed claim becoming visible while recovery attempts a conditional `commitUnknown` update;
- crash after durable fence but before write transaction start;
- commit unknown permanently fenced;
- public DTO, ETag, malformed validators, `304`, and immediate revalidation;
- unlink failure and reconciliation-safe `deleting` state.

All slider smoke fixtures use uploaded JPEG/PNG/WebP. Remove the invalid SVG assumptions from mutation smoke.

### 13.3 Disposable-only fault seams

Faults are compiled/activated only when all existing local-verification guards pass, including exact database `webtopup_task14_dev` and `LOCAL_DEV_VERIFICATION=true`.

Required seams:

- transaction unavailable;
- failure before transaction start;
- failure after registry write;
- failure after slider/order write;
- audit failure;
- commit unknown;
- response loss after commit;
- frozen response oversize;
- reference-count mismatch;
- filesystem unlink failure;
- concurrent revision conflict;
- create/order/limit contention.

No fault seam may be reachable in production.

### 13.4 Playwright desktop and mobile

Verify:

- navigation visibility and permission denial;
- backend compatibility marker/read-only gate;
- loading, stale, empty, filter-empty, and retry states;
- create draft and publish with confirmation/step-up;
- edit active slider and nested ImagePicker;
- archive/restore;
- conflict draft preservation and rebase;
- commit-unknown investigation state with no mutation retry;
- desktop table and mobile cards;
- Move Up/Down and keyboard drag ordering;
- dialog focus trap, Escape, restoration, background inert, and live regions;
- image selection via keyboard;
- homepage banner click layers, external rel, inactive-slide focus exclusion, pause/play, reduced motion, mobile controls/swipe, and broken-image fallback.

### 13.5 Verification commands

The implementation plan must identify focused commands per task and conclude with the full disposable lifecycle. At minimum:

```bash
npm run test:dev-verify:unit
cd rust-api && cargo test
cd client && npm run build
cd server && npm run build
npm run dev-verify -- test
```

`cargo fmt --check` remains unavailable while `rustfmt` is not installed; do not install it without approval. The full disposable run must end with `LOCAL DEV VERIFIED` and teardown must report `serviceCount: 0` before completion is claimed.

## 14. Rollout and rollback

Production rollout remains a separate approval-gated operation:

1. complete backup and restore drill;
2. run production readiness dry-run only after explicit approval;
3. review every finding;
4. separately approve the exact production registration, repair, and index operations;
5. execute only those approved operations, rerun readiness dry-run, and require every mutation-blocking finding to be clear;
6. deploy upload publication registration and the deletion/acquisition fencing code in disabled or backward-compatible mode; verify new uploads receive registry records while unsafe deletion remains fail closed;
7. deploy Rust read support while keeping `mutationContract` absent and all new mutation routes fail closed;
8. deploy/restart Node forwarding, legacy route closures, idempotency/step-up/header handling, and capability-marker forwarding; verify old mutation requests receive explicit `405`/compatibility failures and cannot reach legacy implementations;
9. enable Rust `mutationContract: slider-revision-v1` only after Rust, Node, indexes, registry data, transactions, and upload fencing all pass readiness;
10. deploy the client only after observing the exact marker through the production gateway;
11. run authenticated read smoke;
12. run explicitly approved guarded synthetic mutation smoke;
13. verify public ETag/carousel behavior;
14. monitor conflicts, commit unknown, registry reconciliation, and audit.

Do not deploy the client mutation contract alone. Client writes remain disabled until the exact backend marker is present.

Rollback rules:

- Never delete permanent claims, revision metadata, managed-asset records, references, or audit evidence.
- If writes must be disabled, keep safe reads available and make mutations fail closed.
- Do not reactivate legacy best-effort mutation routes.
- A rollback must not convert `commitUnknown` claims into retryable claims.
- Files in `deleting` remain fenced until reconciliation proves safe completion.

## 15. Explicitly out of scope

- Slider scheduling or start/end windows.
- Click/impression analytics.
- Visual history/rollback UI.
- Permanent purge of archived sliders.
- Automatic production migration or repair.
- Full migration of products, articles, popup banners, flash sales, taxonomy, rewards, payment resources, or other managed-upload consumers to registry references.
- General redesign of the homepage outside carousel correctness/accessibility.
- CDN/image transformation service.
- Arbitrary external slider images.
- A new permission name; `manageSettings` remains authoritative.

## 16. Acceptance criteria

The foundation is complete only when:

- every slider mutation is transaction-only, revision-checked, permanently idempotent, and atomically audited;
- unavailable transactions/indexes/registry fail closed with zero domain writes;
- same-key/same-binding replay is stable and different binding conflicts;
- ambiguous commit is permanently fenced and cannot duplicate an action;
- limits and ordering remain valid under concurrency;
- archive/restore and asset reference transitions are atomic;
- upload deletion cannot race with slider reference acquisition;
- public reads use authoritative ETag revalidation and disclose only approved fields;
- legacy unsafe reads do not silently mutate storage;
- new writes enforce managed covers and internal/HTTPS links;
- admin and ImagePicker dialogs meet keyboard/focus requirements;
- homepage hidden slides cannot receive focus and rotation is pausable/reduced-motion aware;
- desktop/mobile disposable integration and Playwright scenarios pass;
- full disposable verification reports `LOCAL DEV VERIFIED` and teardown `serviceCount: 0`;
- no production scan, migration, index, restart, deployment, or repair occurred without separate approval.
