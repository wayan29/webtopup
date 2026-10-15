use serde_json::Value;
use sqlx::PgPool;

const MARGIN_DEFAULTS: &str = r#"{"basic":10.0,"gold":5.0,"platinum":0.0,"note":"","updatedBy":null}"#;

pub async fn load_margin_setting(pool: &PgPool) -> Option<Value> {
    let (value, updated_at) = sqlx::query_as::<_, (Value, chrono::DateTime<chrono::Utc>)>(
        "SELECT value,updated_at FROM site_settings WHERE key='margins'",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;
    Some(serde_json::json!({
        "value": value,
        "updatedAt": updated_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }))
}

pub async fn save_margin_patch(pool: &PgPool, patch: Value) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO site_settings(key,value,revision,updated_at) \
         VALUES('margins',$1::jsonb || $2::jsonb,1,now()) \
         ON CONFLICT(key) DO UPDATE SET \
           value=site_settings.value || $2::jsonb, \
           revision=site_settings.revision+1, \
           updated_at=now()",
    )
    .bind(MARGIN_DEFAULTS)
    .bind(patch)
    .execute(pool)
    .await?;
    Ok(())
}
