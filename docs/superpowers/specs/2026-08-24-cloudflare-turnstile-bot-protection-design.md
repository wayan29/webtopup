# Cloudflare Turnstile Bot Protection Design

**Date:** 2026-08-24
**Status:** Approved for implementation planning
**Scope:** Cloudflare Turnstile on staff login, member login, member order, and guest order, with a Site Config master switch and an environment kill switch

## Goal

Stop automated abuse of login and checkout without changing existing authentication, session, 2FA, device-selection, rate-limit, CSRF, or Site Config mutation rules. Operators must be able to turn the protection off from `/admin/site-config`. A server environment kill switch must exist so staff are not locked out if Cloudflare is down.

## Approved decisions

- Use **Cloudflare Turnstile Managed** widgets, not Cloudflare Challenge/WAF at the edge and not a second captcha vendor.
- One **master switch**. No per-surface toggles in this release.
- Protected surfaces are exactly:
  - staff login `POST /v2/auth/staff/login`
  - member login `POST /v2/auth/member/login`
  - member order `POST /v2/transactions`
  - guest order `POST /v2/guest-transactions`
- Store `botProtectionEnabled` and `turnstileSiteKey` in Site Config. Store `TURNSTILE_SECRET_KEY` only in server environment. Never persist or return the secret.
- Default `botProtectionEnabled` is **false**.
- When protection is effectively on, fail closed: missing token, empty site key, empty secret, Cloudflare `success: false`, timeout, or malformed Cloudflare response all reject the request. Do not fail open because Cloudflare is down.
- Emergency kill switch: `TURNSTILE_DISABLED=1` makes the server skip Turnstile even if the Site Config toggle is on. The public snapshot reports protection as off so the widget is hidden.
- Do not protect register, deposit, Open API, seller prepaid, 2FA login, or device-selection in this release.
- Do not add npm or Cargo dependencies. Use the existing HTTP client to call Cloudflare `siteverify`.
- Tests must never call live Cloudflare. Use a mock verifier.

## Current architecture

Login and checkout already go through:

```text
React form
  → Node `/api/v2/*` (rate limit, cookies, proxy)
  → Rust `/v2/*` (authoritative)
  → MongoDB
```

Public branding already comes from `GET /settings/public`. `/admin/site-config` already mutates allowlisted keys through one versioned bulk PUT, with `settings.sensitive` step-up for the sensitive inventory.

Login payloads (`LoginPayload`) and checkout payloads (`CreateTransactionPayload`, `GuestCreatePayload`) currently ignore unknown JSON fields. Turnstile must be an explicit optional field, not an accidentally ignored extra key.

Guest checkout idempotency fingerprints product, target, WhatsApp, payment method, voucher, and member id. The Turnstile token must **not** join that fingerprint: a replay with the same `Idempotency-Key` returns the stored snapshot and must not require a second Cloudflare verification.

## Effective protection

Define server-side effective protection as:

```text
effective = botProtectionEnabled
            && TURNSTILE_DISABLED is not a truthy env value
```

Truthy kill switch values: `1`, `true`, `yes` (case-insensitive, trimmed). Any other value, including unset, leaves the kill switch off.

When `effective` is true, the four protected routes must verify a Turnstile token before doing password work or creating an order.

When `effective` is false, those routes ignore `turnstileToken` if present and must not call Cloudflare.

## Settings contract

Add two allowlisted Site Config keys:

| Key | Type | Default | Public GET | Sensitive |
|---|---|---|---|---|
| `botProtectionEnabled` | boolean | `false` | yes, as **effective** value | yes (`settings.sensitive`) |
| `turnstileSiteKey` | string | `""` | yes, stored value | no |

Rules:

- `turnstileSiteKey` is the public widget site key only. Empty is allowed so operators can prepare the field before enabling the toggle.
- Allowed site-key charset: ASCII letters, digits, `_`, `-`, `.`. Maximum 128 characters. Empty string is valid.
- Admin `GET /settings/admin/all` returns the **stored** toggle, not the kill-switch-adjusted value, plus the stored site key. It must never return `TURNSTILE_SECRET_KEY`.
- Admin GET may add a sibling field `botProtectionKillSwitch: boolean` next to `revision`. It is computed from env, not a setting document, not allowlisted, not writable, and omitted from public GET. The Site Config client must strip it from the editable form the same way it already strips `revision`.
- `TURNSTILE_SECRET_KEY` is valid only when trimmed length is at least 32 characters. Shorter or empty is treated as missing.
- Public `GET /settings/public` adds:
  - `botProtectionEnabled`: effective boolean as defined above
  - `turnstileSiteKey`: stored site key, which may be empty
- Secret, kill-switch env name, Cloudflare URLs, and raw verifier errors stay out of public JSON.

Enabling the toggle while site key or secret is missing is allowed to save. The next protected request then fail-closes with unavailable protection. Site Config must warn the operator about that outcome before save.

## Request contract

Add optional `turnstileToken` to:

- `LoginPayload`
- `CreateTransactionPayload`
- `GuestCreatePayload`

Token rules when protection is effective:

- Trimmed string, length 1–2048. Empty/missing is `400`.
- Oversize is `400`.
- Token is verified once on first execution. It is not stored in Mongo, logs, audit details, or idempotency fingerprints.
- Client IP used for Cloudflare `remoteip` comes from the trusted proxy-stamped `x-forwarded-for` / request IP already used by the gateway. Do not trust a client-supplied IP field.

When protection is not effective, `turnstileToken` is ignored.

2FA (`challengeToken` + TOTP) and device-selection remain unchanged and do not accept or require Turnstile.

## Cloudflare verification

Rust is the only verifier. Node only forwards the JSON body.

Verifier request:

- `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`
- form fields: `secret`, `response` (token), optional `remoteip`
- bounded timeout **5 seconds**
- tests inject a fake verifier; production uses the live URL only when `TURNSTILE_SECRET_KEY` is set and protection is effective

Accept only when Cloudflare JSON has `success === true`. Treat HTTP errors, timeouts, non-JSON, missing `success`, and `success: false` as verification failure.

Do not persist or log: secret, token, raw request body, raw Cloudflare body. Logs may include stable codes only (`bot_protection_required`, `bot_protection_unavailable`, `bot_protection_failed`).

## Fail-closed outcomes

When protection is effective:

| Condition | HTTP | Client message |
|---|---|---|
| Token missing/empty/oversize | 400 | `Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.` |
| `TURNSTILE_SECRET_KEY` missing or shorter than 32 characters | 503 | `Verifikasi keamanan sedang tidak tersedia. Coba beberapa saat lagi.` |
| Stored `turnstileSiteKey` empty | 503 | same unavailable message |
| Cloudflare timeout / transport / non-JSON | 503 | same unavailable message |
| Cloudflare `success: false` | 403 | same failed-verification message as 400 |

Do not leak which of secret, site key, or Cloudflare caused 503.

Login timing: when protection is required, verify Turnstile **before** password hashing/comparison. A Turnstile rejection must not run the password dummy-verify path. Existing login timing floor for password outcomes stays unchanged after a successful Turnstile check.

Guest checkout: verify Turnstile after payload normalization and before durable writes. Idempotent replay of a **completed** guest claim skips Turnstile because no new mutation runs. In-progress or conflicting guest claims keep existing idempotency responses and still must not call Cloudflare again.

Member `POST /v2/transactions` has no create-idempotency claim today. Each create request that is effectively protected must present and verify a token. Do not add member-order idempotency in this release.

## Kill switch

`TURNSTILE_DISABLED` is read from process environment on each protected request (or a process-level cached parse that tests can override). It is not a Site Config key.

While the kill switch is on:

- public `botProtectionEnabled` is `false`
- widgets are not rendered
- the four routes skip verification
- admin stored toggle may still show on

Removing the env value restores the stored toggle without a Site Config save.

## Client UI

### Public widget

Render Turnstile Managed only when public settings have `botProtectionEnabled === true` and a non-empty `turnstileSiteKey`.

Surfaces:

- `client/src/pages/Login.tsx` (member `/login` and staff `/staff/login`)
- `client/src/pages/Order.tsx` (member and guest checkout share this page)

Load `https://challenges.cloudflare.com/turnstile/v0/api.js` only when the widget is shown. Do not load it site-wide.

Submit rules:

- Protected submit is disabled until a token exists.
- Send `turnstileToken` in the login or checkout JSON body.
- On 400/403/503 from this verifier, reset the widget and require a new token.
- Do not send the token on 2FA or device-selection follow-up.

### Site Config

On `/admin/site-config` tab **System**, below guest checkout:

- checkbox `Anti-bot Cloudflare (Turnstile)` bound to `botProtectionEnabled`
- text field `Turnstile site key`
- help text: secret is `TURNSTILE_SECRET_KEY`; emergency disable is `TURNSTILE_DISABLED=1`
- if kill-switch flag is true, show a warning that protection is currently ignored by the server
- if enabling the toggle with an empty site key, confirm that login and order will fail closed until site key and secret exist
- changing `botProtectionEnabled` requires existing `settings.sensitive` step-up
- changing only `turnstileSiteKey` does not require step-up
- never render a secret field

## Out of scope

- Cloudflare WAF / JS Challenge / Bot Fight Mode at Caddy
- Per-surface toggles
- Storing the secret in Mongo
- Register, deposit, Open API, seller prepaid, password reset
- New dependencies
- Calling live Cloudflare from tests or disposable verification

## Testing

- Settings policy: default off; enabling toggle requires step-up; site key is public; secret never appears in GET fixtures.
- Verifier unit tests with a fake Cloudflare client:
  - effective off → missing token allowed
  - kill switch on → missing token allowed even if stored toggle is on
  - effective on + missing token → 400
  - effective on + empty secret or empty site key → 503
  - `success: false` → 403
  - timeout → 503
  - successful token then password/order path unchanged
- Guest idempotency: completed replay does not call the verifier again; token is absent from the fingerprint.
- Client source contracts: widget appears only on the four surfaces; Site Config has toggle + site key and no secret field; public settings type includes the two new keys.
- No real Cloudflare, Digiflazz, IRS, or Tokovoucher calls.

## Security invariants

- Secret never in Mongo, admin GET, public GET, logs, or audit payloads.
- Token never stored.
- Invoice-number-only guest lookup remains fail-closed on WhatsApp (unchanged by this work).
- Existing login invalid-credential message stays generic; Turnstile failures use the separate generic verification messages above and must not become a user-enumeration oracle.
- Protected-route rate limits remain in force in addition to Turnstile.
