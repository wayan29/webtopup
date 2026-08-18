# Admin Slider UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicate admin navigation destinations and make Slider Beranda management clearer, more compact, consistently Indonesian, and more accessible on desktop/mobile without changing backend contracts.

**Architecture:** Keep `ADMIN_NAV_BLUEPRINT` as the single navigation source, move its local preference-normalization logic into testable pure helpers, and give all campaign routes one canonical menu location. Add a small pure `sliderPresentation.ts` module for archive/current status, active-capacity, and mobile-position decisions; `Sliders.tsx` remains responsible for rendering and revisioned mutation orchestration but consumes those helpers rather than adding more inline conditions.

**Tech Stack:** React 19, TypeScript 5.9, React Router, Tailwind CSS utility classes, Lucide icons, dnd-kit, Node test runner with `tsx`, Playwright, existing disposable dev-verification stack.

**Spec:** `docs/superpowers/specs/2026-08-17-admin-slider-ux-polish-design.md`

## Global Constraints

- Work inline on `/home/danayasa/proyek/webtopup` `main` with one sequential writer; do not create a worktree unless the user changes that instruction.
- Use strict RED/GREEN TDD: every behavior task starts with a focused failing test, then minimal implementation, focused pass, `git diff --check`, and a checkpoint commit.
- This is client/navigation work only. Do not change Rust routes, Node gateway routes, Mongo data/indexes, slider request envelopes, HMAC capability gating, idempotency, revision fencing, or archive/restore semantics.
- Preserve `manageSettings`, authentication, active-account, CSRF, trusted-proxy, credential-cookie, rate-limit, 2FA, and `settings.sensitive` step-up boundaries.
- Preserve fail-closed parsing: only exact `mutationContract: "slider-revision-v1"` enables slider writes; never synthesize this marker in Node or the client.
- Preserve revision conflict, commit-unknown, managed cover asset, optimistic reorder rollback, and archive/restore safety behavior.
- Do not add or install dependencies.
- All browser/integration verification must use the disposable stack and exact database `webtopup_task14_dev`; do not use production for tests.
- Production build/deploy/restart and GitHub push require separate explicit approval after implementation is complete.
- The admin header is the single refresh affordance; page components continue responding to `admin:refresh-current-page`.
- UI labels are Indonesian; backend action/type identifiers (`restore`, `revision`, `SliderIntent`) remain unchanged internally.

## File Structure

- Modify `client/src/lib/adminNav.ts`: canonical menu blueprint, legacy aliases, and exported menu preference normalizers.
- Modify `client/src/lib/adminNav.test.ts`: duplicate-path and preference-migration contracts.
- Modify `client/src/layouts/AdminLayout.tsx`: consume navigation normalizers; no sidebar rendering redesign.
- Create `client/src/lib/sliderPresentation.ts`: pure current/archive presentation and capacity helpers.
- Create `client/src/lib/sliderPresentation.test.ts`: helper contract tests.
- Modify `client/src/pages/admin/Sliders.tsx`: view-specific summary/filter/status, one refresh path, capacity guard, mobile order, Indonesian copy, tab semantics, and empty-state actions.
- Modify `tools/dev-verification/unit/adminPageChrome.test.ts`: source contracts for canonical copy/semantics and retained safety boundaries.
- Modify `tools/dev-verification/e2e/sliders.spec.ts`: desktop/mobile behavioral assertions.
- No server, Rust, database, or homepage-carousel file is modified.

---

### Task 1: Canonicalize Admin Navigation and Preserve Preferences

**Files:**
- Modify: `client/src/lib/adminNav.ts:75-323`
- Modify: `client/src/lib/adminNav.test.ts`
- Modify: `client/src/layouts/AdminLayout.tsx:128-170`

**Interfaces:**
- Produces: `normalizeAdminMenuOrder(menuOrder: string[]): string[]`
- Produces: `normalizeAdminPinnedMenus(value: unknown, maxPinned?: number): string[]`
- Produces: `ADMIN_MENU_NAME_ALIASES` entries `Slider → Slider Beranda`, `Vouchers → Kampanye`, and `Laporan Promo → Kampanye`.
- Consumes: `ADMIN_DEFAULT_MENU_ORDER` and `ADMIN_NAV_BLUEPRINT` from `adminNav.ts`.

