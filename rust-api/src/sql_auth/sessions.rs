use super::*;
use sqlx::{PgPool, Postgres, Transaction};
use subtle::ConstantTimeEq;

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub session_version: i32,
    pub security_generation: i64,
    pub audience: String,
    pub state: String,
    pub role: String,
    pub slot: i32,
    pub owns_slot: bool,
    pub device_id: String,
    pub user_agent: String,
    pub ip_address: String,
    pub remember_me: bool,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub absolute_expires_at: DateTime<Utc>,
    pub idle_expires_at: Option<DateTime<Utc>>,
    pub locked_at: Option<DateTime<Utc>>,
    pub cleanup_at: DateTime<Utc>,
    pub generation: i64,
    pub refresh_digest: Vec<u8>,
    pub recovery_digest: Vec<u8>,
    pub rotation_key_id: String,
    pub predecessor: Option<sqlx::types::Json<Predecessor>>,
    pub consumed_digests: sqlx::types::Json<Vec<ConsumedDigest>>,
    pub unlock_password_attempts: i32,
    pub unlock_otp_attempts: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Predecessor {
    pub generation: i64,
    pub refresh_digest: Vec<u8>,
    pub recovery_digest: Vec<u8>,
    pub key_id: String,
    pub committed_at: DateTime<Utc>,
    pub race_grace_until: DateTime<Utc>,
    pub recovery_expires_at: DateTime<Utc>,
    pub encrypted_seed: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConsumedDigest {
    pub generation: i64,
    pub refresh_digest: Vec<u8>,
    pub consumed_at: DateTime<Utc>,
}

pub async fn load(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<Session, AuthError> {
    sqlx::query_as("SELECT * FROM auth_sessions WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(&mut **tx).await?.ok_or_else(invalid)
}

pub async fn load_pool(pool: &PgPool, id: Uuid) -> Result<Session, AuthError> {
    sqlx::query_as("SELECT * FROM auth_sessions WHERE id=$1")
        .bind(id).fetch_optional(pool).await?.ok_or_else(invalid)
}

fn invalid() -> AuthError { error("AUTH_TOKEN_INVALID", "Invalid session") }
fn error(code: &'static str, message: &'static str) -> AuthError {
    AuthError::new(StatusCode::UNAUTHORIZED, code, message)
}
fn unavailable(code: &'static str) -> AuthError {
    AuthError::new(StatusCode::SERVICE_UNAVAILABLE, code, "Session recovery unavailable")
}
fn staff(role: &str) -> bool { matches!(role, "owner" | "admin" | "cs" | "staff") }
fn equal(a: &[u8], b: &[u8]) -> bool { a.len() == b.len() && bool::from(a.ct_eq(b)) }

fn binding(user: &User, session: &Session, now: DateTime<Utc>) -> Result<(), AuthError> {
    if !user.active { return Err(error("AUTH_ACCOUNT_DISABLED", "Account disabled")); }
    if session.user_id != user.id { return Err(invalid()); }
    if session.absolute_expires_at <= now { return Err(error("AUTH_SESSION_EXPIRED", "Session expired")); }
    if session.state != "active" && session.state != "locked" {
        return Err(error("AUTH_SESSION_REVOKED", "Session revoked"));
    }
    if session.role != user.role || session.session_version != user.session_version
        || session.security_generation != user.security_generation {
        return Err(error("AUTH_SESSION_POLICY_CHANGED", "Session policy changed"));
    }
    if (session.audience == "member" && user.role != "member")
        || (session.audience == "staff" && !staff(&user.role)) { return Err(invalid()); }
    Ok(())
}

async fn lock_idle(tx: &mut Transaction<'_, Postgres>, session: &mut Session, now: DateTime<Utc>) -> Result<(), AuthError> {
    if staff(&session.role) && session.state == "active" && session.idle_expires_at.is_some_and(|deadline| deadline <= now) {
        sqlx::query("UPDATE auth_sessions SET state='locked',locked_at=$2 WHERE id=$1 AND state='active'")
            .bind(session.id).bind(now).execute(&mut **tx).await?;
        session.state = "locked".into();
        session.locked_at = Some(now);
    }
    Ok(())
}

async fn locked_context(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(User, Session), AuthError> {
    // Lock the user before its sessions everywhere: account changes and issuance share this order.
    let uid: Uuid = sqlx::query_scalar("SELECT user_id FROM auth_sessions WHERE id=$1")
        .bind(id).fetch_optional(&mut **tx).await?.ok_or_else(invalid)?;
    let user = sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE")
        .bind(uid).fetch_optional(&mut **tx).await?.ok_or_else(invalid)?;
    Ok((user, load(tx, id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialPayload {
    pub refresh_token: String,
    #[serde(default)] pub recovery_token: String,
    #[serde(default)] pub password: String,
    pub otp_code: Option<String>,
    pub code: Option<String>,
}

fn pair(payload: &CredentialPayload) -> Result<(Uuid, [u8;32], [u8;32]), AuthError> {
    let (id, refresh) = crypto::parse_token(&payload.refresh_token)?;
    let (recovery_id, recovery) = crypto::parse_token(&payload.recovery_token)?;
    if recovery_id != id { return Err(invalid()); }
    Ok((id, refresh, recovery))
}

fn aad(id: Uuid, previous: i64, next: i64, deadline: DateTime<Utc>) -> String {
    format!("sql-session-rotation:v1:{id}:{previous}:{next}:{}", deadline.timestamp_millis())
}

async fn rotate(tx: &mut Transaction<'_, Postgres>, state: &AppState, user: &User,
    session: &mut Session, refresh: &[u8;32], recovery: &[u8;32], now: DateTime<Utc>, unlock: bool) -> Result<Value, AuthError> {
    let rd = crypto::digest(refresh, &state.session_token_hash_secret, "refresh");
    let kd = crypto::digest(recovery, &state.session_token_hash_secret, "recovery");
    if !equal(&rd, &session.refresh_digest) || !equal(&kd, &session.recovery_digest) { return Err(invalid()); }
    if session.consumed_digests.0.len() >= 4096 { return Err(unavailable("AUTH_SESSION_HISTORY_FULL")); }
    let next = session.generation.checked_add(1).ok_or_else(|| unavailable("AUTH_SESSION_HISTORY_FULL"))?;
    let (new_refresh, new_recovery) = crypto::derive(state, &session.rotation_key_id, session.id, next, recovery)?;
    let deadline = (now + chrono::Duration::seconds(60)).min(session.absolute_expires_at);
    let predecessor = Predecessor {
        generation: session.generation, refresh_digest: rd.clone(), recovery_digest: kd.clone(),
        key_id: session.rotation_key_id.clone(), committed_at: now,
        race_grace_until: now + chrono::Duration::seconds(5), recovery_expires_at: deadline,
        encrypted_seed: crypto::seal(state, &aad(session.id, session.generation, next, deadline), recovery)?,
    };
    session.consumed_digests.0.push(ConsumedDigest { generation: session.generation, refresh_digest: rd.clone(), consumed_at: now });
    let next_rd = crypto::digest(&new_refresh, &state.session_token_hash_secret, "refresh");
    let next_kd = crypto::digest(&new_recovery, &state.session_token_hash_secret, "recovery");
    let idle = if unlock { Some(now + chrono::Duration::minutes(30)) } else { session.idle_expires_at };
    let result = sqlx::query("UPDATE auth_sessions SET generation=$2,refresh_digest=$3,recovery_digest=$4,predecessor=$5,consumed_digests=$6,last_seen_at=$7,state='active',idle_expires_at=$8,locked_at=NULL WHERE id=$1 AND generation=$9 AND refresh_digest=$10 AND recovery_digest=$11 AND state=$12")
        .bind(session.id).bind(next).bind(&next_rd).bind(&next_kd).bind(sqlx::types::Json(&predecessor))
        .bind(&session.consumed_digests).bind(now).bind(idle).bind(session.generation).bind(&rd).bind(&kd).bind(&session.state)
        .execute(&mut **tx).await?;
    if result.rows_affected() != 1 { return Err(AuthError::new(StatusCode::CONFLICT,"AUTH_REFRESH_RACE","Refresh already rotated")); }
    session.generation = next;
    session.refresh_digest = next_rd;
    session.recovery_digest = next_kd;
    session.predecessor = Some(sqlx::types::Json(predecessor));
    session.state = "active".into(); session.idle_expires_at = idle; session.last_seen_at = now; session.locked_at = None;
    session_envelope(state, user, session, new_refresh, new_recovery, now).await
}

async fn classify(tx: &mut Transaction<'_, Postgres>, state: &AppState, user: &User, session: &Session,
    refresh: &[u8;32], recovery: &[u8;32], now: DateTime<Utc>) -> Result<Value, AuthError> {
    let rd = crypto::digest(refresh, &state.session_token_hash_secret, "refresh");
    let kd = crypto::digest(recovery, &state.session_token_hash_secret, "recovery");
    if let Some(sqlx::types::Json(previous)) = &session.predecessor {
        if equal(&previous.refresh_digest, &rd) && equal(&previous.recovery_digest, &kd) {
            if now <= previous.race_grace_until {
                return Err(AuthError::new(StatusCode::CONFLICT,"AUTH_REFRESH_RACE","Refresh already rotated"));
            }
            if now >= previous.recovery_expires_at { return Err(error("AUTH_REFRESH_RECOVERY_EXPIRED","Refresh recovery expired")); }
            let seed = crypto::open(state, &aad(session.id, previous.generation, session.generation, previous.recovery_expires_at), &previous.encrypted_seed)
                .map_err(|_| unavailable("AUTH_REFRESH_RECOVERY_UNAVAILABLE"))?;
            let seed: [u8;32] = seed.as_slice().try_into().map_err(|_| unavailable("AUTH_REFRESH_RECOVERY_UNAVAILABLE"))?;
            let (next_refresh, next_recovery) = crypto::derive(state, &previous.key_id, session.id, session.generation, &seed)?;
            if !equal(&crypto::digest(&next_refresh,&state.session_token_hash_secret,"refresh"), &session.refresh_digest)
                || !equal(&crypto::digest(&next_recovery,&state.session_token_hash_secret,"recovery"), &session.recovery_digest) {
                return Err(unavailable("AUTH_REFRESH_RECOVERY_UNAVAILABLE"));
            }
            return session_envelope(state,user,session,next_refresh,next_recovery,now).await;
        }
    }
    if session.consumed_digests.0.iter().any(|old| equal(&old.refresh_digest,&rd)) {
        sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE id=$1")
            .bind(session.id).execute(&mut **tx).await?;
        return Err(error("AUTH_REFRESH_REUSED","Refresh token reused"));
    }
    Err(invalid())
}

pub async fn refresh(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(payload): Json<CredentialPayload>) -> ApiResult {
    proxy(&headers,&state).await?;
    let (id,refresh,recovery) = pair(&payload)?;
    let now = Utc::now(); let mut tx = state.pg_pool.begin().await?;
    let (user,mut session) = locked_context(&mut tx,id).await?;
    binding(&user,&session,now)?;
    lock_idle(&mut tx,&mut session,now).await?;
    if session.state == "locked" { tx.commit().await?; return Err(AuthError::new(StatusCode::LOCKED,"AUTH_IDLE_LOCKED","Session idle locked")); }
    let rd = crypto::digest(&refresh,&state.session_token_hash_secret,"refresh");
    let result = if equal(&rd,&session.refresh_digest) {
        rotate(&mut tx,&state,&user,&mut session,&refresh,&recovery,now,false).await
    } else { classify(&mut tx,&state,&user,&session,&refresh,&recovery,now).await };
    // Reuse revocation is durable even though the HTTP outcome is an error.
    tx.commit().await?;
    result.map(Json)
}

pub async fn unlock(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(payload): Json<CredentialPayload>) -> ApiResult {
    proxy(&headers,&state).await?;
    let (id,refresh,recovery) = pair(&payload)?;
    let now = Utc::now(); let mut tx = state.pg_pool.begin().await?;
    let (user,mut session) = locked_context(&mut tx,id).await?;
    binding(&user,&session,now)?;
    lock_idle(&mut tx,&mut session,now).await?;
    if !staff(&session.role) || session.state != "locked" { tx.commit().await?; return Err(invalid()); }
    if !equal(&crypto::digest(&refresh,&state.session_token_hash_secret,"refresh"),&session.refresh_digest)
        || !equal(&crypto::digest(&recovery,&state.session_token_hash_secret,"recovery"),&session.recovery_digest) { tx.commit().await?; return Err(invalid()); }
    if session.unlock_password_attempts >= 5 || session.unlock_otp_attempts >= 5 {
        tx.commit().await?; return Err(AuthError::new(StatusCode::BAD_REQUEST,"REAUTH_ATTEMPTS_EXHAUSTED","Too many unlock attempts"));
    }
    if !verify_password(payload.password,user.password_hash.clone()).await {
        sqlx::query("UPDATE auth_sessions SET unlock_password_attempts=unlock_password_attempts+1 WHERE id=$1")
            .bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Err(AuthError::new(StatusCode::BAD_REQUEST,if session.unlock_password_attempts + 1 >= 5 { "REAUTH_ATTEMPTS_EXHAUSTED" } else { "REAUTH_PASSWORD_INVALID" },"Invalid unlock password"));
    }
    if user.two_factor_enabled {
        let code = payload.otp_code.as_deref().or(payload.code.as_deref()).unwrap_or("");
        if factors::consume_otp(&mut tx,&state,&user,code,now).await.is_err() {
            sqlx::query("UPDATE auth_sessions SET unlock_otp_attempts=unlock_otp_attempts+1 WHERE id=$1")
                .bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            return Err(AuthError::new(StatusCode::BAD_REQUEST,if session.unlock_otp_attempts + 1 >= 5 { "REAUTH_ATTEMPTS_EXHAUSTED" } else { "REAUTH_OTP_INVALID" },"Invalid unlock OTP"));
        }
    }
    let result = rotate(&mut tx,&state,&user,&mut session,&refresh,&recovery,now,true).await?;
    tx.commit().await?;
    audit(&state.pg_pool,Some(user.id),"session_unlocked",json!({"sessionId":id})).await?;
    Ok(Json(result))
}

pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(payload): Json<CredentialPayload>) -> ApiResult {
    proxy(&headers,&state).await?;
    let (id,refresh) = crypto::parse_token(&payload.refresh_token)?;
    let mut tx = state.pg_pool.begin().await?;
    let (_,session) = locked_context(&mut tx,id).await?;
    let digest = crypto::digest(&refresh,&state.session_token_hash_secret,"refresh");
    if !equal(&digest,&session.refresh_digest) && !session.consumed_digests.0.iter().any(|old| equal(&digest,&old.refresh_digest)) { return Err(invalid()); }
    sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?; Ok(Json(json!({"ok":true})))
}

fn decode_access(token: &str, secret: &str, now: DateTime<Utc>) -> Result<AccessClaims, AuthError> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = false;
    let claims = jsonwebtoken::decode::<AccessClaims>(token, &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()), &validation)
        .map_err(|_| invalid())?.claims;
    if claims.token_type != "access" || claims.exp <= now.timestamp() || claims.iat > now.timestamp() + 5 { return Err(invalid()); }
    Ok(claims)
}

fn canonical_id(value: &str) -> Result<Uuid, AuthError> {
    let id = Uuid::parse_str(value).map_err(|_| invalid())?;
    if id.to_string() != value { return Err(invalid()); }
    Ok(id)
}

fn authenticated(user: &User, session: &Session) -> SqlAuthenticatedUser {
    SqlAuthenticatedUser {
        id: user.id, session_id: session.id, role: user.role.clone(), email: user.email.clone(),
        permissions: user.permissions.clone(), two_factor_enabled: user.two_factor_enabled,
        two_factor_enrollment_required_at: user.two_factor_enrollment_required_at,
        two_factor_enrollment_completed_at: user.two_factor_enrollment_completed_at,
    }
}

pub async fn admit_access(pool: &PgPool, token: &str, jwt_secret: &str, now: DateTime<Utc>) -> Result<SqlAuthenticatedUser, AuthError> {
    let (user, _) = admit_route(pool,token,jwt_secret,"","",now).await?;
    Ok(user)
}

async fn admit_route(pool: &PgPool, token: &str, secret: &str, method: &str, path: &str, now: DateTime<Utc>) -> Result<(SqlAuthenticatedUser,&'static str),AuthError> {
    let claims = decode_access(token,secret,now)?;
    let id = canonical_id(&claims.sid)?;
    let subject = canonical_id(&claims.sub)?;
    let mut tx = pool.begin().await?;
    let (user,mut session) = locked_context(&mut tx,id).await?;
    if user.id != subject || session.role != claims.role || user.role != claims.role { return Err(invalid()); }
    if !user.active { return Err(error("AUTH_ACCOUNT_DISABLED","Account disabled")); }
    if session.absolute_expires_at <= now { return Err(error("AUTH_SESSION_EXPIRED","Session expired")); }
    if let Some(kind) = factors::admit_recovery(&mut tx,&user,&session,&claims,method,path,now).await? {
        tx.commit().await?; return Ok((authenticated(&user,&session),kind));
    }
    if method == "POST" && path == "/auth/sessions/revoke-all" {
        let permitted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_global_revocations WHERE source_session_id=$1 AND user_id=$2 AND source_session_version=$3 AND result_session_version=$4 AND expires_at>$5)")
            .bind(id).bind(user.id).bind(claims.session_version).bind(user.session_version).bind(now).fetch_one(&mut *tx).await?;
        if permitted { tx.commit().await?; return Ok((authenticated(&user,&session),"revokeAllRecovery")); }
    }
    binding(&user,&session,now)?;
    if claims.session_version != session.session_version { return Err(error("AUTH_SESSION_REVOKED","Session revoked")); }
    lock_idle(&mut tx,&mut session,now).await?;
    let unlock = method == "POST" && path == "/auth/unlock" && staff(&session.role) && session.state == "locked";
    if session.state == "locked" && !unlock {
        tx.commit().await?; return Err(error("AUTH_IDLE_LOCKED","Session idle locked"));
    }
    tx.commit().await?;
    Ok((authenticated(&user,&session),if unlock { "unlock" } else { "ordinary" }))
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct AdmissionPayload {
    pub method: String,
    pub path: String,
    pub refresh_token: Option<String>,
    pub recovery_token: Option<String>,
}

pub async fn internal_admit(State(state): State<Arc<AppState>>,headers: HeaderMap,Json(payload): Json<AdmissionPayload>) -> ApiResult {
    proxy(&headers,&state).await?;
    let now = Utc::now();
    let bearer = headers.get("authorization").and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer "));
    let (user,kind) = if let Some(token) = bearer {
        admit_route(&state.pg_pool,token,&state.jwt_secret,&payload.method,&payload.path,now).await?
    } else if payload.method == "POST" && payload.path == "/auth/unlock" {
        let (id,refresh) = crypto::parse_token(payload.refresh_token.as_deref().ok_or_else(invalid)?)?;
        let (rid,recovery) = crypto::parse_token(payload.recovery_token.as_deref().ok_or_else(invalid)?)?;
        if id != rid { return Err(invalid()); }
        let mut tx = state.pg_pool.begin().await?;
        let (user,mut session) = locked_context(&mut tx,id).await?;
        binding(&user,&session,now)?;
        lock_idle(&mut tx,&mut session,now).await?;
        if !staff(&session.role) || session.state != "locked"
            || !equal(&crypto::digest(&refresh,&state.session_token_hash_secret,"refresh"),&session.refresh_digest)
            || !equal(&crypto::digest(&recovery,&state.session_token_hash_secret,"recovery"),&session.recovery_digest) { tx.commit().await?; return Err(invalid()); }
        tx.commit().await?; (authenticated(&user,&session),"unlock")
    } else { return Err(invalid()); };
    Ok(Json(json!({"user":{"id":user.id,"email":user.email,"role":user.role,"permissions":user.permissions},"sessionId":user.session_id,"admissionKind":kind})))
}

async fn request_identity(headers: &HeaderMap,state: &AppState) -> Result<SqlAuthenticatedUser,AuthError> {
    proxy(headers,state).await?;
    let token = headers.get("authorization").and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).ok_or_else(invalid)?;
    admit_access(&state.pg_pool,token,&state.jwt_secret,Utc::now()).await
}

fn deadlines(session: &Session) -> Result<Value,AuthError> {
    let idle = session.idle_expires_at.ok_or_else(invalid)?;
    Ok(json!({"ok":true,"warningAt":(idle-chrono::Duration::minutes(5)).timestamp_millis(),"idleExpiresAt":idle.timestamp_millis()}))
}

pub async fn activity(State(state): State<Arc<AppState>>,headers: HeaderMap) -> ApiResult {
    let identity = request_identity(&headers,&state).await?;
    let now = Utc::now(); let mut tx = state.pg_pool.begin().await?;
    let (user,mut session) = locked_context(&mut tx,identity.session_id).await?;
    binding(&user,&session,now)?;
    if !staff(&session.role) { return Err(invalid()); }
    lock_idle(&mut tx,&mut session,now).await?;
    if session.state == "locked" { tx.commit().await?; return Err(AuthError::new(StatusCode::LOCKED,"AUTH_IDLE_LOCKED","Session idle locked")); }
    session.last_seen_at = now; session.idle_expires_at = Some(now+chrono::Duration::minutes(30));
    sqlx::query("UPDATE auth_sessions SET last_seen_at=$2,idle_expires_at=$3 WHERE id=$1 AND state='active'")
        .bind(session.id).bind(now).bind(session.idle_expires_at).execute(&mut *tx).await?;
    tx.commit().await?; Ok(Json(deadlines(&session)?))
}

pub async fn activity_status(State(state): State<Arc<AppState>>,headers: HeaderMap) -> ApiResult {
    let identity = request_identity(&headers,&state).await?;
    let session = load_pool(&state.pg_pool,identity.session_id).await?;
    if !staff(&session.role) { return Err(invalid()); }
    Ok(Json(deadlines(&session)?))
}

pub async fn list_sessions(State(state): State<Arc<AppState>>,headers: HeaderMap) -> ApiResult {
    let identity = request_identity(&headers,&state).await?;
    let rows: Vec<Session> = sqlx::query_as("SELECT * FROM auth_sessions WHERE user_id=$1 AND owns_slot AND state IN ('active','locked') AND absolute_expires_at>$2 ORDER BY slot,id LIMIT 3")
        .bind(identity.id).bind(Utc::now()).fetch_all(&state.pg_pool).await?;
    let sessions: Vec<Value> = rows.iter().map(|session| json!({"sessionId":session.id,"slot":session.slot,"deviceName":session.device_id,"userAgent":session.user_agent,"ipAddress":session.ip_address,"createdAt":session.created_at.timestamp_millis(),"lastSeenAt":session.last_seen_at.timestamp_millis(),"absoluteExpiresAt":session.absolute_expires_at.timestamp_millis(),"status":session.state,"isCurrent":session.id==identity.session_id})).collect();
    Ok(Json(json!({"sessions":sessions})))
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct RevokePayload { pub session_id: String }

async fn revoke_owned(state: &AppState,user: Uuid,target: Uuid) -> ApiResult {
    let mut tx = state.pg_pool.begin().await?;
    let _: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE id=$1 FOR UPDATE").bind(user).fetch_one(&mut *tx).await?;
    let session = load(&mut tx,target).await.map_err(|_| AuthError::new(StatusCode::NOT_FOUND,"AUTH_SESSION_NOT_FOUND","Session not found"))?;
    if session.user_id != user { return Err(AuthError::new(StatusCode::NOT_FOUND,"AUTH_SESSION_NOT_FOUND","Session not found")); }
    sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE id=$1").bind(target).execute(&mut *tx).await?;
    tx.commit().await?;
    audit(&state.pg_pool,Some(user),"device_revoked",json!({"sessionId":target})).await?;
    Ok(Json(json!({"ok":true})))
}

pub async fn revoke_current(State(state): State<Arc<AppState>>,headers: HeaderMap) -> ApiResult {
    let identity = request_identity(&headers,&state).await?;
    revoke_owned(&state,identity.id,identity.session_id).await
}

pub async fn revoke_device(State(state): State<Arc<AppState>>,headers: HeaderMap,Json(payload): Json<RevokePayload>) -> ApiResult {
    let identity = request_identity(&headers,&state).await?;
    let target = canonical_id(&payload.session_id).map_err(|_| AuthError::new(StatusCode::BAD_REQUEST,"AUTH_SESSION_INVALID","Invalid session"))?;
    revoke_owned(&state,identity.id,target).await
}

pub async fn revoke_all(State(state): State<Arc<AppState>>,headers: HeaderMap) -> ApiResult {
    proxy(&headers,&state).await?;
    let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).ok_or_else(invalid)?;
    let now = Utc::now();
    let (identity,kind) = admit_route(&state.pg_pool,token,&state.jwt_secret,"POST","/auth/sessions/revoke-all",now).await?;
    if kind == "revokeAllRecovery" { return Ok(Json(json!({"ok":true}))); }
    let mut tx = state.pg_pool.begin().await?;
    let (user,session) = locked_context(&mut tx,identity.session_id).await?;
    binding(&user,&session,now)?;
    factors::require_step_up(&headers,&state,&user,session.id,"security.sessions_all",now)?;
    let version = user.session_version.checked_add(1).ok_or_else(invalid)?;
    sqlx::query("UPDATE users SET session_version=$2 WHERE id=$1").bind(user.id).bind(version).execute(&mut *tx).await?;
    sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE user_id=$1 AND state IN ('active','locked')").bind(user.id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO auth_global_revocations(source_session_id,user_id,source_session_version,result_session_version,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_session_id) DO NOTHING")
        .bind(session.id).bind(user.id).bind(user.session_version).bind(version).bind(now+chrono::Duration::seconds(60)).execute(&mut *tx).await?;
    tx.commit().await?;
    audit(&state.pg_pool,Some(user.id),"logout_all",json!({"sessionId":session.id})).await?;
    Ok(Json(json!({"ok":true})))
}
