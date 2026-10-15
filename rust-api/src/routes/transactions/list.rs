use axum::{response::IntoResponse, response::Response, Json};

use crate::security::ErrorResponse;

use super::{ManualTransactionsQuery, REPORT_OFFSET};

fn internal_error() -> Response {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { message: "Internal Server Error" })).into_response()
}

pub(super) async fn sql_transaction_items(
    pool: &sqlx::PgPool,
    query: &ManualTransactionsQuery,
    page: i64,
    limit: i64,
    default_actionable: bool,
) -> Result<(Vec<super::ManualTransactionItem>, super::ManualTransactionsSummary, i64), Response> {
    use sqlx::Row;
    let status=query.status.as_deref().unwrap_or_default().trim().to_lowercase();
    let source=query.source.as_deref().unwrap_or_default().trim().to_lowercase();
    let scope=query.scope.as_deref().unwrap_or_default().trim().to_lowercase();
    if !status.is_empty()&&!matches!(status.as_str(),"pending"|"processing"|"success"|"failed") { return Err((axum::http::StatusCode::BAD_REQUEST,Json(ErrorResponse{message:"Status transaksi tidak valid"})).into_response()); }
    if !source.is_empty()&&!matches!(source.as_str(),"web"|"api") { return Err((axum::http::StatusCode::BAD_REQUEST,Json(ErrorResponse{message:"Sumber transaksi tidak valid"})).into_response()); }
    let date=|raw:Option<&str>,end:bool|->Result<Option<chrono::DateTime<chrono::FixedOffset>>,Response>{
        let Some(raw)=raw.map(str::trim).filter(|v|!v.is_empty()) else{return Ok(None)};
        let Some(value)=chrono::NaiveDate::parse_from_str(raw,"%Y-%m-%d").ok() else{return Err((axum::http::StatusCode::BAD_REQUEST,Json(ErrorResponse{message:"Format tanggal transaksi tidak valid"})).into_response())};
        let time=if end{"23:59:59.999"}else{"00:00:00.000"};
        chrono::DateTime::parse_from_str(&format!("{}T{}{}",value.format("%Y-%m-%d"),time,REPORT_OFFSET),"%Y-%m-%dT%H:%M:%S%.3f%:z").map(Some).map_err(|_|(axum::http::StatusCode::BAD_REQUEST,Json(ErrorResponse{message:"Format tanggal transaksi tidak valid"})).into_response())
    };
    let start=date(query.start_date.as_deref(),false)?; let end=date(query.end_date.as_deref(),true)?;
    if start.zip(end).is_some_and(|(a,b)|a>b){return Err((axum::http::StatusCode::BAD_REQUEST,Json(ErrorResponse{message:"Rentang tanggal transaksi tidak valid"})).into_response())}
    let mut qb=sqlx::QueryBuilder::<sqlx::Postgres>::new("SELECT t.id,t.user_id,t.product_id,t.reference_id,t.amount,t.status,t.refunded,t.snapshot,t.source,t.created_at,t.updated_at,t.status_updated_at,t.status_update_note,t.status_updated_by,t.vendor_trx_id,t.sn,t.message,t.refunded_at,t.refund_reason, u.name user_name,u.email user_email,u.role user_role, p.name product_name,p.code product_code,p.category product_category,p.brand product_brand,p.vendor_name product_vendor, su.name status_user_name,su.email status_user_email,su.role status_user_role, COUNT(*) OVER() AS total, COUNT(*) FILTER(WHERE t.status='pending') OVER() AS pending,COUNT(*) FILTER(WHERE t.status='processing') OVER() AS processing,COUNT(*) FILTER(WHERE t.status='success') OVER() AS success,COUNT(*) FILTER(WHERE t.status='failed') OVER() AS failed,COALESCE(SUM(t.amount) OVER(),0) AS amount_total FROM financial_transactions t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN products p ON p.id=t.product_id LEFT JOIN users su ON su.id=t.status_updated_by WHERE t.kind='member'");
    if !status.is_empty(){qb.push(" AND t.status=").push_bind(status);}else if default_actionable&&scope!="all"{qb.push(" AND t.status IN ('pending','processing','failed')");}
    if !source.is_empty(){qb.push(" AND t.source=").push_bind(source);}
    if let Some(value)=start{qb.push(" AND t.created_at >= ").push_bind(value.with_timezone(&chrono::Utc));}
    if let Some(value)=end{qb.push(" AND t.created_at <= ").push_bind(value.with_timezone(&chrono::Utc));}
    if let Some(search)=query.search.as_deref().map(str::trim).filter(|v|!v.is_empty()){
        let term=format!("%{}%",search.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_"));
        qb.push(" AND (t.id::text ILIKE ").push_bind(term.clone()).push(" ESCAPE '\\\\' OR COALESCE(t.vendor_trx_id,'') ILIKE ").push_bind(term.clone()).push(" ESCAPE '\\\\' OR COALESCE(t.snapshot->>'customerRefId','') ILIKE ").push_bind(term.clone()).push(" ESCAPE '\\\\' OR t.target ILIKE ").push_bind(term.clone()).push(" ESCAPE '\\\\' OR COALESCE(u.name,'') ILIKE ").push_bind(term.clone()).push(" ESCAPE '\\\\' OR COALESCE(u.email,'') ILIKE ").push_bind(term.clone()).push(" ESCAPE '\\\\' OR p.name ILIKE ").push_bind(term.clone()).push(" ESCAPE '\\\\' OR p.code ILIKE ").push_bind(term).push(" ESCAPE '\\\\')");
    }
    for (field,value) in [("p.category",query.category.as_deref()),("p.brand",query.brand.as_deref()),("p.vendor_name",query.vendor.as_deref())]{if let Some(value)=value.map(str::trim).filter(|v|!v.is_empty()){qb.push(" AND ").push(field).push(" ILIKE ").push_bind(format!("%{}%",value.replace('%',"\\%").replace('_',"\\_"))).push(" ESCAPE '\\\\'");}}
    qb.push(" ORDER BY t.created_at DESC LIMIT ").push_bind(limit).push(" OFFSET ").push_bind((page-1)*limit);
    let rows=qb.build().fetch_all(pool).await.map_err(|_|internal_error())?;
    let total=rows.first().map(|r|r.get::<i64,_>("total")).unwrap_or(0);
    let summary=rows.first().map(|r|super::ManualTransactionsSummary{total:r.get("total"),pending:r.get("pending"),processing:r.get("processing"),success:r.get("success"),failed:r.get("failed"),amount_total:r.get("amount_total")}).unwrap_or_default();
    let items=rows.into_iter().map(|r|{
        let id=r.get::<uuid::Uuid,_>("id"); let user_id=r.try_get::<Option<uuid::Uuid>,_>("user_id").ok().flatten(); let product_id=r.get::<uuid::Uuid,_>("product_id");let snapshot=r.get::<serde_json::Value,_>("snapshot");
        let date=|key:&str|r.try_get::<Option<chrono::DateTime<chrono::Utc>>,_>(key).ok().flatten().map(|d|d.to_rfc3339());
        super::ManualTransactionItem{id:id.to_string(),target:r.get("target"),amount:r.get("amount"),status:r.get("status"),reference_id:r.get("reference_id"),vendor_trx_id:r.try_get::<Option<String>,_>("vendor_trx_id").ok().flatten().unwrap_or_default(),customer_ref_id:snapshot.get("customerRefId").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned(),sn:r.try_get::<Option<String>,_>("sn").ok().flatten().unwrap_or_default(),message:r.get("message"),refunded:r.get("refunded"),refunded_at:date("refunded_at"),refund_reason:r.get("refund_reason"),source:r.get("source"),created_at:r.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),updated_at:r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339(),status_updated_at:date("status_updated_at"),status_update_note:r.get("status_update_note"),user:super::UserBrief{id:user_id.map(|v|v.to_string()).unwrap_or_default(),name:r.try_get::<Option<String>,_>("user_name").ok().flatten().unwrap_or_default(),email:r.try_get::<Option<String>,_>("user_email").ok().flatten().unwrap_or_default(),role:r.try_get("user_role").ok()},product:super::ProductBrief{id:product_id.to_string(),name:r.get("product_name"),code:r.get("product_code"),category:r.get("product_category"),brand:r.get("product_brand"),vendor_name:r.get("product_vendor")},status_updated_by:super::UserBrief{id:r.try_get::<Option<uuid::Uuid>,_>("status_updated_by").ok().flatten().map(|v|v.to_string()).unwrap_or_default(),name:r.try_get::<Option<String>,_>("status_user_name").ok().flatten().unwrap_or_default(),email:r.try_get::<Option<String>,_>("status_user_email").ok().flatten().unwrap_or_default(),role:r.try_get("status_user_role").ok()},discount_voucher_code:r.try_get("discount_voucher_code").ok().flatten(),discount_amount:r.try_get("discount_amount").ok().flatten(),base_amount:r.try_get("base_amount").ok().flatten(),flash_sale:snapshot.get("flashSale").and_then(serde_json::Value::as_str).map(str::to_owned)}
    }).collect();
    Ok((items,summary,total))
}
