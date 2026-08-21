# Digiflazz Seller Center Design

**Date:** 2026-08-20
**Status:** Approved for implementation planning

## Goal

Create one private **Digiflazz Seller Center** for administrators who sell local catalog products through Digiflazz, with IRS presented only as a Digiflazz-specific compatibility integration. Remove duplicate admin entry points, make IRS orders execute the mapped product instead of merely echoing request status, and prevent seller credentials/signatures from being stored or returned while preserving both public seller API contracts.

## Product Positioning

- Digiflazz Seller Center is a private admin capability for Digiflazz selling operations; it is not a generic multi-provider marketplace.
- The canonical admin path is `/admin/addons/digiflazz-seller-center`.
- The sidebar and Add Ons catalog contain exactly one entry/card named **Digiflazz Seller Center**.
- Digiflazz Seller is the primary selling protocol.
- IRS is an integration inside Digiflazz Seller Center because it reuses the same product mappings and exists only for this selling workflow. IRS is not shown as a peer Add On or standalone sidebar menu.
- Future non-Digiflazz seller providers are outside this release and must not be forced into this information architecture.

## Admin Information Architecture

The Seller Center has one overview and four operational sections:

1. **Ringkasan**
   - Digiflazz Seller readiness;
   - IRS integration readiness;
   - shared active mapping count;
   - Digiflazz and IRS order counts requiring attention;
   - callback/retry health for Digiflazz.
2. **Konfigurasi Seller**
   - existing Digiflazz Seller credentials, endpoint, whitelist, margin, and callback settings.
3. **Mapping Produk**
   - the existing `digiflazzsellerproductmaps` inventory;
   - one mapping remains authoritative for both Digiflazz Seller and IRS;
   - IRS does not gain separate mapping mutations.
4. **Order & Callback**
   - existing Digiflazz Seller order, log, callback retry, and scheduler operations.
5. **Integrasi IRS**
   - IRS readiness and credentials;
   - endpoint and whitelist configuration;
   - IRS order and sanitized log views;
   - explicit copy that mappings are managed in **Mapping Produk**.

The active section is URL-addressable through an allowlisted `section` query parameter. Unknown values fail closed to `overview`.

## Navigation and Compatibility

- Canonical route: `/admin/addons/digiflazz-seller-center`.
- Legacy admin routes remain as redirect-only compatibility paths:
  - `/admin/addons/digiflazz-seller` redirects with `replace` to `/admin/addons/digiflazz-seller-center?section=overview`;
  - `/admin/addons/irs-seller` redirects with `replace` to `/admin/addons/digiflazz-seller-center?section=irs`.
- Redirects do not render duplicate page implementations.
- `ADMIN_NAV_BLUEPRINT` remains the source of truth for sidebar identity and permission resolution.
- Sidebar order/pin preferences remain top-level only; no unsupported submenu-preference migration is introduced. The canonical blueprint itself guarantees exactly one Seller Center child and no standalone IRS child.
- Route header metadata uses title **Digiflazz Seller Center** and identifies IRS as an integration section, not a separate Add On.
- The global `admin:refresh-current-page` action refreshes the currently active Seller Center section. Pure local refresh buttons are removed. Mutating actions such as mapping sync, callback retry, and save remain available because they are not duplicate refresh affordances.

## Add Ons Summary

The Add Ons page renders one **Digiflazz Seller Center** card. It includes separate compact status rows, not separate cards:

- **Digiflazz API:** `ready | needs_setup | attention | unavailable`;
- **IRS integration:** `ready | disabled | needs_setup | attention | unavailable`;
- shared active mapping count.

A failed status source is `unavailable`; it must not be converted to unconfigured, zero mappings, or healthy. The card links only to the canonical Seller Center route.

## Private Summary Contract

Add a read-only admin endpoint:

```text
GET /api/v2/digiflazz-seller/center-summary
```

It remains behind `authenticate + manageVendors` at the Node gateway and trusted proxy context in Rust. It returns a typed, non-secret response:

```json
{
  "ok": true,
  "partial": false,
  "issues": [],
  "generatedAt": "2026-08-20T00:00:00.000Z",
  "digiflazz": {
    "configured": true,
    "ready": true,
    "status": "ready",
    "orders": { "total": 0, "pending": 0, "failed": 0, "callbackPending": 0 }
  },
  "irs": {
    "enabled": false,
    "configured": true,
    "ready": false,
    "status": "disabled",
    "orders": { "total": 0, "pending": 0, "failed": 0 }
  },
  "mappings": { "total": 0, "active": 0 }
}
```

