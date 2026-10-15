use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde_json::Value;
use sqlx::{PgPool, Row};

use crate::{
    security::{require_proxy_context, require_sql_user, ErrorResponse, ProxyContextResponse},
    sql_auth::verify_step_up,
    state::AppState,
};

use super::{
    config::{digiflazz_credentials, has_any_non_empty_value, tokovoucher_credentials, vendor_base_url},
    internal_error,
    providers::{fetch_digiflazz_balance_with_base_url, fetch_tokovoucher_balance_with_base_url},
    types::{
        SellerHealthSummary, TransactionStats, VendorHealthIssue,
        VendorHealthSnapshotResponse, VendorRealtimeHealthItem, VendorRealtimeHealthResponse,
        VendorSnapshot, VendorSnapshotTotals, VendorStatsResponse, WebhookStats,
    },
};

pub async fn vendor_health_snapshot(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) { Ok(context) => context, Err(response) => return response };
    let vendor_rows = match sqlx::query("SELECT id::text AS id,name,config,status,low_balance_threshold FROM vendors ORDER BY created_at DESC,id")
        .fetch_all(&state.pg_pool).await { Ok(rows) => rows, Err(_) => return vendor_health_snapshot_failure(proxy_context.into_response()) };
    let vendor_docs = vendor_rows.into_iter().map(|row| serde_json::json!({
        "id":row.try_get::<String,_>("id").unwrap_or_default(), "name":row.try_get::<String,_>("name").unwrap_or_default(),
        "config":row.try_get::<Value,_>("config").unwrap_or_default(), "status":row.try_get::<bool,_>("status").unwrap_or(true),
        "lowBalanceThreshold":row.try_get::<i64,_>("low_balance_threshold").unwrap_or_default()
    })).collect::<Vec<_>>();
    let (tx_stats, issues) = match transaction_stats_today(&state.pg_pool).await {
        Ok(stats) => (stats, Vec::new()),
        Err(_) => (HashMap::new(), vec![VendorHealthIssue::new("TRANSACTION_STATS_UNAVAILABLE", "postgres.financial_transactions")]),
    };
    let mut vendors: Vec<VendorSnapshot> = vendor_docs.iter().map(|vendor| build_vendor_snapshot(vendor, &tx_stats)).collect();
    vendors.sort_by(|left,right| left.label.cmp(&right.label));
    let totals = vendors.iter().fold(VendorSnapshotTotals { vendors: vendors.len(), ..VendorSnapshotTotals::default() }, |mut totals,vendor| {
        match vendor.health { "healthy"=>totals.healthy+=1,"warning"=>totals.warning+=1,"critical"=>totals.critical+=1,_=>{} }
        totals.transactions_today += vendor.transactions_today.total; totals
    });
    let (status,ok,partial)=snapshot_response_status(true,&issues);
    snapshot_response(status,ok,partial,issues,Utc::now().timestamp().to_string(),vendors,totals,proxy_context.into_response())
}
fn snapshot_response_status(
    core_available: bool,
    issues: &[VendorHealthIssue],
) -> (StatusCode, bool, bool) {
    if !core_available {
        return (StatusCode::SERVICE_UNAVAILABLE, false, false);
    }
    let partial = !issues.is_empty();
    (StatusCode::OK, true, partial)
}

#[allow(clippy::type_complexity)]
fn snapshot_response(
    status: StatusCode,
    ok: bool,
    partial: bool,
    issues: Vec<VendorHealthIssue>,
    generated_at: String,
    vendors: Vec<VendorSnapshot>,
    totals: VendorSnapshotTotals,
    user: Option<ProxyContextResponse>,
) -> Response {
    (
        status,
        Json(VendorHealthSnapshotResponse {
            ok,
            partial,
            issues,
            service: "webtopup-api-v2",
            api_prefix: "/v2",
            generated_at,
            source: "postgres-snapshot",
            user,
            vendors,
            totals,
        }),
    )
        .into_response()
}

