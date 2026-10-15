use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sqlx::Row;

use crate::{
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
};

mod sql_sales;
mod promo;
mod types;
pub use promo::{promo_export, promo_summary};
mod dates;
use dates::jakarta_today_key;
use chrono::Datelike;
pub use types::SalesSummaryQuery;
use types::*;

pub async fn sales_summary(headers: HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<SalesSummaryQuery>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let (start,end)=match sql_sales::bounds(&query) { Ok(value)=>value, Err(message)=>return status_message(StatusCode::BAD_REQUEST,message) };
    match sql_sales::payload(&state.pg_pool,start,end).await { Ok(payload)=>Json(payload).into_response(), Err(_)=>unavailable() }
}
pub async fn dashboard_overview(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<SalesSummaryQuery>,
) -> Response {

    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let (start,end)=match sql_sales::bounds(&query) { Ok(value)=>value, Err(message)=>return status_message(StatusCode::BAD_REQUEST,message) };
    let report=match sql_sales::payload(&state.pg_pool,start,end).await { Ok(value)=>value, Err(_)=>return unavailable() };
    let now=chrono::Utc::now();
    let (quick_stats,revenue_breakdown)=sql_dashboard_totals(&state.pg_pool,now).await;
    let queue=sqlx::query("SELECT COUNT(*) FILTER(WHERE delivered_at IS NULL)::bigint pending,COUNT(*) FILTER(WHERE delivered_at IS NULL AND next_retry_at<=now())::bigint due,COUNT(*) FILTER(WHERE delivered_at IS NULL AND attempt_count>=5)::bigint high_attempt,COUNT(*) FILTER(WHERE status='success')::bigint success_count,COUNT(*) FILTER(WHERE status='failed')::bigint failed_count,COALESCE((SELECT last_error FROM seller_callbacks WHERE last_error<>'' ORDER BY next_retry_at DESC NULLS LAST LIMIT 1),'') last_error FROM seller_callbacks").fetch_one(&state.pg_pool).await;
    let (pending,due,high_attempt,success_count,failed_count,last_error)=match queue { Ok(row)=>(row.get::<i64,_>("pending"),row.get::<i64,_>("due"),row.get::<i64,_>("high_attempt"),row.get::<i64,_>("success_count"),row.get::<i64,_>("failed_count"),row.get::<String,_>("last_error")),Err(_)=>(0,0,0,0,0,String::new()) };
    let seller_callback_queue=SellerCallbackQueue{pending,due,high_attempt,high_attempt_threshold:5,scheduler_health:RetryQueueHealth{status:"available".into(),source:"sql".into(),last_run_at:None,processed:success_count+failed_count,success_count,failed_count,remaining_due:due,last_error}};
    Json(DashboardOverviewResponse { summary:report.summary,category_data:report.category_data,daily_data:report.daily_data,recent_transactions:report.recent_transactions,quick_stats,revenue_breakdown,seller_callback_queue,last_updated_at:now.to_rfc3339() }).into_response()
}
async fn sql_dashboard_totals(pool:&sqlx::PgPool, now:chrono::DateTime<chrono::Utc>)->(QuickStats,RevenueBreakdown) {
    let jakarta=now.with_timezone(&chrono::FixedOffset::east_opt(7*3600).expect("valid Jakarta offset"));
    let today=jakarta.date_naive(); let yesterday=today-chrono::Duration::days(1); let month=today.with_day(1).unwrap_or(today); let last_month=month-chrono::Duration::days(1); let last_month_start=last_month.with_day(1).unwrap_or(last_month);
    let utc_midnight=|day:chrono::NaiveDate| day.and_hms_opt(0,0,0).unwrap().and_utc()-chrono::Duration::hours(7);
    let row=sqlx::query("SELECT COUNT(*) FILTER(WHERE status='success' AND created_at >= $1 AND created_at < $2)::bigint today,COUNT(*) FILTER(WHERE status='success' AND created_at >= $3 AND created_at < $1)::bigint yesterday,COUNT(*) FILTER(WHERE status='success' AND created_at >= $4 AND created_at < $2)::bigint this_month,COUNT(*) FILTER(WHERE status='success' AND created_at >= $5 AND created_at < $4)::bigint last_month,COALESCE(SUM(amount) FILTER(WHERE status='success' AND created_at >= $1 AND created_at < $2),0)::bigint today_omset,COALESCE(SUM(amount) FILTER(WHERE status='success' AND created_at >= $3 AND created_at < $1),0)::bigint yesterday_omset,COALESCE(SUM(amount) FILTER(WHERE status='success' AND created_at >= $4 AND created_at < $2),0)::bigint month_omset,COALESCE(SUM(amount) FILTER(WHERE status='success' AND created_at >= $5 AND created_at < $4),0)::bigint last_month_omset,COALESCE(SUM(amount-COALESCE(NULLIF(snapshot #>> '{product,costPrice}','')::bigint,NULLIF(snapshot #>> '{product,cost_price}','')::bigint,0)) FILTER(WHERE status='success' AND created_at >= $1 AND created_at < $2),0)::bigint today_profit,COALESCE(SUM(amount-COALESCE(NULLIF(snapshot #>> '{product,costPrice}','')::bigint,NULLIF(snapshot #>> '{product,cost_price}','')::bigint,0)) FILTER(WHERE status='success' AND created_at >= $3 AND created_at < $1),0)::bigint yesterday_profit,COALESCE(SUM(amount-COALESCE(NULLIF(snapshot #>> '{product,costPrice}','')::bigint,NULLIF(snapshot #>> '{product,cost_price}','')::bigint,0)) FILTER(WHERE status='success' AND created_at >= $4 AND created_at < $2),0)::bigint month_profit,COALESCE(SUM(amount-COALESCE(NULLIF(snapshot #>> '{product,costPrice}','')::bigint,NULLIF(snapshot #>> '{product,cost_price}','')::bigint,0)) FILTER(WHERE status='success' AND created_at >= $5 AND created_at < $4),0)::bigint last_month_profit FROM financial_transactions").bind(utc_midnight(today)).bind(utc_midnight(today+chrono::Duration::days(1))).bind(utc_midnight(yesterday)).bind(utc_midnight(month)).bind(utc_midnight(last_month_start)).fetch_one(pool).await;
    let Ok(r)=row else{return (QuickStats::default(),RevenueBreakdown::default())};
    (QuickStats{today:r.get("today"),yesterday:r.get("yesterday"),this_month:r.get("this_month"),last_month:r.get("last_month")},RevenueBreakdown{today:RevenuePoint{omset:r.get("today_omset"),profit:r.get("today_profit")},yesterday:RevenuePoint{omset:r.get("yesterday_omset"),profit:r.get("yesterday_profit")},this_month:RevenuePoint{omset:r.get("month_omset"),profit:r.get("month_profit")},last_month:RevenuePoint{omset:r.get("last_month_omset"),profit:r.get("last_month_profit")}})
}

