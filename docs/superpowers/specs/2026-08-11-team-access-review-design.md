# Team Access Review and Effective Permissions Design

**Date:** 2026-08-11
**Status:** Draft for user review
**Scope:** `/admin/teams` staff/admin access review and catalog read-guard correction

## Goal

Make `/admin/teams` useful for reviewing what each owner, admin, or CS account can actually see and do, while keeping the existing granular permission editor and correcting catalog read routes so `viewProducts` can read catalog data without granting mutation access.

## Context and current behavior

The application has three staff roles:

- `owner`: backend permission bypass; full staff access.
- `admin`: access is derived from the persisted permission document; non-owner admins may manage CS but not admin accounts.
- `cs`: access is derived from the persisted permission document; normally used for transaction/deposit operations.

Permission dependencies are already enforced in the backend and must remain authoritative:

- `manageProducts` implies `viewProducts` and `manageVouchers`.
- `managePayment` implies `viewPayment`.
- `manageUsers` implies `viewUsers`.
- `manageTeam` implies `viewTeam`.
- `manageSettings` implies `viewSettings`.
- `manageVendors` implies `viewVendors`.

Additional role boundaries are not represented by a checkbox alone:

- Only owner can create, promote, or manage an admin account.
- A non-owner with `manageTeam` can manage CS accounts only.
- Only owner can reset another team member's 2FA.
- Only owner can inspect admin login logs; non-owner team managers may inspect CS login logs.
- Exporting admin audit logs remains protected by `manageTeam` plus the existing `exports.sensitive` step-up.
- Financial and integration actions retain their existing step-up, idempotency, and rate-limit controls.

The current client already has a single route metadata table in `client/src/lib/adminNav.ts`, and the Rust/Node layers enforce permissions independently. The new review surface must not replace either enforcement layer.

## Design

### 1. Shared client access metadata

Create a focused pure helper module, `client/src/lib/teamAccess.ts`, responsible for effective-access presentation. It must not perform network calls or authorization itself.

The module will define typed metadata for access groups and entries. Each entry has:

- stable permission key when applicable;
- human-readable feature label;
- access group;
- access level (`view`, `manage`, `action`, or `owner-only`);
- optional `requiresStepUp` marker;
- optional role-scope predicate for owner/admin/CS boundaries;
- optional route paths used only for explanation, not enforcement.

The helper will export pure functions with behavior equivalent to:

```ts
type TeamAccessLevel = 'view' | 'manage' | 'action' | 'owner-only';
type TeamAccessStatus = 'available' | 'step-up' | 'owner-only' | 'role-limited' | 'unavailable';

type EffectiveTeamAccess = {
  id: string;
  group: string;
  label: string;
  level: TeamAccessLevel;
  status: TeamAccessStatus;
  detail: string;
  route?: string;
  permission?: keyof Permissions;
  requiresStepUp?: boolean;
};

export function effectiveTeamPermissions(
  role: 'owner' | 'admin' | 'cs',
  permissions: Permissions,
): Permissions;

export function getEffectiveTeamAccess(
  member: Pick<TeamMember, 'role' | 'permissions'>,
): EffectiveTeamAccess[];

export function summarizeEffectiveTeamAccess(
  access: readonly EffectiveTeamAccess[],
): { availableCount: number; managedCount: number; stepUpCount: number; labels: string[] };
```

The exact exported type names may follow local conventions, but all consumers must use one helper rather than duplicating permission implications in `Teams.tsx`.

Owner behavior is explicit: owner receives `available` access for all operational entries and `owner-only` entries are shown as available to the owner. For admin/CS, the helper applies backend-equivalent implication rules before evaluating entries. Role-only limits are applied after permission evaluation.

The helper must distinguish viewing from mutation. Examples:

- `viewProducts` grants catalog viewing entries but not catalog mutation entries.
- `manageProducts` grants both catalog viewing and catalog mutation entries.
- `viewDeposits` grants list/detail/export viewing entries.
- `approveDeposits` grants claim and approve/reject actions; approval/rejection entries are marked `step-up` because the existing route requires `finance.deposit_approval`.
- `viewTransactions` grants transaction list/detail/export and guest list viewing.
- `processManualTransaction` grants manual processing, status/recheck/refund actions; actions that already require step-up are marked `step-up`.
- `manageVouchers` grants voucher/giveaway operations; giveaway execution remains marked `step-up` and transaction availability is not altered by this UI.
- `manageTeam` grants team administration entries subject to role scope; it does not by itself grant owner-only admin management or 2FA reset access.

Self-service profile/password/2FA/session entries are represented separately as `teamMemberOnly` access, since every authenticated team member can use them even without an operational permission.

### 2. `/admin/teams` table and access modal

Modify `client/src/pages/admin/Teams.tsx` without changing the existing API response contract.

Add an `Akses efektif` summary column to each member row. The summary must be compact and deterministic:

- owner: `Akses penuh`;
- otherwise show up to three primary group labels, followed by `+N fitur` when more entries are available;
- no operational access: `Dashboard saja` or `Tidak ada akses operasional`, depending on the effective list.

Add a per-row button with an accessible label such as `Lihat akses ${member.name}`. It opens a scrollable modal and never mutates the member.

The modal header shows:

- member name and email;
- role label;
- active/inactive state;
- 2FA state;
- owner/full-access marker when applicable.

The modal body renders access entries grouped into:

