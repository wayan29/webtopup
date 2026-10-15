//! PostgreSQL-backed balance giveaway lottery routes.
use std::{collections::HashSet, sync::Arc};

use axum::{extract::{Path, Query, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use rand::{seq::SliceRandom, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, Postgres, Transaction};
use uuid::Uuid;

use crate::{security::require_sql_permission, state::AppState};

#[derive(Deserialize)]
pub struct GiveawayListQuery { pub(super) page: Option<i64>, pub(super) limit: Option<i64> }
#[derive(Deserialize, Serialize)]
pub struct GiveawayPayload {
 #[serde(rename="participantFilter", default)] pub(super) participant_filter: Option<String>,
 pub(super) emails: Option<Vec<String>>,
 #[serde(rename="winnerCount")] pub(super) winner_count: Option<i64>,
 #[serde(rename="totalPool")] pub(super) total_pool: Option<i64>,
 #[serde(rename="minAmount")] pub(super) min_amount: Option<i64>,
 #[serde(rename="maxAmount")] pub(super) max_amount: Option<i64>,
 pub(super) seed: Option<String>, pub(super) name: Option<String>, pub(super) note: Option<String>,
}
#[derive(Serialize)]
struct Winner { user_id: Uuid, email: String, name: String, amount: i64 }
fn error(status: StatusCode, message: &str) -> Response { (status, Json(json!({"message":message}))).into_response() }
fn unavailable() -> Response { error(StatusCode::INTERNAL_SERVER_ERROR,"Layanan giveaway tidak tersedia") }
fn digest(payload: &GiveawayPayload) -> String { Sha256::digest(serde_json::to_vec(payload).unwrap_or_default()).iter().map(|byte|format!("{byte:02x}")).collect() }
fn parse_uuid(s: &str) -> Option<Uuid> { Uuid::parse_str(s.trim()).ok() }

pub async fn giveaway_list(headers: HeaderMap, State(state): State<Arc<AppState>>, Query(q): Query<GiveawayListQuery>) -> Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageVouchers").await{return r;}
 let page=q.page.unwrap_or(1).clamp(1,100000); let limit=q.limit.unwrap_or(20).clamp(1,100); let offset=(page-1)*limit;
 let rows=match sqlx::query("SELECT g.*, (SELECT count(*) FROM promo_giveaway_winners w WHERE w.giveaway_id=g.id) AS winner_count_actual FROM promo_giveaways g ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2").bind(limit).bind(offset).fetch_all(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()};
 let total=match sqlx::query_scalar::<_,i64>("SELECT count(*) FROM promo_giveaways").fetch_one(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()};
 Json(json!({"giveaways":rows.iter().map(row_json).collect::<Vec<_>>(),"pagination":{"page":page,"limit":limit,"total":total,"pages":(total+limit-1)/limit}})).into_response()
}
fn row_json(row:&sqlx::postgres::PgRow)->Value { json!({"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name"),"note":row.get::<String,_>("note"),"participantFilter":row.get::<String,_>("participant_filter"),"winnerCount":row.get::<i64,_>("winner_count"),"totalPool":row.get::<i64,_>("total_pool"),"minAmount":row.get::<i64,_>("min_amount"),"maxAmount":row.get::<i64,_>("max_amount"),"participantCount":row.get::<i64,_>("participant_count"),"status":row.get::<String,_>("status"),"createdAt":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at")}) }
pub async fn giveaway_detail(headers:HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageVouchers").await{return r;} let Some(id)=parse_uuid(&id)else{return error(StatusCode::NOT_FOUND,"Giveaway not found")};
 let row=match sqlx::query("SELECT * FROM promo_giveaways WHERE id=$1").bind(id).fetch_optional(&state.pg_pool).await{Ok(Some(r))=>r,Ok(None)=>return error(StatusCode::NOT_FOUND,"Giveaway not found"),Err(_)=>return unavailable()};
 let mut result=row_json(&row); let winners=match sqlx::query("SELECT w.user_id,u.email,u.name,w.amount,w.position,w.balance_after,w.points_after FROM promo_giveaway_winners w JOIN users u ON u.id=w.user_id WHERE w.giveaway_id=$1 ORDER BY w.position").bind(id).fetch_all(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()}; result["winners"]=json!(winners.iter().map(|w|json!({"userId":w.get::<Uuid,_>("user_id"),"email":w.get::<String,_>("email"),"name":w.get::<String,_>("name"),"amount":w.get::<i64,_>("amount"),"position":w.get::<i64,_>("position"),"balance":w.get::<i64,_>("balance_after"),"points":w.get::<i64,_>("points_after")})).collect::<Vec<_>>()); Json(result).into_response()
}
pub async fn giveaway_preview(headers:HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<GiveawayPayload>)->Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageVouchers").await{return r;} match draw(&state,&payload).await{Ok((winners,count,_seed))=>Json(json!({"success":true,"participantCount":count,"winners":winners.iter().map(|w|json!({"userId":w.user_id,"email":w.email,"name":w.name,"amount":w.amount})).collect::<Vec<_>>()})).into_response(),Err(e)=>error(StatusCode::BAD_REQUEST,&e)}
}
async fn draw(state:&AppState,p:&GiveawayPayload)->Result<(Vec<Winner>,i64,String),String>{
 let mode=p.participant_filter.as_deref().unwrap_or("members"); if mode!="members"&&mode!="emails"{return Err("participantFilter must be members or emails".into())}
 let wc=p.winner_count.unwrap_or(1);let pool=p.total_pool.unwrap_or(0);let min=p.min_amount.unwrap_or(0);let max=p.max_amount.unwrap_or(pool);if wc<=0||pool<=0||min<0||max<min||max.checked_mul(wc).is_none()||min.checked_mul(wc).is_none()||min*wc>pool||max*wc<pool{return Err("Invalid giveaway totals or winner count".into())}
 let mut candidates=if mode=="members"{sqlx::query("SELECT id,email,name FROM users WHERE role='member' AND active ORDER BY id").fetch_all(&state.pg_pool).await.map_err(|_|"Unable to load participants")?}else{let emails=p.emails.as_ref().filter(|e|!e.is_empty()).ok_or("emails are required for email participant filter")?;let mut norm=Vec::new();let mut seen=HashSet::new();for e in emails{let e=e.trim().to_lowercase();if e.is_empty()||!e.contains('@')||!seen.insert(e.clone()){return Err("Invalid or duplicate participant email".into())}norm.push(e);}sqlx::query("SELECT id,email,name FROM users WHERE normalized_email=ANY($1) AND active ORDER BY id").bind(norm).fetch_all(&state.pg_pool).await.map_err(|_|"Unable to load participants")?};
 if candidates.len()<wc as usize{return Err("Not enough participants for requested winners".into())}let count=candidates.len() as i64;
 let seed=p.seed.clone().unwrap_or_else(||Uuid::new_v4().to_string());let mut rng=ChaCha8Rng::from_seed(Sha256::digest(seed.as_bytes()).into());candidates.shuffle(&mut rng);candidates.truncate(wc as usize);
 let mut amounts=vec![min;wc as usize];let mut remainder=pool-min*wc;let mut i=0;while remainder>0{let capacity=max-amounts[i];if capacity==0{i=(i+1)%amounts.len();continue}let take=remainder.min(capacity);amounts[i]+=take;remainder-=take;i=(i+1)%amounts.len();}
 if remainder!=0||amounts.iter().any(|amount|*amount<min||*amount>max)||amounts.iter().sum::<i64>()!=pool{return Err("Unable to allocate giveaway pool within winner bounds".into())}
 Ok((candidates.into_iter().zip(amounts).map(|(r,amount)|Winner{user_id:r.get("id"),email:r.get("email"),name:r.get("name"),amount}).collect(),count,seed))
}
pub async fn giveaway_execute(headers:HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<GiveawayPayload>)->Response {
 let actor=match require_sql_permission(&headers,&state,"manageVouchers").await{Ok(v)=>v,Err(r)=>return r};let Some(key)=headers.get("idempotency-key").and_then(|v|v.to_str().ok()).map(str::trim).filter(|v|!v.is_empty()&&v.len()<=200)else{return error(StatusCode::BAD_REQUEST,"Idempotency-Key is required")};let hash=digest(&payload);
 let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};
 if sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))").bind(format!("{}:{}",actor.id,key)).execute(&mut *tx).await.is_err(){return unavailable()}
 match sqlx::query("SELECT payload_digest,response,response_status FROM promo_giveaway_claims WHERE actor_id=$1 AND idempotency_key=$2").bind(actor.id).bind(key).fetch_optional(&mut *tx).await {Ok(Some(r))=>{if r.get::<String,_>("payload_digest")!=hash{return error(StatusCode::CONFLICT,"Idempotency key reused with different payload")}let body:Value=r.get("response");let status=StatusCode::from_u16(r.get::<i32,_>("response_status") as u16).unwrap_or(StatusCode::OK);return (status,Json(body)).into_response()},Ok(None)=>{},Err(_)=>return unavailable()}
 let (winners,count,seed)=match draw(&state,&payload).await{Ok(v)=>v,Err(e)=>return error(StatusCode::BAD_REQUEST,&e)};let id=Uuid::new_v4();let mode=payload.participant_filter.as_deref().unwrap_or("members");let emails=payload.emails.clone().unwrap_or_default();let name=payload.name.clone().unwrap_or_else(||"Balance Giveaway".into());let note=payload.note.clone().unwrap_or_default();let (pool,min,max,wc)=(payload.total_pool.unwrap_or(0),payload.min_amount.unwrap_or(0),payload.max_amount.unwrap_or(payload.total_pool.unwrap_or(0)),payload.winner_count.unwrap_or(1));
 if sqlx::query("INSERT INTO promo_giveaways(id,created_by,name,note,participant_filter,emails,winner_count,total_pool,min_amount,max_amount,seed,participant_count,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'completed')").bind(id).bind(actor.id).bind(name).bind(note).bind(mode).bind(json!(emails)).bind(wc).bind(pool).bind(min).bind(max).bind(seed).bind(count).execute(&mut *tx).await.is_err(){return unavailable()}
 let mut output=Vec::new();for (i,w) in winners.iter().enumerate(){let r=match sqlx::query("UPDATE users SET balance=balance+$2,updated_at=now() WHERE id=$1 RETURNING balance,points").bind(w.user_id).bind(w.amount).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return unavailable()};let balance:i64=r.get("balance");let points:i64=r.get("points");let source=format!("giveaway:{id}:{}",w.user_id);if w.amount>0&&(sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,'credit',1,$3,$4)").bind(w.user_id).bind(source).bind(w.amount).bind(balance).execute(&mut *tx).await.is_err()||sqlx::query("INSERT INTO financial_audits(actor_id,action,subject_id,amount,operation_key) VALUES($1,'giveaway-credit',$2,$3,$4)").bind(actor.id).bind(w.user_id).bind(w.amount).bind(format!("giveaway:{id}:{}",w.user_id)).execute(&mut *tx).await.is_err()){return unavailable()}if sqlx::query("INSERT INTO promo_giveaway_winners(giveaway_id,user_id,amount,position,balance_after,points_after) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(w.user_id).bind(w.amount).bind(i as i64+1).bind(balance).bind(points).execute(&mut *tx).await.is_err(){return unavailable()}output.push(json!({"userId":w.user_id,"email":w.email,"name":w.name,"amount":w.amount,"balance":balance,"points":points}));}
 let response=json!({"success":true,"message":"Giveaway executed successfully","giveawayId":id,"participantCount":count,"winners":output});if sqlx::query("INSERT INTO promo_giveaway_claims(actor_id,idempotency_key,payload_digest,giveaway_id,response,response_status) VALUES($1,$2,$3,$4,$5,200)").bind(actor.id).bind(key).bind(hash).bind(id).bind(&response).execute(&mut *tx).await.is_err()||tx.commit().await.is_err(){return unavailable()}Json(response).into_response()
}
