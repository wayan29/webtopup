# Task 17 report — browser, smoke, matrix, and verification expansion

Status: **DONE_WITH_CONCERNS / BROWSER ENVIRONMENT-BLOCKED**

## Implemented

- Added `tools/dev-verification/e2e/sliders.spec.ts` for disposable staff login, revision marker/read-only gate, accessible dialogs/focus restoration/inert background, real cover upload, create/update/step-up same-key observation, archive/restore, and conflict UX.
- Added `tools/dev-verification/e2e/home-slider.spec.ts` for active-only public rendering, safe external/internal links, CTA independence, pause/play, reduced-motion setup, controls, and swipe navigation.
- Added required matrix checks: `slider-management`, `sliders-desktop`, `sliders-mobile`, `home-slider-desktop`, and `home-slider-mobile`.
- Updated mutation smoke slider flow from legacy arrays/flat bodies/SVG assumptions to canonical uploaded PNG, revisioned envelopes, unique idempotency keys, archive/restore/reorder, and archive/upload cleanup without DELETE or legacy sort-order calls.
- Updated read smoke public slider validation to reject leaked internal DTO fields and disclosed HTTP links.
- Documented focused browser commands in `tools/dev-verification/README.md`.

## Fresh verification

- `node --import tsx --test tools/dev-verification/unit/verificationMatrix.test.ts` — **2/2 pass**.
- `node --check scripts/smoke/api-v2-read-smoke.js` — exit 0.
- `node --check scripts/smoke/api-v2-mutation-smoke.js` — exit 0.
- `node --import tsx --check tools/dev-verification/e2e/sliders.spec.ts` — exit 0.
- `node --import tsx --check tools/dev-verification/e2e/home-slider.spec.ts` — exit 0.
- Playwright `--list` discovers exactly 4 required cases across desktop/mobile.
- `npm --prefix client run build` — exit 0.
- `npm --prefix server run build` — exit 0.
- `git diff --check` — pass.

## Browser execution blocker

The approved disposable host was started with the required profile and exact database, but Chromium execution failed before test code ran because the installed Playwright headless shell cannot load the system library `libatk-1.0.so.0`:

`error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory`

No browser assertions are claimed as passed. No package was installed and no system configuration was changed. Both desktop cases failed at browser launch for this environment reason; mobile execution was not claimed after the same launch prerequisite failed.

## Disposable boundary

The browser attempt used only `webtopup_task14_dev`, mock provider mode, loopback Mongo/host ports, and the approved session fault profile. Host teardown was run after the attempt. Production was not touched. Final aggregate `LOCAL DEV VERIFIED` and final `serviceCount:0` remain pending Task 17 completion once a browser-capable environment is available; the current infrastructure may remain at `serviceCount:2` until the approved final `infra-down` lifecycle.