fn vendor_health_snapshot_failure(user: Option<ProxyContextResponse>) -> Response {
    let (status, ok, partial) = snapshot_response_status(false, &[]);
    snapshot_response(
        status,
        ok,
        partial,
        vec![VendorHealthIssue::new("VENDOR_COLLECTION_UNAVAILABLE", "postgres.vendors")],
        Utc::now().timestamp().to_string(),
        Vec::new(),
        VendorSnapshotTotals::default(),
        user,
    )
}

pub async fn vendor_health(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let mut payload = match build_vendor_realtime_payload(&state.pg_pool).await { Ok(payload)=>payload, Err(_)=>return sql_unavailable() };
    let persistence=persist_vendor_health_snapshot(&state.pg_pool,&payload).await;
    let (partial,persisted,issues)=apply_persistence_outcome(persistence.is_ok(),payload.issues.clone());
    if persistence.is_err() { tracing::warn!(code="SNAPSHOT_PERSISTENCE_FAILED",source="postgres.vendor_health_snapshots","vendor health snapshot persistence failed"); }
    payload.partial=partial; payload.snapshot_persisted=persisted; payload.issues=issues;
    Json(payload).into_response()
}

pub async fn export_vendor_health_csv(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers,&state) { return response; }
    let actor = match require_sql_user(&headers, &state).await { Ok(actor) => actor, Err(response) => return response };
    if let Err(error) = verify_step_up(&headers, &state, &actor, "exports.sensitive", Utc::now()) { return error.into_response(); }
    let mut payload=match build_vendor_realtime_payload(&state.pg_pool).await { Ok(payload)=>payload, Err(_)=>return sql_unavailable() };
    let persistence=persist_vendor_health_snapshot(&state.pg_pool,&payload).await;
    let (partial,persisted,issues)=apply_persistence_outcome(persistence.is_ok(),payload.issues.clone());
    if persistence.is_err() { tracing::warn!(code="SNAPSHOT_PERSISTENCE_FAILED",source="postgres.vendor_health_snapshots","vendor health snapshot persistence failed"); }
    payload.partial=partial; payload.snapshot_persisted=persisted; payload.issues=issues;
    let Ok(value)=serde_json::to_value(&payload) else { return internal_error() };
    let csv=build_vendor_health_csv(&value);
    let filename=format!("vendor-health-{}.csv",Utc::now().format("%Y-%m-%d"));
    let mut response_headers=HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE,HeaderValue::from_static("text/csv; charset=utf-8"));
    if let Ok(value)=HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) { response_headers.insert(header::CONTENT_DISPOSITION,value); }
    (StatusCode::OK,response_headers,format!("\u{FEFF}{csv}")).into_response()
}

pub async fn vendor_stats(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Err(response)=require_proxy_context(&headers,&state) { return response; }
    let Ok(id)=id.parse::<uuid::Uuid>() else { return (StatusCode::NOT_FOUND,Json(ErrorResponse{message:"Vendor not found"})).into_response() };
    let vendor=match sqlx::query("SELECT name,status FROM vendors WHERE id=$1").bind(id).fetch_optional(&state.pg_pool).await {
        Ok(Some(row))=>row, _=>return (StatusCode::NOT_FOUND,Json(ErrorResponse{message:"Vendor not found"})).into_response()
    };
    let vendor_name=vendor.try_get::<String,_>("name").unwrap_or_default();
    let (total_products,active_products)=match sqlx::query_as::<_,(i64,i64)>("SELECT count(*),count(*) FILTER (WHERE status) FROM products WHERE vendor_name=$1").bind(&vendor_name).fetch_one(&state.pg_pool).await {
        Ok(counts)=>counts,Err(_)=>return internal_error()
    };
    let mut categories=match sqlx::query_scalar::<_,String>("SELECT DISTINCT category FROM products WHERE vendor_name=$1 ORDER BY category").bind(&vendor_name).fetch_all(&state.pg_pool).await {Ok(rows)=>rows,Err(_)=>return internal_error()};
    categories.sort();
    Json(VendorStatsResponse{vendor_name,total_products,active_products,categories,status:vendor.try_get("status").unwrap_or(true)}).into_response()
}
fn sql_unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(ErrorResponse { message: "Database unavailable" })).into_response()
}

