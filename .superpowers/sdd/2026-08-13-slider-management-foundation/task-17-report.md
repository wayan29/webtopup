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

- `npm run test:dev-verify:unit` — **234/234 pass** (including the matrix contracts).
- `node --import tsx --test tools/dev-verification/unit/verificationMatrix.test.ts` — **2/2 pass**.
- `node --check scripts/smoke/api-v2-read-smoke.js` — exit 0.
- `node --check scripts/smoke/api-v2-mutation-smoke.js` — exit 0.
- `node --import tsx --check tools/dev-verification/e2e/sliders.spec.ts` — exit 0.
- `node --import tsx --check tools/dev-verification/e2e/home-slider.spec.ts` — exit 0.
- Playwright `--list` discovers exactly 4 required cases across desktop/mobile.
- `npm --prefix client run build` — exit 0.
- `npm --prefix server run build` — exit 0.
- `git diff --check` — pass.
- `npm run dev-verify -- test` — **LOCAL DEV FAILED** at the first browser-dependent check, `public-origin`; unit, client-build, server-build, rust-build, and mongo checks completed as `LOCAL DEV VERIFIED` before the browser launch blocker.
- `npm run dev-verify -- infra-status` after teardown — `{"serviceCount":0}`.
- `npm run dev-verify -- status` after teardown — no host processes, no compose services, rollout disabled, and no replica set connected.
- Browser fixture cleanup was rechecked to remove marked uploaded cover registry rows/files and slider claim/audit/reference rows.
- Admin browser fixture now seeds a marked current draft for full-ID context, verifies mobile Move Up visibility, selects the exact uploaded file, and handles active archive step-up explicitly.

## Browser execution blocker

The approved disposable host was started with the required profile and exact database, but Chromium execution failed before test code ran because the installed Playwright browser dependencies are absent. Direct `ldd` inspection reproduced the failure for both bundled Chromium and `chrome-headless-shell`; the missing set includes `libatk-1.0.so.0`, `libatk-bridge-2.0.so.0`, `libcups.so.2`, `libasound.so.2`, `libgbm.so.1`, `libcairo.so.2`, `libpango-1.0.so.0`, `libXcomposite.so.1`, `libXdamage.so.1`, `libXfixes.so.3`, `libXrandr.so.2`, and `libatspi.so.0`. The exact launch error was:

`error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory`

No system browser executable or already-running CDP browser was available, and read-only package inspection found no installed `libatk1.0-0` candidate. No package was installed and no system configuration was changed. No browser assertions are claimed as passed. The aggregate run stopped at `public-origin`; the Task 17 desktop/mobile cases were therefore not run by the matrix. Earlier focused desktop launch attempts showed the same prerequisite failure; mobile execution was not claimed.

## Disposable boundary

The browser attempt used only `webtopup_task14_dev`, mock provider mode, loopback Mongo/host ports, and the approved session fault profile. Host teardown and the approved `infra-down` lifecycle were run after the aggregate attempt. Production was not touched. The final aggregate is explicitly `LOCAL DEV FAILED` because the browser prerequisite is unavailable; the final disposable infrastructure proof is `serviceCount:0`.
