use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use bcrypt::{hash, verify, DEFAULT_COST};
use jsonwebtoken::{decode, DecodingKey, Validation};
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::json;

use crate::{
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    utils::bson::read_string,
};

const MAINTENANCE_MESSAGE: &str =
    "Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.";
const INVALID_LOGIN_MESSAGE: &str = "Login gagal. Periksa email dan password Anda.";
const INVALID_REGISTER_MESSAGE: &str =
    "Registrasi tidak dapat diproses. Periksa data dan coba lagi.";

pub(crate) mod access_session;
mod errors;
mod jwt;
pub(crate) mod legacy_migration;
pub(crate) mod legacy_migration_aead;
pub(crate) mod legacy_migration_cleanup;
pub(crate) mod legacy_migration_store;
mod logging;
mod policy;
mod recovery_aead;
pub(crate) mod security_audit;
pub(crate) mod security_change;
mod serialization;
mod session_handlers;
mod session_issuance;
pub(crate) mod session_migration;
pub(crate) mod session_store;
mod session_tokens;
mod sessions;
mod settings;
mod step_up;
mod totp;
mod two_factor;
mod types;
pub(crate) use access_session::resolve_optional_member_access;
pub(crate) use errors::auth_error;
use jwt::*;
use logging::*;
use policy::SessionPolicy;
use serialization::*;
pub use session_handlers::{
    acknowledge_legacy_migration, activity, activity_status, list_sessions, logout,
    migrate_legacy_session, refresh, revoke_all, revoke_current, revoke_device, unlock,
};
use session_issuance::*;
use session_store::*;
use session_tokens::*;
pub use sessions::revoke_sessions;
use settings::*;
pub use step_up::step_up;
#[allow(unused_imports)]
pub use step_up::{
    require_trusted_step_up_group, verify_step_up_grant, ACTION_GROUPS, STEP_UP_PURPOSE,
};
pub use two_factor::{
    two_factor_confirm, two_factor_disable, two_factor_setup, two_factor_status,
    verify_two_factor_login,
};
use types::*;
pub use types::{DeviceSelectionPayload, LoginPayload, RegisterPayload};

pub async fn me(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(user_id) = context.user_id else {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Unauthorized",
        );
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(user_id) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };
    match client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(Some(user)) => Json(json!({ "user": serialize_auth_user(&user) })).into_response(),
        Ok(None) => status_message(axum::http::StatusCode::NOT_FOUND, "User not found"),
        Err(_) => internal_error(),
    }
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<RegisterPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let settings = site_settings(&db).await;
    if settings.maintenance_mode {
        return status_message(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            &maintenance_message(&settings.maintenance_message),
        );
    }
    if !settings.registration_enabled {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Registrasi member sedang dinonaktifkan",
        );
    }

    let name = normalize_text(payload.name.as_deref());
    let email = normalize_email(payload.email.as_deref());
    let password = payload.password.unwrap_or_default();
    if name.len() < 2 {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama minimal 2 karakter",
        );
    }
    if email.is_empty() {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Email wajib diisi");
    }
    if let Some(message) = password_validation_message(&password) {
        return status_message(axum::http::StatusCode::BAD_REQUEST, message);
    }
    let users = db.collection::<Document>("users");
    if matches!(users.find_one(doc! { "email": &email }).await, Ok(Some(_))) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            INVALID_REGISTER_MESSAGE,
        );
    }
    let Some(hashed) = hash_password_blocking(password).await else {
        return internal_error();
    };
    let now = DateTime::now();
    let user_id = ObjectId::new();
    let user_doc = doc! {
        "_id": user_id,
        "name": name,
        "email": &email,
        "password": hashed,
        "role": "member",
        "level": "basic",
        "balance": 0_i64,
        "points": 0_i64,
        "twoFactorEnabled": false,
        "sessionVersion": 0_i64,
        "permissions": Document::new(),
        "preferences": Document::new(),
        "active": true,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0_i64,
    };
    if users.insert_one(user_doc.clone()).await.is_err() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            INVALID_REGISTER_MESSAGE,
        );
    }
    if !refresh_issuance_enabled(&state, &user_doc) {
        return issue_legacy_session_response(&state, &user_doc, 201);
    }
    issue_session(
        &state,
        &db,
        &user_doc,
        LoginAudience::Member,
        false,
        payload.device_name.as_deref(),
        true,
        &headers,
        201,
    )
    .await
}

pub async fn member_login(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<LoginPayload>,
) -> Response {
    login_for_audience(state, headers, payload, LoginAudience::Member).await
}

pub async fn staff_login(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<LoginPayload>,
) -> Response {
    login_for_audience(state, headers, payload, LoginAudience::Staff).await
}

/// A process-local bcrypt hash used only to spend verification cost on rejected logins.
///
/// It is derived from 48 random lowercase bytes at the production cost, so it cannot be
/// precomputed. Its verification result is always discarded, so even an astronomically unlikely
/// collision with a submitted password can never authenticate anyone.
fn dummy_password_hash() -> &'static str {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY.get_or_init(|| {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let filler: String = (0..48)
            .map(|_| char::from(rng.gen_range(b'a'..=b'z')))
            .collect();
        hash(&filler, DEFAULT_COST).expect("dummy login hash must be constructible")
    })
}

/// Build the dummy hash before serving traffic.
///
/// Without this, the first rejected login of the process pays an extra bcrypt *hash* on top of
/// its verification and stands out clearly from every later request.
pub fn warm_login_timing_material() {
    let _ = dummy_password_hash();
}

/// Minimum wall-clock duration of any login attempt.
///
/// Stored bcrypt costs are not uniform in production: accounts created through the Node model are
/// hashed at cost 10, while password changes performed by this service use cost 12. Spending a
/// dummy verification cannot equalize the outcomes on its own, because a wrong password on a
/// cost-10 account still returns sooner than a cost-12 dummy.
///
/// The floor must therefore sit above the slowest padded outcome, not merely above the average.
/// Measured on the deployment host with an optimized build (12 samples per cost): cost-10
/// verification 69-148ms, cost-12 verification 279-419ms. Verification now runs on the blocking
/// pool so it no longer starves the executor, and 1500ms leaves roughly 3.5x headroom over the
/// measured cost-12 worst case for the Mongo lookup, the failure audit write, and session
/// issuance under load.
const LOGIN_TIMING_FLOOR: std::time::Duration = std::time::Duration::from_millis(1500);

