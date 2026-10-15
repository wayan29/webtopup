use sqlx::{PgPool, Postgres, Transaction};

use super::validation::number_value;

pub(super) const POINTS_PER_TRANSACTION_KEY: &str = "points_per_transaction";
pub(super) const POINT_VALUE_RATE_KEY: &str = "point_value_rate";

/// Reads a numeric site setting without requiring client-side JSONB decoding:
/// `value #>> '{}'` renders the stored JSON scalar as text.
pub(super) async fn site_setting_i64(
    pool: &PgPool,
    key: &str,
    fallback: i64,
) -> Result<i64, sqlx::Error> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value #>> '{}' FROM site_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await?;
    Ok(stored
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| number_value(value))
        .unwrap_or(fallback))
}

/// Last-write-wins numeric upsert; the site_settings row revision advances on update.
pub(super) async fn upsert_points_setting(
    tx: &mut Transaction<'_, Postgres>,
    key: &str,
    value: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO site_settings (key, value, revision, updated_at) \
         VALUES ($1, to_jsonb($2::bigint), 1, now()) \
         ON CONFLICT (key) DO UPDATE \
         SET value = EXCLUDED.value, revision = site_settings.revision + 1, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// `users.points` is the authoritative balance; missing rows read as zero.
pub(super) async fn user_points(pool: &PgPool, user_id: uuid::Uuid) -> Result<i64, sqlx::Error> {
    let points: Option<i64> = sqlx::query_scalar("SELECT points FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    Ok(points.unwrap_or_default())
}

/// Ledger sum for one transaction type, optionally scoped to a user_ref.
/// `absolute` mirrors the Mongo `$sum: { $abs: "$points" }` redemption totals.
pub(super) async fn sum_points(
    pool: &PgPool,
    user_ref: Option<&str>,
    transaction_type: &str,
    absolute: bool,
) -> Result<i64, sqlx::Error> {
    let expression = if absolute { "ABS(points)" } else { "points" };
    let sql = format!(
        "SELECT COALESCE(SUM({expression}), 0) FROM point_ledger \
         WHERE transaction_type = $1::text AND ($2::text IS NULL OR user_ref = $2::text)"
    );
    let total: i64 = sqlx::query_scalar(&sql)
        .bind(transaction_type)
        .bind(user_ref)
        .fetch_one(pool)
        .await?;
    Ok(total)
}
