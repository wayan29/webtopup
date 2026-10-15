use super::*;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use serde::{Deserialize, Serialize};

fn error(status:StatusCode,code:&'static str,message:&'static str)->AuthError { AuthError::new(status,code,message) }
fn invalid()->AuthError { error(StatusCode::UNAUTHORIZED,"AUTH_TOKEN_INVALID","Invalid authentication proof") }
fn staff(user:&User)->Result<(),AuthError> { if matches!(user.role.as_str(),"owner"|"admin"|"cs") { Ok(()) } else { Err(error(StatusCode::FORBIDDEN,"AUTH_FORBIDDEN","2FA hanya tersedia untuk owner, admin, dan CS")) } }
fn sid(headers:&HeaderMap)->Result<Uuid,AuthError> { headers.get("x-webtopup-session-id").and_then(|v|v.to_str().ok()).and_then(|v|Uuid::parse_str(v).ok()).ok_or_else(invalid) }
fn seed_aad(id:Uuid,pending:bool)->String { format!("auth-totp/v1/{id}/{}",if pending {"pending"} else {"active"}) }
fn decode<T:serde::de::DeserializeOwned>(state:&AppState,token:&str)->Result<T,AuthError> { let mut validation=jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);validation.leeway=0;jsonwebtoken::decode::<T>(token,&jsonwebtoken::DecodingKey::from_secret(state.jwt_secret.as_bytes()),&validation).map(|v|v.claims).map_err(|_|invalid()) }
fn otp_counter(seed:&[u8],code:&str,now:DateTime<Utc>,last:Option<i64>)->Option<i64> {
    let code:String=code.split_whitespace().collect();if code.len()!=6 || !code.bytes().all(|v|v.is_ascii_digit()) { return None; }
    (-2..=2).map(|offset|now.timestamp()/30+offset).filter(|c|*c>=0 && last.is_none_or(|last|*c>last)).find(|c| { let mut mac=<Hmac<Sha1> as Mac>::new_from_slice(seed).expect("HMAC key");mac.update(&(*c as u64).to_be_bytes());let bytes=mac.finalize().into_bytes();let i=(bytes[19]&15) as usize;let n=u32::from_be_bytes([bytes[i]&127,bytes[i+1],bytes[i+2],bytes[i+3]])%1_000_000;crypto::equal(format!("{n:06}").as_bytes(),code.as_bytes()) })
}
pub(super) async fn consume_otp(tx:&mut Transaction<'_,Postgres>,state:&AppState,user:&User,code:&str,now:DateTime<Utc>)->Result<i64,AuthError> {
    let encrypted=user.two_factor_secret.as_deref().ok_or_else(invalid)?;let seed=zeroize::Zeroizing::new(crypto::open(state,&seed_aad(user.id,false),encrypted)?);
    let counter=otp_counter(&seed,code,now,user.last_otp_counter).ok_or_else(||error(StatusCode::UNAUTHORIZED,"REAUTH_OTP_INVALID","Kode OTP tidak valid"))?;
    let result=sqlx::query("UPDATE users SET last_otp_counter=$2 WHERE id=$1 AND (last_otp_counter IS NULL OR last_otp_counter<$2)").bind(user.id).bind(counter).execute(&mut **tx).await?;
    if result.rows_affected()!=1 { return Err(error(StatusCode::UNAUTHORIZED,"REAUTH_OTP_INVALID","Kode OTP sudah digunakan")); }Ok(counter)
}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct FactorClaims { sub:Uuid,nonce:Uuid,purpose:String,login_audience:String,iat:i64,exp:i64 }
pub(super) async fn login_challenge(tx:&mut Transaction<'_,Postgres>,state:&AppState,user:&User,audience:&str,remember:bool,device:&str,now:DateTime<Utc>)->Result<Value,AuthError> {
    let id=Uuid::new_v4();let expires=now+chrono::Duration::minutes(5);
    sqlx::query("INSERT INTO auth_factor_challenges(id,user_id,audience,session_version,security_generation,role,remember,device,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(id).bind(user.id).bind(audience).bind(user.session_version).bind(user.security_generation).bind(&user.role).bind(remember).bind(device).bind(expires).execute(&mut **tx).await?;
    let token=super::sign(state,&FactorClaims{sub:user.id,nonce:id,purpose:"2fa-login".into(),login_audience:audience.into(),iat:now.timestamp(),exp:expires.timestamp()})?;
    Ok(json!({"requiresTwoFactor":true,"challengeToken":token}))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct LoginFactorPayload { challenge_token:String,code:String }
#[derive(sqlx::FromRow)]
struct Challenge { user_id:Uuid,audience:String,session_version:i32,security_generation:i64,role:String,remember:bool,device:String,expires_at:DateTime<Utc>,attempts:i32,consumed_at:Option<DateTime<Utc>> }
pub async fn verify_two_factor_login(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(payload):Json<LoginFactorPayload>)->ApiResult {
    proxy(&headers,&state).await?;let claims:FactorClaims=decode(&state,&payload.challenge_token)?;let now=Utc::now();if claims.purpose!="2fa-login" || claims.iat>now.timestamp() { return Err(invalid()); }
    let mut tx=state.pg_pool.begin().await?;
    let user=sqlx::query_as::<_,User>("SELECT * FROM users WHERE id=$1 FOR UPDATE").bind(claims.sub).fetch_optional(&mut *tx).await?.ok_or_else(invalid)?;
    let c=sqlx::query_as::<_,Challenge>("SELECT * FROM auth_factor_challenges WHERE id=$1 FOR UPDATE").bind(claims.nonce).fetch_optional(&mut *tx).await?.ok_or_else(invalid)?;
    if !user.active || !user.two_factor_enabled || c.user_id!=user.id || c.expires_at<=now || c.consumed_at.is_some() || c.attempts>=5 || c.session_version!=user.session_version || c.security_generation!=user.security_generation || c.role!=user.role || claims.login_audience!=c.audience || !(c.audience=="member" && user.role=="member" || c.audience=="staff" && matches!(user.role.as_str(),"owner"|"admin"|"cs")) { return Err(invalid()); }
    sqlx::query("UPDATE auth_factor_challenges SET attempts=attempts+1 WHERE id=$1").bind(claims.nonce).execute(&mut *tx).await?;
    if let Err(e)=consume_otp(&mut tx,&state,&user,&payload.code,now).await { tx.commit().await?;return Err(e); }
    sqlx::query("UPDATE auth_factor_challenges SET consumed_at=$2 WHERE id=$1").bind(claims.nonce).bind(now).execute(&mut *tx).await?;
    let envelope=issue(&mut tx,&state,&user,&c.audience,c.remember,&c.device,now).await?;tx.commit().await?;Ok(Json(envelope))
}
pub async fn two_factor_status(headers:HeaderMap,State(state):State<Arc<AppState>>)->ApiResult {
    let user=current(&headers,&state).await?;staff(&user)?;
    let pending:bool=sqlx::query_scalar("SELECT two_factor_pending_secret IS NOT NULL AND two_factor_pending_expires_at>now() FROM users WHERE id=$1").bind(user.id).fetch_one(&state.pg_pool).await?;
    Ok(Json(json!({"enabled":user.two_factor_enabled,"setupPending":pending})))
}
fn base32(seed:&[u8])->String { const ALPHABET:&[u8]=b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let mut out=String::new();let mut bits=0u32;let mut value=0u32;for b in seed {value=(value<<8)|*b as u32;bits+=8;while bits>=5 {bits-=5;out.push(ALPHABET[((value>>bits)&31) as usize] as char);}}if bits>0 {out.push(ALPHABET[((value<<(5-bits))&31) as usize] as char);}out }
fn url(value:&str)->String { value.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {(b as char).to_string()} else {format!("%{b:02X}")}).collect() }
pub async fn two_factor_setup(headers:HeaderMap,State(state):State<Arc<AppState>>)->ApiResult {
    let auth=current(&headers,&state).await?;let mut tx=state.pg_pool.begin().await?;let user=sqlx::query_as::<_,User>("SELECT * FROM users WHERE id=$1 FOR UPDATE").bind(auth.id).fetch_one(&mut *tx).await?;staff(&user)?;if user.two_factor_enabled { return Err(error(StatusCode::BAD_REQUEST,"AUTH_CONFLICT","2FA sudah aktif")); }
    let (pending,expires):(Option<Vec<u8>>,Option<DateTime<Utc>>)=sqlx::query_as("SELECT two_factor_pending_secret,two_factor_pending_expires_at FROM users WHERE id=$1").bind(user.id).fetch_one(&mut *tx).await?;let now=Utc::now();
    let seed=zeroize::Zeroizing::new(if let Some(p)=pending.filter(|_|expires.is_some_and(|v|v>now)) {crypto::open(&state,&seed_aad(user.id,true),&p)?} else {let seed=crypto::new_secret()[..20].to_vec();let encrypted=crypto::seal(&state,&seed_aad(user.id,true),&seed)?;sqlx::query("UPDATE users SET two_factor_pending_secret=$2,two_factor_pending_expires_at=$3 WHERE id=$1").bind(user.id).bind(encrypted).bind(now+chrono::Duration::minutes(10)).execute(&mut *tx).await?;seed});tx.commit().await?;
    let secret=base32(&seed);let issuer=std::env::var("APP_NAME").ok().filter(|v|!v.trim().is_empty()).unwrap_or_else(||"PPOB Admin".into());let otpauth=format!("otpauth://totp/{}:{}?secret={secret}&issuer={}",url(&issuer),url(&user.email),url(&issuer));Ok(Json(json!({"secret":secret,"otpauthUrl":otpauth,"qrCodeDataUrl":null})))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct CodePayload { #[serde(default)] code:String,#[serde(default)] password:String,recovery_token:Option<String> }
#[derive(sqlx::FromRow)]
struct Change { id:Uuid,result_ciphertext:Vec<u8>,proof_digest:Vec<u8>,expires_at:DateTime<Utc> }
fn change_aad(user:Uuid,source:Uuid,operation:&str,id:Uuid)->String { format!("auth-security-change/v1/{user}/{source}/{operation}/{id}") }
async fn replay_security_change(
    state: &AppState,
    user_id: Uuid,
    source: Uuid,
    operation: &str,
    proof_digest: &[u8],
    now: DateTime<Utc>,
) -> Result<Option<Value>, AuthError> {
    let eligible: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND active AND role IN ('owner','admin','cs'))",
    )
    .bind(user_id)
    .fetch_one(&state.pg_pool)
    .await?;
    if !eligible {
        return Ok(None);
    }
    let Some(change) = sqlx::query_as::<_, Change>(
        "SELECT id,result_ciphertext,proof_digest,expires_at FROM auth_security_changes WHERE user_id=$1 AND source_session_id=$2 AND operation=$3",
    )
    .bind(user_id)
    .bind(source)
    .bind(operation)
    .fetch_optional(&state.pg_pool)
    .await?
    else {
        return Ok(None);
    };
    if change.expires_at <= now || !crypto::equal(proof_digest, &change.proof_digest) {
        return Ok(None);
    }
    let clear = zeroize::Zeroizing::new(crypto::open(
        state,
        &change_aad(user_id, source, operation, change.id),
        &change.result_ciphertext,
    )?);
    let result = serde_json::from_slice(&clear).map_err(|_| invalid())?;
    Ok(Some(result))
}
async fn security_change(headers:HeaderMap,state:Arc<AppState>,payload:CodePayload,enabled:bool)->ApiResult {
    proxy(&headers,&state).await?;let source=sid(&headers)?;let (proof_sid,proof)=crypto::parse_token(payload.recovery_token.as_deref().ok_or_else(invalid)?)?;if proof_sid!=source {return Err(invalid());}let operation=if enabled {"two_factor_confirm"} else {"two_factor_disable"};let now=Utc::now();
    let user_id:Uuid=sqlx::query_scalar("SELECT user_id FROM auth_sessions WHERE id=$1").bind(source).fetch_optional(&state.pg_pool).await?.ok_or_else(invalid)?;
    let proof_digest=crypto::digest(&proof,&state.session_token_hash_secret,"recovery");
    let token=headers.get("authorization").and_then(|value|value.to_str().ok()).and_then(|value|value.strip_prefix("Bearer ")).ok_or_else(invalid)?;
    let authenticated=match crate::sql_auth::admit_access(&state.pg_pool,token,&state.jwt_secret,now).await {
        Ok(user)=>user,
        Err(auth_error)=>{
            if let Some(result)=replay_security_change(&state,user_id,source,operation,&proof_digest,now).await? {return Ok(Json(result));}
            return Err(auth_error);
        }
    };
    if authenticated.id!=user_id || authenticated.session_id!=source {return Err(invalid());}
    let mut tx=state.pg_pool.begin().await?;let user=sqlx::query_as::<_,User>("SELECT * FROM users WHERE id=$1 FOR UPDATE").bind(user_id).fetch_one(&mut *tx).await?;staff(&user)?;if !user.active {return Err(invalid());}
    if let Some(change)=sqlx::query_as::<_,Change>("SELECT * FROM auth_security_changes WHERE source_session_id=$1 AND operation=$2 FOR UPDATE").bind(source).bind(operation).fetch_optional(&mut *tx).await? {
        if change.expires_at<=now || !crypto::equal(&proof_digest,&change.proof_digest) {return Err(invalid());}let clear=zeroize::Zeroizing::new(crypto::open(&state,&change_aad(user.id,source,operation,change.id),&change.result_ciphertext)?);let result=serde_json::from_slice(&clear).map_err(|_|invalid())?;tx.commit().await?;return Ok(Json(result));
    }
    let session=sqlx::query_as::<_,sessions::Session>("SELECT * FROM auth_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE").bind(source).bind(user.id).fetch_one(&mut *tx).await?;
    if session.state!="active" || session.role!=user.role || session.audience!="staff" || session.session_version!=user.session_version || session.security_generation!=user.security_generation || session.absolute_expires_at<=now || session.idle_expires_at.is_some_and(|deadline|deadline<=now) || !crypto::equal(&proof_digest,&session.recovery_digest) {return Err(invalid());}
    let counter;
    let active_seed;
    if enabled {
        if user.two_factor_enabled {return Err(error(StatusCode::CONFLICT,"AUTH_CONFLICT","2FA sudah aktif"));}
        let (pending,expires):(Option<Vec<u8>>,Option<DateTime<Utc>>)=sqlx::query_as("SELECT two_factor_pending_secret,two_factor_pending_expires_at FROM users WHERE id=$1").bind(user.id).fetch_one(&mut *tx).await?;
        if !expires.is_some_and(|v|v>now) {return Err(error(StatusCode::BAD_REQUEST,"AUTH_CONFLICT","Setup 2FA belum dimulai"));}
        let seed=zeroize::Zeroizing::new(crypto::open(&state,&seed_aad(user.id,true),&pending.ok_or_else(invalid)?)?);counter=Some(otp_counter(&seed,&payload.code,now,user.last_otp_counter).ok_or_else(||error(StatusCode::BAD_REQUEST,"REAUTH_OTP_INVALID","Kode OTP tidak valid"))?);active_seed=Some(crypto::seal(&state,&seed_aad(user.id,false),&seed)?);
    } else {
        if !crypto::password(&payload.password,&user.password_hash).await? {return Err(error(StatusCode::UNAUTHORIZED,"REAUTH_PASSWORD_INVALID","Password tidak valid"));}
        if !user.two_factor_enabled {return Err(error(StatusCode::CONFLICT,"AUTH_CONFLICT","2FA tidak aktif"));}consume_otp(&mut tx,&state,&user,&payload.code,now).await?;counter=None;active_seed=None;
    }
    sqlx::query("UPDATE users SET two_factor_enabled=$2,two_factor_secret=$3,last_otp_counter=$4,two_factor_pending_secret=NULL,two_factor_pending_expires_at=NULL,session_version=session_version+1,security_generation=security_generation+1,two_factor_enrollment_completed_at=CASE WHEN $2 THEN $5 ELSE NULL END,two_factor_enrollment_required_at=CASE WHEN $2 THEN NULL ELSE $5 END WHERE id=$1").bind(user.id).bind(enabled).bind(active_seed).bind(counter).bind(now).execute(&mut *tx).await?;
    sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE user_id=$1 AND state IN ('active','locked')").bind(user.id).execute(&mut *tx).await?;
    let updated=sqlx::query_as::<_,User>("SELECT * FROM users WHERE id=$1").bind(user.id).fetch_one(&mut *tx).await?;
    let (audience,remember,device):(String,bool,String)=sqlx::query_as("SELECT audience,remember_me,device_id FROM auth_sessions WHERE id=$1").bind(source).fetch_one(&mut *tx).await?;
    let mut result=issue(&mut tx,&state,&updated,&audience,remember,&device,now).await?;result["enabled"]=json!(enabled);result["message"]=json!(if enabled {"2FA berhasil diaktifkan"} else {"2FA berhasil dinonaktifkan"});
    let id=Uuid::new_v4();let encrypted=crypto::seal(&state,&change_aad(user.id,source,operation,id),&serde_json::to_vec(&result).map_err(|_|invalid())?)?;
    sqlx::query("INSERT INTO auth_security_changes(id,user_id,source_session_id,operation,proof_digest,result_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(user.id).bind(source).bind(operation).bind(proof_digest).bind(encrypted).bind(now+chrono::Duration::minutes(5)).execute(&mut *tx).await?;tx.commit().await?;Ok(Json(result))
}
pub async fn two_factor_confirm(headers:HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<CodePayload>)->ApiResult {security_change(headers,state,payload,true).await}
pub async fn two_factor_disable(headers:HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<CodePayload>)->ApiResult {security_change(headers,state,payload,false).await}

pub(super) async fn admit_recovery(tx:&mut Transaction<'_,Postgres>,user:&User,session:&sessions::Session,_claims:&AccessClaims,method:&str,path:&str,now:DateTime<Utc>)->Result<Option<&'static str>,AuthError> {
    let operation=match (method,path) {("POST","/auth/2fa/confirm"|"/v2/auth/2fa/confirm"|"/api/v2/auth/2fa/confirm")=>"two_factor_confirm",("POST","/auth/2fa/disable"|"/v2/auth/2fa/disable"|"/api/v2/auth/2fa/disable")=>"two_factor_disable",_=>return Ok(None)};
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_security_changes WHERE user_id=$1 AND source_session_id=$2 AND operation=$3 AND expires_at>$4)").bind(user.id).bind(session.id).bind(operation).bind(now).fetch_one(&mut **tx).await?;Ok(if user.active && exists {Some("securityChangeRecovery")} else {None})
}
const GROUPS:&[&str]=&["finance.adjust_balance","finance.refund","finance.deposit_approval","transactions.manual","integrations.credentials","team.manage_privileged","team.reset_2fa","security.sessions_all","exports.sensitive","security.password","settings.sensitive"];
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Grant { sub:Uuid,sid:Uuid,action_group:String,purpose:String,iat:i64,exp:i64,jti:Uuid }
pub(crate) fn require_step_up(headers:&HeaderMap,state:&AppState,user:&User,session_id:Uuid,group:&str,now:DateTime<Utc>)->Result<(),AuthError> {
    if !GROUPS.contains(&group) || headers.get("x-webtopup-step-up-group").and_then(|v|v.to_str().ok())!=Some(group) {return Err(error(StatusCode::FORBIDDEN,"AUTH_STEP_UP_REQUIRED","Verifikasi ulang diperlukan"));}
    // Gateway verifies the signed grant before stamping this proxy-only group header.
    let token=headers.get("x-webtopup-step-up-token").and_then(|v|v.to_str().ok()).ok_or_else(invalid)?;
    let grant:Grant=decode(state,token)?;
    if grant.sub!=user.id || grant.sid!=session_id || grant.action_group!=group || grant.purpose!="step-up" || grant.iat>now.timestamp() || grant.exp<=now.timestamp() {return Err(invalid());}
    Ok(())
}
pub(super) fn verify_step_up(headers:&HeaderMap,state:&AppState,user:&SqlAuthenticatedUser,group:&str,now:DateTime<Utc>)->Result<(),AuthError>{
    if !GROUPS.contains(&group) || headers.get("x-webtopup-step-up-group").and_then(|v|v.to_str().ok())!=Some(group) { return Err(error(StatusCode::FORBIDDEN,"AUTH_STEP_UP_REQUIRED","Verifikasi ulang diperlukan")); }
    let token=headers.get("x-webtopup-step-up-token").and_then(|v|v.to_str().ok()).ok_or_else(invalid)?;
    let grant:Grant=decode(state,token)?;
    if grant.sub!=user.id || grant.sid!=user.session_id || grant.action_group!=group || grant.purpose!="step-up" || grant.iat>now.timestamp() || grant.exp<=now.timestamp() { return Err(invalid()); }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct StepPayload { password:String,otp:Option<String>,otp_code:Option<String>,action_group:String }
pub async fn step_up(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(payload):Json<StepPayload>)->ApiResult {
    let auth=current(&headers,&state).await?;staff(&auth)?;if !GROUPS.contains(&payload.action_group.as_str()) {return Err(error(StatusCode::BAD_REQUEST,"AUTH_STEP_UP_INVALID","Invalid action group"));}
    let id=sid(&headers)?;let now=Utc::now();let mut tx=state.pg_pool.begin().await?;let user=sqlx::query_as::<_,User>("SELECT * FROM users WHERE id=$1 FOR UPDATE").bind(auth.id).fetch_one(&mut *tx).await?;
    let attempts:i32=sqlx::query_scalar("SELECT step_up_attempts FROM auth_sessions WHERE id=$1 AND user_id=$2 AND state='active' AND session_version=$3 AND security_generation=$4 AND absolute_expires_at>$5 AND (idle_expires_at IS NULL OR idle_expires_at>$5) FOR UPDATE").bind(id).bind(user.id).bind(user.session_version).bind(user.security_generation).bind(now).fetch_optional(&mut *tx).await?.ok_or_else(invalid)?;
    if attempts>=5 {return Err(error(StatusCode::TOO_MANY_REQUESTS,"REAUTH_ATTEMPTS_EXHAUSTED","Too many authentication attempts"));}
    sqlx::query("UPDATE auth_sessions SET step_up_attempts=step_up_attempts+1 WHERE id=$1").bind(id).execute(&mut *tx).await?;
    if !crypto::password(&payload.password,&user.password_hash).await? {tx.commit().await?;return Err(error(StatusCode::UNAUTHORIZED,"REAUTH_PASSWORD_INVALID","Password tidak valid"));}
    if !user.two_factor_enabled {tx.commit().await?;return Err(error(StatusCode::FORBIDDEN,"AUTH_2FA_REQUIRED","2FA enrollment required"));}
    if let Err(e)=consume_otp(&mut tx,&state,&user,payload.otp.as_deref().or(payload.otp_code.as_deref()).unwrap_or(""),now).await {tx.commit().await?;return Err(e);}
    sqlx::query("UPDATE auth_sessions SET step_up_attempts=0 WHERE id=$1").bind(id).execute(&mut *tx).await?;let exp=now.timestamp()+300;let token=super::sign(&state,&Grant{sub:user.id,sid:id,action_group:payload.action_group.clone(),purpose:"step-up".into(),iat:now.timestamp(),exp,jti:Uuid::new_v4()})?;tx.commit().await?;Ok(Json(json!({"stepUpToken":token,"actionGroup":payload.action_group,"expiresAt":exp})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn otp_replay_is_rejected_at_counter_boundary() {let seed=b"12345678901234567890";let now=DateTime::from_timestamp(59,0).unwrap();assert_eq!(otp_counter(seed,"287082",now,None),Some(1));assert_eq!(otp_counter(seed,"287082",now,Some(1)),None);}
    #[test] fn encrypted_recovery_binding_separates_operation_and_session() {let user=Uuid::new_v4();let source=Uuid::new_v4();let id=Uuid::new_v4();assert_ne!(change_aad(user,source,"two_factor_confirm",id),change_aad(user,source,"two_factor_disable",id));assert_ne!(change_aad(user,source,"two_factor_confirm",id),change_aad(user,Uuid::new_v4(),"two_factor_confirm",id));}
}
