# Team Access Review and Permission Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accurate, accessible effective-access review and edit preview to `/admin/teams`, align `approveDeposits → viewDeposits` across active authorization layers, and split catalog reads from mutations with defense-in-depth Node/Rust enforcement.

**Architecture:** A pure client module owns permission normalization, access metadata, and deterministic summaries. `Teams.tsx` consumes focused dialog/preview components built on that module; none of this UI authorizes requests. Node and Rust remain independent authorities: exact GET catalog routes require `viewProducts`, all taxonomy/product writes require `manageProducts`, and executable disposable tests prove the 200/403 boundary.

**Tech Stack:** React 19, TypeScript 5.9, Zustand, Fastify 4, Node test runner with `tsx`, Rust/Axum, MongoDB 7 replica set, Playwright 1.61, disposable `webtopup_task14_dev` fixtures.

## Global Constraints

- Preserve authentication, trusted proxy context, CSRF/trusted-origin checks, 2FA-enrollment gates, step-up groups, idempotency, rate limits, and owner/admin/CS role scope.
- The modal and preview are explanatory UI only; Node and Rust database-backed permission checks remain authoritative.
- Active owner keeps the current full-access bypass. An inactive owner/admin/CS has suspended effective access.
- Canonical implications are `manageProducts → viewProducts + manageVouchers`, `approveDeposits → viewDeposits`, `managePayment → viewPayment`, `manageUsers → viewUsers`, `manageTeam → viewTeam`, `manageSettings → viewSettings`, and `manageVendors → viewVendors`.
- Only literal boolean `true` enables a raw permission; missing, null, malformed, or non-boolean values fail closed before implications.
- Only owner may manage admin accounts, inspect admin login logs, or reset another team member's 2FA. Non-owner `manageTeam` is limited to CS targets.
- Read-only catalog GET routes use `viewProducts`; create/update/delete/status/sort/bulk routes use `manageProducts` at both Node and Rust boundaries.
- `/admin/products` stays `viewProducts`; catalog master pages and `/admin/margins` stay `manageProducts`. Vendor imports/settings stay `manageVendors`; validation taxonomy stays `manageSettings`.
- All integration mutations use synthetic fixtures in `webtopup_task14_dev`; never mutate production identities or production MongoDB.
- Do not activate or broadly refactor `server/src/controllers/teamController.ts`; it remains residual legacy debt.
- Do not install OS packages, deploy, restart production services, or push to GitHub without explicit approval.

## File Map

- Create `client/src/lib/teamAccess.ts`: canonical client permission keys, sparse normalization, implication resolution, access inventory, and deterministic summary.
- Create `tools/dev-verification/unit/teamAccess.test.ts`: pure access-model regression tests run by the existing root unit command.
- Modify `client/src/store/useAuthStore.ts`: reuse the canonical client resolver for route/menu checks.
- Modify `server/src/middlewares/authMiddleware.ts`: export/test active Node permission resolution and add the deposit implication.
- Create `server/src/middlewares/authMiddleware.test.ts`: direct Node resolver parity tests.
- Modify `rust-api/src/security.rs`: preserve/test runtime implication parity.
- Modify `rust-api/src/routes/teams/validation.rs`: normalize deposit implications and clamp effective actor permissions safely.
- Modify `rust-api/src/security_hardening_checks.rs`: update and expand catalog authorization source contracts.
- Modify `server/src/routes/apiV2ProxyRoutes.ts`: explicit method-specific catalog read/write route guards.
- Modify `server/src/routes/apiV2ProxyRoutes.test.ts`: exact method, permission, and ordering contracts.
- Modify `rust-api/src/routes/products/read.rs` and `rust-api/src/routes/products/sorting.rs`: `viewProducts` for admin reads only.
- Modify `rust-api/src/routes/taxonomy/categories.rs`, `operators.rs`, and `product_types.rs`: `viewProducts` for admin reads and `manageProducts` for all mutations, while validation wrappers remain `manageSettings`.
- Create `client/src/components/admin/TeamAccessDialog.tsx`: accessible read-only access dialog with focus containment and restoration.
- Create `client/src/components/admin/TeamAccessPreview.tsx`: edit-form effective-access preview.
- Modify `client/src/pages/admin/Teams.tsx`: summary column, dialog trigger, canonical permission types, and form preview.
- Modify `tools/dev-verification/unit/adminPageChrome.test.ts`: source contracts protecting UI authority and helper reuse.
- Modify `tools/dev-verification/seed.ts` and `tools/dev-verification/unit/seed.test.ts`: synthetic access-review and catalog-permission fixtures.
- Create `tools/dev-verification/e2e/team-access.spec.ts`: desktop/mobile dialog behavior and accessibility.
- Create `tools/dev-verification/integration/catalogPermissions.test.ts`: executable gateway/direct-Rust 200/403 authorization proof.
- Modify `tools/dev-verification/verificationMatrix.ts` and `tools/dev-verification/unit/verificationMatrix.test.ts`: make new checks required in the aggregate matrix.

