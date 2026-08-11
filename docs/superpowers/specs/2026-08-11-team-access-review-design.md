# Team Access Review and Effective Permissions Design

**Date:** 2026-08-11
**Status:** Revised after permission and testability review
**Scope:** `/admin/teams` staff/admin access review, permission parity, and catalog read/write guard correction

## Goal

Make `/admin/teams` accurately show what each owner, admin, or CS account can currently see and do, while preserving the granular permission editor, making suspended accounts explicit, and correcting catalog guards so `viewProducts` permits reads without granting mutations.

## Context and current behavior

The application has three staff roles:

- `owner`: full configured staff access through the backend role bypass, subject to the account being active and to ordinary authentication, 2FA-enrollment, step-up, rate-limit, and idempotency controls.
- `admin`: access is derived from the active database permission document; a non-owner admin may manage CS accounts but not admin accounts.
- `cs`: access is derived from the active database permission document and is normally used for transaction, deposit, or member-service operations.

An account with `active=false` cannot authenticate or use protected operations. Its permission document describes configured access only; effective access is suspended until the account is reactivated.

The canonical runtime permission implications for this feature are:

- `manageProducts` implies `viewProducts` and `manageVouchers`.
- `approveDeposits` implies `viewDeposits`.
- `managePayment` implies `viewPayment`.
- `manageUsers` implies `viewUsers`.
- `manageTeam` implies `viewTeam`.
- `manageSettings` implies `viewSettings`.
- `manageVendors` implies `viewVendors`.

The implementation must align these rules in the active Node gateway resolver, Rust resolver, team permission normalization, client presentation helper, and tests. Only literal boolean `true` activates a raw permission; missing, null, malformed, or non-boolean values fail closed before implications are applied.

Additional role boundaries are not represented by a checkbox alone:

- Only owner can create, promote, or manage an admin account.
- A non-owner with `manageTeam` can manage CS accounts only.
- Only owner can reset another team member's 2FA.
- Only owner can inspect admin login logs; non-owner team managers may inspect CS login logs.
- Exporting admin audit logs remains protected by `manageTeam` plus `exports.sensitive` step-up.
- Financial and integration actions retain their existing step-up, idempotency, CSRF, trusted-origin, and rate-limit controls.

The active application registers `apiV2ProxyRoutes` and forwards to Rust. The legacy `server/src/controllers/teamController.ts` is not an active authority for `/api/v2/teams`; its incomplete serializer is recorded as technical debt and is not expanded in this feature. The new presentation helper must mirror the active Node/Rust runtime authorization semantics, not that legacy serializer.

## Design

### 1. Canonical client permission and access metadata

Create `client/src/lib/teamAccess.ts`, a pure module responsible only for normalization and access presentation. It must not perform network calls or make authorization decisions for requests.

The module owns one canonical client permission-key list and exports complete and sparse input types. `Teams.tsx` imports these types instead of declaring another required-field permission interface.

```ts
export const TEAM_PERMISSION_KEYS = [
  'viewDashboard',
  'viewReports',
  'viewTransactions',
  'processManualTransaction',
  'viewDeposits',
  'approveDeposits',
  'viewProducts',
  'manageProducts',
  'manageVouchers',
  'viewPayment',
  'managePayment',
  'viewUsers',
  'manageUsers',
  'viewTeam',
  'manageTeam',
  'viewSettings',
  'manageSettings',
  'viewVendors',
  'manageVendors',
] as const;

export type TeamPermissionKey = typeof TEAM_PERMISSION_KEYS[number];
export type TeamPermissionInput =
  | Readonly<Partial<Record<TeamPermissionKey, unknown>>>
  | null
  | undefined;
export type TeamPermissions = Record<TeamPermissionKey, boolean>;
export type TeamRole = 'owner' | 'admin' | 'cs';
```

Normalization accepts sparse and legacy-shaped documents. Only literal `true` is enabled, then the canonical implication rules are applied. The result is always a complete `TeamPermissions` map.

Access entries use explicit audience, level, and status values:

```ts
export type TeamAccessAudience = 'permission' | 'team-member' | 'owner';
export type TeamAccessLevel = 'view' | 'manage' | 'action';
export type TeamAccessStatus =
  | 'available'
  | 'step-up'
  | 'owner-only'
  | 'role-limited'
  | 'suspended'
  | 'unavailable';

export type TeamAccessMember = {
  role: TeamRole;
  active: boolean;
  permissions: TeamPermissionInput;
};

export type EffectiveTeamAccess = {
  id: string;
  groupId: TeamAccessGroupId;
  label: string;
  detail: string;
  audience: TeamAccessAudience;
  level: TeamAccessLevel;
  status: TeamAccessStatus;
  permission?: TeamPermissionKey;
  route?: string;
  requiresStepUp: boolean;
};
```

