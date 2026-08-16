# Task 14 report — revisioned slider administration

## Status
GREEN for the scoped revisioned `/admin/sliders` UI, source contracts, pure conflict extension, and client build. No services, browser integration, deployment, production mutation, Task 15 carousel, or Task 16/17 verification was run.

## Scope and decisions
- Rebuilt `Sliders.tsx` around revisioned current/archive snapshots while preserving legacy/malformed reads as renderable read-only data.
- The exact `slider-revision-v1` parser marker gates every mutation control; the page never synthesizes or falls back to legacy writes.
- Every mutation creates/uses one stable `SliderIntent` and sends it through `stepUp.run('settings.sensitive', ...)`; `retrySameSliderIntent` preserves the key across step-up/auth retry and `rebaseSliderIntent` is used for conflict rebase.
- Archive/restore/reorder endpoints are used; no DELETE or legacy sort-order request is emitted. `AccessibleDialog` is used for form, archive, restore, conflict, and unknown-result UX; ImagePicker keeps its explicit covers restriction.
- A proven mutation response updates the local frozen result before refresh. Refresh failure leaves the success result and shows a stale warning. Reorder keeps `previousSliders` and rolls back immediately on failure.
- Commit-unknown state offers only Load Latest Snapshot/Open Audit; there is no Retry Mutation control.

## RED evidence
The source contracts and pure three-way conflict test were added before the page implementation.

Commands:
```bash
cd client && node --import tsx --test src/lib/sliderManagement.test.ts
cd .. && node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
```

Initial RED observation:
- Pure suite passed because Task 12 contracts already existed; the new three-way test also passed against the existing pure implementation.
- Admin source suite failed as expected on the old legacy `Sliders.tsx` (missing marker gate, lifecycle views, archive/restore, AccessibleDialog, rollback/conflict/unknown contracts).

## GREEN implementation
- `client/src/pages/admin/Sliders.tsx`: revisioned main/archive request-ID loads, marker gate, revision/capacity labels, lifecycle intents, nested error handling, frozen response updates, stale warning, conflict/rebase controls, commit-unknown investigation controls, desktop table/mobile cards, Move Up/Down, broken image state, accessible dialogs and contextual labels.
- `client/src/lib/sliderManagement.test.ts`: added the required three-way conflict case (overlapping name conflict, server-only link, draft-only image).
- `tools/dev-verification/unit/adminPageChrome.test.ts`: added source contracts for the Task 14 lifecycle, gate, routes, errors, dialogs, rollback, responsive controls, and unknown/conflict UX.

## GREEN commands and output
```bash
cd client && node --import tsx --test src/lib/sliderManagement.test.ts
# ✔ 9 passed, 0 failed

cd .. && node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
# ✔ 11 passed, 0 failed

npm --prefix client run build
# ✓ built successfully (exit 0; existing Vite dynamic-import warnings only)

git diff --check
# exit 0

Final required verification after commit:
```bash
node --import tsx --test client/src/lib/sliderManagement.test.ts
# ✔ 9 passed, 0 failed
npm --prefix client run build
# ✓ built successfully (exit 0)
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
# ✔ 11 passed, 0 failed
git diff --check
# exit 0
```

## Self-review
- Changed only the approved Task 14 page/tests plus the report; `useStepUpOrchestration.tsx` required no code change because the Task 12 shared orchestrator already preserves stable idempotency keys and is consumed by the page. The required staged task-file list therefore includes that unchanged seam only if the final commit command is kept literal; no unrelated file was touched.
- No `apiV2.delete`, legacy `/sliders/admin/sort-order`, or legacy flat mutation fallback remains in the page.
- Current/archive reads each have independent request IDs, while successful mutation state is retained if reconciliation fails.
- Legacy arrays and malformed snapshots stay readable but mutation-disabled through `parseSliderAdminSnapshot`; no marker is synthesized.
- The image picker API and explicit `folder="covers" restrictSelectionTo="covers"` policy remain unchanged.

## Concerns / residual risks
- This task was validated with source/pure tests and a production client build only. Live Node↔Rust/Mongo behavior, step-up effective-sensitivity permutations, browser focus behavior, upload/image failure behavior, and mobile interaction remain for the explicitly out-of-scope integration/browser tasks.
- The repository’s existing build emits Vite dynamic-import warnings unrelated to this page.