---

### Task 1: Build the pure effective-access model

**Files:**
- Create: `client/src/lib/teamAccess.ts`
- Create: `tools/dev-verification/unit/teamAccess.test.ts`

**Interfaces:**
- Produces `TEAM_PERMISSION_KEYS`, `TeamPermissionKey`, `TeamPermissionInput`, `TeamPermissions`, `TeamRole`, `TeamAccessGroupId`, `TeamAccessMember`, `EffectiveTeamAccess`, `normalizeTeamPermissions`, `resolveEffectiveTeamPermissions`, `getEffectiveTeamAccess`, and `summarizeEffectiveTeamAccess` exactly as specified in `docs/superpowers/specs/2026-08-11-team-access-review-design.md`.
- `TeamAccessGroupId` is exactly `'dashboard-reports' | 'transactions' | 'deposits' | 'catalog' | 'payments' | 'members' | 'team-audit' | 'settings-vendors' | 'self'`; a fixed `TEAM_ACCESS_GROUPS` array maps those IDs to the nine approved Indonesian labels in that order.
- Consumers in Tasks 2 and 5 import these types/functions; do not duplicate implication rules elsewhere in the client.

- [ ] **Step 1: Write failing normalization and implication tests**

Create `tools/dev-verification/unit/teamAccess.test.ts` and import the planned Task 1 helper:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTeamPermissions,
  resolveEffectiveTeamPermissions,
} from '../../../client/src/lib/teamAccess.ts';

test('sparse permissions fail closed and canonical implications are applied', () => {
  const sparse = normalizeTeamPermissions({
    approveDeposits: true,
    viewDeposits: false,
    manageProducts: true,
    viewUsers: 'true',
    manageTeam: 1,
  });
  assert.equal(sparse.approveDeposits, true);
  assert.equal(sparse.viewDeposits, true);
  assert.equal(sparse.manageProducts, true);
  assert.equal(sparse.viewProducts, true);
  assert.equal(sparse.manageVouchers, true);
  assert.equal(sparse.viewUsers, false);
  assert.equal(sparse.manageTeam, false);
});

test('owner override returns a complete permission map', () => {
  const owner = resolveEffectiveTeamPermissions('owner', null);
  assert.ok(Object.values(owner).every(Boolean));
});
```

Also cover `null`, `undefined`, an object missing `manageVouchers`, and shuffled key insertion order.

- [ ] **Step 2: Run the focused unit test and confirm RED**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/teamAccess.test.ts
```

Expected: FAIL because `client/src/lib/teamAccess.ts` does not exist.

- [ ] **Step 3: Write failing access-inventory tests**

Add tests with exact assertions for:

```ts
const readOnly = getEffectiveTeamAccess({
  role: 'cs',
  active: true,
  permissions: { viewDashboard: true, viewProducts: true },
});
assert.equal(readOnly.find((entry) => entry.id === 'catalog.read')?.status, 'available');
assert.equal(readOnly.find((entry) => entry.id === 'catalog.manage')?.status, 'unavailable');

const suspendedOwner = getEffectiveTeamAccess({ role: 'owner', active: false, permissions: null });
assert.ok(suspendedOwner.some((entry) => entry.status === 'suspended'));
assert.equal(suspendedOwner.some((entry) => entry.status === 'available'), false);
```

Cover these stable entry IDs in the metadata:

```text
dashboard.view
notifications.view
reports.sales
reports.promo
transactions.view
transactions.guest-view
transactions.manual
transactions.status
transactions.refund
deposits.view
deposits.claim
deposits.approve
catalog.read
catalog.manage
catalog.flash-sales
catalog.rewards
catalog.margin-data
catalog.margin-manage
campaigns.vouchers
campaigns.giveaway-execute
payments.view
payments.manage
payments.credentials
members.view
members.manage
members.balance-adjust
team.view
team.manage-cs
team.manage-admin
team.login-logs-cs
team.login-logs-admin
team.reset-2fa
audit.view
audit.export
settings.manage
settings.validation
vendors.manage
vendors.credentials
vendors.internal-purchase
self.profile-view
self.profile-update
self.password
self.sessions-view
self.sessions-revoke-one
self.sessions-revoke-all
self.two-factor
```

Map each ID to the permission and role boundary documented in the spec. Assert `status='step-up'` for `transactions.status`, `transactions.refund`, `deposits.approve`, `campaigns.giveaway-execute`, `payments.credentials`, `members.balance-adjust`, `audit.export`, `vendors.credentials`, `self.profile-update`, `self.password`, and `self.sessions-revoke-all`. `vendors.internal-purchase` is an eligible action with the existing mutation rate limit but no invented step-up label.

- [ ] **Step 4: Implement the minimal pure module**

Implement:

```ts
export const TEAM_PERMISSION_KEYS = [
  'viewDashboard', 'viewReports',
  'viewTransactions', 'processManualTransaction',
  'viewDeposits', 'approveDeposits',
  'viewProducts', 'manageProducts', 'manageVouchers',
  'viewPayment', 'managePayment',
  'viewUsers', 'manageUsers',
  'viewTeam', 'manageTeam',
  'viewSettings', 'manageSettings',
  'viewVendors', 'manageVendors',
] as const;

const IMPLICATIONS: Partial<Record<TeamPermissionKey, readonly TeamPermissionKey[]>> = {
  approveDeposits: ['viewDeposits'],
  manageProducts: ['viewProducts', 'manageVouchers'],
  managePayment: ['viewPayment'],
  manageUsers: ['viewUsers'],
  manageTeam: ['viewTeam'],
  manageSettings: ['viewSettings'],
  manageVendors: ['viewVendors'],
};
```

Use `TEAM_ACCESS_GROUPS` when constructing/sorting the fixed access metadata array so the nine approved group labels and order have one source. For `audience='owner'`, return `owner-only` to non-owner roles even if a permission is true. For inactive users, map otherwise eligible `available`/`step-up` entries to `suspended`.

- [ ] **Step 5: Write and pass deterministic summary tests**

Add exact tests using a deliberately shuffled fixture:

```ts
const shuffledAccess: EffectiveTeamAccess[] = [
  { id: 'self.password', groupId: 'self', label: 'Ubah password', detail: '', audience: 'team-member', level: 'action', status: 'step-up', requiresStepUp: true },
  { id: 'catalog.read', groupId: 'catalog', label: 'Lihat katalog', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
  { id: 'deposits.view', groupId: 'deposits', label: 'Lihat deposit', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
  { id: 'transactions.refund', groupId: 'transactions', label: 'Refund', detail: '', audience: 'permission', level: 'action', status: 'step-up', requiresStepUp: true },
  { id: 'dashboard.view', groupId: 'dashboard-reports', label: 'Dashboard', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
  { id: 'transactions.view', groupId: 'transactions', label: 'Lihat transaksi', detail: '', audience: 'permission', level: 'view', status: 'available', requiresStepUp: false },
];
const summary = summarizeEffectiveTeamAccess(shuffledAccess);
assert.deepEqual(summary.labels, ['Dashboard & Laporan', 'Transaksi', 'Deposit']);
assert.equal(summary.remainingGroupCount, 1);
assert.equal(summary.availableCount, 5);
assert.equal(summary.managedCount, 0);
assert.equal(summary.actionCount, 1);
assert.equal(summary.stepUpCount, 2);
```

The `stepUpCount` is `2` because it includes the self-service password action, while operational labels/counts exclude the self-service group. Also assert duplicate entries in one group do not duplicate labels, active dashboard-only renders the data needed for `Dashboard saja`, and inactive users expose no eligible operational count.

Run:

```bash
node --import tsx --test tools/dev-verification/unit/teamAccess.test.ts
npm run test:dev-verify:unit
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add client/src/lib/teamAccess.ts tools/dev-verification/unit/teamAccess.test.ts
git commit -m "feat: model effective team access"
```

---

### Task 2: Align deposit permission implications across active layers

**Files:**
- Modify: `client/src/store/useAuthStore.ts`
- Modify: `server/src/middlewares/authMiddleware.ts`
- Create: `server/src/middlewares/authMiddleware.test.ts`
- Modify: `rust-api/src/security.rs`
- Modify: `rust-api/src/routes/teams/validation.rs`
- Test: `tools/dev-verification/unit/teamAccess.test.ts`

**Interfaces:**
- Consumes `TeamPermissionKey`, `TeamPermissionInput`, and `resolveEffectiveTeamPermissions` from Task 1.
- Produces exported Node `hasResolvedPermission(permissions, permission): boolean` for focused tests.
- Preserves owner bypass and database re-read behavior in `hasPermission`.

- [ ] **Step 1: Write failing Node resolver tests**

Create `server/src/middlewares/authMiddleware.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { hasResolvedPermission } from './authMiddleware';

test('approveDeposits implies viewDeposits but not unrelated access', () => {
  const permissions = { approveDeposits: true } as never;
  assert.equal(hasResolvedPermission(permissions, 'viewDeposits'), true);
  assert.equal(hasResolvedPermission(permissions, 'viewProducts'), false);
});
```

Run:

```bash
npm --prefix server run build
node --test server/dist/middlewares/authMiddleware.test.js
```

Expected: FAIL because the resolver is not exported and does not resolve the deposit implication.

- [ ] **Step 2: Implement Node and client resolver parity**

In `server/src/middlewares/authMiddleware.ts`:

- export `hasResolvedPermission`;
- add only `permission === 'viewDeposits' && permissions.approveDeposits`;
- do not alter owner, active-account, member, or DB lookup behavior.

In `client/src/store/useAuthStore.ts`:

- remove its private implication chain;
- keep owner returning `true`;
- return `false` when `user.role` is neither `admin` nor `cs`;
- for admin/CS, call `normalizeTeamPermissions(user.permissions)[permission]`;
- use `TeamPermissionKey` for `hasPermission`;
- keep `User.permissions` sparse and compatible with refresh payloads.