pub(super) async fn transaction_stats_today(pool: &PgPool) -> Result<HashMap<String, TransactionStats>, sqlx::Error> {
    let today = Utc::now().date_naive().and_hms_opt(0,0,0).expect("midnight").and_utc();
    let rows = sqlx::query("SELECT COALESCE(NULLIF(snapshot #>> '{product,vendorName}',''), 'Unknown') AS vendor, count(*) AS total, count(*) FILTER (WHERE status='success') AS success, count(*) FILTER (WHERE status='failed') AS failed, count(*) FILTER (WHERE status IN ('pending','processing')) AS pending, COALESCE(sum(amount),0) AS amount_total FROM financial_transactions WHERE created_at >= $1 GROUP BY 1")
        .bind(today).fetch_all(pool).await?;
    let mut stats=HashMap::new();
    for row in rows {
        let key=row.try_get::<String,_>("vendor")?.to_lowercase();
        let total=row.try_get::<i64,_>("total")?;
        let success=row.try_get::<i64,_>("success")?;
        stats.insert(key,TransactionStats { total, success, failed:row.try_get("failed")?, pending:row.try_get("pending")?, success_rate:if total>0 { ((success as f64/total as f64)*100.0).round() as i64 } else {0}, amount_total:row.try_get("amount_total")? });
    }
    Ok(stats)
}

async fn load_vendor_health_documents(pool: &PgPool) -> Result<(Option<Value>, Option<Value>), sqlx::Error> {
    let rows=sqlx::query("SELECT id::text AS id,name,api_base_url,config,low_balance_threshold,status FROM vendors WHERE lower(name) LIKE '%digiflazz%' OR lower(name) LIKE '%tokovoucher%' ORDER BY id").fetch_all(pool).await?;
    let mut digiflazz=None; let mut tokovoucher=None;
    for row in rows {
        let name=row.try_get::<String,_>("name")?;
        let vendor=serde_json::json!({"id":row.try_get::<String,_>("id")?,"name":name,"apiBaseUrl":row.try_get::<String,_>("api_base_url")?,"config":row.try_get::<Value,_>("config")?,"lowBalanceThreshold":row.try_get::<i64,_>("low_balance_threshold")?,"status":row.try_get::<bool,_>("status")?});
        if name.to_lowercase().contains("digiflazz") { digiflazz=Some(vendor); } else if name.to_lowercase().contains("tokovoucher") { tokovoucher=Some(vendor); }
    }
    Ok((digiflazz,tokovoucher))
}

fn realtime_issue_set(
    transaction_stats_available: bool,
    webhook_stats_available: bool,
    last_webhook_available: bool,
    seller_available: bool,
    digiflazz_balance_available: bool,
    tokovoucher_balance_available: bool,
) -> Vec<VendorHealthIssue> {
    let mut issues = Vec::new();
    if !transaction_stats_available {
        issues.push(VendorHealthIssue::new(
            "TRANSACTION_STATS_UNAVAILABLE",
            "postgres.financial_transactions",
        ));
    }
    if !webhook_stats_available {
        issues.push(VendorHealthIssue::new(
            "WEBHOOK_STATS_UNAVAILABLE",
            "postgres.webhook_event_logs",
        ));
    }
    if !last_webhook_available {
        issues.push(VendorHealthIssue::new(
            "LAST_WEBHOOK_UNAVAILABLE",
            "postgres.webhook_event_logs",
        ));
    }
    if !seller_available {
        issues.push(VendorHealthIssue::new(
            "SELLER_SUMMARY_UNAVAILABLE",
            "postgres.seller_orders",
        ));
    }
    if !digiflazz_balance_available {
        issues.push(VendorHealthIssue::new(
            "DIGIFLAZZ_BALANCE_UNAVAILABLE",
            "provider.digiflazz",
        ));
    }
    if !tokovoucher_balance_available {
        issues.push(VendorHealthIssue::new(
            "TOKOVOUCHER_BALANCE_UNAVAILABLE",
            "provider.tokovoucher",
        ));
    }
    issues
}

fn apply_persistence_outcome(
    persisted: bool,
    mut issues: Vec<VendorHealthIssue>,
) -> (bool, bool, Vec<VendorHealthIssue>) {
    if !persisted {
        issues.insert(
            0,
            VendorHealthIssue::new("SNAPSHOT_PERSISTENCE_FAILED", "postgres.vendor_health_snapshots"),
        );
    }
    let partial = !issues.is_empty();
    (partial, persisted, issues)
}

