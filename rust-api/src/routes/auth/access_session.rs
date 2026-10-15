use axum::http::{header, HeaderMap};
use uuid::Uuid;

use crate::{sql_auth, state::AppState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OptionalMemberAccess {
    pub user_id: Uuid,
    pub level: String,
}

pub(crate) async fn resolve_optional_member_access(
    headers: &HeaderMap,
    state: &AppState,
) -> Option<OptionalMemberAccess> {
    let authorization = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = authorization.strip_prefix("Bearer ")?;
    let user = sql_auth::admit_access(
        &state.pg_pool,
        token,
        &state.jwt_secret,
        chrono::Utc::now(),
    )
    .await
    .ok()?;
    if user.role != "member" {
        return None;
    }
    let level: String = sqlx::query_scalar("SELECT level FROM users WHERE id=$1 AND role='member' AND active=TRUE")
        .bind(user.id)
        .fetch_optional(&state.pg_pool)
        .await
        .ok()??;
    let level = match level.as_str() {
        "gold" => "gold",
        "platinum" => "platinum",
        _ => "basic",
    };
    Some(OptionalMemberAccess {
        user_id: user.id,
        level: level.to_string(),
    })
}