Add a root unit source/behavior assertion proving `useAuthStore` imports the canonical resolver and does not retain a second implication chain.

- [ ] **Step 3: Write failing Rust parity tests**

In `rust-api/src/security.rs` tests, add:

```rust
#[test]
fn deposit_permission_approval_implies_view_only() {
    assert!(team_user_has_any_permission(
        "admin",
        &["approveDeposits".to_string()],
        &["viewDeposits"],
    ));
    assert!(!team_user_has_any_permission(
        "admin",
        &["approveDeposits".to_string()],
        &["viewProducts"],
    ));
}
```

In `rust-api/src/routes/teams/validation.rs`, add tests named `deposit_permission_normalization_sets_view` and `deposit_permission_clamp_uses_effective_actor`. The normalization assertion is:

```rust
let permissions = build_permissions(Some(&serde_json::json!({
    "approveDeposits": true,
    "viewDeposits": false,
})), "cs");
assert_eq!(permissions.get_bool("approveDeposits"), Ok(true));
assert_eq!(permissions.get_bool("viewDeposits"), Ok(true));
```

Add an actor-clamp test where the actor has sparse `approveDeposits=true`, `viewDeposits=false`; the target keeps both effective approval and view after clamping.

Run:

```bash
cd rust-api && cargo test --bin webtopup-rust-api deposit_permission --no-fail-fast
```

Expected: at least the team normalization/clamp test fails before implementation.

- [ ] **Step 4: Implement Rust team normalization and effective clamping**

Update `build_permissions` so `approveDeposits` sets `viewDeposits=true`.

Update `clamp_permissions_to_actor` to compare effective actor permission, not only the actor's raw boolean. A target permission may remain true when the actor has the canonical managing/implying permission. Keep the explicit `viewDashboard=true` behavior.

Do not change the existing runtime Rust implication in `security.rs`; its test locks the already-correct behavior.

- [ ] **Step 5: Run focused and cross-layer tests**

```bash
npm --prefix server run build
node --test server/dist/middlewares/authMiddleware.test.js
npm run test:dev-verify:unit
(cd rust-api && cargo test --bin webtopup-rust-api deposit_permission --no-fail-fast)
(cd rust-api && cargo test --bin webtopup-rust-api security_hardening_checks --no-fail-fast)
```

Expected: PASS, with no owner/role bypass changes.

- [ ] **Step 6: Commit Task 2**

```bash
git add client/src/store/useAuthStore.ts server/src/middlewares/authMiddleware.ts server/src/middlewares/authMiddleware.test.ts rust-api/src/security.rs rust-api/src/routes/teams/validation.rs tools/dev-verification/unit/teamAccess.test.ts
git commit -m "fix: align effective staff permissions"
```

---

### Task 3: Split catalog gateway read and mutation guards

**Files:**
- Modify: `server/src/routes/apiV2ProxyRoutes.ts`
- Modify: `server/src/routes/apiV2ProxyRoutes.test.ts`

**Interfaces:**
- Exact GET routes use `authenticate, hasPermission('viewProducts')`.
- Existing mutation routes and catch-alls remain `authenticate, hasPermission('manageProducts')`.
- Route ordering places exact reads before matching mutation catch-alls.

- [ ] **Step 1: Write failing route matrix tests**

Extend `server/src/routes/apiV2ProxyRoutes.test.ts` with a table:

```ts
const reads = [
  "app.get('/categories/admin/all'",
  "app.get('/operators/admin/all'",
  "app.get('/operators/admin/:id'",
  "app.get('/product-types/admin/all'",
  "app.get('/product-types/admin/:id'",
  "app.get('/products/admin/all'",
  "app.get('/products/admin/sorting'",
];
```

For each read, assert its route slice contains `hasPermission('viewProducts')`. Assert these mutation paths contain `manageProducts`:

```text
POST /categories/admin/create
PUT /categories/admin/sort-order
PUT/DELETE /categories/admin/:id
POST /operators/admin/create
PUT /operators/admin/sort-order
PUT/DELETE /operators/admin/:id
POST /product-types/admin/create
PUT /product-types/admin/sort-order
PUT/DELETE /product-types/admin/:id
POST `/products`, PUT `/products/:id`, DELETE `/products/:id`, POST `/products/admin/sort-order`, and POST `/products/admin/sort-by-price`
POST /products/admin/sort-order
POST /products/admin/sort-by-price
```

Assert every exact GET appears before its matching `app.all` mutation catch-all.

- [ ] **Step 2: Run gateway tests and confirm RED**

```bash
npm --prefix server run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js
```

Expected: FAIL because the exact read routes do not yet exist and broad catch-alls require `manageProducts`.

- [ ] **Step 3: Implement exact method-specific gateway routes**

Add the exact GET routes from the matrix before mutation catch-alls. Replace method-agnostic sort mutation declarations with the actual methods where known (`PUT` taxonomy sort routes, `POST` product sort routes) so no GET can inherit mutation permission accidentally.

