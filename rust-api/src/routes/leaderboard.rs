mod types;

use std::sync::Arc;

use axum::{extract::Query, response::IntoResponse, response::Response, Json};
use chrono::{Datelike, Local, TimeZone};
use sqlx::Row;

use crate::state::AppState;
use types::{CurrentUser, LeaderboardItem, LeaderboardMeta, LeaderboardQuery, LeaderboardResponse};

pub async fn get_leaderboard(
    headers: axum::http::HeaderMap,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Query(query): Query<LeaderboardQuery>,
) -> Response {
    let period = match query.period.as_deref() {
        Some("weekly") => "weekly",
        Some("monthly") => "monthly",
        _ => "alltime",
    };
    let member = current_member(&headers, &state).await;
    let local_now = Local::now();
    let start: Option<chrono::DateTime<chrono::Utc>> = match period {
        "weekly" => {
            let day = local_now.date_naive() - chrono::Duration::days(i64::from(chrono::Datelike::weekday(&local_now).num_days_from_monday()));
            Local.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap()).single().map(|value| value.with_timezone(&chrono::Utc))
        }
        "monthly" => {
            let day = chrono::NaiveDate::from_ymd_opt(chrono::Datelike::year(&local_now), chrono::Datelike::month(&local_now), 1).unwrap();
            Local.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap()).single().map(|value| value.with_timezone(&chrono::Utc))
        }
        _ => None,
    };
    let rows = match sqlx::query(
        "WITH totals AS (SELECT u.id,u.name,u.level,COUNT(*)::bigint AS tx,SUM(t.amount)::bigint AS amount FROM financial_transactions t JOIN users u ON u.id=t.user_id WHERE t.status='success' AND u.role='member' AND u.active AND ($1::timestamptz IS NULL OR t.created_at >= $1) GROUP BY u.id,u.name,u.level) SELECT id,name,level,tx,amount,COUNT(*) OVER()::bigint AS participants,SUM(tx) OVER()::bigint AS total_tx,SUM(amount) OVER()::bigint AS total_amount FROM totals ORDER BY amount DESC,tx DESC,id LIMIT 10"
    ).bind(start).fetch_all(&state.pg_pool).await {
        Ok(rows) => rows,
        Err(_) => return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE,"SQL leaderboard store is unavailable"),
    };
    let participant_count = rows.first().map(|r|r.get("participants")).unwrap_or(0);
    let total_transactions = rows.first().map(|r|r.get("total_tx")).unwrap_or(0);
    let total_amount = rows.first().map(|r|r.get("total_amount")).unwrap_or(0);
    let items = rows.iter().enumerate().map(|(i,r)| {
        let id: uuid::Uuid=r.get("id");
        LeaderboardItem { id:Some(id.to_string()), name:r.get("name"), level:r.get("level"), total_transactions:r.get("tx"), total_amount:r.get("amount"), rank:i as i64+1, is_current_user:member.as_ref().is_some_and(|m|m.0==id) }
    }).collect::<Vec<_>>();
    let current_user = if let Some((id,name))=member {
        let row=sqlx::query("SELECT COUNT(*)::bigint tx,COALESCE(SUM(t.amount),0)::bigint amount FROM financial_transactions t WHERE t.user_id=$1 AND t.status='success' AND ($2::timestamptz IS NULL OR t.created_at >= $2)").bind(id).bind(start).fetch_optional(&state.pg_pool).await.ok().flatten();
        if let Some(r) = row {
            let tx: i64 = r.get("tx");
            let amount: i64 = r.get("amount");
            if tx == 0 {
                None
            } else {
                let rank = sqlx::query_scalar::<_, i64>("WITH totals AS (SELECT t.user_id,COUNT(*)::bigint tx,SUM(t.amount)::bigint amount FROM financial_transactions t JOIN users u ON u.id=t.user_id WHERE t.status='success' AND u.role='member' AND u.active AND ($1::timestamptz IS NULL OR t.created_at >= $1) GROUP BY t.user_id) SELECT COUNT(*)::bigint+1 FROM totals WHERE amount>$2 OR (amount=$2 AND tx>$3)").bind(start).bind(amount).bind(tx).fetch_one(&state.pg_pool).await.unwrap_or(1);
                Some(CurrentUser { id: id.to_string(), name, rank, total_transactions: tx, total_amount: amount, in_top_list: items.iter().any(|item| item.id.as_deref() == Some(&id.to_string())) })
            }
        } else {
            None
        }
    } else {
        None
    };
    Json(LeaderboardResponse { items,current_user,meta:LeaderboardMeta { period:period.to_string(),participant_count,total_transactions,total_amount,generated_at:chrono::Utc::now().to_rfc3339() } }).into_response()
}

async fn current_member(headers:&axum::http::HeaderMap,state:&AppState)->Option<(uuid::Uuid,String)> {
    let token=headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?;
    let secret=std::env::var("JWT_SECRET").ok()?;
    let claims=jsonwebtoken::decode::<std::collections::HashMap<String,serde_json::Value>>(token,&jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),&jsonwebtoken::Validation::default()).ok()?.claims;
    let id=uuid::Uuid::parse_str(claims.get("id")?.as_str()?).ok()?;
    sqlx::query("SELECT name FROM users WHERE id=$1 AND role='member' AND active").bind(id).fetch_optional(&state.pg_pool).await.ok().flatten().map(|r|(id,r.get("name")))
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(serde_json::json!({"message":message}))).into_response()
}
