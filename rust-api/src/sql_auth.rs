use std::sync::{Arc, LazyLock};
use axum::{extract::State, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use subtle::ConstantTimeEq;
use uuid::Uuid;
mod crypto;
mod factors;
mod sessions;
mod issuance;
pub use issuance::device_selection;
use issuance::{issue,session_envelope};
pub use factors::{step_up, two_factor_status, verify_two_factor_login, two_factor_setup, two_factor_confirm, two_factor_disable};
pub use sessions::{admit_access, internal_admit, refresh, unlock, logout, activity, activity_status, list_sessions, revoke_current, revoke_device, revoke_all};
use sessions::Session;
use crate::state::AppState;

pub type ApiResult = Result<Json<Value>, AuthError>;
pub type SqlAuthError = AuthError;
#[derive(Debug)]
pub struct AuthError { pub status: StatusCode, pub code: &'static str, pub message: &'static str }
impl AuthError { pub fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self { Self {status,code,message} } }
impl IntoResponse for AuthError { fn into_response(self)->Response { (self.status,Json(json!({"error":{"code":self.code,"message":self.message}}))).into_response() } }
impl From<sqlx::Error> for AuthError { fn from(_:sqlx::Error)->Self { Self::new(StatusCode::SERVICE_UNAVAILABLE,"AUTH_UNAVAILABLE","Authentication service unavailable") } }
#[derive(Clone, Debug, Serialize)]
pub struct SqlAuthenticatedUser { pub id:Uuid,pub session_id:Uuid,pub role:String,pub email:String,pub permissions:Vec<String>,pub two_factor_enabled:bool,pub two_factor_enrollment_required_at:Option<DateTime<Utc>>,pub two_factor_enrollment_completed_at:Option<DateTime<Utc>> }
#[derive(Clone, Debug, sqlx::FromRow)]
pub(crate) struct User { pub id:Uuid,pub email:String,pub name:String,pub role:String,pub password_hash:String,pub active:bool,pub session_version:i32,pub security_generation:i64,pub two_factor_enabled:bool,pub two_factor_secret:Option<Vec<u8>>,pub last_otp_counter:Option<i64>,pub permissions:Vec<String>,pub two_factor_enrollment_required_at:Option<DateTime<Utc>>,pub two_factor_enrollment_completed_at:Option<DateTime<Utc>>,pub phone:String,pub address:String,pub avatar_url:String,pub level:String,pub balance:i64,pub points:i64,pub preferences:Value,pub created_at:DateTime<Utc>,pub updated_at:DateTime<Utc> }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AccessClaims { pub sub:String,pub sid:String,#[serde(rename="sessionVersion")] pub session_version:i32,pub role:String,pub iat:i64,pub exp:i64,pub jti:String,#[serde(rename="tokenType")] pub token_type:String }
pub(crate) fn invalid()->AuthError { AuthError::new(StatusCode::UNAUTHORIZED,"AUTH_TOKEN_INVALID","Unauthorized") }
pub(crate) async fn proxy(headers:&HeaderMap,state:&AppState)->Result<(),AuthError>{ let value=headers.get("x-api-v2-proxy-secret").and_then(|v|v.to_str().ok()).unwrap_or(""); if value.is_empty() || !bool::from(value.as_bytes().ct_eq(state.proxy_secret.as_bytes())) {return Err(invalid());} Ok(()) }
pub(crate) async fn current(headers:&HeaderMap,state:&AppState)->Result<User,AuthError>{proxy(headers,state).await?;let token=headers.get("authorization").and_then(|v|v.to_str().ok()).and_then(|v|v.strip_prefix("Bearer ")).ok_or_else(invalid)?;let admitted=admit_access(&state.pg_pool,token,&state.jwt_secret,Utc::now()).await?;sqlx::query_as("SELECT * FROM users WHERE id=$1").bind(admitted.id).fetch_one(&state.pg_pool).await.map_err(Into::into)}
pub(crate) fn sign<T:Serialize>(state:&AppState,claims:&T)->Result<String,AuthError>{jsonwebtoken::encode(&jsonwebtoken::Header::default(),claims,&jsonwebtoken::EncodingKey::from_secret(state.jwt_secret.as_bytes())).map_err(|_|AuthError::new(StatusCode::SERVICE_UNAVAILABLE,"AUTH_UNAVAILABLE","Authentication service unavailable"))}
pub(crate) fn user_json(user:&User)->Value { let permissions:serde_json::Map<String,Value>=user.permissions.iter().map(|p|(p.clone(),Value::Bool(true))).collect(); json!({"id":user.id,"email":user.email,"name":user.name,"role":user.role,"active":user.active,"phone":user.phone,"address":user.address,"avatarUrl":user.avatar_url,"level":user.level,"balance":user.balance,"points":user.points,"permissions":permissions,"preferences":user.preferences,"twoFactorEnabled":user.two_factor_enabled,"twoFactorEnrollmentRequiredAt":user.two_factor_enrollment_required_at,"twoFactorEnrollmentCompletedAt":user.two_factor_enrollment_completed_at,"createdAt":user.created_at,"serverTime":Utc::now()}) }
pub(crate) async fn audit(pool:&PgPool,user:Option<Uuid>,event:&str,details:Value)->Result<(),AuthError>{let outcome=if event.ends_with("_failed"){"failed"}else{"success"};sqlx::query("INSERT INTO audit_events(actor,action,outcome,correlation,payload) VALUES($1,$2,$3,$4,$5)").bind(user.map(|id|id.to_string()).unwrap_or_else(||"anonymous".to_string())).bind(event).bind(outcome).bind(event).bind(details).execute(pool).await?;Ok(())}
static PASSWORD_PERMITS: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(std::thread::available_parallelism().map(|n|n.get()).unwrap_or(2).max(2))));
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| bcrypt::hash("not-a-real-login-password",12).expect("bcrypt dummy initialization"));
static BACKGROUND_PERMITS: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));
fn permits()-> &'static Arc<tokio::sync::Semaphore>{&PASSWORD_PERMITS}
fn dummy()-> &'static str {&DUMMY_HASH}
pub fn warm_login_timing_material(){let _=dummy();}
pub(crate) async fn verify_password(password:String,hash:String)->bool {let Ok(permit)=permits().clone().acquire_owned().await else{return false;};tokio::task::spawn_blocking(move||{let _permit=permit;let h=if hash.is_empty(){dummy()}else{&hash};match bcrypt::verify(&password,h){Ok(v)=>v&&!hash.is_empty(),Err(_)=>{let _=bcrypt::verify(&password,dummy());false}}}).await.unwrap_or(false)}
pub(crate) async fn hash_password(password:String)->Result<String,AuthError>{let permit=permits().clone().acquire_owned().await.map_err(|_|invalid())?;tokio::task::spawn_blocking(move||{let _permit=permit;bcrypt::hash(password,12)}).await.map_err(|_|invalid())?.map_err(|_|invalid())}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct LoginPayload { email:Option<String>,password:Option<String>,remember_me:Option<bool>,device_name:Option<String>,turnstile_token:Option<String> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct RegisterPayload {name:Option<String>,email:Option<String>,password:Option<String>,device_name:Option<String>}
fn accepts(audience:&str,role:&str)->bool {if audience=="member"{role=="member"}else{matches!(role,"owner"|"admin"|"cs")}}
fn device(value:Option<&str>)->String {value.unwrap_or("Unknown device").trim().chars().take(100).collect()}
async fn setting(pool:&PgPool,key:&str)->Result<Option<Value>,AuthError>{Ok(sqlx::query_scalar("SELECT value FROM site_settings WHERE key=$1").bind(key).fetch_optional(pool).await?)}
async fn login(state:Arc<AppState>,headers:HeaderMap,payload:LoginPayload,audience:&str)->Response {let started=std::time::Instant::now();let response=login_core(&state,&headers,payload,audience).await; if let Some(wait)=std::time::Duration::from_millis(1500).checked_sub(started.elapsed()){tokio::time::sleep(wait).await;} response}
async fn login_core(state:&AppState,headers:&HeaderMap,payload:LoginPayload,audience:&str)->Response {match login_result(state,headers,payload,audience).await {Ok(v)=>Json(v).into_response(),Err(e)=>e.into_response()}}
async fn login_result(state:&AppState,headers:&HeaderMap,payload:LoginPayload,audience:&str)->Result<Value,AuthError>{
 proxy(headers,state).await?;let email=payload.email.unwrap_or_default().trim().to_lowercase();let password=payload.password.unwrap_or_default();
 let enabled=setting(&state.pg_pool,"botProtectionEnabled").await?.and_then(|v|v.as_bool()).unwrap_or(false);let site_key=setting(&state.pg_pool,"turnstileSiteKey").await?.and_then(|v|v.as_str().map(str::to_owned)).unwrap_or_default();let secret=std::env::var("TURNSTILE_SECRET_KEY").unwrap_or_default();
 if let Err(response)=crate::services::bot_protection::enforce_turnstile(enabled,&site_key,&secret,crate::services::bot_protection::kill_switch_enabled(std::env::var("TURNSTILE_DISABLED").ok().as_deref()),payload.turnstile_token.as_deref(),headers.get("x-forwarded-for").and_then(|v|v.to_str().ok()),crate::services::bot_protection::cloudflare_turnstile_verifier()).await {let status=response.status();return Err(AuthError::new(status,if status==StatusCode::SERVICE_UNAVAILABLE{"AUTH_UNAVAILABLE"}else{"TURNSTILE_INVALID"},"Bot protection verification failed"));}
 let found:Option<User>=sqlx::query_as("SELECT * FROM users WHERE normalized_email=$1").bind(&email).fetch_optional(&state.pg_pool).await?;
 let hash=found.as_ref().map(|u|u.password_hash.clone()).unwrap_or_default();let matched=verify_password(password.clone(),hash.clone()).await;
 if !matched || found.as_ref().map(|u|!u.active||!accepts(audience,&u.role)).unwrap_or(true){audit(&state.pg_pool,found.as_ref().map(|u|u.id),"login_failed",json!({"email":email,"audience":audience})).await?;return Err(AuthError::new(StatusCode::BAD_REQUEST,"AUTH_INVALID_CREDENTIALS","Login gagal. Periksa email dan password Anda."));}
 let found=found.ok_or_else(invalid)?;let mut tx=state.pg_pool.begin().await?;let mut user:User=sqlx::query_as("SELECT * FROM users WHERE id=$1 FOR UPDATE").bind(found.id).fetch_one(&mut *tx).await?;
 if !user.active||!accepts(audience,&user.role)||user.password_hash!=hash||user.session_version!=found.session_version||user.security_generation!=found.security_generation{return Err(invalid());}
 if audience=="staff"&&user.two_factor_enrollment_required_at.is_none(){user.two_factor_enrollment_required_at=Some(Utc::now()+Duration::hours(24));sqlx::query("UPDATE users SET two_factor_enrollment_required_at=$2 WHERE id=$1").bind(user.id).bind(user.two_factor_enrollment_required_at).execute(&mut *tx).await?;}
 let now=Utc::now();let remember=audience=="member"&&payload.remember_me.unwrap_or(false);let name=device(payload.device_name.as_deref());
 let result=if user.two_factor_enabled {factors::login_challenge(&mut tx,state,&user,audience,remember,&name,now).await?}else{issue(&mut tx,state,&user,audience,remember,&name,now).await?};tx.commit().await?;
 audit(&state.pg_pool,Some(user.id),"login_success",json!({"audience":audience,"twoFactorPending":user.two_factor_enabled})).await?;
 if hash.split('$').nth(2).and_then(|c|c.parse::<u32>().ok()).map(|c|c<12).unwrap_or(false){static BG:LazyLock<Arc<tokio::sync::Semaphore>>=LazyLock::new(||Arc::new(tokio::sync::Semaphore::new(1)));if let Ok(permit)=BG.clone().try_acquire_owned(){let pool=state.pg_pool.clone();let id=user.id;tokio::spawn(async move{let upgraded=tokio::task::spawn_blocking(move||{let _p=permit;bcrypt::hash(password,12)}).await;if let Ok(Ok(next))=upgraded{let _=sqlx::query("UPDATE users SET password_hash=$3 WHERE id=$1 AND password_hash=$2").bind(id).bind(hash).bind(next).execute(&pool).await;}});}}
 Ok(result)
}
pub async fn member_login(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(payload):Json<LoginPayload>)->Response{login(state,headers,payload,"member").await}
pub async fn staff_login(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(payload):Json<LoginPayload>)->Response{login(state,headers,payload,"staff").await}
pub async fn me(State(state):State<Arc<AppState>>,headers:HeaderMap)->ApiResult{let user=current(&headers,&state).await?;Ok(Json(json!({"user":user_json(&user)})))}
pub async fn register(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(payload):Json<RegisterPayload>)->ApiResult{
 proxy(&headers,&state).await?;if setting(&state.pg_pool,"maintenanceMode").await?.and_then(|v|v.as_bool()).unwrap_or(false){return Err(AuthError::new(StatusCode::SERVICE_UNAVAILABLE,"MAINTENANCE_MODE","Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi."));}if setting(&state.pg_pool,"registrationEnabled").await?.and_then(|v|v.as_bool())==Some(false){return Err(AuthError::new(StatusCode::FORBIDDEN,"REGISTRATION_DISABLED","Registrasi member sedang dinonaktifkan"));}
 let name=payload.name.unwrap_or_default().trim().to_owned();let email=payload.email.unwrap_or_default().trim().to_lowercase();let password=payload.password.unwrap_or_default();if name.len()<2||name.len()>200||!email.contains('@')||email.len()>254||password.len()<8||password.len()>72{return Err(AuthError::new(StatusCode::BAD_REQUEST,"VALIDATION_ERROR","Registrasi tidak dapat diproses. Periksa data dan coba lagi."));}let hash=hash_password(password).await?;let mut tx=state.pg_pool.begin().await?;
 let user:User=sqlx::query_as("INSERT INTO users(email,password_hash,name,role,role_updated_at,policy_updated_at) VALUES($1,$2,$3,'member',now(),now()) RETURNING *").bind(email).bind(hash).bind(name).fetch_one(&mut *tx).await.map_err(|e|if e.as_database_error().map(|d|d.is_unique_violation()).unwrap_or(false){AuthError::new(StatusCode::BAD_REQUEST,"REGISTRATION_FAILED","Registrasi tidak dapat diproses. Periksa data dan coba lagi.")}else{e.into()})?;
 let result=issue(&mut tx,&state,&user,"member",false,&device(payload.device_name.as_deref()),Utc::now()).await?;tx.commit().await?;Ok(Json(result))
}
pub(crate) fn verify_step_up(headers:&HeaderMap,state:&AppState,user:&SqlAuthenticatedUser,group:&str,now:DateTime<Utc>)->Result<(),AuthError>{
    factors::verify_step_up(headers,state,user,group,now)
}