/// Hold the response until the floor has elapsed.
async fn settle_login_timing_floor(started: std::time::Instant) {
    if let Some(remaining) = LOGIN_TIMING_FLOOR.checked_sub(started.elapsed()) {
        tokio::time::sleep(remaining).await;
    }
}

/// Verify a password while always paying exactly one bcrypt verification.
///
/// A missing or malformed stored hash still costs a full verification against a dummy hash, so
/// response time cannot distinguish an unknown or password-less account from a wrong password.
///
/// This is CPU-bound for hundreds of milliseconds. Call it through
/// [`verify_password_constant_cost_blocking`] from request handling; only tests use it directly.
fn verify_password_constant_cost(password: &str, stored_hash: &str) -> bool {
    if stored_hash.is_empty() {
        let _ = verify(password, dummy_password_hash());
        return false;
    }
    match verify(password, stored_hash) {
        Ok(matched) => matched,
        Err(_) => {
            // Malformed stored hash: spend the cost anyway, then fail closed.
            let _ = verify(password, dummy_password_hash());
            false
        }
    }
}

/// Hash a new password on the blocking pool, under the verification budget.
///
/// Registration and password changes are request-path bcrypt calls too. Left inline they block an
/// async worker and contend with login verification for CPU outside any budget. The permit moves
/// into the closure so it stays held until bcrypt exits, matching the verification path.
async fn hash_password_blocking(password: String) -> Option<String> {
    let permit = Arc::clone(verify_hashing_permits())
        .acquire_owned()
        .await
        .ok()?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        hash(&password, DEFAULT_COST).ok()
    })
    .await
    .ok()
    .flatten()
}

/// Reserved admission for response-path password verification.
///
/// bcrypt is hundreds of milliseconds of CPU per call. Tokio's blocking pool grows to hundreds of
/// threads, so unbounded hashing lets work crowd out logins: they slow down unevenly, which both
/// amplifies load and reintroduces a timing signal. Verification draws from its own budget so
/// background work can never take the last permit from a login that is waiting to verify.
fn verify_hashing_permits() -> &'static Arc<tokio::sync::Semaphore> {
    static PASSWORD_VERIFY_PERMITS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    PASSWORD_VERIFY_PERMITS.get_or_init(|| {
        let parallelism = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(2);
        Arc::new(tokio::sync::Semaphore::new(parallelism.max(2)))
    })
}

/// Separate, deliberately small admission for opportunistic background hashing.
///
/// Keeping this budget disjoint from [`verify_hashing_permits`] is what guarantees a rehash storm
/// cannot delay a login, no matter how many upgrades are pending.
fn background_hashing_permits() -> &'static Arc<tokio::sync::Semaphore> {
    static PASSWORD_BACKGROUND_PERMITS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    PASSWORD_BACKGROUND_PERMITS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

/// Run the constant-cost verification on the blocking pool.
///
/// bcrypt at cost 12 measured 279-419ms on the deployment host, and cost 10 measured 69-148ms.
/// Executing that inline on a Tokio worker starves the executor under concurrent logins, which
/// inflates unrelated request latency and makes the timing floor unenforceable because the padded
/// work itself overruns the deadline.
///
/// The permit is owned by the blocking closure rather than the awaiting future. `spawn_blocking`
/// work cannot be cancelled, so a permit scoped to the future would be released while bcrypt kept
/// burning CPU, letting repeated cancellations run more hashes than the budget allows.
async fn verify_password_constant_cost_blocking(password: String, stored_hash: String) -> bool {
    let Ok(permit) = Arc::clone(verify_hashing_permits()).acquire_owned().await else {
        return false;
    };
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        verify_password_constant_cost(&password, &stored_hash)
    })
    .await
    {
        Ok(matched) => matched,
        // A panicking or cancelled verification must never authenticate.
        Err(_) => false,
    }
}

/// Whether a stored hash was produced at a weaker cost than this service now uses.
///
/// Accounts created through the Node model are hashed at cost 10 while this service hashes at
/// cost 12. Converging them on successful login removes the mixed-cost timing variance at the
/// source.
///
/// The whole bcrypt structure is validated, not just the cost field: reading the third `$` segment
/// alone accepts truncated or bogus records such as `$2b$10$bad` and `$bogus$01$x`. This helper
/// fails closed on its own so a malformed record is never rewritten, regardless of caller order.
fn stored_hash_needs_rehash(stored_hash: &str) -> bool {
    // Layout: $<2a|2b|2x|2y>$<two-digit cost>$<22-char salt><31-char digest>
    if stored_hash.len() != 60 || !stored_hash.starts_with('$') {
        return false;
    }
    let mut parts = stored_hash.split('$');
    if parts.next() != Some("") {
        return false;
    }
    let Some(version) = parts.next() else {
        return false;
    };
    if !matches!(version, "2a" | "2b" | "2x" | "2y") {
        return false;
    }
    let Some(cost_field) = parts.next() else {
        return false;
    };
    if cost_field.len() != 2 || !cost_field.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(cost) = cost_field.parse::<u32>() else {
        return false;
    };
    // bcrypt only accepts costs in 4..=31; anything else is a corrupt record.
    if !(4..=31).contains(&cost) {
        return false;
    }
    let Some(body) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || body.len() != 53 {
        return false;
    }
    if !body
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'/')
    {
        return false;
    }

    cost < DEFAULT_COST
}

/// Accounts with an upgrade already scheduled, so a login burst launches at most one hash each.
fn rehash_in_flight() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static REHASH_IN_FLIGHT: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashSet<String>>,
    > = std::sync::OnceLock::new();
    REHASH_IN_FLIGHT.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Releases an in-flight key on drop.
///
/// Removing the key only on the success path would permanently suppress upgrades for an account
/// whose task panicked or was cancelled, so cleanup has to be RAII. A poisoned lock is recovered
/// rather than propagated: refusing to unlock would disable upgrades process-wide and leak keys.
struct RehashGuard {
    key: String,
}

