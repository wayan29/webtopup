use serde_json::Value;
use sqlx::PgPool;

pub async fn setting_string(pool: &PgPool, key: &str) -> Result<String, sqlx::Error> {
    Ok(sqlx::query_scalar::<_,String>("SELECT value FROM webhook_settings WHERE key=$1").bind(key).fetch_optional(pool).await?.unwrap_or_default())
}
pub async fn upsert_setting(pool: &PgPool,key: &str,value: String)->Result<(),sqlx::Error>{
    sqlx::query("INSERT INTO webhook_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value").bind(key).bind(value).execute(pool).await?; Ok(())
}
pub async fn tokovoucher_credentials(pool: &PgPool)->Result<(String,String),sqlx::Error>{
    let config=sqlx::query_scalar::<_,Value>("SELECT config FROM vendors WHERE lower(name) LIKE '%tokovoucher%' ORDER BY id LIMIT 1").fetch_optional(pool).await?.unwrap_or_default();
    let member=config.get("memberCode").or_else(||config.get("apiKey")).and_then(Value::as_str).unwrap_or("").trim().to_owned();
    let secret=config.get("secret").and_then(Value::as_str).unwrap_or("").trim().to_owned();
    Ok((member,secret))
}
pub async fn tokovoucher_credentials_configured(pool: &PgPool)->Result<bool,sqlx::Error>{let (member,secret)=tokovoucher_credentials(pool).await?;Ok(!member.is_empty()&&!secret.is_empty())}
