# Task 17 report — browser, smoke, matrix, and verification expansion

Status: **DONE**

## Implemented

- Added `tools/dev-verification/e2e/sliders.spec.ts` for disposable staff login, revision marker/read-only gate, accessible dialogs/focus restoration/inert background, real cover upload, create/update/step-up same-key observation, archive/restore, and conflict UX.
- Added `tools/dev-verification/e2e/home-slider.spec.ts` for active-only public rendering, safe external/internal links, CTA independence, pause/play, reduced-motion setup, controls, and swipe navigation.
- Added required matrix checks: `slider-management`, `sliders-desktop`, `sliders-mobile`, `home-slider-desktop`, and `home-slider-mobile`.
- Updated mutation smoke slider flow from legacy arrays/flat bodies/SVG assumptions to canonical uploaded PNG, revisioned envelopes, unique idempotency keys, archive/restore/reorder, and archive/upload cleanup without DELETE or legacy sort-order calls.
- Updated read smoke public slider validation to reject leaked internal DTO fields and disclosed HTTP links.
- Documented focused browser commands in `tools/dev-verification/README.md`.
- Moved `upload-security` onto `session-cs-fault` so `managed_asset_unlink_failure` can consume a Rust lease.
- Slider `AUTH_STEP_UP_REQUIRED` now includes `actionGroup`, matching the Site Config client contract.
- Root admin dialogs no longer inert or exclusive-modal the step-up portal.
- Explicit homepage Play is informed opt-in and continues rotation through hover/focus/reduced-motion until Pause.

## Fresh verification

- `npx playwright install-deps chromium` installed the missing OS libraries; `ldd` on bundled Chromium and `chrome-headless-shell` then reported no missing libraries.
- Direct Playwright launch probe: `playwright_launch=ok`.
- Focused disposable browser cases after `db-reset` + `db-seed`:
  - `sliders.spec.ts` chromium-desktop — **1 passed**
  - `sliders.spec.ts` chromium-mobile — **1 passed**
  - `home-slider.spec.ts` chromium-desktop — **1 passed**
  - `home-slider.spec.ts` chromium-mobile — **1 passed**
- `npm run dev-verify -- test` — **LOCAL DEV VERIFIED**
  - runId `1657ce88-43bd-4f19-9256-d994dc8ac42b`
  - started `2026-08-17T07:22:58.161Z`
  - completed `2026-08-17T07:42:23.662Z`
  - commit `e1aba218418bf2c73d90c2e0fcfab0b949a13258`
  - **64/64** required checks `LOCAL DEV VERIFIED`, including `slider-management`, `sliders-desktop`, `sliders-mobile`, `home-slider-desktop`, `home-slider-mobile`, `upload-security`, `diff-check`, `report-secrecy`, and `stopped-state`
- `npm run dev-verify -- infra-down` — exit 0
- `npm run dev-verify -- infra-status` after teardown — `{"serviceCount":0}`
- `npm run dev-verify -- status` after teardown — no host processes, no compose services, rollout disabled, and no replica set connected
- Host process manifest absent
- `git diff --check` — pass

## Disposable boundary

All verification used only `webtopup_task14_dev`, mock provider mode, and loopback Mongo/host ports. Host teardown and the approved `infra-down` lifecycle were run after the aggregate. Production was not touched. No GitHub push, production restart, or production data mutation was performed.