impl Drop for RehashGuard {
    fn drop(&mut self) {
        let mut in_flight = rehash_in_flight()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        in_flight.remove(&self.key);
    }
}

/// Upgrade a legacy-cost hash in the background, at most once per account at a time.
///
/// This is opportunistic: it takes a permit from the separate background budget with
/// `try_acquire_owned` and gives up when that budget is committed, so it can never delay a login
/// waiting to verify. A skipped or failed upgrade is retried by the next successful login. The
/// update matches the old hash as well as the id, so a concurrent password change is never
/// overwritten.
fn spawn_stored_hash_upgrade(
    db: mongodb::Database,
    user_id: ObjectId,
    password: String,
    stored_hash: String,
) {
    let key = user_id.to_hex();
    {
        let mut in_flight = rehash_in_flight()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // A burst of concurrent logins for one account must not launch duplicate hashes.
        if !in_flight.insert(key.clone()) {
            return;
        }
    }
    let guard = RehashGuard { key };

    tokio::spawn(async move {
        // Dropped on every exit path, including panic and cancellation.
        let _guard = guard;
        let Ok(permit) = Arc::clone(background_hashing_permits()).try_acquire_owned() else {
            // No spare background budget: leave the legacy hash for a later login.
            return;
        };
        let Ok(Ok(upgraded)) = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            hash(&password, DEFAULT_COST)
        })
        .await
        else {
            return;
        };
        let _ = db
            .collection::<Document>("users")
            .update_one(
                doc! { "_id": user_id, "password": &stored_hash },
                doc! { "$set": { "password": upgraded } },
            )
            .await;
    });
}

fn accepted_login_role(audience: LoginAudience, role: &str) -> bool {
    audience.accepts_role(role)
}

fn effective_remember_me(audience: LoginAudience, requested: Option<bool>) -> bool {
    matches!(audience, LoginAudience::Member) && requested.unwrap_or(false)
}

/// Serve a login attempt and pad it to the constant floor.
///
/// Every early return of the core passes through here, so no outcome can be distinguished by
/// response time: bad request, unknown account, absent or malformed stored hash, wrong password,
/// wrong channel, inactive account, 2FA challenge, and success all settle at the same floor.
async fn login_for_audience(
    state: Arc<AppState>,
    headers: axum::http::HeaderMap,
    payload: LoginPayload,
    audience: LoginAudience,
) -> Response {
    let started = std::time::Instant::now();
    let response = login_for_audience_core(state, headers, payload, audience).await;
    settle_login_timing_floor(started).await;
    response
}

async fn login_for_audience_core(
    state: Arc<AppState>,
    headers: axum::http::HeaderMap,
    payload: LoginPayload,
    audience: LoginAudience,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let email = normalize_email(payload.email.as_deref());
    let password = payload.password.unwrap_or_default();
    let (ip, user_agent) = client_info(&headers);
    if email.is_empty() || password.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Email dan password wajib diisi",
        );
    }

    let users = db.collection::<Document>("users");
    let user = match users.find_one(doc! { "email": &email }).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };

    // Spend one constant bcrypt cost before any credential rejection below. Otherwise unknown,
    // password-less and inactive accounts return measurably faster than a wrong password and
    // leak account existence and state despite the identical response body.
    let stored_hash = user
        .as_ref()
        .map(|document| read_string(document, "password"))
        .unwrap_or_default();
    let password_matches =
        verify_password_constant_cost_blocking(password.clone(), stored_hash.clone()).await;

    let Some(mut user) = user else {
        write_login_log(
            &db,
            None,
            &email,
            None,
            &ip,
            &user_agent,
            "failed",
            Some("User not found"),
        )
        .await;
        return status_message(axum::http::StatusCode::BAD_REQUEST, INVALID_LOGIN_MESSAGE);
    };

    let user_id = user.get_object_id("_id").ok().map(|id| id.to_hex());
    let role = read_string(&user, "role");
    if stored_hash.is_empty() {
        write_login_log(
            &db,
            user_id.as_deref(),
            &email,
            Some(&role),
            &ip,
            &user_agent,
            "failed",
            Some("No password set"),
        )
        .await;
        return status_message(axum::http::StatusCode::BAD_REQUEST, INVALID_LOGIN_MESSAGE);
    }
    if !password_matches {
        write_login_log(
            &db,
            user_id.as_deref(),
            &email,
            Some(&role),
            &ip,
            &user_agent,
            "failed",
            Some("Invalid password"),
        )
        .await;
        return status_message(axum::http::StatusCode::BAD_REQUEST, INVALID_LOGIN_MESSAGE);
    }
    if user.get_bool("active") == Ok(false) {
        write_login_log(
            &db,
            user_id.as_deref(),
            &email,
            Some(&role),
            &ip,
            &user_agent,
            "failed",
            Some("Account inactive"),
        )
        .await;
        return status_message(axum::http::StatusCode::BAD_REQUEST, INVALID_LOGIN_MESSAGE);
    }
    if !accepted_login_role(audience, &role) {
        write_login_log(
            &db,
            user_id.as_deref(),
            &email,
            None,
            &ip,
            &user_agent,
            "failed",
            Some("invalid_credentials"),
        )
        .await;
        return status_message(axum::http::StatusCode::BAD_REQUEST, INVALID_LOGIN_MESSAGE);
    }
    let remember_me = effective_remember_me(audience, payload.remember_me);

    // Converge legacy cost-10 hashes onto the current cost now that the password is confirmed and
    // the channel is accepted. This removes the mixed-cost timing variance at its source instead
    // of only masking it, and runs detached so the extra bcrypt hash never lands in this response.
    if stored_hash_needs_rehash(&stored_hash) {
        if let Ok(authoritative_id) = user.get_object_id("_id") {
            spawn_stored_hash_upgrade(
                db.clone(),
                authoritative_id,
                password.clone(),
                stored_hash.clone(),
            );
        }
    }

    if can_use_two_factor(&role)
        && !matches!(
            user.get("twoFactorEnrollmentRequiredAt"),
            Some(mongodb::bson::Bson::DateTime(_))
        )
    {
        let assigned_at = DateTime::now();
        let deadline = crate::security::staff_two_factor_deadline(assigned_at);
        let Some(id) = user.get_object_id("_id").ok() else {
            return internal_error();
        };
        let result = users
            .update_one(
                doc! {
                    "_id": id,
                    "active": true,
                    "role": { "$in": ["owner", "admin", "cs"] },
                    "$or": [
                        { "twoFactorEnrollmentRequiredAt": { "$exists": false } },
                        { "twoFactorEnrollmentRequiredAt": null },
                    ],
                },
                doc! { "$set": { "twoFactorEnrollmentRequiredAt": deadline, "updatedAt": assigned_at } },
            )
            .await;
        let Ok(result) = result else {
            return internal_error();
        };
        if result.modified_count == 1 {
            user.insert("twoFactorEnrollmentRequiredAt", deadline);
        } else {
            user = match users.find_one(doc! { "_id": id }).await {
                Ok(Some(authoritative))
                    if authoritative
                        .get_datetime("twoFactorEnrollmentRequiredAt")
                        .is_ok() =>
                {
                    authoritative
                }
                _ => return internal_error(),
            };
        }
    }
    let enrollment_completed = user.get_datetime("twoFactorEnrollmentCompletedAt").is_ok();
    if (user.get_bool("twoFactorEnabled") == Ok(true) || enrollment_completed)
        && can_use_two_factor(&role)
    {
        let Some(id) = user_id else {
            return internal_error();
        };
        let challenge_token = match sign_token(
            &Claims {
                id,
                email: None,
                role: None,
                level: None,
                session_version: read_i64(&user, "sessionVersion"),
                purpose: Some(format!(
                    "2fa-login:{}:{}",
                    remember_me,
                    bounded_device_name(payload.device_name.as_deref())
                )),
                login_audience: Some(audience),
                iat: now_seconds(),
                exp: now_seconds() + 5 * 60,
            },
            &state.jwt_secret,
        ) {
            Ok(value) => value,
            Err(_) => return internal_error(),
        };
        return Json(json!({
            "message": "Two-factor verification required",
            "requiresTwoFactor": true,
            "challengeToken": challenge_token,
        }))
        .into_response();
    }

    write_login_log(
        &db,
        user_id.as_deref(),
        &email,
        Some(&role),
        &ip,
        &user_agent,
        "success",
        None,
    )
    .await;
    if !refresh_issuance_enabled(&state, &user) {
        return issue_legacy_session_response(&state, &user, 200);
    }
    issue_session(
        &state,
        &db,
        &user,
        audience,
        remember_me,
        payload.device_name.as_deref(),
        true,
        &headers,
        200,
    )
    .await
}