Stable issue codes are:

- `SELLER_CONFIG_UNAVAILABLE`
- `IRS_CONFIG_UNAVAILABLE`
- `SELLER_MAPPING_SUMMARY_UNAVAILABLE`
- `SELLER_ORDER_SUMMARY_UNAVAILABLE`
- `IRS_ORDER_SUMMARY_UNAVAILABLE`
- client-only `MALFORMED_SELLER_CENTER_RESPONSE`

Core Mongo absence returns structured `503` with `ok:false`. Auxiliary aggregate failure retains usable data with `partial:true`, an issue code, and the affected status `unavailable`. Mongo errors and stored values are never included.

## Public API Compatibility

These public paths remain canonical and unchanged:

```text
POST /api/v2/digiflazz-seller/prepaid
POST /api/v2/irs-seller/prepaid
```

Requirements:

- no rename or new public alias;
- request field compatibility is retained;
- the existing Digiflazz and IRS response envelopes/field names are retained;
- no admin authentication is added to either public seller endpoint;
- channel credential/signature and IP checks remain channel-specific;
- public operational/storage failures return channel-compatible generic failure messages and never reveal Mongo configuration or internal errors.

The Rust modules and Mongo collections remain channel-specific. Seller Center is a private admin composition layer, not a merged public protocol or merged order collection.

## IRS Fulfillment Correctness

An authenticated, valid, non-duplicate IRS request must use the shared active `digiflazzsellerproductmaps` mapping and execute the referenced local product:

1. validate required request fields, source IP, and IRS credentials;
2. claim `refId` idempotently;
3. load the active shared mapping and active product;
4. create one pending IRS order in `ready` execution state, or load the existing order;
5. allow any request that observes `ready` to compete for one atomic `ready -> executing` claim; requests observing `executing` or `completed` return the persisted outcome without supplier execution;
6. execute paid validation when the product has validation configuration, otherwise call the existing supplier fulfillment path used by transactions;
7. persist `success | failed | pending`, message, SN, and supplier transaction identifier where available;
8. return the established IRS response envelope translated from the persisted outcome;
9. repeated/concurrent `refId` requests can recover an unclaimed `ready` order but never execute fulfillment twice after one request holds the `executing` claim.

Database errors must not become “Produk tidak ditemukan,” an empty list, or a successful/pending synthetic order. A failure before a durable idempotent claim returns the channel-compatible generic failure response without calling a provider. Tests must use local/disposable fixtures and may not call a real provider.

Exact unique indexes are required for `digiflazzsellerorders.refId` and `irssellerorders.refId`. Startup must not create them blindly. The hygiene tool audits duplicates/index readiness first; production index application is a separately approved operational action.

## Credential and Payload Secrecy

The following values are sensitive and must never be persisted in raw seller request fields, returned by admin APIs, logged, exported, or retained in verification reports:

- Digiflazz `sign` and API key;
- IRS `password`/`pass`, `pin`, `secret`, `sign`, credential aliases, and formatter secrets;
- authorization/session/step-up tokens and cookies;
- raw request bodies containing any of the above.

New behavior:

- Digiflazz and IRS order documents store only explicit operational fields already needed for reconciliation; new writes do not store `rawRequest`.
- Digiflazz and IRS request/event logs store explicit safe metadata only; new writes do not store `raw`.
- Admin order/log handlers use typed allowlist DTOs. They never serialize a Mongo document directly and never expose `raw`, `rawRequest`, credential config, or unknown fields.
- Digiflazz settings reads return `apiKeyConfigured: boolean`, never `apiKeyMasked` or any API-key fragment. IRS settings reads return `merchantId` plus `passwordConfigured`, `pinConfigured`, and `secretConfigured` booleans, never masks or secret fragments. Secret inputs are write-only; blank/omitted secret fields preserve existing values.
- `server/src/app.ts` must not register `digiflazzSellerRoutes` or any other legacy Node seller controller. The live path remains Node gateway → Rust API. Leftover `rawRequest`/`apiKeyMasked` code in unused Node files is not an active API surface and must not be re-enabled.
- IRS credential comparisons use constant-time comparison after exact-length validation.
- Formatter input is bounded and schema-validated before persistence; arbitrary nested credential aliases are not accepted as formatter configuration.