pub(super) async fn build_vendor_realtime_payload(pool: &PgPool) -> Result<VendorRealtimeHealthResponse, sqlx::Error> {
    let (digiflazz_vendor,tokovoucher_vendor)=load_vendor_health_documents(pool).await?;
    let (tx_stats,tx_available)=match transaction_stats_today(pool).await {Ok(v)=>(v,true),Err(_)=>(HashMap::new(),false)};
    let (webhook_stats,webhook_available)=match webhook_stats_today(pool).await {Ok(v)=>(v,true),Err(_)=>(HashMap::new(),false)};
    let (last_webhooks,last_webhook_available)=match last_webhook_stats(pool).await {Ok(v)=>(v,true),Err(_)=>(HashMap::new(),false)};
    let (seller,seller_available)=match seller_health_summary(pool).await {Ok(v)=>(v,true),Err(_)=>(SellerHealthSummary::default(),false)};
    let digiflazz_balance=digiflazz_health_balance(digiflazz_vendor.as_ref()).await;
    let tokovoucher_balance=tokovoucher_health_balance(tokovoucher_vendor.as_ref()).await;
    let issues=realtime_issue_set(tx_available,webhook_available,last_webhook_available,seller_available,digiflazz_balance.as_ref().map(|x|x.0).unwrap_or(true),tokovoucher_balance.as_ref().map(|x|x.0).unwrap_or(true));
    let vendors=vec![build_realtime_vendor_health("digiflazz","Digiflazz",digiflazz_vendor.as_ref(),digiflazz_balance,&tx_stats,&webhook_stats,&last_webhooks),build_realtime_vendor_health("tokovoucher","Tokovoucher",tokovoucher_vendor.as_ref(),tokovoucher_balance,&tx_stats,&webhook_stats,&last_webhooks)];
    Ok(VendorRealtimeHealthResponse { ok:true,partial:!issues.is_empty(),issues,snapshot_persisted:false,generated_at:Utc::now().to_rfc3339(),vendors,seller })
}

fn balance_probe_allowed(vendor: Option<&Value>, configured: bool) -> bool { configured && vendor.and_then(|v|v.get("status")).and_then(Value::as_bool).unwrap_or(true) }
async fn digiflazz_health_balance(vendor: Option<&Value>) -> Option<(bool,Value,String)> {
    let credentials=digiflazz_credentials(vendor); let configured=!credentials.username.is_empty()&&!credentials.secret.is_empty(); if !balance_probe_allowed(vendor,configured){return None;}
    let base=vendor.map(|v|vendor_base_url(v,"https://api.digiflazz.com/v1")).unwrap_or_else(||"https://api.digiflazz.com/v1".to_string());
    match fetch_digiflazz_balance_with_base_url(&credentials,&base).await {Ok(v)=>Some((true,v,"OK".to_string())),Err(_)=>Some((false,Value::Null,"Pemeriksaan saldo tidak tersedia".to_string()))}
}
async fn tokovoucher_health_balance(vendor: Option<&Value>) -> Option<(bool,Value,String)> {
    let credentials=tokovoucher_credentials(vendor); let configured=!credentials.username.is_empty()&&!credentials.secret.is_empty(); if !balance_probe_allowed(vendor,configured){return None;}
    let base=vendor.map(|v|vendor_base_url(v,"https://api.tokovoucher.net")).unwrap_or_else(||"https://api.tokovoucher.net".to_string());
    match fetch_tokovoucher_balance_with_base_url(&credentials,&base).await {Ok(v)=>Some((true,v,"OK".to_string())),Err(_)=>Some((false,Value::Null,"Pemeriksaan saldo tidak tersedia".to_string()))}
}
async fn persist_vendor_health_snapshot(pool: &PgPool,payload: &VendorRealtimeHealthResponse) -> Result<(),sqlx::Error> {
    let value=serde_json::to_value(payload).map_err(|error|sqlx::Error::Protocol(error.to_string()))?;
    sqlx::query("INSERT INTO vendor_health_snapshots(key,value) VALUES ('vendorHealthSnapshot',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()")
        .bind(value).execute(pool).await?; Ok(())
}