pub(super) fn refresh_issuance_enabled(state: &AppState, user: &Document) -> bool {
    let Some(user_id) = user.get_object_id("_id").ok() else {
        return false;
    };
    let role = read_string(user, "role");
    security_audit::role_in_refresh_cohort(&role, &user_id.to_hex(), &state.rollout_config)
}

pub(super) fn issue_legacy_session_response(
    state: &AppState,
    user: &Document,
    status: u16,
) -> Response {
    if !security_audit::legacy_issuance_available(&state.rollout_config, chrono::Utc::now()) {
        return status_message(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "Authentication temporarily unavailable",
        );
    }
    let Ok(access) = jwt::token_for_user(user, 8 * 60 * 60, &state.jwt_secret) else {
        return internal_error();
    };
    (
        axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::OK),
        Json(json!({
            "accessToken": access,
            "user": serialize_auth_user(user)
        })),
    )
        .into_response()
}

fn decode_device_selection_token(
    token: &str,
    secret: &str,
) -> Result<DeviceSelectionClaims, jsonwebtoken::errors::Error> {
    decode::<DeviceSelectionClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
}

fn bounded_device_name(value: Option<&str>) -> String {
    value
        .unwrap_or("Unknown device")
        .trim()
        .chars()
        .take(80)
        .collect()
}

async fn issue_session(
    state: &AppState,
    db: &mongodb::Database,
    user: &Document,
    audience: LoginAudience,
    remember_me: bool,
    device_name: Option<&str>,
    two_factor_verified: bool,
    headers: &axum::http::HeaderMap,
    status: u16,
) -> Response {
    if ensure_slot_indexes_ready(db).await.is_err() {
        return internal_error();
    }
    let Ok(user_id) = user.get_object_id("_id") else {
        return internal_error();
    };
    let role = read_string(user, "role");
    let now = now_seconds() as i64;
    let policy = SessionPolicy::for_role(&role, remember_me, now);
    let bounded_device = bounded_device_name(device_name);
    let (ip, user_agent) = client_info(headers);
    let refresh_secret = new_refresh_secret();
    let recovery_secret = new_refresh_secret();
    let (rotation_key_id, rotation_key) = state.rotation_keys.active();
    struct MongoSlotAdmission<'a> {
        db: &'a mongodb::Database,
        user_id: ObjectId,
        role: &'a str,
        session_version: i64,
        device_id: &'a str,
        user_agent: &'a str,
        ip_address: &'a str,
        policy: SessionPolicy,
        now: i64,
        refresh_secret: [u8; 32],
        recovery_secret: [u8; 32],
        rotation_key_id: &'a str,
        rotation_key: &'a [u8; 32],
        hash_secret: &'a [u8],
    }
    impl SlotAdmissionStore for MongoSlotAdmission<'_> {
        type Claimed = AuthSession;
        async fn claim_next_slot(&self, _max_slot: i32) -> Result<AuthSession, SlotClaimFailure> {
            try_claim_session_slot(
                self.db,
                self.user_id,
                self.role,
                self.session_version,
                self.device_id,
                self.user_agent,
                self.ip_address,
                self.policy,
                self.now,
                self.refresh_secret,
                self.recovery_secret,
                self.rotation_key_id,
                self.rotation_key,
                self.hash_secret,
            )
            .await
        }
    }
    let admission = MongoSlotAdmission {
        db,
        user_id,
        role: &role,
        session_version: read_i64(user, "sessionVersion"),
        device_id: &bounded_device,
        user_agent: &user_agent,
        ip_address: &ip,
        policy,
        now,
        refresh_secret,
        recovery_secret,
        rotation_key_id,
        rotation_key,
        hash_secret: state.session_token_hash_secret.as_bytes(),
    };
    match orchestrate_slot_admission(&admission, &role).await {
        Ok(session) => {
            build_credential_response(
                state,
                db,
                user,
                &session,
                &refresh_secret,
                &recovery_secret,
                policy,
                now,
                status,
            )
            .await
        }
        Err(SlotClaimFailure::DeviceLimit) => {
            let sessions = match active_sessions_for_display(db, user_id).await {
                Ok(s) => s,
                Err(_) => return internal_error(),
            };
            let nonce = ObjectId::new().to_hex();
            let mut claims = new_device_selection_claims(user_id, &nonce, now, audience);
            claims.remember_me = remember_me;
            claims.device_name = bounded_device;
            claims.session_version = read_i64(user, "sessionVersion");
            claims.role = role.clone();
            claims.two_factor_enabled = user.get_bool("twoFactorEnabled").unwrap_or(false);
            claims.two_factor_verified = two_factor_verified;
            if create_device_limit_challenge(db, &claims).await.is_err() {
                return internal_error();
            }
            let Ok(token) = session_store::sign_device_selection_token(&claims, &state.jwt_secret)
            else {
                return internal_error();
            };
            (
                axum::http::StatusCode::CONFLICT,
                Json(device_limit_value(token, &sessions)),
            )
                .into_response()
        }
        Err(SlotClaimFailure::Store) => internal_error(),
    }
}

