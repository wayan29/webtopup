# Cloudflare Turnstile Bot Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require Cloudflare Turnstile Managed on staff login, member login, member order, and guest order when Site Config enables a master switch, with fail-closed verification, an env secret, and a `TURNSTILE_DISABLED` kill switch.

**Architecture:** Add a pure Rust `bot_protection` service that decides skip/verify/reject from stored settings + env, then verifies tokens through an injectable Cloudflare client. Site Config stores only `botProtectionEnabled` and `turnstileSiteKey`. Public GET reports the **effective** toggle. The four protected routes call the same helper before password work or durable writes. React loads the widget only when public settings say protection is on and a site key exists.

**Tech Stack:** Rust/Axum/Reqwest/MongoDB, Node/Fastify TypeScript gateway (forward-only), React 19/TypeScript, Node test runner with `tsx`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-cloudflare-turnstile-bot-protection-design.md`

## Global Constraints

- Work on branch `feat/cloudflare-turnstile-bot-protection` from `origin/main`. Do not mix Open API, Seller Center, or check-transaction commits.
- Strict RED/GREEN TDD: failing test first, minimal implementation, focused pass, `git diff --check`, checkpoint commit.
- Do not add npm or Cargo dependencies. Use existing `reqwest`.
- Tests must never call live Cloudflare, Digiflazz, IRS, or Tokovoucher. Inject a fake verifier.
- `TURNSTILE_SECRET_KEY` never enters Mongo, admin GET, public GET, logs, or audit payloads.
- Turnstile tokens are never stored and never join guest checkout idempotency fingerprints.
- Default `botProtectionEnabled` is `false`.
- Fail closed when protection is effective. Fail open only when the stored toggle is off or `TURNSTILE_DISABLED` is truthy (`1`, `true`, `yes`, case-insensitive, trimmed).
- `TURNSTILE_SECRET_KEY` is missing unless trimmed length is at least 32.
- Exact client messages:
  - 400/403: `Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.`
  - 503: `Verifikasi keamanan sedang tidak tersedia. Coba beberapa saat lagi.`
- Protected surfaces are only: `POST /v2/auth/staff/login`, `POST /v2/auth/member/login`, `POST /v2/transactions`, `POST /v2/guest-transactions`.
- 2FA login-verify and device-selection stay unprotected.
- Guest completed idempotent replay skips Turnstile. Member create has no idempotency and verifies every request.
- Verify Turnstile before login password dummy-verify. A Turnstile rejection must not spend bcrypt.
- `cargo fmt --check` remains unavailable until rustfmt is installed; run focused `cargo test` and record that honestly.
- Rust edition is 2021: `TurnstileVerifier::verify` must return `Pin<Box<dyn Future<...> + Send + '_>>`. Do not add `async-trait`.
- `cargo test` takes one filter regex. Combine names with `|`; do not pass multiple test names as separate argv.
- Disposable verification, if added later, uses exact database `webtopup_task14_dev`. This plan's tasks are unit/source-contract only unless a later task says otherwise.

## File Structure

- Create `rust-api/src/services/bot_protection.rs`: kill switch, effective flag, token/site-key/secret rules, `evaluate_turnstile`, `TurnstileVerifier`, live HTTP verifier, reject responses.
- Modify `rust-api/src/services/mod.rs`: `pub mod bot_protection`.
- Modify `rust-api/src/routes/settings/defaults.rs`: default keys + public allowlist.
- Modify `rust-api/src/routes/settings/policy.rs`: add `botProtectionEnabled` to `SENSITIVE_SITE_SETTING_KEYS` and its exact-inventory test.
- Modify `rust-api/src/routes/settings/validation.rs`: boolean + site-key charset validation.
- Modify `rust-api/src/routes/settings/conversion.rs`: boolean normalize for `botProtectionEnabled`.
- Modify `rust-api/src/routes/settings/snapshot.rs`: `apply_public_bot_protection`, `with_admin_bot_protection_metadata`.
- Modify `rust-api/src/routes/settings.rs`: public GET uses effective toggle; admin GET adds `botProtectionKillSwitch`.
- Modify `rust-api/src/routes/auth/types.rs`, `guest_transactions/types.rs`, `transactions/types.rs`: optional `turnstileToken`.
- Modify `rust-api/src/routes/auth.rs`: evaluate+verify before password work.
- Modify `rust-api/src/routes/guest_transactions/public.rs`: verify after completed-replay return, before durable writes.
- Modify `rust-api/src/routes/transactions.rs`: verify after member auth + payload normalize, before durable writes.
- Modify `rust-api/.env.example`, `server/.env.example`, `.env.local.example`.
- Create `client/src/lib/botProtection.ts` and `client/src/lib/botProtection.test.ts`.
- Modify `client/src/lib/siteConfigMutation.ts` and its test: strip `botProtectionKillSwitch`.
- Modify `client/src/pages/admin/SiteConfig.tsx`, `Login.tsx`, `Order.tsx`, `store/useAuthStore.ts`, `layouts/MainLayout.tsx`.
- Create `tools/dev-verification/unit/botProtection.test.ts`.
- Modify root `package.json` `test:dev-verify:unit` to include `client/src/lib/botProtection.test.ts`.