fn build_realtime_vendor_health(key:&str,label:&str,vendor:Option<&Value>,balance_result:Option<(bool,Value,String)>,tx_stats:&HashMap<String,TransactionStats>,webhook_stats:&HashMap<String,WebhookStats>,last_webhooks:&HashMap<String,WebhookStats>)->VendorRealtimeHealthItem {
    let config=vendor.and_then(|v|v.get("config"));
    let configured=match key {"digiflazz"=>{let c=digiflazz_credentials(vendor);!c.username.is_empty()&&!c.secret.is_empty()},"tokovoucher"=>{let c=tokovoucher_credentials(vendor);!c.username.is_empty()&&!c.secret.is_empty()},_=>config.map(has_any_non_empty_value).unwrap_or(false)};
    let active=vendor.and_then(|v|v.get("status")).and_then(Value::as_bool).unwrap_or(true);
    let low_balance_threshold=vendor.and_then(|v|v.get("lowBalanceThreshold")).and_then(Value::as_i64).unwrap_or(0);
    let (balance_ok,balance,balance_message)=balance_result.unwrap_or((false,Value::Null,"Credentials belum dikonfigurasi".to_string()));
    let balance_number=json_i64(&balance);let low_balance=balance_ok&&low_balance_threshold>0&&balance_number<=low_balance_threshold;
    let transactions_today=tx_stats.iter().find(|(name,_)|name.contains(key)).map(|(_,v)|v.clone()).unwrap_or_default();
    let mut webhook_today=webhook_stats.get(key).cloned().unwrap_or_default();
    if let Some(last)=last_webhooks.get(key){webhook_today.last_at=last.last_at.clone();webhook_today.last_status=last.last_status.clone();webhook_today.last_message=last.last_message.clone();}
    let health=resolve_realtime_health(configured,active,balance_ok,low_balance,transactions_today.pending,transactions_today.failed,webhook_today.rejected);
    VendorRealtimeHealthItem{key:key.to_string(),label:label.to_string(),configured,active,balance,balance_ok,low_balance_threshold,low_balance,balance_message,health,transactions_today,webhook_today}
}

fn resolve_realtime_health(
    configured: bool,
    active: bool,
    balance_ok: bool,
    low_balance: bool,
    pending_count: i64,
    failed_count: i64,
    rejected_webhook_count: i64,
) -> &'static str {
    if !active {
        "disabled"
    } else if !configured || !balance_ok || failed_count > 5 || rejected_webhook_count > 0 {
        "critical"
    } else if low_balance || pending_count > 10 || failed_count > 0 {
        "warning"
    } else {
        "healthy"
    }
}

async fn webhook_stats_today(pool:&PgPool)->Result<HashMap<String,WebhookStats>,sqlx::Error>{
    let today=Utc::now().date_naive().and_hms_opt(0,0,0).expect("midnight").and_utc();
    let rows=sqlx::query("SELECT provider,count(*) AS total,count(*) FILTER(WHERE status='rejected') AS rejected,count(*) FILTER(WHERE status IN ('failed','error')) AS failed,count(*) FILTER(WHERE verified) AS delivered FROM webhook_event_logs WHERE created_at >= $1 GROUP BY provider").bind(today).fetch_all(pool).await?;
    let mut out=HashMap::new();for r in rows{out.insert(r.try_get::<String,_>("provider")?,WebhookStats{total:r.try_get("total")?,rejected:r.try_get("rejected")?,failed:r.try_get("failed")?,delivered:r.try_get("delivered")?,..Default::default()});}Ok(out)
}
async fn last_webhook_stats(pool:&PgPool)->Result<HashMap<String,WebhookStats>,sqlx::Error>{
    let rows=sqlx::query("SELECT DISTINCT ON(provider) provider,created_at,status,message FROM webhook_event_logs ORDER BY provider,created_at DESC,id DESC").fetch_all(pool).await?;
    let mut out=HashMap::new();for r in rows{out.insert(r.try_get::<String,_>("provider")?,WebhookStats{last_at:Some(r.try_get::<chrono::DateTime<Utc>,_>("created_at")?.to_rfc3339()),last_status:r.try_get("status")?,last_message:r.try_get("message")?,..Default::default()});}Ok(out)
}
async fn seller_health_summary(pool:&PgPool)->Result<SellerHealthSummary,sqlx::Error>{
    let r=sqlx::query("SELECT count(*) AS total,count(*) FILTER(WHERE o.status='pending') AS pending,count(*) FILTER(WHERE o.status='failed') AS failed,count(*) FILTER(WHERE c.delivered_at IS NULL AND c.ref_id IS NOT NULL) AS callback_pending,count(*) FILTER(WHERE c.delivered_at IS NOT NULL) AS callback_delivered FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.channel='digiflazz'").fetch_one(pool).await?;
    let callback_pending=r.try_get::<i64,_>("callback_pending")?;let failed=r.try_get::<i64,_>("failed")?;
    Ok(SellerHealthSummary{total:r.try_get("total")?,pending:r.try_get("pending")?,failed,callback_pending,callback_delivered:r.try_get("callback_delivered")?,health:if callback_pending>0||failed>5{"warning"}else{"healthy"}})
}