async fn build_credential_response(
    state: &AppState,
    db: &mongodb::Database,
    user: &Document,
    session: &AuthSession,
    refresh_secret: &[u8; 32],
    recovery_secret: &[u8; 32],
    policy: SessionPolicy,
    now: i64,
    status: u16,
) -> Response {
    let role = read_string(user, "role");
    let claims = AccessClaims {
        sub: session.user_id.to_hex(),
        sid: session.session_id.to_hex(),
        session_version: session.session_version_at_issue,
        role,
        iat: now,
        exp: policy.access_expires_at,
        jti: ObjectId::new().to_hex(),
        token_type: "access".into(),
    };
    let credentials = sign_access_token(&claims, &state.jwt_secret).and_then(|access| {
        encode_refresh_token(&session.session_id.to_hex(), refresh_secret)
            .and_then(|refresh| {
                encode_refresh_token(&session.session_id.to_hex(), recovery_secret)
                    .map(|recovery| (refresh, recovery))
            })
            .map(|(refresh, recovery)| (access, refresh, recovery))
            .map_err(|_| {
                jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
            })
    });
    let Ok((access, refresh, recovery)) = credentials else {
        let _ = mark_session_issuance_failed(&db, session.session_id).await;
        return internal_error();
    };
    {
        // Correlation is owned by the gateway; only preserve a validated span trace here.
        let validated_trace = crate::services::correlation::current_span_correlation_trace_id()
            .filter(|value| crate::services::correlation::validate_trace_id(value));
        let correlation_source = if validated_trace.is_some() {
            "otel_span"
        } else {
            "absent"
        };
        security_audit::write_security_audit(
            db,
            security_audit::SecurityAuditEvent {
                event: security_audit::EVENT_SESSION_CREATED,
                outcome: "created",
                user_id: Some(session.user_id),
                session_id: Some(session.session_id),
                trace_id: validated_trace,
                correlation_source,
                action_group: None,
                reason: None,
                device: Some(security_audit::bounded_device_context(
                    &session.device_id,
                    &session.ip_address,
                    &session.user_agent,
                )),
            },
        )
        .await;
    }
    (
        axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::OK),
        Json(json!({
            "accessToken": access,
            "refreshToken": refresh,
            "recoveryToken": recovery,
            "refreshCookieMaxAgeSeconds": policy.absolute_expires_at - now,
            "recoveryCookieMaxAgeSeconds": policy.absolute_expires_at - now,
            "user": serialize_auth_user(user),
            "session": sanitize_session(session)
        })),
    )
        .into_response()
}