## Stable Messages And Codes

```rust
pub const BOT_PROTECTION_FAILED_MESSAGE: &str =
    "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.";
pub const BOT_PROTECTION_UNAVAILABLE_MESSAGE: &str =
    "Verifikasi keamanan sedang tidak tersedia. Coba beberapa saat lagi.";
```

Log codes only, never tokens/secrets: `bot_protection_required`, `bot_protection_unavailable`, `bot_protection_failed`.

HTTP mapping:

- `BotProtectionReject::Required` / `TurnstileVerifyError::Failed` → 400 / 403 with `BOT_PROTECTION_FAILED_MESSAGE`
- `BotProtectionReject::Unavailable` / `TurnstileVerifyError::Unavailable` → 503 with `BOT_PROTECTION_UNAVAILABLE_MESSAGE`

Missing/empty/oversize token is 400 (`Required`). Cloudflare `success: false` is 403 (`Failed`). Transport/timeout/non-JSON/missing secret/empty site key is 503 (`Unavailable`).

---

### Task 1: Site Config Keys, Sensitivity, And Validation

**Files:**
- Modify: `rust-api/src/routes/settings/defaults.rs`
- Modify: `rust-api/src/routes/settings/policy.rs`
- Modify: `rust-api/src/routes/settings/validation.rs`
- Modify: `rust-api/src/routes/settings/conversion.rs`
- Test: existing `policy.rs` inventory test plus new tests in `defaults.rs` / `validation.rs`

**Interfaces:**
- Produces settings keys `botProtectionEnabled: false` and `turnstileSiteKey: ""`.
- Produces public allowlist entries for both keys.
- Produces `botProtectionEnabled` in `SENSITIVE_SITE_SETTING_KEYS`. `turnstileSiteKey` is not sensitive.
- Produces site-key validation: empty or ASCII `[A-Za-z0-9._-]` up to 128 chars.

- [ ] **Step 1: Extend the sensitive-inventory test so it fails**

In `rust-api/src/routes/settings/policy.rs` `sensitive_settings_inventory_is_exact`, add `"botProtectionEnabled"` after `"guestCheckoutEnabled"`. Do not add `turnstileSiteKey`.

Add this test in `rust-api/src/routes/settings/defaults.rs` `tests`:

```rust
#[test]
fn bot_protection_defaults_are_off_and_public() {
    let defaults = default_site_settings();
    assert_eq!(defaults.get("botProtectionEnabled"), Some(&json!(false)));
    assert_eq!(defaults.get("turnstileSiteKey"), Some(&json!("")));
    assert!(public_site_setting_keys().contains(&"botProtectionEnabled"));
    assert!(public_site_setting_keys().contains(&"turnstileSiteKey"));
}
```

Add this test in `rust-api/src/routes/settings/validation.rs` (new `#[cfg(test)]` module if missing; otherwise append):

```rust
#[test]
fn turnstile_site_key_rejects_illegal_characters() {
    assert!(validate_setting_json_value_for_policy(
        "turnstileSiteKey",
        &json!("sitekey_ok-1.2")
    ).is_ok());
    assert!(validate_setting_json_value_for_policy("turnstileSiteKey", &json!("")).is_ok());
    assert!(validate_setting_json_value_for_policy(
        "turnstileSiteKey",
        &json!("bad key")
    ).is_err());
}
```