Because Digiflazz Seller currently also retains its request signature in raw data, the secrecy boundary applies to both Digiflazz and IRS historical seller data.

## Historical Hygiene Tool

Add a dry-run-first operational tool for `digiflazzsellerorders`, `irssellerorders`, and seller-provider rows in `webhookeventlogs`.

The safest migration removes redundant legacy `rawRequest` and `raw` fields wholesale; canonical operational fields remain intact. It does not delete orders or logs.

The tool:

- defaults to audit/dry-run;
- reports only database name, collections, scanned count, affected count, modified count, duplicate-ref count, and index readiness;
- never prints document samples, request bodies, credential keys with values, or connection strings;
- permits `--apply` automatically only for exact database `webtopup_task14_dev`;
- for any protected database requires all of:
  - `--apply`;
  - `--allow-protected-database`;
  - `--confirm-database <exact-name>`;
  - `--backup-reference <non-empty-operator-reference>`;
- uses conditional updates so concurrent document changes are not overwritten;
- re-runs the raw-field audit after apply and exits nonzero if sensitive raw fields remain;
- reports duplicate `refId` and unique-index readiness but never creates indexes itself;
- is paired with a separate seller-order readiness binary that refuses unique-index application when duplicate `refId` values or drifted definitions exist;
- neither apply path runs automatically during API startup or deployment; startup is verification-only.

Production execution requires a fresh backup, explicit user approval, dry-run review, apply, post-apply verification, and service smoke checks in a later operation. This design and its implementation do not authorize production mutation.

## IRS Admin Reliability

- IRS settings/config reads distinguish Mongo failure from an absent config.
- Mapping, order, and log reads return explicit storage failure rather than empty arrays.
- Lookup failures distinguish storage failure from a missing mapping/product.
- Order and log insert/update outcomes are checked. A response cannot claim a durable order outcome when persistence failed.
- Admin error envelopes are generic and non-secret.
- Loading, saving, empty, disabled, partial, and unavailable states have distinct Indonesian copy.
- IRS tables are typed and responsive; mobile renders readable cards or an explicitly responsive table rather than relying on truncated generic `any` cells.

## Client Architecture

Create a pure `client/src/lib/digiflazzSellerCenter.ts` module responsible for:

- canonical section constants and query parsing;
- legacy redirect destinations;
- typed summary/settings/order/log parsers;
- fail-closed status normalization;
- Indonesian labels and presentation metadata.

Create `client/src/pages/admin/DigiflazzSellerCenter.tsx` as the shell and section orchestrator. Existing large channel code is split by responsibility:

- `DigiflazzSellerChannel.tsx`: Digiflazz settings, mapping, order/callback operations;
- `IrsSellerIntegration.tsx`: IRS settings, order, and log operations;
- small shared presentation components only where both sections genuinely reuse them.

The shell owns URL section selection, summary loading, global refresh dispatch, latest-request-wins protection, and accessible page status. Child sections own channel-specific mutations.

## Permission and Step-up Boundaries

- Canonical Seller Center page permission remains `manageVendors`.
- Summary, settings reads, mapping administration, logs, and Seller Center operational controls retain their existing authenticated permission boundaries.
- Digiflazz and IRS credential mutations remain exactly `authenticate + manageVendors + requireStepUp('integrations.credentials')` at Node and trusted `integrations.credentials` step-up verification in Rust.
- Existing transaction read boundaries are not widened merely because the UI is consolidated.
- No credential appears in route query parameters or redirect state.
- No new client-selected step-up action group is introduced.

## Accessibility and Refresh

- The canonical page exposes `aria-busy` and a named navigation for Seller Center sections.
- Active section uses `aria-current="page"` or equivalent selected-tab semantics.
- Loading/success feedback uses `role="status"`; failures and partial/unavailable states use `role="alert"` as appropriate.
- Every button has `type="button"` and an accessible name; decorative icons are `aria-hidden="true"`.
- The existing step-up dialogs remain mounted.
- The AdminLayout global refresh button is the only pure refresh control. It refreshes summary plus the active section with latest-request-wins guards.
- No automatic polling is added.

## Testing Strategy

### Rust unit and source-contract tests