pub async fn device_selection(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<DeviceSelectionPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let claims = match decode_device_selection_token(&payload.challenge_token, &state.jwt_secret) {
        Ok(c) if c.purpose == "device-selection" => c,
        _ => {
            return auth_error(
                axum::http::StatusCode::UNAUTHORIZED,
                "AUTH_CHALLENGE_INVALID",
                "Invalid challenge",
            )
        }
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let Ok(user_id) = ObjectId::parse_str(&claims.sub) else {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_CHALLENGE_INVALID",
            "Invalid challenge",
        );
    };
    let Some(user) = (match db
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .await
    {
        Ok(user) => user,
        Err(_) => return unavailable(),
    }) else {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_CHALLENGE_INVALID",
            "Invalid challenge",
        );
    };
    let Ok(authoritative_id) = user.get_object_id("_id") else {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_CHALLENGE_INVALID",
            "Invalid challenge",
        );
    };
    let current_role = read_string(&user, "role");
    if authoritative_id.to_hex() != claims.sub
        || user.get_bool("active") != Ok(true)
        || !claims.login_audience.accepts_role(&current_role)
        || !refresh_issuance_enabled(&state, &user)
        || read_i64(&user, "sessionVersion") != claims.session_version
        || current_role != claims.role
        || user.get_bool("twoFactorEnabled").unwrap_or(false) != claims.two_factor_enabled
        || (claims.two_factor_enabled && !claims.two_factor_verified)
    {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_CHALLENGE_INVALID",
            "Invalid challenge",
        );
    }
    if ensure_slot_indexes_ready(&db).await.is_err() {
        return internal_error();
    }
    let Ok(target) = ObjectId::parse_str(&payload.revoke_session_id) else {
        return auth_error(
            axum::http::StatusCode::BAD_REQUEST,
            "AUTH_SESSION_INVALID",
            "Invalid session",
        );
    };

    let now = now_seconds() as i64;
    let (ip_address, user_agent) = client_info(&headers);
    let entry = DeviceSelectionEntryContext {
        remember_me: claims.remember_me,
        device_name: claims.device_name.clone(),
        user_agent,
        ip_address,
        issued_at: now,
    };
    struct ProductionEncoder<'a>(&'a str);
    impl CredentialEncoder for ProductionEncoder<'_> {
        fn encode(
            &self,
            access_claims: &AccessClaims,
            session_id: ObjectId,
            refresh_secret: &[u8; 32],
            recovery_secret: &[u8; 32],
            refresh_cookie_max_age_seconds: i64,
        ) -> Result<CredentialMaterial, ()> {
            Ok(CredentialMaterial {
                access_token: sign_access_token(access_claims, self.0).map_err(|_| ())?,
                refresh_token: encode_refresh_token(&session_id.to_hex(), refresh_secret)
                    .map_err(|_| ())?,
                recovery_token: encode_refresh_token(&session_id.to_hex(), recovery_secret)
                    .map_err(|_| ())?,
                refresh_cookie_max_age_seconds,
                recovery_cookie_max_age_seconds: refresh_cookie_max_age_seconds,
            })
        }
    }
    let (rotation_key_id, rotation_key) = state.rotation_keys.active();
    let store = MongoDeviceSelectionStore {
        db: &db,
        claims: &claims,
        user_id,
        hash_secret: state.session_token_hash_secret.as_bytes(),
        rotation_key_id,
        rotation_key,
    };
    let result = match orchestrate_device_selection(
        &store,
        &ProductionEncoder(&state.jwt_secret),
        target,
        entry,
    )
    .await
    {
        Ok(result) => result,
        Err(IssuanceError::Expired) => {
            return auth_error(
                axum::http::StatusCode::UNAUTHORIZED,
                "AUTH_CHALLENGE_EXPIRED",
                "Challenge expired",
            )
        }
        Err(IssuanceError::NotFound) => {
            return auth_error(
                axum::http::StatusCode::UNAUTHORIZED,
                "AUTH_CHALLENGE_INVALID",
                "Invalid challenge",
            )
        }
        Err(IssuanceError::Conflict) => {
            return auth_error(
                axum::http::StatusCode::CONFLICT,
                "AUTH_CHALLENGE_CONFLICT",
                "Challenge already claimed for a different session",
            )
        }
        Err(IssuanceError::InvalidSession) => {
            return auth_error(
                axum::http::StatusCode::BAD_REQUEST,
                "AUTH_SESSION_INVALID",
                "Invalid session",
            )
        }
        Err(IssuanceError::Store | IssuanceError::Credential) => return internal_error(),
    };
    (
        axum::http::StatusCode::OK,
        Json(json!({
            "accessToken": result.material.access_token,
            "refreshToken": result.material.refresh_token,
            "recoveryToken": result.material.recovery_token,
            "refreshCookieMaxAgeSeconds": result.material.refresh_cookie_max_age_seconds,
            "recoveryCookieMaxAgeSeconds": result.material.recovery_cookie_max_age_seconds,
            "user": serialize_auth_user(&result.user),
            "session": sanitize_session(&result.session)
        })),
    )
        .into_response()
}

async fn current_user(
    headers: &axum::http::HeaderMap,
    state: &Arc<AppState>,
) -> Result<(mongodb::Database, ObjectId, Document), Response> {
    let context = require_proxy_context(headers, state)?;
    let Some(user_id) = context.user_id else {
        return Err(auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Unauthorized",
        ));
    };
    let Some(client) = &state.mongo_client else {
        return Err(unavailable());
    };
    let Ok(object_id) = ObjectId::parse_str(user_id) else {
        return Err(status_message(
            axum::http::StatusCode::NOT_FOUND,
            "User not found",
        ));
    };
    let db = client.database(&state.mongo_db);
    match db
        .collection::<Document>("users")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(Some(user)) => Ok((db, object_id, user)),
        Ok(None) => Err(status_message(
            axum::http::StatusCode::NOT_FOUND,
            "User not found",
        )),
        Err(_) => Err(internal_error()),
    }
}

fn normalize_text(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}

fn normalize_email(value: Option<&str>) -> String {
    normalize_text(value).to_lowercase()
}

fn password_validation_message(password: &str) -> Option<&'static str> {
    if password.len() < 12 {
        return Some("Password minimal 12 karakter");
    }

    let normalized = password.to_lowercase();
    let common_passwords = [
        "password",
        "password123",
        "12345678",
        "123456789",
        "1234567890",
        "qwerty123",
        "admin123",
    ];

    if common_passwords.contains(&normalized.as_str()) {
        return Some("Password terlalu umum. Gunakan password yang lebih kuat");
    }

    None
}

fn can_use_two_factor(role: &str) -> bool {
    matches!(role, "owner" | "admin" | "cs")
}

fn now_seconds() -> usize {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as usize)
        .unwrap_or(0)
}

pub(super) fn read_i64(document: &Document, key: &str) -> i64 {
    match document.get(key) {
        Some(Bson::Int32(value)) => i64::from(*value),
        Some(Bson::Int64(value)) => *value,
        Some(Bson::Double(value)) => *value as i64,
        _ => 0,
    }
}

fn status_message(status: axum::http::StatusCode, message: &str) -> Response {
    (status, Json(json!({ "message": message }))).into_response()
}

fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}

#[cfg(test)]
mod task3_issuance_route_tests {
    use super::{
        dummy_password_hash, effective_remember_me, hash, stored_hash_needs_rehash,
        verify_password_constant_cost, LoginAudience, DEFAULT_COST, LOGIN_TIMING_FLOOR,
    };

    #[test]
    fn login_spends_password_verification_cost_on_every_rejection() {
        // Returning before bcrypt for unknown, password-less or inactive accounts leaks account
        // existence and state through response time even though the body is identical.
        let src = include_str!("auth.rs");
        let login_start = src
            .find("async fn login_for_audience")
            .expect("shared login core");
        let issue_fn = src.find("async fn issue_session").expect("issue_session");
        let login = &src[login_start..issue_fn];

        let lookup = login.find("users.find_one").expect("user lookup");
        let password_gate = login
            .find("verify_password_constant_cost")
            .expect("constant-cost password verification");
        let inactive_gate = login.find("Account inactive").expect("inactive gate");

        // Every rejection between the lookup and the password gate must be constant cost.
        let early = &login[lookup..password_gate];
        assert!(
            !early.contains("INVALID_LOGIN_MESSAGE"),
            "no credential rejection may return before constant-cost verification"
        );
        // Inactive accounts must be rejected only after the password cost has been paid.
        assert!(password_gate < inactive_gate);
    }

