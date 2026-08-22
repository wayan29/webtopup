# Member Open API Settings UX Design

**Date:** 2026-08-23
**Status:** Approved from the bounded `/settings` Open API polish discussion

## Goal

Make the member `/settings` Open API tab readable and usable on mobile and desktop without changing key generate/revoke APIs, secret-once semantics, or public Open API request contracts.

## Scope

This is client-only work on the member settings page. The live surface is:

- Route: `/settings` (`client/src/App.tsx` `path="settings"`)
- Page: `client/src/pages/Settings.tsx`
- Tab: `api` (Open API)

Preferences and Security tabs stay in place. Copy and overflow may be cleaned only where they share the same chrome (header, tab bar, banners). Do not rebuild theme selection or 2FA.

### Tabs and URL

- Canonical query param is exactly `tab`.
- Allowed values: `preferences`, `api`, `security`.
- Unknown, missing, array, or empty values fail closed to `preferences`.
- Refreshing `/settings?tab=api` must keep the Open API tab selected.
- Tab buttons use `role="tab"`, a shared `role="tablist"`, and matching `role="tabpanel"`.
- Mobile labels are short: `Preferensi`, `API`, `Keamanan`. Desktop may show `Tampilan & Preferensi`, `Open API`, `Keamanan`.
- The tab bar must not overflow the viewport: `min-w-0`, no horizontal page scroll.

### Credentials

- Keep existing APIs:
  - `GET /api/v2/api/key`
  - `POST /api/v2/api/key/generate`
  - `DELETE /api/v2/api/key/revoke`
- GET never returns secret plaintext. Generate still returns secret once. Reload must not re-display it.
- Member ID, API Key, and Secret render as stacked cards on a phone (`grid-cols-1`) and three columns from `lg`.
- Key/secret text wraps (`break-all`); do not use single-line horizontal scroll for the credential value.
- API Key remains maskable with show/hide.
- Secret copy is enabled only while the one-time plaintext is in memory. Stored-but-hidden and missing secrets cannot be copied.
- Secret empty/hidden copy:
  - visible: the plaintext
  - stored-hidden: `Tersimpan (hanya ditampilkan saat generate)`
  - missing: `-`
- Show a one-time warning while plaintext is visible.
- Actions use Indonesian:
  - `Buat API Key & Secret`
  - `Buat ulang kredensial`
  - `Cabut key`
- Regenerating an existing key and revoking a key use an inline confirm panel on the page. Do not use `window.confirm`.
- Clipboard writes use `try/catch`. Failure shows `Gagal menyalin ke clipboard.` Success still uses the existing copied-icon feedback.

### Documentation

- A compact docs summary is always visible on the Open API tab after credentials load:
  - Base URL
  - list/profile signature `md5(member_id:api_key:secret)`
  - order/status signature `md5(member_id:api_key:secret:ref_id)`
- CURL examples and the endpoint catalog stay behind an expander. Default is closed.
- Expander labels: `Buka contoh CURL & endpoint` / `Tutup contoh CURL & endpoint`.
- Endpoint paths wrap. Do not truncate path text with `truncate`.
- CURL examples use placeholders only: `MEMBER_ID`, `API_KEY`, `SECRET`, `SIGNATURE`, `REF_ID`. They must not interpolate the signed-in member's live key, secret, or member id.
- Code samples use theme tokens (`ui-panel-muted` / `ui-text`), not a hardcoded dark `#0c0c16` block.

### Language and density

- User-visible Open API chrome is Indonesian.
- Keep technical identifiers (`member_id`, `api_key`, `signature`, HTTP methods, paths) unchanged.
- Header/subtitle stay compact. Do not add a second marketing hero.

## Non-goals

- No Rust, Node gateway, Mongo, or Open API protocol changes.
- No change to generate/revoke request or response envelopes.
- No re-display of a stored secret.
- No 2FA implementation.
- No rewrite of the Preferences theme gallery.
- No new dependencies.
- No new Playwright spec in this plan. Verification is unit helpers, Settings source contracts, and `client` build.
- No production deploy or GitHub push.

## Acceptance Criteria

1. `/settings?tab=api` opens the Open API tab; invalid `tab` values open Preferences.
2. Mobile tab labels fit one row without horizontal page scroll.
3. Credential values wrap on a 360px-wide layout; secret copy is disabled unless plaintext is in memory.
4. Docs summary (base URL + signatures) is visible without opening the expander; CURL/endpoints remain collapsed by default.
5. CURL examples contain no live `apiKey` / `memberId` / secret values.
6. Regenerate and revoke require an inline confirm; `window.confirm` is gone from `Settings.tsx`.
7. Clipboard failure is reported instead of failing silently.
8. Existing generate-once secret behavior and revoke clearing remain unchanged.