The module exports exact pure interfaces:

```ts
export function normalizeTeamPermissions(input: TeamPermissionInput): TeamPermissions;

export function resolveEffectiveTeamPermissions(
  role: TeamRole,
  input: TeamPermissionInput,
): TeamPermissions;

export function getEffectiveTeamAccess(member: TeamAccessMember): EffectiveTeamAccess[];

export function summarizeEffectiveTeamAccess(
  access: readonly EffectiveTeamAccess[],
): {
  availableCount: number;
  managedCount: number;
  actionCount: number;
  stepUpCount: number;
  labels: string[];
  remainingGroupCount: number;
};
```

Owner receives every configured operational and owner entry only while active. For an inactive owner, entries that would otherwise be `available` or `step-up` become `suspended`; the modal says configured full access is suspended. For inactive admin/CS, entries allowed by their configured permissions similarly become `suspended`. Entries that were already unavailable or role-limited remain so.

### 2. Access inventory and action-level status

The helper distinguishes page visibility, data visibility, management, and sensitive actions.

Examples:

- `viewProducts` grants product-list and supporting catalog-read entries, not mutation entries.
- `manageProducts` grants catalog create/update/delete/status/sort, flash sale, rewards management, and related mutations.
- `manageVouchers` grants voucher and giveaway management; giveaway execution remains `step-up` and transaction capability remains backend-authoritative.
- `viewDeposits` grants deposit list/detail/export.
- `approveDeposits` implies `viewDeposits`, grants claim/release, and grants approve/reject; approve/reject are marked `step-up` for `finance.deposit_approval`.
- `viewTransactions` grants transaction list/detail/export and guest transaction viewing.
- `processManualTransaction` grants manual processing and status/recheck/refund actions; routes with an existing step-up group are marked `step-up`.
- `viewUsers` grants member detail and balance-history viewing.
- `manageUsers` grants member update/status/delete and balance adjustment; balance adjustment is marked `step-up` and retains idempotency/rate-limit requirements.
- `manageTeam` grants team operations subject to target-role scope; it never converts admin management or 2FA reset into non-owner access.

Self-service entries use `audience: 'team-member'` and are split by action:

- view own staff profile: available while authenticated;
- update own profile/email: `step-up` with `security.password`;
- change own password: `step-up` with `security.password`;
- view own sessions: available;
- revoke current or one device session: available subject to trusted mutation/auth rate limits;
- revoke all sessions: `step-up` with `security.sessions_all`;
- view 2FA status and perform the exact enrollment flow: available according to current auth flow.

The modal states that this is normal eligibility. An overdue staff 2FA-enrollment gate can temporarily restrict otherwise eligible operations to the exact Rust allowlist until enrollment is completed.

Margin access is split into two entries:

- viewing margin data used by product surfaces follows `viewProducts`;
- opening and changing `/admin/margins` remains a management surface requiring `manageProducts`.

### 3. Deterministic summary contract

Access metadata and group order are fixed:

1. Dashboard & Laporan
2. Transaksi
3. Deposit
4. Produk & Kampanye
5. Pembayaran
6. Member
7. Tim & Audit
8. Settings & Vendor
9. Keamanan pribadi

Summary rules are exact:

- Eligible statuses are `available` and `step-up`.
- `availableCount` counts all eligible entries outside `Keamanan pribadi`.
- `managedCount` counts eligible entries with `level='manage'` outside `Keamanan pribadi`.
- `actionCount` counts eligible entries with `level='action'` outside `Keamanan pribadi`.
- `stepUpCount` counts eligible entries with `status='step-up'`, including self-service entries when shown in the modal preview count.
- `labels` contains at most the first three distinct eligible operational group labels in fixed metadata order.
- `remainingGroupCount` is the number of distinct eligible operational groups not included in `labels`; the suffix is rendered as `+N area akses`. Entries within a displayed group do not increment this suffix.
- Self-service entries never cause an account to be described as having operational access.
- An active account with only `viewDashboard` renders `Dashboard saja`.
- An active account with no eligible operational entry renders `Tidak ada akses operasional`.
- An inactive account renders `Akses ditangguhkan`, while its modal can still list configured entries with `suspended` status.
- Active owner renders `Akses penuh`; inactive owner renders `Akses penuh dikonfigurasi · ditangguhkan`.

Metadata order, not object insertion order, controls all output. Shuffled sparse input produces identical summary output.

### 4. `/admin/teams` table and access modal