    #[test]
    fn absent_password_hash_still_pays_verification_cost() {
        // A user document with no password must cost the same as a wrong password.
        assert!(!verify_password_constant_cost("any-password", ""));
        assert!(!verify_password_constant_cost(
            "any-password",
            "not-a-bcrypt-hash"
        ));
        let real = hash("correct-horse", DEFAULT_COST).expect("hash");
        assert!(verify_password_constant_cost("correct-horse", &real));
        assert!(!verify_password_constant_cost("wrong", &real));
    }

    #[test]
    fn dummy_verification_hash_matches_production_cost() {
        // A cheaper dummy hash would still separate unknown accounts by timing.
        let dummy = dummy_password_hash();
        let cost: u32 = dummy
            .split('$')
            .nth(2)
            .and_then(|value| value.parse().ok())
            .expect("bcrypt cost field");
        assert_eq!(cost, DEFAULT_COST);
    }

    #[test]
    fn login_pads_every_outcome_to_a_constant_floor() {
        // Stored bcrypt costs are mixed in production: Node registration hashes at cost 10 while
        // Rust password changes use cost 12. A dummy hash alone therefore cannot equalize timing,
        // because a wrong password on a cost-10 account is measurably faster than the cost-12
        // dummy spent for an unknown account. A constant floor covers every outcome instead.
        let src = include_str!("auth.rs");
        let core_start = src
            .find("async fn login_for_audience_core")
            .expect("login core");
        let wrapper_start = src
            .find("async fn login_for_audience(")
            .expect("login wrapper");
        let wrapper = &src[wrapper_start..];

        assert!(
            wrapper.contains("settle_login_timing_floor"),
            "the login wrapper must pad every outcome to the floor"
        );
        // The core must not be able to return without passing through the wrapper's padding.
        let core = &src[core_start..wrapper_start.max(core_start)];
        assert!(
            !core.contains("settle_login_timing_floor"),
            "padding belongs to the single wrapper, not scattered per branch"
        );
        assert!(LOGIN_TIMING_FLOOR.as_millis() >= 250);
    }
    #[test]
    fn login_timing_floor_exceeds_worst_case_password_cost() {
        // Measured on the deployment host with an optimized build (bcrypt 0.16, 12 samples per
        // cost): cost-10 verification 69-148ms, cost-12 verification 279-419ms. A floor at or
        // below the cost-12 worst case cannot pad those attempts, so cost-10 accounts would
        // settle at the floor while cost-12 and dummy paths overshoot it, which is the mixed-cost
        // oracle again. Keep the floor clear of the measured worst case with margin.
        assert!(
            LOGIN_TIMING_FLOOR.as_millis() >= 1200,
            "floor must clear the measured cost-12 worst case with margin"
        );
    }

    #[test]
    fn password_verification_never_blocks_the_async_executor() {
        // bcrypt is hundreds of milliseconds of CPU. Run inline on a Tokio worker it starves the
        // executor under concurrency, which both inflates unrelated request latency and makes the
        // timing floor unenforceable because padded work overruns it.
        let src = include_str!("auth.rs");
        let core_start = src
            .find("async fn login_for_audience_core")
            .expect("login core");
        let core_end = src.find("async fn issue_session").expect("issue_session");
        let core = &src[core_start..core_end];
        assert!(
            core.contains("verify_password_constant_cost_blocking"),
            "login must verify passwords off the async executor"
        );
        assert!(
            !core.contains("verify_password_constant_cost("),
            "login must not call the inline verifier directly"
        );
    }

    #[test]
    fn legacy_cost_hashes_are_scheduled_for_rehash() {
        // Node registration hashes at cost 10 while this service uses cost 12, so stored costs are
        // mixed. Converging them on successful login removes the source of the variance instead of
        // only masking it.
        let cost_10 = hash("password", 10).expect("cost 10 hash");
        let current = hash("password", DEFAULT_COST).expect("current cost hash");
        assert!(stored_hash_needs_rehash(&cost_10));
        assert!(!stored_hash_needs_rehash(&current));
        // An unreadable hash must not trigger a rewrite.
        assert!(!stored_hash_needs_rehash("not-a-bcrypt-hash"));
        assert!(!stored_hash_needs_rehash(""));
    }

