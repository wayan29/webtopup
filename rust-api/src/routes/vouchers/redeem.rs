use std::sync::Arc;
use axum::{extract::State,response::{IntoResponse,Response},Json};
use sqlx::Row;
use super::{internal_error,status_message,types::*,validation::normalize_voucher_code};
use crate::{security::require_sql_user,state::AppState};

pub async fn redeem(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<VoucherRedeemPayload>)->Response {
 let user=match require_sql_user(&headers,&state).await {Ok(v)=>v,Err(r)=>return r};
 let code=match normalize_voucher_code(payload.code){Ok(v) if !v.is_empty()=>v,Ok(_)=>return status_message(axum::http::StatusCode::BAD_REQUEST,"Kode voucher wajib diisi"),Err(r)=>return r};
 let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return internal_error()};
 let voucher=match sqlx::query("SELECT id,kind,amount,is_redeemed,is_archived FROM vouchers WHERE code=$1 FOR UPDATE").bind(&code).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return status_message(axum::http::StatusCode::BAD_REQUEST,"Kode voucher tidak valid atau sudah tidak bisa diredeem"),Err(_)=>return internal_error()};
 if voucher.get::<bool,_>("is_redeemed")||voucher.get::<bool,_>("is_archived"){return status_message(axum::http::StatusCode::BAD_REQUEST,"Kode voucher tidak valid atau sudah tidak bisa diredeem")}
 if voucher.get::<String,_>("kind")=="discount" {return status_message(axum::http::StatusCode::BAD_REQUEST,"Kode ini adalah voucher diskon — pakai di halaman order, bukan redeem saldo")}
 let id:uuid::Uuid=voucher.get("id"); let amount:i64=voucher.get("amount");
 let balance=match sqlx::query_scalar::<_,i64>("UPDATE users SET balance=balance+$2,updated_at=now() WHERE id=$1 RETURNING balance").bind(user.id).bind(amount).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return status_message(axum::http::StatusCode::NOT_FOUND,"User tidak ditemukan"),Err(_)=>return internal_error()};
 if sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,'credit',1,$3,$4)").bind(user.id).bind(format!("voucher:{id}")).bind(amount).bind(balance).execute(&mut *tx).await.is_err(){return internal_error()}
 if sqlx::query("UPDATE vouchers SET is_redeemed=true,redeemed_by=$2,redeemed_at=now(),updated_at=now(),redeemed_balance_before=$3,redeemed_balance_after=$4 WHERE id=$1").bind(id).bind(user.id).bind(balance-amount).bind(balance).execute(&mut *tx).await.is_err(){return internal_error()}
 if tx.commit().await.is_err(){return internal_error()}
 Json(VoucherRedeemResponse{message:"Voucher berhasil diredeem",code,amount,new_balance:balance}).into_response()
}