`validate_setting_json_value_for_policy` already exists in this file. Use it.

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
cd rust-api && cargo test --bin webtopup-rust-api sensitive_settings_inventory_is_exact bot_protection_defaults_are_off_and_public turnstile_site_key_rejects_illegal_characters
```

Expected: FAIL (`botProtectionEnabled` missing from inventory/defaults, unknown validation key or illegal key accepted).

- [ ] **Step 3: Implement the keys**

`defaults.rs` `default_site_settings()` add:

```rust
("botProtectionEnabled".to_string(), json!(false)),
("turnstileSiteKey".to_string(), json!("")),
```

`public_site_setting_keys()` add `"botProtectionEnabled"` and `"turnstileSiteKey"` after `"guestCheckoutEnabled"`.

`policy.rs` `SENSITIVE_SITE_SETTING_KEYS` add `"botProtectionEnabled"` immediately after `"guestCheckoutEnabled"`.

`conversion.rs` `normalize_setting_value` boolean arm add `| "botProtectionEnabled"`.

`validation.rs` `validate_setting_json_value` match add:

```rust
"botProtectionEnabled" => ensure_boolean(value, "Anti-bot Cloudflare"),
"turnstileSiteKey" => ensure_turnstile_site_key(value),
```

Add helper in the same file:

```rust
fn ensure_turnstile_site_key(value: &Value) -> Result<Value, Response> {
    let normalized = value.as_str().unwrap_or("").trim().to_string();
    if normalized.is_empty() {
        return Ok(Value::String(String::new()));
    }
    if normalized.len() > 128
        || !normalized
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Turnstile site key tidak valid",
        ));
    }
    Ok(Value::String(normalized))
}
```

If `validate_setting_json_value_for_policy` delegates to the same match, the policy test will pick this up. Do not add a secret setting key.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run the same `cargo test` filter. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/settings/defaults.rs rust-api/src/routes/settings/policy.rs rust-api/src/routes/settings/validation.rs rust-api/src/routes/settings/conversion.rs
git commit -m "feat(settings): add Turnstile site config keys"
```

---

### Task 2: Pure Evaluate/Kill-Switch Helpers

**Files:**
- Create: `rust-api/src/services/bot_protection.rs`
- Modify: `rust-api/src/services/mod.rs`
- Test: inline `#[cfg(test)]` in `bot_protection.rs`

**Interfaces:**
- Consumes: none.
- Produces:

```rust
pub fn kill_switch_enabled(raw: Option<&str>) -> bool;
pub fn secret_is_configured(secret: &str) -> bool; // trim len >= 32
pub fn effective_bot_protection(stored_enabled: bool, kill_switch: bool) -> bool;

pub enum BotProtectionReject { Required, Unavailable }
pub enum TurnstileAction { Skip, Verify(String) }

pub fn evaluate_turnstile(
    stored_enabled: bool,
    site_key: &str,
    secret: &str,
    kill_switch: bool,
    token: Option<&str>,
) -> Result<TurnstileAction, BotProtectionReject>;
```

Token rules when effective: trim; empty/missing → `Required`; len > 2048 → `Required`; else `Verify(token)`.
When effective and site key empty or secret not configured → `Unavailable` (do not inspect token for 503 vs 400 leakage beyond: if token invalid, 400 is allowed first; prefer config 503 only after a present token of valid size, **or** 503 for missing config even without token). Spec fail-closed table: missing token is 400, empty secret/site key is 503. Implement **config 503 before token 400** so a misconfigured on-switch cannot be probed as "token missing" vs "not ready". Order:

1. If not effective → `Skip` (ignore token).
2. If site key empty or secret not configured → `Unavailable`.
3. Normalize token; invalid → `Required`.
4. `Verify(token)`.

- [ ] **Step 1: Write failing tests in the new module**