pub async fn export_sales_report(headers: HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<SalesSummaryQuery>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let user = match crate::security::require_sql_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(error) = crate::sql_auth::verify_step_up(&headers, &state, &user, "exports.sensitive", chrono::Utc::now()) {
        return error.into_response();
    }
    let (start,end)=match sql_sales::bounds(&query) { Ok(value)=>value, Err(message)=>return status_message(StatusCode::BAD_REQUEST,message) };
    let rows=match sqlx::query("SELECT t.id,t.created_at,p.name product,p.category,COALESCE(u.name,'') username,t.target,t.amount,t.status,COALESCE(NULLIF(t.snapshot #>> '{product,costPrice}','')::bigint,NULLIF(t.snapshot #>> '{product,cost_price}','')::bigint,p.cost_price::bigint,0) cost_price,p.vendor_name vendor FROM financial_transactions t LEFT JOIN products p ON p.id=t.product_id LEFT JOIN users u ON u.id=t.user_id WHERE t.status='success' AND ($1::timestamptz IS NULL OR t.created_at >= $1) AND ($2::timestamptz IS NULL OR t.created_at <= $2) ORDER BY t.created_at DESC LIMIT 5000").bind(start).bind(end).fetch_all(&state.pg_pool).await { Ok(rows)=>rows, Err(_)=>return unavailable() };
    let mut csv=String::from("Internal ID,Tanggal,Produk,Kategori,User,Target,Omset,Modal,Profit,Vendor,Status\n");
    for row in rows { let fields=[row.get::<uuid::Uuid,_>("id").to_string(),row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),row.get::<Option<String>,_>("product").unwrap_or_default(),row.get::<Option<String>,_>("category").unwrap_or_default(),row.get("username"),row.get("target"),row.get::<i64,_>("amount").to_string(),row.get::<i64,_>("cost_price").to_string(),(row.get::<i64,_>("amount")-row.get::<i64,_>("cost_price")).to_string(),row.get("vendor"),row.get("status")]; csv.push_str(&fields.iter().map(|v|format!("\"{}\"",v.replace('"',"\"\""))).collect::<Vec<_>>().join(",")); csv.push('\n'); }
    let filename=format!("sales-report-{}.csv",jakarta_today_key()); let mut response_headers=HeaderMap::new(); response_headers.insert(header::CONTENT_TYPE,HeaderValue::from_static("text/csv; charset=utf-8")); if let Ok(value)=HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")){response_headers.insert(header::CONTENT_DISPOSITION,value);}
    (StatusCode::OK,response_headers,format!("\u{FEFF}{csv}")).into_response()
}


fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(ErrorResponse { message: "PostgreSQL report store is unavailable" })).into_response()
}
pub async fn sql_report_summary(Query(query): Query<std::collections::HashMap<String, String>>) -> Response {
    let Some(day) = query.get("date").and_then(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()) else { return status_message(StatusCode::BAD_REQUEST, "Report date is required"); };
    let Ok(store) = sql_report_store().await else { return status_message(StatusCode::SERVICE_UNAVAILABLE, "SQL report store is unavailable"); };
    match store.report_summary(day).await {
        Ok((omzet, balance, points, success_count, failed_count)) => {
            let status = if success_count == 0 && failed_count == 0 { "empty" } else { "available" };
            if store.save_report_snapshot(day, (omzet, balance, points, success_count, failed_count)).await.is_err() {
                return Json(serde_json::json!({"date": day.to_string(), "omzet": omzet, "balance": balance, "points": points, "successCount": success_count, "failedCount": failed_count, "status": "partial"})).into_response();
            }
            Json(serde_json::json!({"date": day.to_string(), "omzet": omzet, "balance": balance, "points": points, "successCount": success_count, "failedCount": failed_count, "status": status})).into_response()
        }
        Err(_) => status_message(StatusCode::SERVICE_UNAVAILABLE, "SQL report store is unavailable"),
    }
}

async fn sql_report_store() -> Result<crate::wallet_store::WalletStore, ()> {
    let Ok(url) = std::env::var("DATABASE_URL") else { return Err(()); };
    crate::wallet_store::WalletStore::connect(&url).await.map_err(|_| ())
}

fn status_message(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

