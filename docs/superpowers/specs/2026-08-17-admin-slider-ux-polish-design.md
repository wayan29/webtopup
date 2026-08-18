# Admin Slider UX Polish Design

**Date:** 2026-08-17
**Status:** Approved from read-only admin Slider audit

## Goal

Simplify admin navigation and make Slider management clearer on desktop/mobile without changing the revisioned slider API, security boundaries, mutation semantics, or production data.

## Scope

### Sidebar navigation

- Make every path in `ADMIN_NAV_BLUEPRINT` unique.
- Keep campaign destinations only under **Kampanye**:
  - Flash Sale
  - Voucher & Giveaway
  - Laporan Promo
- Remove the duplicate top-level **Laporan Promo**, duplicate top-level **Vouchers**, and duplicate **Produk → Flash Sale** entry.
- Rename **Slider** to **Slider Beranda** with subtitle **Kelola carousel banner halaman utama**.
- Preserve browser-local menu order and pinned-menu migration by mapping the legacy name `Slider` to `Slider Beranda`.
- Do not change route paths or permission rules.

### Slider views

- Keep the two views **Aktif & Draft** and **Arsip**.
- Current view owns status filtering and current-capacity metrics.
- Archive view hides the active/draft status filter, labels every archived item **Diarsipkan**, and presents archive-appropriate summary/empty-state copy.
- Keep the global revision visible because it fences both current and archive mutations.
- Replace mixed English/Indonesian operational copy with Indonesian labels.

### Controls

- Keep only the global admin-header refresh action. Remove the page-local duplicate refresh button; the existing `admin:refresh-current-page` event continues to reload both current and archive snapshots.
- When `remainingActive === 0`, a new/draft slider cannot be switched to active. An already-active slider remains editable without being falsely blocked.
- On mobile, position copy uses authoritative `sortOrder`, not the filtered-list index.
- Empty current view offers **Tambah slider pertama** when mutation/capacity gates permit it; a filter-empty state offers **Hapus filter**; archive-empty state remains informational.

### Accessibility

- Tabs receive stable `id` and `aria-controls`; content uses one `role="tabpanel"` with matching `aria-labelledby`.
- The desktop reorder column has a screen-reader label.
- Action/button accessible names use Indonesian consistently.
- Preserve `AccessibleDialog`, nested-picker inert behavior, focus return, keyboard reorder, step-up orchestration, and live-region semantics.

## Non-goals

- No changes to Rust, Node gateway, Mongo indexes/data, HMAC capability marker, permissions, step-up action group, idempotency, revision conflicts, archive/restore semantics, upload registry, or homepage carousel.
- No batch reorder redesign in this iteration.
- No removal of revision/conflict/commit-unknown information required for operational safety.
- No new dependency.

## Acceptance Criteria

1. `ADMIN_NAV_BLUEPRINT` contains no duplicate paths and campaign routes have one canonical sidebar location.
2. Existing `Slider` menu order/pin preferences migrate to `Slider Beranda`.
3. Slider page exposes exactly one refresh action through the admin header.
4. Archive view has no active/draft filter, uses `Diarsipkan`, and shows archive-oriented summary/copy.
5. Active-capacity exhaustion disables publication for new/draft sliders with an explanatory message, while existing active sliders remain editable.
6. Filtered mobile cards show authoritative original order.
7. Tabs/tabpanel semantics and Indonesian accessible names are verified on desktop and mobile.
8. Existing revisioned lifecycle, split-deploy fail-closed behavior, dialogs, step-up retry, archive/restore, conflict handling, and keyboard interactions remain passing.