- [x] **Step 1: Add failing tests for unique paths, canonical campaign locations, label migration, and deduplication**

Append focused tests to `client/src/lib/adminNav.test.ts`:

```ts
import {
    ADMIN_DEFAULT_MENU_ORDER,
    ADMIN_MENU_NAME_ALIASES,
    normalizeAdminMenuOrder,
    normalizeAdminPinnedMenus,
} from './adminNav.ts';

test('sidebar destinations are unique and campaign routes have one canonical location', () => {
    const paths = ADMIN_NAV_BLUEPRINT.flatMap((item) => [
        item.path,
        ...(item.submenu ?? []).map((child) => child.path),
    ]).filter((value): value is string => Boolean(value));
    const counts = new Map<string, number>();
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);

    assert.deepEqual(
        [...counts.entries()].filter(([, count]) => count > 1),
        [],
    );
    assert.equal(counts.get('/admin/flash-sales'), 1);
    assert.equal(counts.get('/admin/vouchers'), 1);
    assert.equal(counts.get('/admin/promo-report'), 1);

    const campaign = ADMIN_NAV_BLUEPRINT.find((item) => item.name === 'Kampanye');
    assert.deepEqual(
        campaign?.submenu?.map((item) => item.path),
        ['/admin/flash-sales', '/admin/vouchers', '/admin/promo-report'],
    );
    const sliderMenu = ADMIN_NAV_BLUEPRINT.find((item) => item.path === '/admin/sliders');
    assert.equal(sliderMenu?.name, 'Slider Beranda');
    assert.equal(sliderMenu?.subtitle, 'Kelola carousel banner halaman utama');
});

test('legacy Slider and campaign preferences migrate without duplicate menu names', () => {
    assert.equal(ADMIN_MENU_NAME_ALIASES.Slider, 'Slider Beranda');
    assert.equal(ADMIN_MENU_NAME_ALIASES.Vouchers, 'Kampanye');
    assert.equal(ADMIN_MENU_NAME_ALIASES['Laporan Promo'], 'Kampanye');

    const order = normalizeAdminMenuOrder(['Slider', 'Vouchers', 'Kampanye', 'Laporan Promo']);
    assert.equal(order.filter((name) => name === 'Kampanye').length, 1);
    assert.equal(order.filter((name) => name === 'Slider Beranda').length, 1);
    assert.deepEqual(new Set(order), new Set(ADMIN_DEFAULT_MENU_ORDER));

    assert.deepEqual(
        normalizeAdminPinnedMenus(['Slider', 'Vouchers', 'Kampanye', 'Laporan Promo'], 6),
        ['Slider Beranda', 'Kampanye'],
    );
});
```

- [x] **Step 2: Run the navigation tests to verify RED**

Run:

```bash
node --import tsx --test client/src/lib/adminNav.test.ts
```

Expected: FAIL because duplicate route declarations remain, `Slider Beranda` aliases are absent, and the exported normalizer functions do not exist.

- [x] **Step 3: Implement canonical menu entries and pure normalizers**

In `client/src/lib/adminNav.ts`:

1. Remove the top-level `Laporan Promo` item.
2. Remove `Produk → 5. Flash Sale` and renumber `Audit Katalog` to `5. Audit Katalog`.
3. Remove the top-level `Vouchers` item.
4. Rename the Slider item exactly:

```ts
{
    name: 'Slider Beranda',
    path: '/admin/sliders',
    icon: SlidersHorizontal,
    permission: 'manageSettings',
    section: 'Sistem',
    subtitle: 'Kelola carousel banner halaman utama'
}
```

5. Add aliases:

```ts
Slider: 'Slider Beranda',
Vouchers: 'Kampanye',
'Laporan Promo': 'Kampanye',
```

6. Move the existing order/pin normalization behavior out of `AdminLayout.tsx` into exported helpers:

```ts
const normalizeAdminMenuName = (name: string) => ADMIN_MENU_NAME_ALIASES[name] || name;

export const normalizeAdminMenuOrder = (menuOrder: string[]) => {
    const seen = new Set<string>();
    const nextOrder: string[] = [];
    for (const rawItem of menuOrder) {
        const item = normalizeAdminMenuName(rawItem);
        if (ADMIN_DEFAULT_MENU_ORDER.includes(item) && !seen.has(item)) {
            seen.add(item);
            nextOrder.push(item);
        }
    }
    for (const item of ADMIN_DEFAULT_MENU_ORDER) {
        if (!seen.has(item)) {
            seen.add(item);
            nextOrder.push(item);
        }
    }
    return nextOrder;
};

export const normalizeAdminPinnedMenus = (value: unknown, maxPinned = 6) => {
    if (!Array.isArray(value)) return [] as string[];
    const seen = new Set<string>();
    const next: string[] = [];
    for (const rawItem of value) {
        if (typeof rawItem !== 'string') continue;
        const item = normalizeAdminMenuName(rawItem);
        if (!ADMIN_DEFAULT_MENU_ORDER.includes(item) || seen.has(item)) continue;
        seen.add(item);
        next.push(item);
    }
    return next.slice(0, maxPinned);
};
```

In `AdminLayout.tsx`, import these two helpers, remove the local `normalizeMenuOrder`/`normalizePinnedMenus` implementations, and call:

```ts
normalizeAdminMenuOrder(storedOrder)
normalizeAdminPinnedMenus(storedPinned, MAX_PINNED_MENUS)
```

Do not change favorite rendering: `unpinnedNavItems` must continue removing pinned entries from the regular list.

- [x] **Step 4: Run focused tests and client build to verify GREEN**

Run:

```bash
node --import tsx --test client/src/lib/adminNav.test.ts
npm --prefix client run build
git diff --check
```

Expected: all tests PASS, client build exits 0, and no whitespace errors.

- [x] **Step 5: Commit the canonical navigation checkpoint**

```bash
git add client/src/lib/adminNav.ts client/src/lib/adminNav.test.ts client/src/layouts/AdminLayout.tsx
git commit -m "fix: remove duplicate admin campaign destinations"
```

---

### Task 2: Add Pure Slider Presentation Contracts

**Files:**
- Create: `client/src/lib/sliderPresentation.ts`
- Create: `client/src/lib/sliderPresentation.test.ts`
- Modify later: `client/src/pages/admin/Sliders.tsx`

**Interfaces:**
- Produces: `SliderView = 'current' | 'archive'`
- Produces: `sliderStatusLabel(view: SliderView, status: boolean): 'Aktif' | 'Draft' | 'Diarsipkan'`
- Produces: `canActivateSlider(limits: SliderLimits | undefined, wasActive: boolean): boolean`
- Produces: `sliderPositionLabel(input: SliderPositionInput): string`
- Produces: `formatArchivedMeta(slider: SliderAdminItem): string | null`
- Consumes: `SliderAdminItem` and `SliderLimits` from `client/src/lib/sliderManagement.ts`.

- [x] **Step 1: Write failing pure presentation tests**

Create `client/src/lib/sliderPresentation.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canActivateSlider,
    formatArchivedMeta,
    sliderPositionLabel,
    sliderStatusLabel,
} from './sliderPresentation.ts';

const fullActiveLimits = {
    total: 20,
    active: 8,
    currentTotal: 8,
    currentActive: 8,
    remainingTotal: 12,
    remainingActive: 0,
};

test('archive status never masquerades as draft', () => {
    assert.equal(sliderStatusLabel('archive', false), 'Diarsipkan');
    assert.equal(sliderStatusLabel('archive', true), 'Diarsipkan');
    assert.equal(sliderStatusLabel('current', true), 'Aktif');
    assert.equal(sliderStatusLabel('current', false), 'Draft');
});

test('active-capacity guard blocks new and draft publication but not an existing active edit', () => {
    assert.equal(canActivateSlider(fullActiveLimits, false), false);
    assert.equal(canActivateSlider(fullActiveLimits, true), true);
    assert.equal(canActivateSlider({ ...fullActiveLimits, remainingActive: 1 }, false), true);
    assert.equal(canActivateSlider(undefined, false), false);
});

test('mobile position remains authoritative when filtered or archived', () => {
    assert.equal(sliderPositionLabel({ sortOrder: 4, total: 10, filtered: false, archived: false }), 'Posisi 5 dari 10');
    assert.equal(sliderPositionLabel({ sortOrder: 4, total: 2, filtered: true, archived: false }), 'Urutan asli 5');
    assert.equal(sliderPositionLabel({ sortOrder: 4, total: 2, filtered: false, archived: true }), 'Urutan terakhir 5');
});

test('archive metadata is shown only when a valid archive timestamp exists', () => {
    assert.match(formatArchivedMeta({
        _id: '1', name: 'Promo', image: '/uploads/covers/a.webp', link: '',
        sortOrder: 0, status: false, lifecycle: 'archived',
        archivedAt: '2026-08-17T12:00:00.000Z', archivedBy: 'operator-1',
    }) ?? '', /Diarsipkan/);
    assert.equal(formatArchivedMeta({
        _id: '2', name: 'Promo', image: '/uploads/covers/a.webp', link: '',
        sortOrder: 0, status: false, lifecycle: 'archived', archivedAt: null,
    }), null);
});
```

