# Task 13 report — accessible admin image dialogs

## Scope

Task 13 only. A one-line explicit caller opt-in was added to `Sliders.tsx` because the covers-only selection policy must be explicit; no other Task 14 UI, upload API behavior, server code, packages, services, or production systems were changed.

## RED evidence

The focused source/behavior contracts were added to `tools/dev-verification/unit/adminPageChrome.test.ts` before the production dialog and picker implementation.

Command:

```bash
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
```

Expected RED result observed:

- 8 existing unrelated admin page contracts passed.
- 2 new Task 13 contracts failed as expected.
- The accessible dialog contract could not read the not-yet-created `client/src/components/admin/AccessibleDialog.tsx` (`ENOENT`).
- The picker contract failed because the existing picker had no `AccessibleDialog` usage and still had the pre-change semantics.

This established the requested RED baseline before writing production code.

## GREEN implementation

- Added `AccessibleDialog` with dialog role and modal labelling IDs, children rendering, initial focus, return-focus fallback, one document keydown trap, Escape and Tab handling, busy-protected close, exact body overflow restoration, parent inert restoration, and portal rendering for nested dialogs.
- Updated `ImagePicker` to use the primitive, provide named close/delete/confirm controls, accessible tabs, gallery image buttons with filename/size/selection state and `aria-pressed`, a separate delete button, nested accessible delete confirmation, picker and nested server errors in `role="alert"`, and no raw `confirm()`.
- Added `restrictSelectionTo` while keeping every folder tab browsable; nonmatching folder assets cannot be selected or confirmed. Existing non-slider `ImagePickerField` callers retain their prior cross-folder browsing behavior; `/admin/sliders` opts into the explicit `covers` restriction.
- Preserved existing upload/list/delete endpoint shapes and multipart upload behavior. Server error presentation remains generic except for the explicit safe `ASSET_IN_USE`/server message contract.

## Validation evidence

Focused source contracts:

```text
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
✔ 10 passed, 0 failed
```

Client build:

```text
npm --prefix client run build
✓ built successfully (exit 0)
```

The build emitted the repository's existing Vite dynamic-import warnings; TypeScript and bundling completed successfully.

Diff whitespace check:

```text
git diff --check
exit 0
```

## Review fix round 1

- Parent/scoped review found an Important compatibility regression: `restrictSelectionTo ?? folder` unintentionally restricted every existing ImagePickerField caller to its default folder, while the requirement restricts slider selection only.
- RED regression updated `adminPageChrome.test.ts` to require an explicit `restrictSelectionTo="covers"` on `Sliders.tsx` and reject the fallback expression; it failed before the fix.
- GREEN fix passes the source suite: ImagePickerField forwards only the optional restriction, and Sliders.tsx supplies the explicit covers-only selection policy. This is the only Task 14 caller adjustment needed to preserve legacy callers while enforcing the Task 13 contract.

No live integration, browser behavior, service startup, or production operation was run or claimed; browser behavior is delegated to Task 16.
