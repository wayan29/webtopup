use axum::{extract::{Query,State},http::{header,HeaderMap,HeaderValue,StatusCode},response::{IntoResponse,Response},Json};
use serde::Serialize;
use sqlx::Row;
use std::sync::Arc;
use crate::{security::{require_proxy_context,ErrorResponse},state::AppState};
use super::{sql_sales,SalesSummaryQuery};

#[derive(Default,Serialize)]
#[serde(rename_all="camelCase")]
/// Giveaway totals are unavailable: SQL has no balance-giveaway entity, credited amount,
/// or authoritative event table; financial_checkout_effects only contains voucher/points/flash_sale.
struct PromoReportResponse { ok:bool, range:PromoRange, balance_vouchers_redeemed:PromoCountAmount, discount_vouchers_applied:PromoCountAmount, giveaways:PromoCountAmount, giveaway_data_available:bool, flash_sales_live:i64, idle_balance_vouchers:i64, open_discount_vouchers:i64 }
#[derive(Default,Serialize)]
#[serde(rename_all="camelCase")]
struct PromoRange { start:Option<String>,end:Option<String> }
#[derive(Default,Serialize)]
struct PromoCountAmount { count:Option<i64>,amount:Option<i64> }

async fn data(state:&AppState,query:&SalesSummaryQuery)->Result<PromoReportResponse,()>{
    let (start,end)=sql_sales::bounds(query).map_err(|_|())?;
    let row=sqlx::query("SELECT COUNT(*) FILTER(WHERE kind='balance' AND is_redeemed AND ($1::timestamptz IS NULL OR redeemed_at >= $1) AND ($2::timestamptz IS NULL OR redeemed_at <= $2))::bigint balance_count,COALESCE(SUM(amount) FILTER(WHERE kind='balance' AND is_redeemed AND ($1::timestamptz IS NULL OR redeemed_at >= $1) AND ($2::timestamptz IS NULL OR redeemed_at <= $2)),0)::bigint balance_amount,COUNT(*) FILTER(WHERE kind='discount' AND used_count>0)::bigint discount_count,COUNT(*) FILTER(WHERE kind='balance' AND NOT is_redeemed AND NOT is_archived AND created_at<=now()-interval '30 days')::bigint idle,COUNT(*) FILTER(WHERE kind='discount' AND NOT is_archived AND used_count<max_uses)::bigint open_discount FROM vouchers").bind(start).bind(end).fetch_one(&state.pg_pool).await.map_err(|_|())?;
    let tx=sqlx::query("SELECT COUNT(*) FILTER(WHERE discount_amount>0 AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at <= $2))::bigint count,COALESCE(SUM(discount_amount) FILTER(WHERE discount_amount>0 AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at <= $2)),0)::bigint amount FROM financial_transactions").bind(start).bind(end).fetch_one(&state.pg_pool).await.map_err(|_|())?;
    let flash_sales_live=sqlx::query_scalar::<_,i64>("SELECT COUNT(*)::bigint FROM content_flash_sales WHERE is_active AND start_date<=now() AND end_date>=now()").fetch_one(&state.pg_pool).await.map_err(|_|())?;
    Ok(PromoReportResponse{ok:true,range:PromoRange{start:query.start_date.clone(),end:query.end_date.clone()},balance_vouchers_redeemed:PromoCountAmount{count:Some(row.get("balance_count")),amount:Some(row.get("balance_amount"))},discount_vouchers_applied:PromoCountAmount{count:Some(tx.get("count")),amount:Some(tx.get("amount"))},giveaways:PromoCountAmount{count:None,amount:None},giveaway_data_available:false,flash_sales_live,idle_balance_vouchers:row.get("idle"),open_discount_vouchers:row.get("open_discount")})
}

pub async fn promo_summary(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Query(query):Query<SalesSummaryQuery>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}
    match data(&state,&query).await{Ok(report)=>Json(report).into_response(),Err(())=>(StatusCode::SERVICE_UNAVAILABLE,Json(ErrorResponse{message:"SQL promo report store is unavailable"})).into_response()}
}
pub async fn promo_export(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Query(query):Query<SalesSummaryQuery>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}
    let report=match data(&state,&query).await{Ok(value)=>value,Err(())=>return (StatusCode::SERVICE_UNAVAILABLE,Json(ErrorResponse{message:"SQL promo report store is unavailable"})).into_response()};
    let start=query.start_date.unwrap_or_default();let end=query.end_date.unwrap_or_default();
    let rows=[("Voucher saldo ditukar",report.balance_vouchers_redeemed.count,report.balance_vouchers_redeemed.amount),("Diskon checkout",report.discount_vouchers_applied.count,report.discount_vouchers_applied.amount),("Giveaway dikredit",report.giveaways.count,report.giveaways.amount),("Flash sale live",Some(report.flash_sales_live),Some(0)),("Voucher saldo idle >30 hari",Some(report.idle_balance_vouchers),Some(0)),("Diskon masih ada slot",Some(report.open_discount_vouchers),Some(0))];
    let mut csv=String::from("\"Metrik\",\"Jumlah\",\"Nominal\",\"Data tersedia\",\"Dari\",\"Sampai\"\n");for (label,count,amount) in rows{csv.push_str(&format!("\"{label}\",\"{}\",\"{}\",\"{}\",\"{start}\",\"{end}\"\n",count.map(|v|v.to_string()).unwrap_or_default(),amount.map(|v|v.to_string()).unwrap_or_default(),if label=="Giveaway dikredit"{"false"}else{"true"}));}
    let mut headers=HeaderMap::new();headers.insert(header::CONTENT_TYPE,HeaderValue::from_static("text/csv; charset=utf-8"));headers.insert(header::CONTENT_DISPOSITION,HeaderValue::from_static("attachment; filename=\"promo-report.csv\""));(StatusCode::OK,headers,format!("\u{FEFF}{csv}")).into_response()
}