- [x] **Step 2: Run the pure tests to verify RED**

```bash
node --import tsx --test client/src/lib/sliderPresentation.test.ts
```

Expected: FAIL with module-not-found for `sliderPresentation.ts`.

- [x] **Step 3: Implement the pure presentation module**

Create `client/src/lib/sliderPresentation.ts`:

```ts
import type { SliderAdminItem, SliderLimits } from './sliderManagement';

export type SliderView = 'current' | 'archive';

export const sliderStatusLabel = (view: SliderView, status: boolean) => (
    view === 'archive' ? 'Diarsipkan' : status ? 'Aktif' : 'Draft'
);

export const canActivateSlider = (limits: SliderLimits | undefined, wasActive: boolean) => (
    wasActive || Boolean(limits && limits.remainingActive > 0)
);

export type SliderPositionInput = {
    sortOrder: number;
    total: number;
    filtered: boolean;
    archived: boolean;
};

export const sliderPositionLabel = ({ sortOrder, total, filtered, archived }: SliderPositionInput) => {
    const position = sortOrder + 1;
    if (archived) return `Urutan terakhir ${position}`;
    if (filtered) return `Urutan asli ${position}`;
    return `Posisi ${position} dari ${total}`;
};

export const formatArchivedMeta = (slider: SliderAdminItem) => {
    if (!slider.archivedAt) return null;
    const date = new Date(slider.archivedAt);
    if (Number.isNaN(date.getTime())) return null;
    const formatted = new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(date);
    return slider.archivedBy
        ? `Diarsipkan ${formatted} oleh ${slider.archivedBy}`
        : `Diarsipkan ${formatted}`;
};
```

Keep formatting pure and independent from React/Axios/browser globals.

- [x] **Step 4: Run pure tests to verify GREEN**

```bash
node --import tsx --test client/src/lib/sliderPresentation.test.ts
git diff --check
```

Expected: 4 tests PASS, no whitespace errors.

- [x] **Step 5: Commit the helper checkpoint**

```bash
git add client/src/lib/sliderPresentation.ts client/src/lib/sliderPresentation.test.ts
git commit -m "test: define admin slider presentation contracts"
```

---

### Task 3: Make Current and Archive Views Semantically Distinct

**Files:**
- Modify: `client/src/pages/admin/Sliders.tsx:40-1049`
- Modify: `tools/dev-verification/unit/adminPageChrome.test.ts:293-330`
- Test: `client/src/lib/sliderPresentation.test.ts`

**Interfaces:**
- Consumes: all Task 2 helpers.
- Preserves: `ParsedSliderAdminSnapshot`, `SliderIntent`, `createSliderRequest`, `useStepUpOrchestration`, and all existing mutation endpoints.
- Produces UI: current summary (`Revisi`, `Slider saat ini`, `Kapasitas total`, `Kapasitas aktif`) and archive summary (`Revisi`, `Total arsip`).

- [x] **Step 1: Change source-contract assertions first so they fail against the old UI**

Update `slider administration uses the revisioned lifecycle and accessible state contracts` in `tools/dev-verification/unit/adminPageChrome.test.ts` to require the new copy and reject old mixed copy:

```ts
assert.match(sliders, /Slider saat ini/);
assert.match(sliders, /Kapasitas total/);
assert.match(sliders, /Kapasitas aktif/);
assert.match(sliders, /Total arsip/);
assert.match(sliders, /Diarsipkan/);
assert.match(sliders, /sliderStatusLabel/);
assert.match(sliders, /formatArchivedMeta/);
assert.doesNotMatch(sliders, /Current total/);
assert.doesNotMatch(sliders, /Current active/);
assert.doesNotMatch(sliders, /Snapshot baca saja/);
```

Keep every existing safety assertion for endpoints, `SLIDER_VERSION_CONFLICT`, `SLIDER_COMMIT_UNKNOWN`, no hard delete, dialogs, rollback, and accessible action names.

- [x] **Step 2: Run the source-contract test to verify RED**

```bash
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
```

Expected: FAIL because old summary/status copy remains and helpers are not consumed.

- [x] **Step 3: Implement view-specific filtering, labels, metadata, and summaries**

In `Sliders.tsx`:

1. Import Task 2 helpers and remove the local `SliderView` declaration.
2. Add a view-change function that prevents a hidden current filter from blanking the archive:

```ts
const changeView = (nextView: SliderView) => {
    setView(nextView);
    if (nextView === 'archive') setStatusFilter('all');
};
```

3. Make status matching current-only:

```ts
const matchesStatus = view === 'archive'
    || statusFilter === 'all'
    || (statusFilter === 'active' ? slider.status : !slider.status);
```

4. Render archived badges using `sliderStatusLabel('archive', slider.status)` and the archived tone. Do not show a secondary `Draft` badge/text in archive.
5. Render `formatArchivedMeta(slider)` below the archive item name when available.
6. Replace the five unconditional cards with:

```tsx
<div className={`grid gap-3 ${view === 'archive' ? 'sm:grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-4'}`}>
    {/* Revisi always */}
    {/* Archive: Total arsip */}
    {/* Current: Slider saat ini, Kapasitas total, Kapasitas aktif */}
</div>
```

Exact current copy:

- `Revisi` / `Versi data slider saat ini`
- `Slider saat ini` / `${currentActive} aktif · ${draftCount} draft`
- `Kapasitas total` / `${currentTotal} / ${total}`
- `Kapasitas aktif` / `${currentActive} / ${active}`

Exact archive copy:

- `Revisi` / `Versi data slider saat ini`
- `Total arsip` / `${items.length} slider tersimpan`

7. Render the status `<select>` only when `view === 'current'`; search remains available in both views.
8. Update reorder helper copy so it appears only in current view.

Do not modify fetch behavior: both current and archive snapshots are still loaded initially and by global refresh.

- [x] **Step 4: Run source contracts, helper tests, and build to verify GREEN**

```bash
node --import tsx --test \
  client/src/lib/sliderPresentation.test.ts \
  tools/dev-verification/unit/adminPageChrome.test.ts
npm --prefix client run build
git diff --check
```

Expected: tests PASS and build exits 0.

- [x] **Step 5: Commit view semantics**

```bash
git add client/src/pages/admin/Sliders.tsx tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "fix: distinguish current and archived slider views"
```

---

### Task 4: Simplify Controls, Guard Active Capacity, and Improve Accessibility

**Files:**
- Modify: `client/src/pages/admin/Sliders.tsx`
- Modify: `tools/dev-verification/unit/adminPageChrome.test.ts`
- Test: `client/src/lib/sliderPresentation.test.ts`

**Interfaces:**
- Consumes: `canActivateSlider()` and `sliderPositionLabel()` from Task 2.
- Preserves: global `admin:refresh-current-page` listener, mutation intent/replay identity, dialog focus behavior, keyboard sorting, and step-up retry.
- Produces: one visible refresh button per Slider route (the global header button), tab/tabpanel relationships, predictable empty-state CTAs, and Indonesian operational copy.

- [x] **Step 1: Add failing source-contract assertions for one refresh path, tab semantics, capacity guard, mobile order, and Indonesian copy**

Add/replace assertions in `adminPageChrome.test.ts`:

```ts
assert.match(sliders, /role="tabpanel"/);
assert.match(sliders, /aria-controls="slider-current-panel"/);
assert.match(sliders, /aria-controls="slider-archive-panel"/);
assert.match(sliders, /canActivateSlider/);
assert.match(sliders, /Kapasitas slider aktif penuh/);
assert.match(sliders, /sliderPositionLabel/);
assert.match(sliders, /Naikkan/);
assert.match(sliders, /Turunkan/);
assert.match(sliders, /Muat snapshot terbaru/);
assert.match(sliders, /Terapkan perubahan tanpa konflik/);
assert.match(sliders, /Buang perubahan draft/);
assert.match(sliders, /Buka log audit/);
assert.doesNotMatch(sliders, /> Segarkan</);
assert.doesNotMatch(sliders, /Move Up|Move Down|Load Latest Snapshot|Open Audit/);
```

The `/> Segarkan</` rejection targets page-local text; `AdminLayout.tsx` retains the global refresh.

- [x] **Step 2: Run source contract to verify RED**

```bash
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
```

Expected: FAIL on old page-local refresh, missing tabpanel semantics, old English labels, and absent capacity/position helpers.

- [x] **Step 3: Remove duplicate page refresh and keep the global event path**

In `Sliders.tsx`:

- Remove `RefreshCw` import.
- Remove the page-local **Segarkan** button.
- Keep this existing listener unchanged:

```ts
window.addEventListener('admin:refresh-current-page', handler);
```

- Keep `handler` loading both current and archived snapshots.

The global header button in `AdminLayout.tsx` will now have accessible name `Segarkan Slider Beranda` because Task 1 changed route metadata.

- [x] **Step 4: Add the client-side active-capacity guard without weakening backend authority**

Compute:

```ts
const wasActive = editingBase?.status === true;
const canSelectActive = canActivateSlider(mainSnapshot?.limits, wasActive);
const activeCapacityMessage = !canSelectActive
    ? 'Kapasitas slider aktif penuh (maksimal 8). Simpan sebagai draft atau nonaktifkan slider aktif lain.'
    : null;
```

Add a second defense in `handleSubmit` before creating the intent:

```ts
: form.status && !canActivateSlider(mainSnapshot.limits, editingBase?.status === true)
    ? 'Kapasitas slider aktif penuh (maksimal 8). Simpan sebagai draft atau nonaktifkan slider aktif lain.'
```

Disable the publish checkbox only when activation would add one active slot:

```tsx
<input
    type="checkbox"
    checked={form.status}
    disabled={!canSelectActive && !form.status}
    onChange={(event) => setForm({ ...form, status: event.target.checked })}
/>
```

Show `activeCapacityMessage` next to the checkbox. Existing active sliders (`editingBase.status === true`) remain editable and can be unpublished.

- [x] **Step 5: Add authoritative mobile position, tabpanel semantics, empty actions, and Indonesian copy**

1. Replace mobile `index + 1 / total` with:

```tsx
sliderPositionLabel({
    sortOrder: slider.sortOrder,
    total: items.length,
    filtered: Boolean(keyword || statusFilter !== 'all'),
    archived: view === 'archive',
})
```

Pass the authoritative total/filter/archive inputs into `SliderMobileCard` rather than deriving order from `filteredItems`.

2. Tab markup:

```tsx
<button id="slider-current-tab" role="tab" aria-controls="slider-current-panel" ... />
<button id="slider-archive-tab" role="tab" aria-controls="slider-archive-panel" ... />
<div
    id={view === 'current' ? 'slider-current-panel' : 'slider-archive-panel'}
    role="tabpanel"
    aria-labelledby={view === 'current' ? 'slider-current-tab' : 'slider-archive-tab'}
>
    {/* summary, filters, list */}
</div>
```

3. Give the desktop drag header screen-reader copy:

```tsx
<th className="w-12 px-4 py-3 text-left"><span className="sr-only">Ubah urutan</span></th>
```

4. Translate exact visible/accessibility copy:

- `Move Up` → `Naikkan`
- `Move Down` → `Turunkan`
- `Restore` → `Pulihkan`
- `Restore slider?` → `Pulihkan slider?`
- `Restore sebagai Draft` → `Pulihkan sebagai Draft`
- `Load Latest Snapshot` → `Muat snapshot terbaru`
- `Apply Nonconflicting Changes` → `Terapkan perubahan tanpa konflik`
- `Discard Draft` → `Buang perubahan draft`
- `Open Audit` → `Buka log audit`
- `Konflik revision slider` → `Konflik revisi slider`

Internal action names and endpoint paths remain unchanged.

5. Empty state actions:

- Current with zero items and `canAdd`: show **Tambah slider pertama**, calling `openAddModal`.
- Current/archive with nonempty items but no filtered results: show **Hapus filter**, calling `resetFilters`.
- Archive with zero items: show informational `Belum ada slider yang diarsipkan.` without a create CTA.

- [x] **Step 6: Run focused contracts and build to verify GREEN**

```bash
node --import tsx --test \
  client/src/lib/sliderPresentation.test.ts \
  tools/dev-verification/unit/adminPageChrome.test.ts
npm --prefix client run build
git diff --check
```

Expected: all PASS, build exits 0, and no page-local refresh/old English action copy remains.

- [x] **Step 7: Commit control and accessibility polish**

```bash
git add client/src/pages/admin/Sliders.tsx tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "feat: polish slider controls and accessibility"
```

---

### Task 5: Update Desktop and Mobile Browser Coverage

**Files:**
- Modify: `tools/dev-verification/e2e/sliders.spec.ts:75-210`
- Modify: `client/src/lib/adminNav.test.ts` only if browser-discovered migration behavior requires a pure regression assertion.

**Interfaces:**
- Consumes: final visible labels/semantics from Tasks 1-4.
- Preserves: existing marked fixture cleanup, managed asset cleanup, revisioned create/publish/archive/restore, same-key step-up replay, conflict dialog, and desktop/mobile projects.
- Produces: browser proof that one refresh, archive semantics, capacity guard, tabpanel semantics, and mobile order are correct.

- [x] **Step 1: Update existing assertions to the approved Indonesian copy**

In `sliders.spec.ts`, replace exact old names:

```ts
'Move Up'                   -> 'Naikkan'
'Restore slider ...'        -> 'Pulihkan slider ...'
'Restore slider?'           -> 'Pulihkan slider?'
'Restore sebagai Draft'     -> 'Pulihkan sebagai Draft'
'Load Latest Snapshot'      -> 'Muat snapshot terbaru'
'Discard Draft'             -> 'Buang perubahan draft'
```

Keep backend response/status assertions and fixture cleanup unchanged.

- [x] **Step 2: Add browser assertions for the new navigation/view contracts before implementation is considered complete**

After `page.goto('/admin/sliders')`, assert:

```ts
await expect(page.getByRole('tab', { name: 'Aktif & Draft' })).toHaveAttribute('aria-controls', 'slider-current-panel');
await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'slider-current-tab');
await expect(page.getByRole('button', { name: 'Segarkan Slider Beranda' })).toHaveCount(1);
await expect(page.getByText('Current total', { exact: true })).toHaveCount(0);
```

After archiving and switching tabs:

```ts
await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'slider-archive-tab');
await expect(page.getByLabel('Filter status slider')).toHaveCount(0);
await expect(page.getByText('Diarsipkan', { exact: true }).first()).toBeVisible();
await expect(page.getByText('Total arsip', { exact: true })).toBeVisible();
```

For mobile, assert `Naikkan`/`Turunkan` and authoritative order copy rather than filtered index.

- [x] **Step 3: Add a versioned full-active snapshot browser scenario**

Use Playwright route interception to return a valid writable current snapshot with:

```ts
{
  mutationContract: 'slider-revision-v1',
  revision: 7,
  sliders: [{
    _id: seedId.toHexString(),
    name: `${prefix} full-capacity draft`,
    image: '/uploads/covers/task17-seed-missing.png',
    link: '/capacity',
    sortOrder: 0,
    status: false,
    lifecycle: 'active',
  }],
  limits: {
    total: 20, active: 8,
    currentTotal: 8, currentActive: 8,
    remainingTotal: 12, remainingActive: 0,
  },
}
```