Keep:

```ts
app.get('/margins', { preHandler: [authenticate, hasPermission('viewProducts')] }, proxyRequest);
app.put('/margins', { preHandler: [authenticate, hasPermission('manageProducts')] }, proxyRequest);
```

Do not change public catalog routes, vendor routes, validation taxonomy, rewards writes, flash-sale writes, or settings routes.

- [ ] **Step 4: Add negative boundary assertions**

Assert the source slice for the new read block contains neither `manageVendors` nor `manageSettings`, and mutation blocks never use `viewProducts` as their only permission.

Run:

```bash
npm --prefix server run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add server/src/routes/apiV2ProxyRoutes.ts server/src/routes/apiV2ProxyRoutes.test.ts
git commit -m "fix: split catalog gateway permissions"
```

---

### Task 4: Enforce catalog permissions independently in Rust

**Files:**
- Modify: `rust-api/src/routes/products/read.rs`
- Modify: `rust-api/src/routes/products/sorting.rs`
- Modify: `rust-api/src/routes/taxonomy/categories.rs`
- Modify: `rust-api/src/routes/taxonomy/operators.rs`
- Modify: `rust-api/src/routes/taxonomy/product_types.rs`
- Modify: `rust-api/src/security_hardening_checks.rs`

**Interfaces:**
- Admin reads in the approved route matrix call `require_permission(..., "viewProducts")`.
- Every taxonomy/product write calls `require_permission(..., "manageProducts")` before parsing/mutation.
- Validation taxonomy wrappers call `require_permission(..., "manageSettings")` and then a private data-loading helper that does not downgrade that decision.

- [ ] **Step 1: Write failing Rust source-contract tests**

Update `sensitive_routes_use_db_backed_authorization_helpers` so product reads expect `viewProducts`, while mutations/sorts expect `manageProducts`.

Add a new test that loads the three taxonomy modules and asserts each contains both:

```rust
require_permission(&headers, &state, "viewProducts")
require_permission(&headers, &state, "manageProducts")
```

Also assert validation wrappers still contain `manageSettings`.

Run:

```bash
cd rust-api && cargo test --bin webtopup-rust-api security_hardening_checks --no-fail-fast
```

Expected: FAIL because taxonomy handlers currently use only `require_proxy_context` and product reads use `manageProducts`.

- [ ] **Step 2: Change product read guards only**

In `products/read.rs`, change `admin_all` to `viewProducts`.

In `products/sorting.rs`, change only `admin_sorting` to `viewProducts`; keep `update_sort_order` and `sort_by_price` on `manageProducts`.

Run the focused security test and confirm remaining failures are taxonomy-specific.

- [ ] **Step 3: Add taxonomy read wrappers with `viewProducts`**

For categories, operators, and product types:

- admin list/detail public handlers first call `require_permission(..., "viewProducts")`;
- internal data-loading functions remain private and are called only after a wrapper has authorized the correct surface;
- validation taxonomy wrappers retain `manageSettings` and call the private loader after that check.

Do not let validation wrappers call a `viewProducts` wrapper, because that would incorrectly require both permissions.

- [ ] **Step 4: Add `manageProducts` to every taxonomy mutation**

Replace mutation-level `require_proxy_context`-only checks with `require_permission(..., "manageProducts")` in:

```text
categories_update_sort_order
category_admin_create
category_admin_update
category_admin_delete
operators_update_sort_order
operator_admin_create
operator_admin_update
operator_admin_delete
product_types_update_sort_order
product_type_admin_create
product_type_admin_update
product_type_admin_delete
```

`require_permission` already validates trusted proxy context and reloads the active DB user. Avoid redundant authorization calls unless an internal helper specifically still needs the parsed proxy context.

- [ ] **Step 5: Run focused and full Rust tests**

```bash
(cd rust-api && cargo test --bin webtopup-rust-api security_hardening_checks --no-fail-fast)
(cd rust-api && cargo test --bin webtopup-rust-api validation_taxonomy --no-fail-fast)
(cd rust-api && cargo test --lib --no-fail-fast)
(cd rust-api && cargo build)
```

Expected: PASS. Existing `manageSettings` validation taxonomy tests remain green.

- [ ] **Step 6: Commit Task 4**

```bash
git add rust-api/src/routes/products/read.rs rust-api/src/routes/products/sorting.rs rust-api/src/routes/taxonomy/categories.rs rust-api/src/routes/taxonomy/operators.rs rust-api/src/routes/taxonomy/product_types.rs rust-api/src/security_hardening_checks.rs
git commit -m "fix: enforce catalog permissions in Rust"
```

---

### Task 5: Add the access dialog and edit preview to `/admin/teams`

**Files:**
- Create: `client/src/components/admin/TeamAccessDialog.tsx`
- Create: `client/src/components/admin/TeamAccessPreview.tsx`
- Modify: `client/src/pages/admin/Teams.tsx`
- Modify: `tools/dev-verification/unit/adminPageChrome.test.ts`
- Test: `tools/dev-verification/unit/teamAccess.test.ts`