1. Dashboard & Laporan
2. Transaksi
3. Deposit
4. Produk & Kampanye
5. Pembayaran
6. Member
7. Tim & Audit
8. Settings & Vendor
9. Keamanan pribadi

Every entry shows text plus an icon/status treatment. Color alone must not communicate access. The modal must work on mobile with vertical scrolling and stacked rows. It must support an accessible close button, `aria-modal`, labelled heading, and Escape behavior consistent with existing modals.

The existing row action buttons remain unchanged in authority:

- edit/toggle/archive are shown only when `canManageMember` allows them;
- reset 2FA remains owner-only;
- member login logs retain owner/non-owner scope;
- team audit section remains controlled by `manageTeam`.

### 3. Edit-form effective preview

Keep the existing permission checkboxes and role defaults. Add an `Preview akses setelah disimpan` panel below the permission groups.

The preview uses the same pure access helper as the read-only modal, with the current form role and normalized permissions. It displays:

- number of accessible entries;
- number of managed entries;
- number of step-up-protected actions;
- grouped compact labels;
- dependency notices such as `manageProducts otomatis memberikan akses lihat produk`.

For non-owner editors, show a non-authoritative notice that permissions outside the actor's scope may be removed by the server. Do not claim that the browser preview is final authorization. The backend `clamp_permissions_to_actor` remains the final decision.

When changing role, preserve the existing role-default behavior and recompute the preview immediately. Do not add a new permission key.

### 4. Correct catalog read guards

The catalog read surface must be usable by a staff account with `viewProducts` but without `manageProducts`.

Change only read/list/detail guards that currently unnecessarily require `manageProducts`:

- Node gateway GET routes for admin categories, operators, product types, and admin product list/detail/sorting-read endpoints must require `viewProducts` where the operation is read-only.
- Rust handlers for admin product reads and taxonomy admin reads used by the catalog UI must require `viewProducts` where they only query data.
- Catalog mutations (create, update, delete, activate/deactivate, sort-order changes, bulk changes, and related writes) must continue requiring `manageProducts`.
- Margin GET requires `viewProducts`; margin PUT remains `manageProducts`.
- Vendor-backed catalog imports and vendor settings remain under `manageVendors`; do not broaden them through `viewProducts`.
- Validation-product taxonomy remains under `manageSettings`; it is a settings surface, not ordinary catalog viewing.

The route metadata in `client/src/lib/adminNav.ts` already gives `/admin/products` `viewProducts` and master-data pages `manageProducts`. Keep that distinction. If a page combines read-only data with mutation controls, the page may load for `viewProducts` and hide/disable mutation controls, while mutation endpoints remain backend-protected.

Any route whose read behavior is ambiguous must be classified from its handler: if it performs a write or exposes a mutation-specific operation, leave `manageProducts`; if it only reads a catalog document/list, use `viewProducts`.

### 5. Backend authority and security invariants

Do not weaken or reorder:

- authentication and trusted proxy context;
- role checks and database-backed permission resolution;
- owner-only team-management scope;
- step-up requirements;
- CSRF and trusted-origin protections;
- rate limits and idempotency requirements;
- 2FA enrollment route guards;
- direct Rust proxy rejection.

The access modal is explanatory UI, not a security boundary. The backend must continue to re-read active user permissions from the database for protected operations.

## Testing strategy

### Pure client tests

Add tests in the existing Node test path for the helper:

- owner receives all operational entries;
- admin and CS effective permissions honor implication rules;
- CS with only `viewProducts` receives read/catalog entries but no mutation entries;
- `manageProducts` produces both read and mutation catalog access;
- approve/reject deposits and financial operations are marked step-up;
- non-owner team manager receives CS team scope but admin management and reset 2FA remain owner-only;
- summary counts and compact labels are deterministic;
- missing/legacy permission fields fail closed except for owner role.

### UI/source contract tests

Extend the existing `tools/dev-verification/unit/adminPageChrome.test.ts` or add a focused unit test to verify:

- `Teams.tsx` contains the access modal and accessible `Lihat akses` control;
- the edit form uses the same helper for preview;
- existing manage-team and owner-only checks remain present;
- no raw permission object is rendered as an unreviewed JSON dump.

### Guard tests

Add source/route contract tests covering the exact intended split:

- GET catalog list/detail routes accept `viewProducts` at gateway/Rust guard boundaries;
- catalog mutations still require `manageProducts`;
- payment, users, vendors, settings, teams, and financial route guards remain unchanged;
- `viewProducts` does not grant vendor settings/import access.

Where the repository's existing integration harness can create synthetic `viewProducts`-only staff, add an isolated request test proving GET succeeds and a mutation returns `403`. Use only `webtopup_task14_dev` disposable fixtures; never mutate production users.

### Verification commands

At minimum after implementation:

```bash
npm run test:dev-verify:unit
npm run build
(cd rust-api && cargo test --bin webtopup-rust-api --no-fail-fast)
(cd rust-api && cargo test --lib --no-fail-fast)
(cd server && npm run test:security)
git diff --check
```

Then run the relevant disposable browser/integration checks, including `/admin/teams` if a dedicated spec is added, and the full disposable matrix before claiming completion.

## Non-goals

- No new role beyond owner/admin/CS.
- No redesign of the authentication model or permission storage schema.
- No client-only authorization.
- No change to owner bypass semantics.
- No broad refactor of `AdminLayout`, `App.tsx`, or all API routes beyond the catalog read/write split needed for this feature.
- No production deployment or GitHub push as part of implementation without explicit approval.
