use sqlx::{PgPool, Row};
use super::{CategorySummary, DailySummary, RecentTransaction, SalesSummary, SalesSummaryQuery, SalesSummaryResponse};

pub(super) fn bounds(query: &SalesSummaryQuery) -> Result<(Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>), &'static str> {
    let parse = |value: Option<&str>, end: bool| -> Result<Option<chrono::DateTime<chrono::Utc>>, &'static str> {
        let Some(value) = value else { return Ok(None) };
        let date = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "Invalid date format")?;
        let local = date.and_hms_nano_opt(if end {23} else {0}, if end {59} else {0}, if end {59} else {0}, if end {999_999_999} else {0}).ok_or("Invalid date format")?;
        Ok(Some(chrono::DateTime::from_naive_utc_and_offset(local - chrono::Duration::hours(7), chrono::Utc)))
    };
    let start=parse(query.start_date.as_deref(),false)?; let end=parse(query.end_date.as_deref(),true)?;
    if start.zip(end).is_some_and(|(a,b)|a>b) { return Err("Start date must be before end date"); }
    Ok((start,end))
}
pub(super) async fn payload(pool:&PgPool, start:Option<chrono::DateTime<chrono::Utc>>, end:Option<chrono::DateTime<chrono::Utc>>) -> Result<SalesSummaryResponse,sqlx::Error> {
    let row=sqlx::query("SELECT COUNT(*)::bigint total, COUNT(*) FILTER(WHERE t.status='success')::bigint success, COUNT(*) FILTER(WHERE t.status IN ('pending','processing'))::bigint pending, COUNT(*) FILTER(WHERE t.status='failed')::bigint failed, COALESCE(SUM(t.amount) FILTER(WHERE t.status='success'),0)::bigint omzet, COALESCE(SUM(t.amount-COALESCE(NULLIF(t.snapshot #>> '{product,costPrice}','')::bigint,NULLIF(t.snapshot #>> '{product,cost_price}','')::bigint,p.cost_price::bigint,0)) FILTER(WHERE t.status='success'),0)::bigint profit FROM financial_transactions t LEFT JOIN products p ON p.id=t.product_id WHERE ($1::timestamptz IS NULL OR t.created_at >= $1) AND ($2::timestamptz IS NULL OR t.created_at <= $2)").bind(start).bind(end).fetch_one(pool).await?;
    let total:i64=row.get("total");let success:i64=row.get("success");let omzet:i64=row.get("omzet");
    let summary=SalesSummary { total_transactions:total,success_transactions:success,pending_transactions:row.get("pending"),failed_transactions:row.get("failed"),total_omset:omzet,total_profit:row.get("profit"),average_transaction:if success>0 {omzet as f64/success as f64}else{0.0}};
    let category_rows=sqlx::query("SELECT COALESCE(p.category,'') category,COUNT(*)::bigint count,COALESCE(SUM(t.amount),0)::bigint omset,COALESCE(SUM(t.amount-COALESCE(NULLIF(t.snapshot #>> '{product,costPrice}','')::bigint,NULLIF(t.snapshot #>> '{product,cost_price}','')::bigint,p.cost_price::bigint,0)),0)::bigint profit FROM financial_transactions t LEFT JOIN products p ON p.id=t.product_id WHERE t.status='success' AND ($1::timestamptz IS NULL OR t.created_at >= $1) AND ($2::timestamptz IS NULL OR t.created_at <= $2) GROUP BY p.category ORDER BY count DESC").bind(start).bind(end).fetch_all(pool).await?;
    let category_data=category_rows.iter().map(|r|CategorySummary{category:r.get("category"),count:r.get("count"),omset:r.get("omset"),profit:r.get("profit")}).collect();
    let daily_rows=sqlx::query("SELECT to_char(t.created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') date,COUNT(*)::bigint count,COALESCE(SUM(t.amount),0)::bigint omset,COALESCE(SUM(t.amount-COALESCE(NULLIF(t.snapshot #>> '{product,costPrice}','')::bigint,NULLIF(t.snapshot #>> '{product,cost_price}','')::bigint,p.cost_price::bigint,0)),0)::bigint profit FROM financial_transactions t LEFT JOIN products p ON p.id=t.product_id WHERE t.status='success' AND ($1::timestamptz IS NULL OR t.created_at >= $1) AND ($2::timestamptz IS NULL OR t.created_at <= $2) GROUP BY 1 ORDER BY 1").bind(start).bind(end).fetch_all(pool).await?;
    let daily_data=daily_rows.iter().map(|r|DailySummary{date:r.get("date"),count:r.get("count"),omset:r.get("omset"),profit:r.get("profit")}).collect();
    let recent=sqlx::query("SELECT t.id,t.target,t.amount,t.status,t.created_at,p.name product,COALESCE(p.category,'') category,COALESCE(u.name,'') username FROM financial_transactions t LEFT JOIN products p ON p.id=t.product_id LEFT JOIN users u ON u.id=t.user_id WHERE ($1::timestamptz IS NULL OR t.created_at >= $1) AND ($2::timestamptz IS NULL OR t.created_at <= $2) ORDER BY t.created_at DESC LIMIT 10").bind(start).bind(end).fetch_all(pool).await?;
    let recent_transactions=recent.iter().map(|r|RecentTransaction{id:r.get::<uuid::Uuid,_>("id").to_string(),target:r.get("target"),amount:r.get("amount"),status:r.get("status"),created_at:r.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),product:r.get("product"),category:r.get("category"),user:r.get("username")}).collect();
    Ok(SalesSummaryResponse{summary,category_data,daily_data,recent_transactions})
}