**Interfaces:**
- `TeamAccessDialog` consumes `{ member: TeamAccessMember & { name: string; email: string; twoFactorEnabled?: boolean }; onClose: () => void }`.
- `TeamAccessPreview` consumes `{ role: Exclude<TeamRole, 'owner'>; permissions: TeamPermissionInput; provisional: boolean }`.
- `Teams.tsx` keeps API payload permission keys unchanged and uses Task 1 normalization before editing/submitting.

- [ ] **Step 1: Write failing UI source contracts**

Extend `adminPageChrome.test.ts` to require:

```ts
assert.match(teams, /TeamAccessDialog/);
assert.match(teams, /TeamAccessPreview/);
assert.match(teams, /Lihat akses/);
assert.match(teams, /normalizeTeamPermissions/);
assert.match(teams, /canManageMember/);
assert.match(teams, /isOwner/);
assert.doesNotMatch(teams, /JSON\.stringify\(member\.permissions/);
```

Add source checks for dialog semantics:

```text
role="dialog"
aria-modal="true"
aria-label="Tutup detail akses"
Escape
focus()
```

Run:

```bash
npm run test:dev-verify:unit -- --test-name-pattern='team access|settings and account pages'
```

Expected: FAIL because the components do not exist.

- [ ] **Step 2: Implement `TeamAccessDialog` with complete focus behavior**

Follow the existing `TwoFactorReminderDialog` behavior:

- capture `document.activeElement` on mount;
- focus the dialog heading (`tabIndex={-1}`) or close button;
- trap Tab/Shift+Tab among enabled focusable elements;
- call `onClose` on Escape;
- remove the key listener on cleanup;
- restore focus to the captured trigger if still connected.

Render grouped access entries from `getEffectiveTeamAccess`. Include text for `available`, `step-up`, `owner-only`, `role-limited`, `suspended`, and `unavailable`; do not rely on color alone.

- [ ] **Step 3: Implement `TeamAccessPreview`**

Use `getEffectiveTeamAccess` with `active=true` and `summarizeEffectiveTeamAccess`. Render:

```text
Preview akses setelah disimpan
<N> fitur tersedia
<N> akses pengelolaan
<N> aksi operasional
<N> membutuhkan verifikasi ulang
```

Render implication notices only when the source permission is true. If `provisional=true`, show the approved server-clamping warning.

- [ ] **Step 4: Integrate Teams table and modal**

In `Teams.tsx`:

- import canonical types/helper; remove the local required-field `Permissions` interface;
- normalize API permissions on read/edit;
- add `accessMember` state;
- add the `Akses efektif` table column for every `viewTeam` viewer;
- render active owner as `Akses penuh`, inactive owner as `Akses penuh dikonfigurasi · ditangguhkan`, inactive non-owner as `Akses ditangguhkan`, and active non-owner from summary labels plus `+N area akses`;
- add `aria-label={`Lihat akses ${member.name}`}` to the trigger;
- render `TeamAccessDialog` outside the table when selected;
- insert `TeamAccessPreview` below the permission checkboxes;
- preserve all `canManageTeam`, `canManageMember`, log-scope, owner reset-2FA, and step-up handlers.

- [ ] **Step 5: Align form normalization with all canonical implications**

Replace the one-rule local `normalizePermissions` implementation with `normalizeTeamPermissions`. Ensure submitted payload remains a complete boolean map. When unchecking an implied view permission while its source manage permission remains true, the preview and submitted map keep the view permission true.

- [ ] **Step 6: Run focused tests and build**

```bash
node --import tsx --test tools/dev-verification/unit/teamAccess.test.ts
npm run test:dev-verify:unit
npm --prefix client run build
git diff --check
```

Expected: PASS with no React hook or TypeScript errors.

- [ ] **Step 7: Commit Task 5**

```bash
git add client/src/components/admin/TeamAccessDialog.tsx client/src/components/admin/TeamAccessPreview.tsx client/src/pages/admin/Teams.tsx tools/dev-verification/unit/adminPageChrome.test.ts tools/dev-verification/unit/teamAccess.test.ts
git commit -m "feat: review effective team access"
```

---

### Task 6: Add synthetic fixtures and Playwright access-dialog coverage

**Files:**
- Modify: `tools/dev-verification/seed.ts`
- Modify: `tools/dev-verification/unit/seed.test.ts`
- Modify: `tools/dev-verification/e2e/fixtures.ts`
- Create: `tools/dev-verification/e2e/team-access.spec.ts`

**Interfaces:**
- Adds fixture aliases `team-access-viewer-desktop`, `team-access-viewer-mobile`, `team-access-owner-target`, `team-access-suspended-target`, `catalog-viewer`, and `catalog-manager`.
- Viewer fixtures are CS with `viewDashboard=true`, `viewTeam=true`, `twoFactorEnabled=false`, and a future `twoFactorEnrollmentRequiredAt`, so they run under `session-cs`.
- Catalog fixtures are CS with either `viewProducts=true` only or `manageProducts=true` only, plus a future 2FA enrollment deadline so the enrollment middleware does not mask permission results.