Open that draft for edit and assert:

```ts
await expect(page.getByText(/Kapasitas slider aktif penuh/)).toBeVisible();
await expect(page.getByRole('checkbox', { name: 'Publikasikan sebagai slider aktif' })).toBeDisabled();
```

Then unroute and reload before continuing lifecycle mutations. This mock must never call a mutation endpoint.

- [x] **Step 4: Start the disposable stack for focused browser RED/GREEN verification**

Run from the repository root:

```bash
npm run dev-verify -- setup
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session-fault
```

Expected: infrastructure healthy, exact DB `webtopup_task14_dev` seeded, host processes healthy.

- [x] **Step 5: Run focused desktop and mobile Slider browser tests**

```bash
npx playwright test \
  --config tools/dev-verification/playwright.config.ts \
  sliders.spec.ts --project=chromium-desktop --workers=1

npx playwright test \
  --config tools/dev-verification/playwright.config.ts \
  sliders.spec.ts --project=chromium-mobile --workers=1
```

Expected: both projects PASS, including existing step-up retry, lifecycle, nested dialog, and conflict assertions.

- [x] **Step 6: Tear down and prove no disposable services remain**

```bash
npm run dev-verify -- host-down
npm run dev-verify -- infra-down
npm run dev-verify -- infra-status
```

Expected final status: `{"serviceCount":0}`.

- [x] **Step 7: Commit browser coverage**

```bash
git add tools/dev-verification/e2e/sliders.spec.ts
git commit -m "test: cover polished slider admin UX"
```

---

### Task 6: Focused and Aggregate Verification

**Files:**
- Verify: all files from Tasks 1-5
- No production files or services are changed by this task.

**Interfaces:**
- Consumes: complete UI/navigation implementation.
- Produces: fresh local evidence that focused unit/build/browser checks and the full disposable verification matrix pass.

- [x] **Step 1: Run all focused pure/source tests**

```bash
node --import tsx --test \
  client/src/lib/adminNav.test.ts \
  client/src/lib/sliderManagement.test.ts \
  client/src/lib/sliderPresentation.test.ts \
  tools/dev-verification/unit/adminPageChrome.test.ts
```

Expected: all tests PASS with zero failures.

- [x] **Step 2: Run client build and diff validation**

```bash
npm --prefix client run build
git diff --check
```

Expected: TypeScript/Vite build exits 0 and no whitespace errors.

- [x] **Step 3: Run full disposable aggregate verification**

```bash
npm run dev-verify -- test
```

Expected final result: `LOCAL DEV VERIFIED`. Do not accept a partial matrix or prior run as evidence.

- [x] **Step 4: Prove teardown after aggregate verification**

```bash
npm run dev-verify -- down
npm run dev-verify -- status
```

Expected: stopped disposable state and no host process manifest/services left running. If `test` already stopped the stack, `down` remains an idempotent proof step.

- [x] **Step 5: Inspect final repository state**

```bash
git status --short --branch
git diff --check
git log --oneline -8
```

Expected: only intentional plan/spec documentation may remain uncommitted; implementation files are covered by checkpoint commits; no generated verification secrets/reports are staged.

- [x] **Step 6: Request independent read-only code review**

Reviewer checklist:

- no duplicate `ADMIN_NAV_BLUEPRINT` paths;
- legacy menu/pin migration is deterministic;
- only one Slider refresh control is visible;
- current/archive UI does not mix status/summary semantics;
- full active capacity blocks only new activation;
- filtered mobile order is authoritative;
- tab/tabpanel semantics are valid;
- no backend/security/idempotency/request-envelope change;
- no production mutation/deploy/restart/push occurred.

Any valid finding must be fixed with a focused RED/GREEN test and a separate checkpoint commit, followed by the affected focused commands again.

- [x] **Step 7: Present release handoff without deploying**

Report:

- changed files and checkpoint commits;
- focused test/build results;
- aggregate run ID/result and teardown proof;
- reviewer findings/resolution;
- residual risks, especially that production remains unchanged;
- explicit approval sentence for a later production client/Node/Rust release if the user wants deployment.

Do not deploy, restart production, or push GitHub in this task.