Create `rust-api/src/services/bot_protection.rs` with only the tests first (and empty `todo!` stubs if needed so it compiles after Step 3). Start with tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_switch_truthy_values() {
        assert!(kill_switch_enabled(Some("1")));
        assert!(kill_switch_enabled(Some("true")));
        assert!(kill_switch_enabled(Some(" YES ")));
        assert!(!kill_switch_enabled(None));
        assert!(!kill_switch_enabled(Some("0")));
        assert!(!kill_switch_enabled(Some("false")));
    }

    #[test]
    fn secret_requires_32_trimmed_characters() {
        assert!(!secret_is_configured(""));
        assert!(!secret_is_configured("short"));
        assert!(secret_is_configured(&"a".repeat(32)));
        assert!(secret_is_configured(&format!("  {}  ", "b".repeat(32))));
    }

    #[test]
    fn disabled_or_kill_switch_skips_token() {
        let secret = "s".repeat(32);
        assert!(matches!(
            evaluate_turnstile(false, "site", &secret, false, None),
            Ok(TurnstileAction::Skip)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", &secret, true, None),
            Ok(TurnstileAction::Skip)
        ));
    }

    #[test]
    fn effective_missing_config_is_unavailable_even_without_token() {
        assert!(matches!(
            evaluate_turnstile(true, "", &"s".repeat(32), false, None),
            Err(BotProtectionReject::Unavailable)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", "", false, Some("tok")),
            Err(BotProtectionReject::Unavailable)
        ));
    }

    #[test]
    fn effective_missing_token_is_required() {
        assert!(matches!(
            evaluate_turnstile(true, "site", &"s".repeat(32), false, None),
            Err(BotProtectionReject::Required)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", &"s".repeat(32), false, Some("  ")),
            Err(BotProtectionReject::Required)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", &"s".repeat(32), false, Some(&"x".repeat(2049))),
            Err(BotProtectionReject::Required)
        ));
    }

    #[test]
    fn effective_valid_token_is_verify() {
        match evaluate_turnstile(true, "site", &"s".repeat(32), false, Some(" token ")) {
            Ok(TurnstileAction::Verify(token)) => assert_eq!(token, "token"),
            other => panic!("{other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run RED**

```bash
cd rust-api && cargo test --bin webtopup-rust-api kill_switch_truthy_values secret_requires_32_trimmed_characters disabled_or_kill_switch_skips_token effective_missing_config_is_unavailable_even_without_token effective_missing_token_is_required effective_valid_token_is_verify
```

Expected: FAIL (module/functions missing). Then add `pub mod bot_protection;` so the file is compiled, still with unresolved names / `todo!`.

- [ ] **Step 3: Implement helpers**

```rust
pub fn kill_switch_enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(str::trim).unwrap_or_default().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

pub fn secret_is_configured(secret: &str) -> bool {
    secret.trim().len() >= 32
}

pub fn effective_bot_protection(stored_enabled: bool, kill_switch: bool) -> bool {
    stored_enabled && !kill_switch
}

pub fn evaluate_turnstile(
    stored_enabled: bool,
    site_key: &str,
    secret: &str,
    kill_switch: bool,
    token: Option<&str>,
) -> Result<TurnstileAction, BotProtectionReject> {
    if !effective_bot_protection(stored_enabled, kill_switch) {
        return Ok(TurnstileAction::Skip);
    }
    if site_key.trim().is_empty() || !secret_is_configured(secret) {
        return Err(BotProtectionReject::Unavailable);
    }
    let normalized = token.unwrap_or_default().trim();
    if normalized.is_empty() || normalized.len() > 2048 {
        return Err(BotProtectionReject::Required);
    }
    Ok(TurnstileAction::Verify(normalized.to_string()))
}
```

Export `BotProtectionReject` and `TurnstileAction` as in Interfaces. Do not call Cloudflare here.

- [ ] **Step 4: GREEN**

Same `cargo test` filter. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/services/bot_protection.rs rust-api/src/services/mod.rs
git commit -m "feat(security): add Turnstile evaluate and kill switch helpers"
```

---

### Task 3: Injectable Verifier And HTTP Mapping

**Files:**
- Modify: `rust-api/src/services/bot_protection.rs`
- Test: same file

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnstileVerifyError { Failed, Unavailable }

pub trait TurnstileVerifier: Send + Sync {
    fn verify(
        &self,
        secret: &str,
        token: &str,
        remote_ip: Option<&str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), TurnstileVerifyError>> + Send + '_>
    >;
}

pub fn reject_response(reject: BotProtectionReject) -> axum::response::Response;
pub fn verify_error_response(error: TurnstileVerifyError) -> axum::response::Response;
```

Live verifier (used by production callers, not by unit tests):

```rust
pub struct CloudflareTurnstileVerifier {
    client: reqwest::Client,
}

impl CloudflareTurnstileVerifier {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("turnstile client"),
        }
    }
}
```

POST `https://challenges.cloudflare.com/turnstile/v0/siteverify` as `application/x-www-form-urlencoded` with `secret`, `response`, optional `remoteip`. Success only if JSON `success === true`. HTTP/transport/timeout/non-JSON/missing success → `Unavailable`. `success: false` → `Failed`. Never log secret, token, or raw body.

For tests, a `FakeTurnstileVerifier` in the test module is enough; do not hit the network.

- [ ] **Step 1: Write failing tests**

```rust
struct FakeVerifier {
    result: Result<(), TurnstileVerifyError>,
    called: std::sync::Mutex<u32>,
}

impl TurnstileVerifier for FakeVerifier {
    fn verify(
        &self,
        secret: &str,
        token: &str,
        _remote_ip: Option<&str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), TurnstileVerifyError>> + Send + '_>
    > {
        assert!(secret_is_configured(secret));
        assert!(!token.is_empty());
        *self.called.lock().unwrap() += 1;
        let result = self.result;
        Box::pin(async move { result })
    }
}

#[tokio::test]
async fn fake_success_and_failure_map_without_network() {
    let ok = FakeVerifier { result: Ok(()), called: Mutex::new(0) };
    assert!(ok.verify(&"s".repeat(32), "tok", None).await.is_ok());
    let failed = FakeVerifier { result: Err(TurnstileVerifyError::Failed), called: Mutex::new(0) };
    assert!(matches!(
        failed.verify(&"s".repeat(32), "tok", None).await,
        Err(TurnstileVerifyError::Failed)
    ));
}

#[test]
fn reject_messages_are_generic() {
    // inspect status + JSON message; do not include secret/token/cloudflare
}
```

For `reject_messages_are_generic`, convert the Response to status + body. Follow existing `status_message` JSON `{ "message": ... }` used by auth. Use `ErrorResponse` / `status_message` from `crate::security` or settings responses. Auth login uses `status_message(StatusCode, &'static str)`. Reuse that so clients already parsing `message` keep working.

- [ ] **Step 2: RED**

```bash
cd rust-api && cargo test --bin webtopup-rust-api fake_success_and_failure_map_without_network reject_messages_are_generic
```

Expected: FAIL.

- [ ] **Step 3: Implement verifier trait, live client, and response helpers**

`reject_response(Required)` → 400 `BOT_PROTECTION_FAILED_MESSAGE`.
`reject_response(Unavailable)` → 503 `BOT_PROTECTION_UNAVAILABLE_MESSAGE`.
`verify_error_response(Failed)` → 403 same failed message.
`verify_error_response(Unavailable)` → 503 unavailable message.

Live `verify` must never run in these tests.

- [ ] **Step 4: GREEN**

Same filter. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/services/bot_protection.rs
git commit -m "feat(security): add injectable Turnstile verifier"
```

---

### Task 4: Public Effective Flag And Admin Kill-Switch Metadata

**Files:**
- Modify: `rust-api/src/routes/settings/snapshot.rs`
- Modify: `rust-api/src/routes/settings.rs` `admin_all` and `public_settings`
- Modify: `client/src/lib/siteConfigMutation.ts`
- Test: `snapshot.rs` tests + `client/src/lib/siteConfigMutation.test.ts`

**Interfaces:**
- Consumes: `effective_bot_protection`, `kill_switch_enabled`.
- Produces:

```rust
pub fn apply_public_bot_protection(settings: &mut Map<String, Value>, kill_switch: bool);
pub fn with_admin_bot_protection_metadata(
    settings: Map<String, Value>,
    revision: i64,
    kill_switch: bool,
) -> Map<String, Value>;
```

Public: overwrite `botProtectionEnabled` with effective boolean. Do not add `botProtectionKillSwitch`.
Admin: `with_revision_field` plus sibling `botProtectionKillSwitch`. Stored toggle remains the settings value.

`parseAdminSettingsResponse` must `delete form.botProtectionKillSwitch` like `revision`.
`createChangedPayload` must skip `botProtectionKillSwitch`.

Env examples: add commented `TURNSTILE_SECRET_KEY=` and `TURNSTILE_DISABLED=` to `rust-api/.env.example` (Rust reads them). Node does not verify; still document in `server/.env.example` / `.env.local.example` as unused-by-gateway comments so operators see them.

- [ ] **Step 1: Failing tests**

In `snapshot.rs`:

```rust
#[test]
fn public_bot_protection_uses_effective_flag() {
    let mut settings = Map::new();
    settings.insert("botProtectionEnabled".into(), json!(true));
    settings.insert("turnstileSiteKey".into(), json!("site"));
    apply_public_bot_protection(&mut settings, true);
    assert_eq!(settings.get("botProtectionEnabled"), Some(&json!(false)));
    assert!(settings.get("botProtectionKillSwitch").is_none());
}

#[test]
fn admin_metadata_exposes_kill_switch_beside_revision() {
    let mut settings = Map::new();
    settings.insert("botProtectionEnabled".into(), json!(true));
    let out = with_admin_bot_protection_metadata(settings, 4, true);
    assert_eq!(out.get("revision"), Some(&Value::from(4)));
    assert_eq!(out.get("botProtectionKillSwitch"), Some(&json!(true)));
    assert_eq!(out.get("botProtectionEnabled"), Some(&json!(true)));
}
```

In `siteConfigMutation.test.ts`:

```ts
test('kill switch metadata never becomes an editable setting', () => {
  const parsed = parseAdminSettingsResponse({
    ...fixtureSettings,
    revision: 14,
    botProtectionKillSwitch: true,
    botProtectionEnabled: true,
  });
  assert.equal('botProtectionKillSwitch' in parsed.form, false);
  assert.equal(parsed.form.botProtectionEnabled, true);
  const changes = createChangedPayload(
    { ...parsed.form, botProtectionKillSwitch: true },
    parsed.form,
  );
  assert.equal('botProtectionKillSwitch' in changes, false);
});
```

- [ ] **Step 2: RED**

```bash
cd rust-api && cargo test --bin webtopup-rust-api public_bot_protection_uses_effective_flag admin_metadata_exposes_kill_switch_beside_revision
node --import tsx --test client/src/lib/siteConfigMutation.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement snapshot helpers and wire GET handlers**

`public_settings`: after loading snapshot, `apply_public_bot_protection(&mut snapshot.settings, kill_switch_enabled(env::var("TURNSTILE_DISABLED").ok().as_deref()));` then existing ETag/body. ETag remains revision-based (kill switch does not bump revision). Accept that a kill-switch flip can serve stale public `botProtectionEnabled` until revision changes; the four routes still read env per request, so protection skip is immediate. Public widget hide can lag until refresh; that is acceptable because routes skip verification under kill switch.

`admin_all`: return `with_admin_bot_protection_metadata(snapshot.settings, snapshot.revision, kill_switch)`.

Strip `botProtectionKillSwitch` in `parseAdminSettingsResponse` and skip it in `createChangedPayload`.

- [ ] **Step 4: GREEN**

Same commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/settings/snapshot.rs rust-api/src/routes/settings.rs client/src/lib/siteConfigMutation.ts client/src/lib/siteConfigMutation.test.ts rust-api/.env.example server/.env.example .env.local.example
git commit -m "feat(settings): expose effective Turnstile flag and kill switch metadata"
```

---

### Task 5: Protect Login Before Password Work

**Files:**
- Modify: `rust-api/src/routes/auth/types.rs` (`LoginPayload.turnstile_token: Option<String>` serde `turnstileToken`)
- Modify: `rust-api/src/routes/auth.rs` `login_for_audience_core`
- Modify: `rust-api/src/services/bot_protection.rs` if a small `load_bot_protection_settings(db)` helper is cleaner
- Test: unit tests for a new `async fn enforce_turnstile(...)` plus a source/timing test that login calls evaluate before `verify_password_constant_cost_blocking`

**Interfaces:**
- Consumes: `evaluate_turnstile`, `TurnstileVerifier`, `reject_response`, `verify_error_response`.
- Produces: login requires token when effective.

Load stored `botProtectionEnabled` and `turnstileSiteKey` from `settings` with the same bson_to_bool / string pattern as `guest_checkout_enabled`. Secret from `env::var("TURNSTILE_SECRET_KEY").unwrap_or_default()`. Kill switch from `TURNSTILE_DISABLED`.

Insert **after** proxy/mongo and empty email/password 400, **before** the dummy bcrypt verify. If `evaluate` returns `Verify(token)`, call verifier with `client_info` IP. On reject, return mapped response without bcrypt.

Use a process-wide `CloudflareTurnstileVerifier` constructed lazily, or `reqwest` client per call like other providers. Per-call builder with 5s timeout is acceptable and matches vendor probes.

Add a test in `auth.rs` similar to existing source tests (`login_spends_password_verification_cost_on_every_rejection`): assert `login_for_audience_core` source contains `evaluate_turnstile` before `verify_password_constant_cost_blocking`.

Also add `enforce_turnstile` tests in `bot_protection.rs` that do not need Mongo:

```rust
pub async fn enforce_turnstile<V: TurnstileVerifier>(
    stored_enabled: bool,
    site_key: &str,
    secret: &str,
    kill_switch: bool,
    token: Option<&str>,
    remote_ip: Option<&str>,
    verifier: &V,
) -> Result<(), axum::response::Response> {
    match evaluate_turnstile(stored_enabled, site_key, secret, kill_switch, token) {
        Ok(TurnstileAction::Skip) => Ok(()),
        Ok(TurnstileAction::Verify(token)) => verifier
            .verify(secret.trim(), &token, remote_ip)
            .await
            .map_err(verify_error_response),
        Err(reject) => Err(reject_response(reject)),
    }
}
```

Login then only loads settings + env and calls `enforce_turnstile`.

- [ ] **Step 1: Failing tests**

Add `enforce_turnstile` tests: skip does not call fake; required/unavailable map statuses; verify failure → 403; verify ok increments call count.

Add auth source test: `login_for_audience_core` text has `enforce_turnstile` before `verify_password_constant_cost_blocking`.

- [ ] **Step 2: RED**

```bash
cd rust-api && cargo test --bin webtopup-rust-api enforce_turnstile login_verifies_turnstile_before_password
```

Expected: FAIL.

- [ ] **Step 3: Implement payload field, `enforce_turnstile`, and login call**

Do not require Turnstile on register, 2FA, or device-selection.

- [ ] **Step 4: GREEN**

Same filter. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/services/bot_protection.rs rust-api/src/routes/auth.rs rust-api/src/routes/auth/types.rs
git commit -m "feat(auth): require Turnstile on member and staff login"
```

---

### Task 6: Protect Guest And Member Checkout

**Files:**
- Modify: `rust-api/src/routes/guest_transactions/types.rs` `GuestCreatePayload.turnstile_token`
- Modify: `rust-api/src/routes/guest_transactions/public.rs`
- Modify: `rust-api/src/routes/guest_transactions/idempotency.rs` tests: fingerprint still excludes token
- Modify: `rust-api/src/routes/transactions/types.rs` `CreateTransactionPayload.turnstile_token`
- Modify: `rust-api/src/routes/transactions.rs` `create_transaction`
- Test: source/unit tests as below

**Interfaces:**
- Consumes: `enforce_turnstile`.
- Guest: after `IdempotencyBegin::Completed/Conflict/InProgress` returns, **before** `retain_uncertain_started` / `prepare_guest_checkout`.
- Member: after `require_member_user`, empty-target 400, and maintenance check; before product lookup / balance debit.

Load the same two settings keys. Do not add `turnstileToken` to `GuestCheckoutFingerprint` or `guest_checkout_digest` parts.

- [ ] **Step 1: Failing tests**

In `idempotency.rs` tests, assert the digest helper input struct still has no token field (compile-time) and a comment/test that extra token would not change digest: build two fingerprints identical except callers holding different tokens; digests equal.

Source tests:

- `create_public` contains `enforce_turnstile` after `IdempotencyBegin::Completed` match and before `retain_uncertain_started`.
- `create_transaction` contains `enforce_turnstile` before `products.find_one`.

- [ ] **Step 2: RED**

```bash
cd rust-api && cargo test --bin webtopup-rust-api guest_checkout_digest create_public_verifies_turnstile_after_replay create_transaction_verifies_turnstile
```

Expected: FAIL on the new source tests.

- [ ] **Step 3: Wire both routes**

Guest completed replay must return before `enforce_turnstile`. Conflict/InProgress also return before it.

Member every create calls `enforce_turnstile`.

- [ ] **Step 4: GREEN**

Same filter plus Task 2 evaluate tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/guest_transactions/types.rs rust-api/src/routes/guest_transactions/public.rs rust-api/src/routes/guest_transactions/idempotency.rs rust-api/src/routes/transactions/types.rs rust-api/src/routes/transactions.rs
git commit -m "feat(order): require Turnstile on member and guest checkout"
```

---

### Task 7: Client Widget, Site Config, And Source Contracts

**Files:**
- Create: `client/src/lib/botProtection.ts`
- Create: `client/src/lib/botProtection.test.ts`
- Create: `tools/dev-verification/unit/botProtection.test.ts`
- Modify: `package.json` `test:dev-verify:unit`
- Modify: `client/src/pages/admin/SiteConfig.tsx`
- Modify: `client/src/pages/Login.tsx`
- Modify: `client/src/pages/Order.tsx`
- Modify: `client/src/store/useAuthStore.ts`
- Modify: `client/src/layouts/MainLayout.tsx` `PublicSettings`
- Optional small widget component: `client/src/components/TurnstileField.tsx` if Login and Order would otherwise duplicate script loading. Prefer one component.

**Interfaces:**
- Produces:

```ts
export const BOT_PROTECTION_FAILED_MESSAGE =
  'Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.';
export const BOT_PROTECTION_UNAVAILABLE_MESSAGE =
  'Verifikasi keamanan sedang tidak tersedia. Coba beberapa saat lagi.';

export function shouldRenderTurnstile(settings: {
  botProtectionEnabled?: unknown;
  turnstileSiteKey?: unknown;
}): settings is { botProtectionEnabled: true; turnstileSiteKey: string };

export function turnstileSiteKey(settings: { turnstileSiteKey?: unknown }): string | null;
```

`shouldRenderTurnstile` is true only when `botProtectionEnabled === true` and trimmed site key is non-empty.

Widget: Cloudflare Managed (`data-appearance` default). Load `https://challenges.cloudflare.com/turnstile/v0/api.js` only when rendering. Token in React state; submit disabled until token exists. On 400/403/503 whose message matches the two generic strings, reset widget.

`useAuthStore.login(audience, email, password, rememberMe, turnstileToken?: string)` adds optional 5th arg; 2FA verify does not take it.

Site Config System tab below guest checkout: checkbox `Anti-bot Cloudflare (Turnstile)`, site key field, help text mentioning `TURNSTILE_SECRET_KEY` and `TURNSTILE_DISABLED=1`. If `botProtectionKillSwitch` was true on the raw response, keep it in component state (not form) and show warning. Enabling toggle with empty site key uses existing confirm dialog (`getSensitiveChangeMessage` add: `Anti-bot Cloudflare akan diaktifkan. Login dan order akan ditolak sampai site key dan TURNSTILE_SECRET_KEY siap.`). Never render a secret input.

- [ ] **Step 1: Write failing helper + source-contract tests**

`client/src/lib/botProtection.test.ts`: render true/false matrix.

`tools/dev-verification/unit/botProtection.test.ts` reads source:

- `SiteConfig.tsx` has `botProtectionEnabled`, `turnstileSiteKey`, and does not contain `TURNSTILE_SECRET` as a form value / password input.
- `Login.tsx` / `Order.tsx` reference `shouldRenderTurnstile` or `TurnstileField`.
- `useAuthStore.ts` login payload may include `turnstileToken`; `verifyTwoFactorLogin` payload does not.
- `MainLayout.tsx` `PublicSettings` includes `botProtectionEnabled` and `turnstileSiteKey`.
- Guest order payload includes `turnstileToken` only when widget shown (assert `turnstileToken` in `Order.tsx` near `/guest-transactions` and `/transactions`).

Add `client/src/lib/botProtection.test.ts` to `package.json` `test:dev-verify:unit`.

- [ ] **Step 2: RED**

```bash
node --import tsx --test client/src/lib/botProtection.test.ts tools/dev-verification/unit/botProtection.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement helper, widget, Site Config, login, order**

Keep Managed widget. Do not load the script on Home or Register.

- [ ] **Step 4: GREEN**

```bash
node --import tsx --test client/src/lib/botProtection.test.ts tools/dev-verification/unit/botProtection.test.ts client/src/lib/siteConfigMutation.test.ts
npm --prefix client run build
cd rust-api && cargo test --bin webtopup-rust-api evaluate_turnstile enforce_turnstile bot_protection sensitive_settings_inventory_is_exact
```

Expected: PASS, client build PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/botProtection.ts client/src/lib/botProtection.test.ts client/src/components/TurnstileField.tsx client/src/pages/admin/SiteConfig.tsx client/src/pages/Login.tsx client/src/pages/Order.tsx client/src/store/useAuthStore.ts client/src/layouts/MainLayout.tsx tools/dev-verification/unit/botProtection.test.ts package.json
git commit -m "feat(ui): add Turnstile widget and Site Config master switch"
```

---

## Spec Coverage

| Spec requirement | Task |
|---|---|
| Turnstile Managed, not WAF | Task 7 widget |
| Master switch only | Task 1 + 7 |
| Four surfaces | Tasks 5–7 |
| Site key in settings, secret in env | Tasks 1, 4, 5 |
| Default off | Task 1 |
| Fail closed | Tasks 2–6 |
| Kill switch env | Tasks 2, 4 |
| Public effective flag | Task 4 |
| Admin stored toggle + kill-switch sibling | Task 4 |
| Token not stored / not in guest digest | Task 6 |
| Login before bcrypt | Task 5 |
| Guest completed replay skips | Task 6 |
| Member create always verifies | Task 6 |
| No new dependencies | all |
| No live Cloudflare in tests | Tasks 2, 3 |
| Site Config step-up on toggle | Task 1 sensitive key (existing mutation path) |
| Exact messages | Task 3 |
| Secret never GET | Task 1 (no key) + Task 4 strip |

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-24-cloudflare-turnstile-bot-protection.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints

Which approach?