- [ ] **Step 1: Write failing seeder tests**

Extend `seed.test.ts` to assert:

```ts
assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-desktop'));
assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-mobile'));
assert.ok(definitions.some((item) => item.alias === 'team-access-owner-target' && item.role === 'owner'));
assert.ok(definitions.some((item) => item.alias === 'team-access-suspended-target' && item.active === false));
assert.ok(definitions.some((item) => item.alias === 'catalog-viewer'));
assert.ok(definitions.some((item) => item.alias === 'catalog-manager'));
```

Assert public manifest remains credential-free.

Run:

```bash
npm run test:dev-verify:unit -- --test-name-pattern='fixture definitions|public fixture manifest'
```

Expected: FAIL because aliases and flexible fixture fields do not exist.

- [ ] **Step 2: Extend fixture types and seeding safely**

Change `FixtureDefinition`:

```ts
role: 'member' | 'owner' | 'admin' | 'cs';
active: boolean;
permissions?: Record<string, boolean>;
```

Define the password map explicitly so the new role cannot become `undefined`:

```ts
const passwords: Record<FixtureDefinition['role'], string | undefined> = {
  member: secrets.FIXTURE_MEMBER_PASSWORD,
  cs: secrets.FIXTURE_STAFF_PASSWORD,
  admin: secrets.FIXTURE_ADMIN_PASSWORD,
  owner: secrets.FIXTURE_ADMIN_PASSWORD,
};
```

Do not expose any password in the public manifest. Persist `fixture.permissions` and `fixture.active` instead of hardcoded scenario-only permission/active logic. Preserve finance/login-return special cases by merging their scenario permissions explicitly before save.

Extend `FixtureLogin` manifest role to include owner and map owner to the staff endpoint/admin password.

Create target fixtures with unique `.invalid` emails and `task14Fixture=true`; no production identity is reused.

- [ ] **Step 3: Write the failing Playwright spec**

Create `tools/dev-verification/e2e/team-access.spec.ts`. Select the viewer alias by project name and log in through `/staff/login`. Test:

```text
/admin/teams loads
Lihat akses Task 14 team-access-owner-target opens the named dialog
active owner copy is Akses penuh
dialog role/name are correct
focus enters dialog
Tab/Shift+Tab remain in dialog
Escape closes it
focus returns to the exact trigger
suspended target renders Akses ditangguhkan
```

For `chromium-mobile`, scroll the dialog and assert the `Keamanan pribadi` heading is visible/reachable.

Run against an initialized disposable stack:

```bash
npx playwright test --config tools/dev-verification/playwright.config.ts team-access.spec.ts --project=chromium-desktop --workers=1
npx playwright test --config tools/dev-verification/playwright.config.ts team-access.spec.ts --project=chromium-mobile --workers=1
```

Expected before UI integration/fixtures: FAIL. After Task 5 and fixture implementation: PASS.

- [ ] **Step 4: Verify fixture and browser cleanup**

The spec performs no mutation. After the run, verify no extra session remains active for the viewer, or revoke any synthetic viewer sessions in teardown using the exact fixture user ID. Do not delete the fixture users; matrix isolation resets the marked database.

- [ ] **Step 5: Commit Task 6**

```bash
git add tools/dev-verification/seed.ts tools/dev-verification/unit/seed.test.ts tools/dev-verification/e2e/fixtures.ts tools/dev-verification/e2e/team-access.spec.ts
git commit -m "test: verify team access review dialog"
```

---

### Task 7: Add executable catalog authorization proof and matrix gates

**Files:**
- Create: `tools/dev-verification/integration/catalogPermissions.test.ts`
- Modify: `tools/dev-verification/verificationMatrix.ts`
- Modify: `tools/dev-verification/unit/verificationMatrix.test.ts`

**Interfaces:**
- Uses `catalog-viewer` and `catalog-manager` from Task 6.
- Runs under `session-cs` with current Node/Rust processes and the marked disposable replica set.
- Makes no successful mutation: denied requests stop at permission guards; manager requests use invalid payloads and assert validation response rather than creating data.

- [ ] **Step 1: Write the failing matrix contract**

Add required checks:

```text
team-access-desktop    session-cs isolated
team-access-mobile     session-cs isolated
catalog-permissions    session-cs isolated
```

Use commands:

```ts
check('team-access-desktop', 'session-cs', 'npx', [
  'playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts',
  'team-access.spec.ts', '--project=chromium-desktop', '--workers=1',
], true)
```

and the mobile equivalent. Catalog command:

```ts
check('catalog-permissions', 'session-cs', 'node', [
  '--import', 'tsx', '--test', 'tools/dev-verification/integration/catalogPermissions.test.ts',
], true)
```

