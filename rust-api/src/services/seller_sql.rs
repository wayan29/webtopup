use sqlx::{PgPool, Row};
use serde_json::{json, Value};

pub async fn stored_settings(pool: &PgPool, channel: &str) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar("SELECT data FROM seller_settings WHERE channel=$1")
        .bind(channel).fetch_optional(pool).await.map(|value| value.unwrap_or_else(|| json!({})))
}

pub async fn save_settings(pool: &PgPool, channel: &str, data: &Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO seller_settings(channel,data) VALUES($1,$2) ON CONFLICT(channel) DO UPDATE SET data=EXCLUDED.data")
        .bind(channel).bind(data).execute(pool).await?;
    Ok(())
}

pub async fn record_event(pool: &PgPool, channel: &str, event: &str, reference_id: &str, status: &str, message: &str, verified: bool, request_ip: &str) {
    let _ = sqlx::query("INSERT INTO seller_event_logs(channel,reference_id,event,status,message,verified,request_ip) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(channel).bind(reference_id).bind(event).bind(status).bind(message).bind(verified).bind(request_ip).execute(pool).await;
}

pub async fn order_by_reference(pool: &PgPool, channel: &str, reference_id: &str) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT * FROM seller_orders WHERE channel=$1 AND reference_id=$2")
        .bind(channel).bind(reference_id).fetch_optional(pool).await
}

pub async fn pending_callback_orders(pool: &PgPool, channel: &str, limit: i64) -> Result<Vec<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT o.* FROM seller_orders o JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.channel=$1 AND c.delivered_at IS NULL ORDER BY c.created_at ASC LIMIT $2")
        .bind(channel).bind(limit).fetch_all(pool).await
}

pub async fn order_count(pool: &PgPool, channel: &str) -> Result<(i64,i64,i64,i64), sqlx::Error> {
    let row=sqlx::query("SELECT count(*)::bigint AS total,count(*) FILTER(WHERE status='pending')::bigint AS pending,count(*) FILTER(WHERE status='success')::bigint AS success,count(*) FILTER(WHERE status='failed')::bigint AS failed FROM seller_orders WHERE channel=$1").bind(channel).fetch_one(pool).await?;
    Ok((row.try_get("total")?,row.try_get("pending")?,row.try_get("success")?,row.try_get("failed")?))
}