- request sanitization omits every sensitive alias;
- admin DTOs omit raw/unknown fields;
- constant-time IRS credential comparison accepts exact valid values and rejects malformed values;
- summary classification and issue aggregation fail closed;
- IRS storage errors differ from business not-found responses;
- idempotent outcome mapping does not trigger a second fulfillment;
- public Digiflazz and IRS response field names remain exact;
- hygiene policy, protected-database CLI guard, duplicate report, and post-apply verification are deterministic.

### Gateway tests

- both public prepaid paths remain public and precede protected catch-alls;
- canonical summary/read routes require `manageVendors`;
- both settings mutations retain exact `integrations.credentials` step-up;
- no standalone IRS admin route weakens permissions.

### Client tests

- canonical and legacy routes resolve to the correct section;
- exactly one Seller Center navigation item exists;
- old menu names normalize without duplicates;
- summary parsing never upgrades malformed/unavailable data to ready;
- global refresh and latest-request-wins remain source-contract tested;
- IRS UI does not contain generic `any` DTO rendering or local pure refresh.

### Disposable integration and browser tests

Use exact database `webtopup_task14_dev` only.

- manager can read Seller Center; denied fixture receives `403`;
- settings mutations require `integrations.credentials` step-up;
- public route envelopes remain compatible;
- malformed/invalid requests never persist credentials or raw bodies;
- historical fixture documents are detected by dry-run, scrubbed by disposable apply, and verified clean;
- admin order/log responses do not contain seeded secrets or unknown fields;
- IRS duplicate `refId` cannot cause two durable orders or two fulfillment attempts;
- no real Digiflazz, IRS, or supplier endpoint is contacted;
- legacy URL redirects and canonical desktop/mobile Seller Center navigation work;
- the Add Ons page renders one card with Digiflazz and IRS status rows;
- global refresh reloads summary and active section; stale responses cannot overwrite newer data.

Add required matrix checks:

- `seller-center-integration`
- `seller-center-desktop`
- `seller-center-mobile`

## Rollout

1. Run focused Rust/client/gateway tests and full builds.
2. Build the disposable Rust binary before integration execution.
3. Bootstrap exact disposable database and run all Seller Center checks.
4. Run historical dry-run/apply/post-check against disposable fixtures only.
5. Run the full disposable verification matrix and secrecy audit.
6. Tear down and prove zero processes/services.
7. Obtain independent read-only code review and resolve Critical/Important findings.
8. Commit and push only after explicit approval.
9. Before any production migration: create a fresh backup, run protected dry-run, review duplicate/index findings, obtain explicit approval, run protected apply with confirmation and backup reference, verify, deploy, and smoke test.

## Non-goals

- No generic seller marketplace or provider plugin framework.
- No merged public API namespace or merged order collection.
- No change to public prepaid path names or response field names.
- No new real-provider test calls.
- No automatic polling.
- No redesign of core supplier fulfillment beyond making IRS invoke the established mapped-product path safely.
- No deletion of historical orders or logs.
- No production database mutation, index application, deployment, restart, or push without later explicit approval.

## Acceptance Criteria

1. The admin sidebar and Add Ons page expose exactly one private **Digiflazz Seller Center** entry/card.
2. The canonical path is `/admin/addons/digiflazz-seller-center`; both old admin URLs redirect to the correct canonical section without duplicate rendering.
3. Digiflazz remains the primary Seller Center workflow and IRS appears only as an internal integration using the shared mapping inventory.
4. Both public prepaid paths and response field contracts remain compatible.
5. A valid new IRS request durably claims one `refId`, executes the mapped product once, persists the real outcome, and returns that outcome in the IRS envelope.
6. Database failures cannot appear as empty healthy data, product-not-found business results, or successfully persisted orders.
7. New seller order/log writes never retain `rawRequest` or `raw`; admin DTOs never return raw or unknown Mongo fields.
8. Historical Digiflazz/IRS seller raw fields are auditable and removable through a dry-run-first guarded tool without deleting orders/logs or printing secrets.
9. Seller summary and Add Ons statuses fail closed with explicit partial/unavailable diagnostics.
10. Existing `manageVendors`, transaction-read, public-route, and `integrations.credentials` boundaries remain enforced.
11. Global refresh, latest-request-wins, Indonesian degraded states, desktop/mobile responsiveness, and accessibility semantics are verified.
12. Focused tests, full Rust/client/server builds, required disposable Seller Center checks, aggregate matrix, report secrecy audit, teardown proof, and independent review pass before any production release.