Update `verificationMatrix.test.ts` to require exact profiles and isolation.

Run the unit test and confirm RED before modifying the matrix.

- [ ] **Step 2: Write the gateway authorization integration test**

In `catalogPermissions.test.ts`:

1. read the marked shared/private env and public fixture manifest;
2. assert DB name, loopback URI, and local verification marker;
3. log `catalog-viewer` in via `/api/v2/auth/staff/login` at `http://127.0.0.1:${NODE_PORT}`, sending `Origin: shared.PUBLIC_ORIGIN` and JSON content type;
4. use the returned access token without logging it, and send the same configured public Origin on subsequent gateway requests that require it;
5. assert these GETs are `200`:

```text
/api/v2/products/admin/all
/api/v2/categories/admin/all
/api/v2/operators/admin/all
/api/v2/product-types/admin/all
```

6. send `{}` to `POST /api/v2/categories/admin/create` and assert `403` with `PERMISSION_DENIED`;
7. assert vendor settings and `/api/v2/settings/admin/all` are `403 PERMISSION_DENIED`;
8. revoke/clean any synthetic sessions in `finally` by exact fixture user ID.

Never include tokens, passwords, or Mongo credentials in assertion messages.

- [ ] **Step 3: Add direct Rust defense-in-depth assertions**

Load the exact catalog fixture users from Mongo. Build trusted proxy headers with the local proxy secret, actor ID, actual fixture role (`cs`), actor email, configured public Origin, and JSON content type; do not hardcode an `admin` role header. Assert `catalog-viewer` gets `200` on the four listed Rust GET paths and `403` on `POST /v2/categories/admin/create` with `{}`.

For `catalog-manager`, send the same invalid body and assert the result is a validation response (`400`), not `403`; this proves the permission guard passed without creating a document. Record category count before/after and assert unchanged.

- [ ] **Step 4: Run focused disposable tests**

With disposable infra seeded and `host-up-session` running:

```bash
node --import tsx --test tools/dev-verification/integration/catalogPermissions.test.ts
npx playwright test --config tools/dev-verification/playwright.config.ts team-access.spec.ts --project=chromium-desktop --workers=1
npx playwright test --config tools/dev-verification/playwright.config.ts team-access.spec.ts --project=chromium-mobile --workers=1
```

Expected: PASS, no catalog count change, and no active synthetic sessions left by the tests.

- [ ] **Step 5: Commit Task 7**

```bash
git add tools/dev-verification/integration/catalogPermissions.test.ts tools/dev-verification/verificationMatrix.ts tools/dev-verification/unit/verificationMatrix.test.ts
git commit -m "test: gate team and catalog permissions"
```

---

### Task 8: Run complete verification and prepare the integration decision

**Files:**
- Modify: none unless a verification failure exposes a concrete regression.

**Interfaces:**
- Consumes all previous tasks.
- Produces fresh evidence only; no production deployment or push.

- [ ] **Step 1: Run focused unit, build, gateway, Rust, security, and provider checks**

```bash
cd /home/danayasa/proyek/webtopup
npm run test:dev-verify:unit
npm run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js
(cd rust-api && cargo test --bin webtopup-rust-api --no-fail-fast)
(cd rust-api && cargo test --lib --no-fail-fast)
(cd server && npm run test:security)
npm run test:provider-sandbox
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run the full disposable matrix**

Use the already-approved user-cache Chromium and temporary extracted-library wrapper when system libraries are still unavailable:

```bash
export LD_LIBRARY_PATH="/tmp/webtopup-playwright-libs/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DEV_VERIFICATION_CHROME_EXECUTABLE=/tmp/webtopup-playwright-chrome-wrapper
export FONTCONFIG_FILE=/tmp/webtopup-playwright-fonts/fonts.conf
npm run dev-verify -- infra-up
npm run dev-verify -- test
```

Expected aggregate report: `LOCAL DEV VERIFIED`, including the three new required checks.

- [ ] **Step 3: Verify cleanup and repository state**

```bash
npm run dev-verify -- infra-down
npm run dev-verify -- status
npm run dev-verify -- infra-status
git diff --check
git status --short
```

Expected: no owned host processes, zero disposable services after teardown, no generated tracked artifacts, and only intentional source changes before the final commit.

- [ ] **Step 4: Request read-only review**

Request independent review of the implementation diff for:

- access-model correctness and inactive behavior;
- modal accessibility and focus restoration;
- Node/Rust permission parity;
- exact catalog route method ordering;
- absence of widened vendor/settings access;
- executable test cleanup.

Do not treat a stalled reviewer as approval. Verify accepted findings before applying them.

- [ ] **Step 5: Commit any verified review fixes**

If review identifies a concrete issue, add a failing regression test, apply the smallest fix, rerun focused checks, and commit only those files. If no fix is needed, create no empty commit.

- [ ] **Step 6: Present branch integration options**

Use `superpowers:finishing-a-development-branch`. Do not push or deploy without explicit user selection/approval.