pub(super) fn build_vendor_health_csv(payload: &Value) -> String {
    let header = vec![
        "Vendor",
        "Health",
        "Configured",
        "Active",
        "Balance",
        "Balance OK",
        "Low Balance Threshold",
        "Low Balance",
        "Balance Message",
        "Transactions Today",
        "Success Today",
        "Failed Today",
        "Pending Today",
        "Success Rate",
        "Amount Total",
        "Webhook Total",
        "Webhook Rejected",
        "Webhook Failed",
        "Webhook Delivered",
        "Last Webhook At",
        "Last Webhook Status",
        "Last Webhook Message",
        "Partial",
        "Snapshot Persisted",
        "Issue Codes",
        "Generated At",
    ];
    let generated_at = payload
        .get("generatedAt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let partial = yes_no(json_bool(payload, "partial"));
    let snapshot_persisted = yes_no(json_bool(payload, "snapshotPersisted"));
    let issue_codes = payload
        .get("issues")
        .and_then(Value::as_array)
        .map(|issues| {
            issues
                .iter()
                .filter_map(|issue| issue.get("code").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(";")
        })
        .unwrap_or_default();
    let mut rows = vec![header
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()];
    let vendors = payload.get("vendors").and_then(Value::as_array);
    let vendor_rows = vendors.map(|vendors| {
        vendors
            .iter()
            .map(|vendor| {
                vec![
                    json_string(vendor, "label"),
                    json_string(vendor, "health"),
                    yes_no(json_bool(vendor, "configured")),
                    yes_no(json_bool(vendor, "active")),
                    json_value_string(vendor.get("balance")),
                    yes_no(json_bool(vendor, "balanceOk")),
                    json_value_string(vendor.get("lowBalanceThreshold")),
                    yes_no(json_bool(vendor, "lowBalance")),
                    json_string(vendor, "balanceMessage"),
                    nested_json_value_string(vendor, "transactionsToday", "total"),
                    nested_json_value_string(vendor, "transactionsToday", "success"),
                    nested_json_value_string(vendor, "transactionsToday", "failed"),
                    nested_json_value_string(vendor, "transactionsToday", "pending"),
                    nested_json_value_string(vendor, "transactionsToday", "successRate"),
                    nested_json_value_string(vendor, "transactionsToday", "amountTotal"),
                    nested_json_value_string(vendor, "webhookToday", "total"),
                    nested_json_value_string(vendor, "webhookToday", "rejected"),
                    nested_json_value_string(vendor, "webhookToday", "failed"),
                    nested_json_value_string(vendor, "webhookToday", "delivered"),
                    nested_json_value_string(vendor, "webhookToday", "lastAt"),
                    nested_json_value_string(vendor, "webhookToday", "lastStatus"),
                    nested_json_value_string(vendor, "webhookToday", "lastMessage"),
                    partial.clone(),
                    snapshot_persisted.clone(),
                    issue_codes.clone(),
                    generated_at.to_string(),
                ]
            })
            .collect::<Vec<_>>()
    });
    // Export-level diagnostics are payload-wide: repeat them on every vendor row,
    // and emit one diagnostics-only row when no vendors exist so degraded exports
    // remain self-describing.
    match vendor_rows {
        Some(rows_payload) if !rows_payload.is_empty() => rows.extend(rows_payload),
        _ => rows.push(vec![
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
            partial,
            snapshot_persisted,
            issue_codes,
            generated_at.to_string(),
        ]),
    }
    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|value| csv_escape(&value))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn json_i64(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number.as_i64().unwrap_or_default(),
        Value::String(text) => text.parse::<i64>().unwrap_or_default(),
        _ => 0,
    }
}

pub(super) fn build_vendor_snapshot(vendor: &Value, tx_stats: &HashMap<String, TransactionStats>) -> VendorSnapshot {
    let label = json_string(vendor, "name");
    let key = label.to_lowercase();
    let active = json_bool(vendor, "status");
    let config = vendor.get("config");
    let configured = config.map(has_any_non_empty_value).unwrap_or(false);
    let low_balance_threshold = vendor.get("lowBalanceThreshold").and_then(Value::as_i64).unwrap_or(0);
    let transactions_today = tx_stats.iter().find(|(name,_)| name.contains(&key)||key.contains(name.as_str())).map(|(_,stats)|stats.clone()).unwrap_or_default();
    let (health, health_reason)=resolve_snapshot_health(configured,active,&transactions_today);
    VendorSnapshot { key,label,configured,active,low_balance_threshold,health,health_reason,transactions_today }
}

fn resolve_snapshot_health(
    configured: bool,
    active: bool,
    stats: &TransactionStats,
) -> (&'static str, String) {
    if !active {
        return ("disabled", "Vendor dinonaktifkan".to_string());
    }

    if !configured {
        return ("critical", "Credentials belum dikonfigurasi".to_string());
    }

    if stats.pending > 10 || stats.failed > 5 {
        return (
            "warning",
            format!(
                "Transaksi hari ini perlu perhatian: {} pending, {} gagal",
                stats.pending, stats.failed
            ),
        );
    }

    ("healthy", "Snapshot PostgreSQL terlihat normal".to_string())
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn json_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn json_value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn nested_json_value_string(value: &Value, parent: &str, key: &str) -> String {
    json_value_string(value.get(parent).and_then(|parent| parent.get(key)))
}

fn yes_no(value: bool) -> String {
    if value { "yes" } else { "no" }.to_string()
}

fn csv_escape(value: &str) -> String {
    let dangerous = value
        .trim_start_matches(|character: char| character.is_whitespace() || character.is_control())
        .starts_with(['=', '+', '-', '@']);
    let safe = if dangerous {
        format!("'{value}")
    } else {
        value.to_string()
    };

    if safe.contains(',') || safe.contains('"') || safe.contains('\n') || safe.contains('\r') {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_vendor_is_disabled_and_failures_are_not_healthy_zeroes() {
        let empty = TransactionStats::default();
        assert_eq!(resolve_snapshot_health(true, false, &empty).0, "disabled");
        assert_eq!(
            resolve_realtime_health(true, false, true, false, 0, 0, 0),
            "disabled"
        );
        assert_eq!(
            resolve_realtime_health(true, true, false, false, 0, 0, 0),
            "critical"
        );
        assert_eq!(
            resolve_realtime_health(true, true, true, false, 0, 1, 0),
            "warning"
        );
    }

    #[test]
    fn snapshot_issue_contract_uses_stable_non_secret_codes() {
        let issue = VendorHealthIssue::new("VENDOR_COLLECTION_UNAVAILABLE", "postgres.vendors");
        let json = serde_json::to_value(issue).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "code": "VENDOR_COLLECTION_UNAVAILABLE",
                "source": "postgres.vendors"
            })
        );
    }

    #[test]
    fn core_failure_is_503_and_auxiliary_failure_is_partial_200() {
        assert_eq!(
            snapshot_response_status(false, &[]),
            (StatusCode::SERVICE_UNAVAILABLE, false, false),
        );
        let issues = vec![VendorHealthIssue::new(
            "TRANSACTION_STATS_UNAVAILABLE",
            "postgres.transactions",
        )];
        assert_eq!(
            snapshot_response_status(true, &issues),
            (StatusCode::OK, true, true),
        );
    }

    #[test]
    fn realtime_auxiliary_and_probe_failures_are_explicit() {
        let issues = realtime_issue_set(
            false, // transaction stats unavailable
            false, // webhook stats unavailable
            true,  // last webhook available
            false, // seller unavailable
            false, // Digiflazz balance unavailable
            true,  // Tokovoucher balance available
        );
        let codes = issues.iter().map(|issue| issue.code).collect::<Vec<_>>();
        assert_eq!(
            codes,
            vec![
                "TRANSACTION_STATS_UNAVAILABLE",
                "WEBHOOK_STATS_UNAVAILABLE",
                "SELLER_SUMMARY_UNAVAILABLE",
                "DIGIFLAZZ_BALANCE_UNAVAILABLE",
            ]
        );
    }

    #[test]
    fn persistence_failure_keeps_metrics_but_marks_partial() {
        let (partial, persisted, issues) = apply_persistence_outcome(false, Vec::new());
        assert!(partial);
        assert!(!persisted);
        assert_eq!(issues[0].code, "SNAPSHOT_PERSISTENCE_FAILED");

        let kept = vec![VendorHealthIssue::new(
            "TRANSACTION_STATS_UNAVAILABLE",
            "postgres.transactions",
        )];
        let (partial, persisted, issues) = apply_persistence_outcome(true, kept);
        assert!(partial);
        assert!(persisted);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "TRANSACTION_STATS_UNAVAILABLE");

        let (partial, persisted, issues) = apply_persistence_outcome(true, Vec::new());
        assert!(!partial);
        assert!(persisted);
        assert!(issues.is_empty());
    }

    #[test]
    fn csv_exposes_only_stable_diagnostics() {
        let payload = serde_json::json!({
            "generatedAt": "2026-08-18T12:00:00.000Z",
            "partial": true,
            "snapshotPersisted": false,
            "issues": [{ "code": "SNAPSHOT_PERSISTENCE_FAILED", "source": "postgres.settings" }],
            "vendors": []
        });
        let csv = build_vendor_health_csv(&payload);
        let header = csv.trim_start_matches('\u{FEFF}').lines().next().unwrap();
        assert!(header.contains("Partial"));
        assert!(header.contains("Snapshot Persisted"));
        assert!(header.contains("Issue Codes"));
        assert!(csv.contains("SNAPSHOT_PERSISTENCE_FAILED"));
        assert!(!csv.contains("password"));
        assert!(!csv.contains("apiKey"));
    }

    #[test]
    fn disabled_vendor_does_not_allow_a_balance_probe() {
        let vendor = serde_json::json!({"status":false,"config":{"username":"fixture","apiKey":"fixture"}});
        assert!(!balance_probe_allowed(Some(&vendor), true));
        assert!(balance_probe_allowed(Some(&serde_json::json!({"status":true})), true));
    }

    #[test]
    fn persisted_snapshot_keeps_notification_compatible_vendor_fields() {
        let response = VendorRealtimeHealthResponse {
            ok:true, partial:false, issues:Vec::new(), snapshot_persisted:true,
            generated_at:"2026-08-18T12:00:00.000Z".to_string(),
            vendors:vec![VendorRealtimeHealthItem { key:"digiflazz".to_string(),label:"Digiflazz".to_string(),configured:true,active:true,balance:serde_json::json!(1000),balance_ok:true,low_balance_threshold:100,low_balance:false,balance_message:"OK".to_string(),health:"healthy",transactions_today:TransactionStats::default(),webhook_today:WebhookStats::default() }],
            seller:SellerHealthSummary::default(),
        };
        let value=serde_json::to_value(&response).unwrap();
        let vendor=value["vendors"][0].as_object().unwrap();
        for field in ["key","label","balanceOk","lowBalance","balanceMessage","balance","lowBalanceThreshold"] { assert!(vendor.contains_key(field),"missing persisted field {field}"); }
        let serialized=value.to_string();
        assert!(!serialized.contains("apiKey")); assert!(!serialized.contains("signature")); assert!(!serialized.contains("Authorization"));
    }
}