    #[test]
    fn malformed_cost_bearing_hashes_are_never_rehashed() {
        // Parsing only the third `$` field accepts truncated and bogus records: `$2b$10$bad` and
        // `$bogus$01$x` both yield a cost. The helper must validate the whole bcrypt structure so
        // it fails closed on its own, independent of the caller's ordering.
        for malformed in [
            "$2b$10$bad",
            "$bogus$01$x",
            "$2b$10$",
            "$2b$$",
            "$2z$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "$2b$99$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "$2b$10$short",
        ] {
            assert!(
                !stored_hash_needs_rehash(malformed),
                "{malformed} must not be rehashed"
            );
        }
        // A well-formed legacy hash is still upgraded, including costs weaker than Node's 10.
        assert!(stored_hash_needs_rehash(
            &hash("password", 10).expect("cost 10 hash")
        ));
        assert!(stored_hash_needs_rehash(
            "$2b$07$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }

    #[test]
    fn password_hashing_capacity_is_bounded_and_prioritizes_verification() {
        // The blocking pool is shared. An unbounded detached rehash can occupy it and slow
        // response-path verification, which both amplifies load and reintroduces a timing signal.
        //
        // include_str! pulls in this test module too, so searching the whole file would match
        // these very assertions. Truncate at the test marker and inspect production code only.
        let full = include_str!("auth.rs");
        let src = &full[..full.find("\n#[cfg(test)]").expect("test module marker")];
        assert!(
            src.contains("PASSWORD_VERIFY_PERMITS"),
            "response-path verification needs its own reserved capacity"
        );
        assert!(
            src.contains("PASSWORD_BACKGROUND_PERMITS"),
            "background hashing must draw from a separate budget"
        );

        // Background work must never be able to consume the verification budget.
        let rehash_start = src
            .find("fn spawn_stored_hash_upgrade")
            .expect("rehash scheduler");
        let rehash = &src[rehash_start..];
        assert!(
            rehash.contains("background_hashing_permits"),
            "rehash must use the background budget"
        );
        assert!(
            !rehash.contains("verify_hashing_permits"),
            "rehash must not touch the verification budget"
        );
        assert!(
            rehash.contains("try_acquire_owned"),
            "rehash must yield rather than wait for a permit"
        );
        assert!(
            src.contains("REHASH_IN_FLIGHT"),
            "duplicate rehashes for one account must be suppressed"
        );
        assert!(
            rehash.contains("rehash_in_flight()"),
            "concurrent logins must not launch duplicate rehashes for the same account"
        );

        // Registration is also a request-path bcrypt hash. Left inline it blocks an async worker
        // and contends with login verification for CPU, outside any budget.
        let register_start = src.find("pub async fn register").expect("register handler");
        let register_end = register_start
            + src[register_start..]
                .find("\npub async fn ")
                .unwrap_or(src.len() - register_start);
        let register = &src[register_start..register_end];
        assert!(
            register.contains("hash_password_blocking"),
            "registration must hash off the async executor under the shared budget"
        );
        assert!(
            !register.contains("hash(password, DEFAULT_COST)"),
            "registration must not hash inline on the executor"
        );
    }

    #[test]
    fn bcrypt_permits_are_held_until_the_blocking_work_exits() {
        // spawn_blocking work cannot be cancelled. A permit held only by the awaiting future is
        // released when the request is dropped, while bcrypt keeps burning CPU, so repeated
        // cancellations can run more hashes than the semaphore allows and starve verification.
        // The permit must be owned by the blocking closure itself.
        let full = include_str!("auth.rs");
        let src = &full[..full.find("\n#[cfg(test)]").expect("test module marker")];
        let verify_start = src
            .find("async fn verify_password_constant_cost_blocking")
            .expect("verify wrapper");
        let verify_end = verify_start
            + src[verify_start..]
                .find("\nfn stored_hash_needs_rehash")
                .expect("end of verify wrapper");
        let verify = &src[verify_start..verify_end];
        assert!(
            verify.contains("acquire_owned"),
            "verification must take an owned permit"
        );
        assert!(
            verify.contains("move |") || verify.contains("move ||"),
            "the permit must move into the blocking closure"
        );
        // Holding the permit only across the await is the bug this guards against.
        assert!(
            !verify.contains("let Ok(_permit)"),
            "permit must not be scoped to the future instead of the blocking work"
        );
    }

    #[test]
    fn rehash_deduplication_cleans_up_on_panic_and_poison() {
        // Inserting a key and removing it only on the happy path permanently suppresses upgrades
        // for that account if the task panics or is cancelled, and a poisoned mutex would disable
        // upgrades process-wide. Cleanup must be RAII and poison recovery must not retain keys.
        let full = include_str!("auth.rs");
        let src = &full[..full.find("\n#[cfg(test)]").expect("test module marker")];
        let rehash_start = src
            .find("fn spawn_stored_hash_upgrade")
            .expect("rehash scheduler");
        let rehash = &src[rehash_start..];
        assert!(
            rehash.contains("RehashGuard") || rehash.contains("impl Drop"),
            "the in-flight key must be released by a drop guard"
        );
        assert!(
            !rehash.contains("if let Ok(mut guard) = in_flight.lock()"),
            "cleanup must not depend on normal control flow or a healthy lock"
        );
        assert!(
            src.contains("unwrap_or_else(|error| error.into_inner())"),
            "a poisoned in-flight lock must recover instead of disabling upgrades"
        );
    }

    #[test]
    fn staff_remember_me_is_always_disabled() {
        assert!(!effective_remember_me(LoginAudience::Staff, Some(true)));
        assert!(!effective_remember_me(LoginAudience::Staff, Some(false)));
        assert!(!effective_remember_me(LoginAudience::Staff, None));
        assert!(effective_remember_me(LoginAudience::Member, Some(true)));
        assert!(!effective_remember_me(LoginAudience::Member, Some(false)));
    }

    #[test]
    fn staff_login_orders_audience_and_two_factor_gates_before_issuance() {
        let src = include_str!("auth.rs");
        let login_start = src
            .find("async fn login_for_audience")
            .expect("shared login core");
        let issue_fn = src.find("async fn issue_session").expect("issue_session");
        let login = &src[login_start..issue_fn];
        let password_gate = login
            .find("if !password_matches")
            .expect("password verification");
        let audience_gate = login
            .find("accepted_login_role(audience, &role)")
            .expect("audience gate");
        let enrollment_mutation = login
            .find("twoFactorEnrollmentRequiredAt")
            .expect("enrollment mutation");
        let two_factor_return = login.find("requiresTwoFactor").expect("2FA branch");
        let issuance_call = login.rfind("issue_session(").expect("issuance call");

        assert!(password_gate < audience_gate);
        assert!(audience_gate < enrollment_mutation);
        assert!(audience_gate < two_factor_return);
        assert!(audience_gate < issuance_call);
    }

    #[test]
    fn credential_routes_check_proxy_secret_before_issuance() {
        let auth_rs = include_str!("auth.rs");
        let two_factor_rs = include_str!("auth/two_factor.rs");
        for (file, marker, delegated_core) in [
            (
                auth_rs,
                "pub async fn member_login",
                Some("login_for_audience"),
            ),
            (
                auth_rs,
                "pub async fn staff_login",
                Some("login_for_audience"),
            ),
            (auth_rs, "pub async fn register", None),
            (auth_rs, "pub async fn device_selection", None),
            (two_factor_rs, "pub async fn verify_two_factor_login", None),
        ] {
            let start = file
                .find(marker)
                .unwrap_or_else(|| panic!("missing {marker}"));
            let chunk = &file[start..start.saturating_add(700).min(file.len())];
            let protected = chunk.contains("require_proxy_context")
                || delegated_core.is_some_and(|core| chunk.contains(core));
            assert!(protected, "{marker} must require or delegate proxy context");
        }
        let core_start = auth_rs
            .find("async fn login_for_audience")
            .expect("shared login core");
        let core = &auth_rs[core_start..core_start.saturating_add(700).min(auth_rs.len())];
        assert!(core.contains("require_proxy_context"));
    }
}
