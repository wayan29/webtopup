# Task 15 report — homepage slider carousel hardening

## Status
GREEN for pure carousel helpers, isolated accessible component, Home integration, client build, and diff check. No browser/e2e or live service run; delegated to Tasks 16–17.

## Execution note
The original worker timed out after 30 minutes with all task files written but uncommitted. The parent recovered the lane: reviewed the worker diff, validated pure tests, fixed two UX/a11y defects, then verified and committed. The timeout was not treated as approval; recovery included a fresh code pass.

## RED evidence
- `node --import tsx --test client/src/lib/sliderCarousel.test.ts` initially failed with module not found for `./sliderCarousel.ts` before implementation (expected RED).
- Pure RED set includes the two verbatim brief tests plus count shrink/negative index, swipe threshold/vertical dominance, empty fallback, full pause-source truth table, and internal query/fragment preservation.

## GREEN implementation
- `client/src/lib/sliderCarousel.ts`: `normalizeSlideIndex`, `classifyPublicSliderLink` (safe internal preserving query/fragment; HTTPS-only external with credential/traversal/encoded-attack rejection), `shouldAutoRotate`, `swipeDirection` (vertical-dominance ignore), and exported prop types.
- `client/src/components/home/HomeSliderCarousel.tsx`:
  - Only the active slide can be interactive; linked active slide renders exactly one full-banner anchor; inactive slides are non-anchor containers with `inert` and `aria-hidden="true"` plus `pointer-events-none`.
  - Decorative overlays use `pointer-events-none`; CTA/content overlay sits on `z-10` above the banner layer so homepage CTAs stay clickable and focusable.
  - Five-second auto-rotation honoring `prefers-reduced-motion`, hover pause, focus-within pause, and explicit Pause/Play; an explicit Play opt-in overrides the reduced-motion default pause until the user pauses again.
  - Prev/next/indicators available on desktop and mobile; manual navigation resets timing deterministically and announces `Slide n dari m` via a polite live region (auto rotations do not announce).
  - Pointer swipe uses `touchAction: 'pan-y'`, 40px horizontal threshold, ignores vertically dominant gestures, and suppresses the accidental banner-click that would otherwise fire after a swipe on a linked anchor.
  - Broken/missing images render a named fallback banner (gradient + slider name) instead of a hidden element.
  - Empty/default state uses the provided `defaultSlides`; an empty set renders the named fallback.
- `client/src/pages/Home.tsx`: delegates carousel state/rendering to the component (`sliders`, `defaultSlides`, `categoryCount`); removed local timer/link helpers; all other homepage flows unchanged. Article images now use the centralized `getAssetUrl`, which preserves absolute URLs (verified against `client/src/lib/assetUrl.ts`).

## Validation
```text
node --import tsx --test client/src/lib/sliderCarousel.test.ts
✔ 7 passed, 0 failed
npm --prefix client run build
✓ exit 0 (existing Vite dynamic-import warnings only)
git diff --check
✓ exit 0
```

## Residual risks
- DOM/browser behavior (real swipe devices, SR announcements, matchMedia changes) is validated only by source/pure review; Playwright proof is delegated to Tasks 16–17.
