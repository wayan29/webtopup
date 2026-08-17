# Task 17 report — browser, smoke, matrix, and verification expansion

Status: **IN PROGRESS / FOCUSED BROWSER GREEN**

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
- `node --import tsx --test tools/dev-verification/unit/verificationMatrix.test.ts` — **2/2 pass**.
- `node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts` — **13/13 pass**.
- `node --import tsx --test client/src/lib/sliderCarousel.test.ts` — **8/8 pass**.
- `cargo test --manifest-path rust-api/Cargo.toml --bin webtopup-rust-api trusted_group_rejection_includes_action_group -- --nocapture` — **1 pass**.
- `cargo build --manifest-path rust-api/Cargo.toml --bin webtopup-rust-api` — exit 0.
- `npm --prefix client run build` — exit 0.
- Focused disposable browser cases after `db-reset` + `db-seed`:
  - `sliders.spec.ts` chromium-desktop — **1 passed**
  - `sliders.spec.ts` chromium-mobile — **1 passed**
  - `home-slider.spec.ts` chromium-desktop — **1 passed**
  - `home-slider.spec.ts` chromium-mobile — **1 passed**
- `git diff --check` — pass.

## Remaining

The full aggregate `npm run dev-verify -- test` is the remaining Task 17 gate. Focused Task 17 browser cases are green, but this report does not claim `LOCAL DEV VERIFIED` until the aggregate completes with every required check verified.

## Disposable boundary

All verification used only `webtopup_task14_dev`, mock provider mode, and loopback Mongo/host ports. Host processes were stopped after focused browser runs. Production was not touched. No GitHub push, production restart, or production data mutation was performed.