Modify `client/src/pages/admin/Teams.tsx` without adding an API endpoint or changing the `/teams/admin/list` response.

Add an `Akses efektif` column. It renders up to three deterministic area labels followed by `+N area akses` when needed, and includes a per-row `Lihat akses ${member.name}` button available to every viewer with `viewTeam`. The button is read-only.

The modal header shows name, email, role, active state, 2FA state, and full/suspended status. Its body renders the nine fixed groups with text plus icon/status; color alone cannot communicate status.

The access modal has a complete dialog contract:

- `role="dialog"`, `aria-modal="true"`, and a labelled heading;
- an icon button with explicit `aria-label="Tutup detail akses"`;
- initial focus moves to the heading or close button;
- Tab and Shift+Tab remain inside the modal while it is open;
- Escape closes the modal;
- focus returns to the exact row trigger after close;
- mobile layout uses stacked rows and a bounded vertically scrollable dialog so the last group remains reachable.

Use the existing focus-trap behavior in `TwoFactorReminderDialog`/`idleLockFocus` as a behavioral reference, without broad refactoring of unrelated modals.

Existing mutation controls remain unchanged in authority:

- edit/toggle/archive follow `canManageMember` and backend target-role checks;
- reset 2FA remains owner-only;
- login-log visibility retains owner/CS scope;
- team audit remains `manageTeam`;
- the new modal never enables or calls a protected operation.

### 5. Edit-form effective preview

Keep the existing permission checkboxes and role defaults. Add `Preview akses setelah disimpan` below the permission groups.

The preview passes the current form role, `active=true`, and normalized form permissions to the same helper. It displays available, managed, action, and step-up counts plus deterministic group labels and implication notices.

The UI and backend normalization both apply:

- `approveDeposits → viewDeposits`;
- all existing manage-to-view implications;
- `manageProducts → manageVouchers`.

For a non-owner editor, the preview is explicitly provisional: permissions beyond the actor's authority can be removed by backend clamping. Backend authorization and clamping remain final.

### 6. Permission parity at active authorization layers

Add `approveDeposits → viewDeposits` to the active Node gateway resolver and team normalization, matching the existing Rust runtime resolver. Tests must lock parity between Node, Rust, and client implication tables.

The Rust team permission builder writes `viewDeposits=true` when `approveDeposits=true`. Runtime implication still remains necessary for sparse legacy documents. The actor-clamp path must not accidentally remove effective deposit viewing when the actor has `approveDeposits`; tests cover an actor with sparse `approveDeposits=true, viewDeposits=false`.

Do not expand the inactive legacy `server/src/controllers/teamController.ts` in this feature. Record its incomplete serializer as residual debt; it is not registered in `server/src/app.ts` and does not determine active `/api/v2/teams` responses.

### 7. Catalog read/write guard matrix

Replace broad method-agnostic gateway authorization where needed with explicit method routes ordered before any catch-all. The required matrix is:

| Method and gateway path | Rust handler | Required permission |
|---|---|---|
| `GET /categories/admin/all` | `categories_admin_all` | `viewProducts` |
| `GET /operators/admin/all` | `operators_admin_all` | `viewProducts` |
| `GET /operators/admin/:id` | `operator_admin_detail` | `viewProducts` |
| `GET /product-types/admin/all` | `product_types_admin_all` | `viewProducts` |
| `GET /product-types/admin/:id` | `product_type_admin_detail` | `viewProducts` |
| `GET /products/admin/all` | `products::admin_all` | `viewProducts` |
| `GET /products/admin/sorting` | `products::admin_sorting` | `viewProducts` |
| `GET /margins` | `margins::get_margins` | `viewProducts` |
| `POST/PUT/DELETE` catalog taxonomy/product routes | matching mutation handlers | `manageProducts` |
| `POST/PUT` catalog sort/status/bulk routes | matching mutation handlers | `manageProducts` |
| `PUT /margins` | `margins::update_margins` | `manageProducts` |

No new category-admin detail or product-admin detail endpoint is required because no active consumer needs one; public detail routes are not reclassified as admin authority.

At the Rust boundary:

- every admin taxonomy read/list/detail wrapper in the matrix requires database-backed `viewProducts` in addition to trusted proxy context;
- every taxonomy create/update/delete/sort/status mutation requires database-backed `manageProducts` in addition to trusted proxy context;
- validation-product taxonomy wrappers retain `manageSettings` and may reuse internal read helpers only after their own permission check;
- product read handlers change from `manageProducts` to `viewProducts` where listed;
- product mutations remain `manageProducts`.

At the Node gateway:

- explicit GET routes use `viewProducts`;
- explicit mutation routes and mutation catch-alls use `manageProducts`;
- route order must prevent a broad `viewProducts` wildcard from authorizing writes.

Client route metadata remains:

- `/admin/products`: `viewProducts`, with mutation controls gated by `manageProducts`;
- category/operator/product-type master pages: `manageProducts`;
- `/admin/margins`: `manageProducts`.

Vendor-backed imports/settings remain `manageVendors`. Validation taxonomy remains `manageSettings`.

### 8. Backend authority and security invariants

Do not weaken or reorder:

- authentication and trusted proxy context;
- database-backed role, active-state, and permission resolution;
- owner-only team-management scope;
- step-up requirements;
- CSRF and trusted-origin protections;
- rate limits and idempotency requirements;
- 2FA-enrollment guards;
- direct Rust proxy rejection.

The modal and preview are explanatory UI, never an authorization boundary.

## Testing strategy

### Pure client tests

Add tests for:

- canonical permission normalization from complete, sparse, null, missing, malformed, and Node-shaped documents missing `manageVouchers`;
- only literal `true` enabling a raw permission;
- all implication rules, including `approveDeposits → viewDeposits`;
- active owner full access and inactive owner suspended access;
- active/inactive admin and CS behavior;
- `viewProducts` producing read entries but no mutation entries;
- `manageProducts` producing read and mutation entries;
- financial and self-service step-up labels;
- non-owner team manager CS scope and owner-only admin/reset/log entries;
- exact deterministic counts, labels, remaining-group count, shuffled input, and duplicate-group behavior.

### Required UI/browser tests

Source-contract tests verify that `Teams.tsx` imports the shared helper, retains owner/manage-team authority checks, and does not render raw JSON permission documents.

A disposable Playwright test is mandatory. It must:

1. log in with a synthetic `viewTeam` fixture;
2. open `Lihat akses <nama>`;
3. verify dialog role and accessible name;
4. verify initial focus enters the dialog;
5. verify Tab/Shift+Tab focus containment;
6. close with Escape;
7. verify focus returns to the triggering row button;
8. repeat in mobile viewport and scroll to the final `Keamanan pribadi` group;
9. verify inactive and owner summary copy using disposable fixtures.

### Required authorization tests

Source tests alone are insufficient. Add a mandatory isolated disposable fixture with `viewProducts=true`, `manageProducts=false`, and no vendor/settings permissions in `webtopup_task14_dev`.

Through the gateway, prove:

```text
GET /api/v2/products/admin/all -> 200
GET /api/v2/categories/admin/all -> 200
GET /api/v2/operators/admin/all -> 200
GET /api/v2/product-types/admin/all -> 200
POST/PUT/DELETE catalog mutation -> 403 PERMISSION_DENIED
GET vendor settings/import surface -> 403 PERMISSION_DENIED
GET settings admin surface -> 403 PERMISSION_DENIED
```

At the direct Rust boundary with trusted proxy headers, prove the same `viewProducts`-only actor can read the listed taxonomy/product routes but receives `403` for mutations. Also prove a `manageProducts` actor can reach the mutation guard path without a permission denial.

Add route-registration tests proving method and ordering contracts so GET routes cannot shadow mutation routes or vice versa.

Add permission-parity tests proving `approveDeposits` implies `viewDeposits` in Node, Rust, team normalization, and client presentation.

All mutation tests use disposable synthetic documents and clean them up. Never use production users or production MongoDB.

### Verification commands

At minimum after implementation:

```bash
npm run test:dev-verify:unit
npm run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js
(cd rust-api && cargo test --bin webtopup-rust-api --no-fail-fast)
(cd rust-api && cargo test --lib --no-fail-fast)
(cd server && npm run test:security)
npm run test:provider-sandbox
git diff --check
```

Then run the focused `/admin/teams` Playwright spec, catalog authorization integration tests, and the full disposable matrix before claiming completion.

## Non-goals

- No new role beyond owner/admin/CS.
- No permission-storage schema migration.
- No client-only authorization.
- No change to owner bypass semantics for an active owner.
- No activation of or broad cleanup in the legacy Node team controller.
- No new admin category/product detail endpoint without an active consumer.
- No broad refactor of `AdminLayout`, `App.tsx`, or unrelated modals/routes.
- No production deployment or GitHub push without explicit approval.

## Residual technical debt

- `server/src/controllers/teamController.ts` has an incomplete legacy permission list and differs from active Rust normalization, but it is not registered by `server/src/app.ts`; this feature does not activate or refactor it.
- Permission metadata exists in multiple languages. Cross-layer parity tests reduce drift, but a future generated schema could centralize it if justified separately.
