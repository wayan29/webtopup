use std::{collections::HashMap, sync::Arc};

use axum::{extract::{Path, Query, State}, response::{IntoResponse, Response}, Json};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{
    routes::{auth::require_trusted_step_up_group, teams::{
        types::{TeamListResponse, TeamMemberItem, TeamMemberPayload, TeamMemberResponse, TeamSummary},
        validation::{build_permissions, clamp_permissions_to_actor, ensure_assignable_role, ensure_manage_scope, is_valid_email, normalize_email, normalize_name},
        TEAM_PERMISSIONS,
    }},
    security::{require_proxy_context, require_sql_permission},
    sql_auth::SqlAuthenticatedUser,
    state::AppState,
};

#[derive(Clone, Debug, sqlx::FromRow)]
struct TeamMemberRow {
    id: Uuid,
    name: String,
    email: String,
    role: String,
    active: bool,
    two_factor_enabled: bool,
    permissions: Vec<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
struct TeamActor {
    id: Uuid,
    role: String,
    permissions: Vec<String>,
}

fn error_response(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"message":message}))).into_response()
}

fn db_unavailable() -> Response {
    error_response(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Database unavailable")
}

fn canonical_user_id(value: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(value).ok()?;
    (id.to_string() == value).then_some(id)
}

async fn authorize(
    headers: &axum::http::HeaderMap,
    state: &AppState,
    permission: &str,
    step_up: Option<&str>,
) -> Result<SqlAuthenticatedUser, Response> {
    let actor = require_sql_permission(headers, state, permission).await?;
    let proxy = require_proxy_context(headers, state)?;
    if proxy.user_id.as_deref() != Some(actor.id.to_string().as_str())
        || proxy.session_id.as_deref() != Some(actor.session_id.to_string().as_str())
    {
        return Err(error_response(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    if let Some(group) = step_up {
        require_trusted_step_up_group(headers, group)?;
    }
    Ok(actor)
}

async fn lock_actor(
    tx: &mut Transaction<'_, Postgres>,
    actor: &SqlAuthenticatedUser,
) -> Result<TeamActor, Response> {
    let row: Option<(String, bool, Vec<String>, i32, i64)> = match sqlx::query_as(
        "SELECT role,active,permissions,session_version,security_generation FROM users WHERE id=$1 FOR UPDATE",
    )
    .bind(actor.id)
    .fetch_optional(&mut **tx)
    .await
    {
        Ok(row) => row,
        Err(_) => return Err(db_unavailable()),
    };
    let Some((role, active, permissions, user_version, user_generation)) = row else {
        return Err(error_response(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"));
    };
    let session: Option<(String, String, i32, i64, DateTime<Utc>, Option<DateTime<Utc>>)> =
        match sqlx::query_as(
            "SELECT state,role,session_version,security_generation,absolute_expires_at,idle_expires_at FROM auth_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE",
        )
        .bind(actor.session_id)
        .bind(actor.id)
        .fetch_optional(&mut **tx)
        .await
        {
            Ok(row) => row,
            Err(_) => return Err(db_unavailable()),
        };
    let Some((state, session_role, session_version, session_generation, absolute_expires_at, idle_expires_at)) = session else {
        return Err(error_response(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"));
    };
    let now = Utc::now();
    if !active || state != "active" || session_role != role
        || session_version != user_version || session_generation != user_generation
        || absolute_expires_at <= now || idle_expires_at.is_some_and(|deadline| deadline <= now)
    {
        return Err(error_response(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    if role != "owner" && !permissions.iter().any(|value| value == "manageTeam") {
        return Err(error_response(axum::http::StatusCode::FORBIDDEN, "Forbidden: Insufficient permissions"));
    }
    Ok(TeamActor { id: actor.id, role, permissions })
}

fn permissions_document(values: &[String]) -> Value {
    let mut permissions = serde_json::Map::new();
    for permission in TEAM_PERMISSIONS {
        permissions.insert(
            (*permission).to_string(),
            Value::Bool(values.iter().any(|value| value == permission)),
        );
    }
    Value::Object(permissions)
}

fn permissions_array(permissions: &Value) -> Vec<String> {
    TEAM_PERMISSIONS
        .iter()
        .filter(|permission| {
            permissions
                .get(*permission)
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .map(|permission| permission.to_string())
        .collect()
}

fn permissions_json(values: &[String]) -> Value {
    let mut permissions = Map::new();
    for permission in TEAM_PERMISSIONS {
        permissions.insert(permission.to_string(), Value::Bool(values.iter().any(|value| value == permission)));
    }
    Value::Object(permissions)
}

fn member_item(row: TeamMemberRow) -> TeamMemberItem {
    TeamMemberItem {
        id: row.id.to_string(),
        name: row.name,
        email: row.email,
        role: row.role,
        active: row.active,
        two_factor_enabled: row.two_factor_enabled,
        permissions: permissions_json(&row.permissions),
        created_at: row.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        updated_at: row.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        created_by: None,
    }
}

async fn write_team_event(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    target: Uuid,
    action: &'static str,
    payload: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO audit_events(actor,action,outcome,correlation,payload) VALUES($1,$2,'success',$3,$4)")
        .bind(actor.to_string())
        .bind(action)
        .bind(format!("team:{target}"))
        .bind(payload)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn load_member_for_update(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<TeamMemberRow>, sqlx::Error> {
    sqlx::query_as::<_, TeamMemberRow>(
        "SELECT id,name,email,role,active,two_factor_enabled,permissions,created_at,updated_at FROM users WHERE id=$1 AND role IN ('admin','cs') FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
}

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Err(response) = authorize(&headers, &state, "viewTeam", None).await {
        return response;
    }
    let search = query.get("search").map(|value| value.trim().to_lowercase()).unwrap_or_default();
    let rows = match sqlx::query_as::<_, TeamMemberRow>(
        "SELECT id,name,email,role,active,two_factor_enabled,permissions,created_at,updated_at FROM users WHERE role IN ('owner','admin','cs') AND ($1='' OR position($1 in lower(name))>0 OR position($1 in normalized_email)>0) ORDER BY role,created_at DESC,id",
    )
    .bind(search)
    .fetch_all(&state.pg_pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return db_unavailable(),
    };
    let mut summary = TeamSummary::default();
    let members = rows.into_iter().map(|row| {
        summary.total += 1;
        if row.active { summary.active += 1; } else { summary.inactive += 1; }
        match row.role.as_str() { "owner" => summary.owner += 1, "admin" => summary.admin += 1, "cs" => summary.cs += 1, _ => {} }
        member_item(row)
    }).collect();
    Json(TeamListResponse { members, summary }).into_response()
}

pub async fn admin_detail(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&headers, &state, "viewTeam", None).await {
        return response;
    }
    let Some(id) = canonical_user_id(&id) else {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "ID anggota tim tidak valid");
    };
    let row = match sqlx::query_as::<_, TeamMemberRow>(
        "SELECT id,name,email,role,active,two_factor_enabled,permissions,created_at,updated_at FROM users WHERE id=$1 AND role IN ('admin','cs')",
    )
    .bind(id)
    .fetch_optional(&state.pg_pool)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return error_response(axum::http::StatusCode::NOT_FOUND, "Anggota tim tidak ditemukan"),
        Err(_) => return db_unavailable(),
    };
    Json(TeamMemberResponse { member: member_item(row) }).into_response()
}

pub async fn create_member(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TeamMemberPayload>,
) -> Response {
    let actor = match authorize(&headers, &state, "manageTeam", Some("team.manage_privileged")).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let name = normalize_name(payload.name.as_deref().unwrap_or_default());
    if !(2..=80).contains(&name.len()) {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "Nama anggota tim harus 2-80 karakter");
    }
    let email = normalize_email(payload.email.as_deref().unwrap_or_default());
    if !is_valid_email(&email) {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "Format email tidak valid");
    }
    let password = payload.password.unwrap_or_default();
    if password.len() < 6 || password.len() > 100 {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "Password minimal 6 karakter");
    }
    let role = payload.role.unwrap_or_default();
    if let Err(response) = ensure_assignable_role(&actor.role, &role) {
        return response;
    }
    let password_hash = match crate::sql_auth::hash_password(password).await {
        Ok(hash) => hash,
        Err(error) => return error.into_response(),
    };
    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return db_unavailable(),
    };
    let current_actor = match lock_actor(&mut tx, &actor).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if let Err(response) = ensure_assignable_role(&current_actor.role, &role) {
        return response;
    }
    let mut permissions = build_permissions(payload.permissions.as_ref(), &role);
    if current_actor.role != "owner" {
        permissions = clamp_permissions_to_actor(permissions, &permissions_document(&current_actor.permissions));
    }
    let permissions = permissions_array(&permissions);
    let inserted = sqlx::query_as::<_, TeamMemberRow>(
        "INSERT INTO users(email,password_hash,name,role,active,permissions,role_updated_at,policy_updated_at) VALUES($1,$2,$3,$4,TRUE,$5,now(),now()) RETURNING id,name,email,role,active,two_factor_enabled,permissions,created_at,updated_at",
    )
    .bind(&email)
    .bind(password_hash)
    .bind(&name)
    .bind(&role)
    .bind(&permissions)
    .fetch_one(&mut *tx)
    .await;
    let member = match inserted {
        Ok(member) => member,
        Err(error) if error.as_database_error().is_some_and(|database_error| database_error.is_unique_violation()) => {
            return error_response(axum::http::StatusCode::BAD_REQUEST, "Email sudah dipakai akun lain");
        }
        Err(_) => return db_unavailable(),
    };
    if write_team_event(&mut tx, current_actor.id, member.id, "team_member_created", json!({"role":member.role,"permissions":permissions_json(&member.permissions)})).await.is_err() {
        return db_unavailable();
    }
    if tx.commit().await.is_err() { return db_unavailable(); }
    (axum::http::StatusCode::CREATED, Json(json!({"message":"Anggota tim berhasil dibuat","user":member_item(member)}))).into_response()
}

pub async fn update_member(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<TeamMemberPayload>,
) -> Response {
    let actor = match authorize(&headers, &state, "manageTeam", Some("team.manage_privileged")).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(id) = canonical_user_id(&id) else {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "ID anggota tim tidak valid");
    };
    let name = match payload.name {
        Some(value) => {
            let value = normalize_name(&value);
            if !(2..=80).contains(&value.len()) { return error_response(axum::http::StatusCode::BAD_REQUEST, "Nama anggota tim harus 2-80 karakter"); }
            Some(value)
        }
        None => None,
    };
    let email = match payload.email {
        Some(value) => {
            let value = normalize_email(&value);
            if !is_valid_email(&value) { return error_response(axum::http::StatusCode::BAD_REQUEST, "Format email tidak valid"); }
            Some(value)
        }
        None => None,
    };
    let password_hash = match payload.password.filter(|value| !value.is_empty()) {
        Some(password) if !(6..=100).contains(&password.len()) => return error_response(axum::http::StatusCode::BAD_REQUEST, "Password minimal 6 karakter"),
        Some(password) => match crate::sql_auth::hash_password(password).await { Ok(hash) => Some(hash), Err(error) => return error.into_response() },
        None => None,
    };
    let requested_role = payload.role;
    let permissions_input = payload.permissions;
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return db_unavailable() };
    let current_actor = match lock_actor(&mut tx, &actor).await { Ok(actor) => actor, Err(response) => return response };
    let previous = match load_member_for_update(&mut tx, id).await {
        Ok(Some(row)) => row,
        Ok(None) => return error_response(axum::http::StatusCode::NOT_FOUND, "Anggota tim tidak ditemukan"),
        Err(_) => return db_unavailable(),
    };
    if let Err(response) = ensure_manage_scope(&current_actor.role, &previous.role) { return response; }
    let next_role = requested_role.unwrap_or_else(|| previous.role.clone());
    if let Err(response) = ensure_assignable_role(&current_actor.role, &next_role) { return response; }
    let role_changed = next_role != previous.role;
    let role = role_changed.then_some(next_role.clone());
    let permissions_requested = permissions_input.is_some() || role_changed;
    let next_permissions = if permissions_requested {
        let mut permissions = build_permissions(permissions_input.as_ref(), &next_role);
        if current_actor.role != "owner" {
            permissions = clamp_permissions_to_actor(permissions, &permissions_document(&current_actor.permissions));
        }
        Some(permissions_array(&permissions))
    } else { None };
    let name_changed = name.as_ref().is_some_and(|value| value != &previous.name);
    let email_changed = email.as_ref().is_some_and(|value| value != &previous.email);
    let password_changed = password_hash.is_some();
    let permission_changed = next_permissions.as_ref().is_some_and(|values| values != &previous.permissions);
    let security_changed = role_changed || permission_changed || password_changed;
    if !name_changed && !email_changed && !permissions_requested && !security_changed {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "Tidak ada perubahan yang bisa disimpan");
    }
    let update_name = if name_changed { name } else { None };
    let update_email = if email_changed { email } else { None };
    let updated = sqlx::query_as::<_, TeamMemberRow>(
        "UPDATE users SET name=COALESCE($2,name),email=COALESCE($3,email),role=COALESCE($4,role),permissions=COALESCE($5,permissions),password_hash=COALESCE($6,password_hash),role_updated_at=CASE WHEN $7 THEN now() ELSE role_updated_at END,policy_updated_at=CASE WHEN $8 THEN now() ELSE policy_updated_at END,session_version=session_version+CASE WHEN $9 THEN 1 ELSE 0 END,security_generation=security_generation+CASE WHEN $9 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 RETURNING id,name,email,role,active,two_factor_enabled,permissions,created_at,updated_at",
    )
    .bind(id)
    .bind(update_name)
    .bind(update_email)
    .bind(role)
    .bind(next_permissions)
    .bind(password_hash)
    .bind(role_changed)
    .bind(security_changed)
    .bind(security_changed)
    .fetch_one(&mut *tx)
    .await;
    let updated = match updated {
        Ok(row) => row,
        Err(error) if error.as_database_error().is_some_and(|database_error| database_error.is_unique_violation()) => return error_response(axum::http::StatusCode::BAD_REQUEST, "Email sudah dipakai akun lain"),
        Err(_) => return db_unavailable(),
    };
    if security_changed {
        if sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE user_id=$1 AND state IN ('active','locked')")
            .bind(id).execute(&mut *tx).await.is_err() { return db_unavailable(); }
    }
    if write_team_event(&mut tx, current_actor.id, id, "team_member_updated", json!({"before":{"role":previous.role,"active":previous.active,"permissions":permissions_json(&previous.permissions)},"after":{"role":updated.role,"active":updated.active,"permissions":permissions_json(&updated.permissions)},"securityChanged":security_changed})).await.is_err() {
        return db_unavailable();
    }
    if tx.commit().await.is_err() { return db_unavailable(); }
    Json(json!({"message":"Anggota tim berhasil diperbarui","user":member_item(updated)})).into_response()
}

async fn set_member_active(
    headers: axum::http::HeaderMap,
    state: Arc<AppState>,
    raw_id: String,
    forced_active: Option<bool>,
) -> Response {
    let actor = match authorize(&headers, &state, "manageTeam", Some("team.manage_privileged")).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(id) = canonical_user_id(&raw_id) else {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "ID anggota tim tidak valid");
    };
    if id == actor.id { return error_response(axum::http::StatusCode::BAD_REQUEST, "Akun sendiri tidak dapat diarsipkan dari halaman ini"); }
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return db_unavailable() };
    let current_actor = match lock_actor(&mut tx, &actor).await { Ok(actor) => actor, Err(response) => return response };
    let previous = match load_member_for_update(&mut tx,id).await {
        Ok(Some(row)) => row,
        Ok(None) => return error_response(axum::http::StatusCode::NOT_FOUND, "Anggota tim tidak ditemukan"),
        Err(_) => return db_unavailable(),
    };
    if let Err(response) = ensure_manage_scope(&current_actor.role, &previous.role) { return response; }
    let active = forced_active.unwrap_or(!previous.active);
    let security_changed = active != previous.active;
    let updated = match sqlx::query_as::<_,TeamMemberRow>(
        "UPDATE users SET active=$2,updated_at=now(),policy_updated_at=CASE WHEN $3 THEN now() ELSE policy_updated_at END,session_version=session_version+CASE WHEN $3 THEN 1 ELSE 0 END,security_generation=security_generation+CASE WHEN $3 THEN 1 ELSE 0 END WHERE id=$1 RETURNING id,name,email,role,active,two_factor_enabled,permissions,created_at,updated_at",
    )
    .bind(id).bind(active).bind(security_changed)
    .fetch_one(&mut *tx).await {
        Ok(row)=>row,
        Err(_)=>return db_unavailable(),
    };
    if security_changed && sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE user_id=$1 AND state IN ('active','locked')")
        .bind(id).execute(&mut *tx).await.is_err() { return db_unavailable(); }
    let action = if forced_active.is_some() { "team_member_archived" } else if active { "team_member_activated" } else { "team_member_deactivated" };
    if write_team_event(&mut tx,current_actor.id,id,action,json!({"active":active,"previousActive":previous.active})).await.is_err() { return db_unavailable(); }
    if tx.commit().await.is_err() { return db_unavailable(); }
    let message = if forced_active.is_some() { "Anggota tim diarsipkan dan dinonaktifkan" } else if active { "Akun tim berhasil diaktifkan" } else { "Akun tim berhasil dinonaktifkan" };
    if forced_active.is_some() { Json(json!({"message":message})).into_response() }
    else { Json(json!({"message":message,"user":member_item(updated)})).into_response() }
}

pub async fn toggle_member(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    set_member_active(headers,state,id,None).await
}

pub async fn archive_member(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    set_member_active(headers,state,id,Some(false)).await
}
pub async fn reset_member_two_factor(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(raw_id): Path<String>,
) -> Response {
    let actor = match authorize(&headers, &state, "manageTeam", Some("team.reset_2fa")).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(id) = canonical_user_id(&raw_id) else {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "ID anggota tim tidak valid");
    };
    if id == actor.id {
        return error_response(axum::http::StatusCode::BAD_REQUEST, "Akun sendiri tidak dapat direset dari halaman ini");
    }
    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return db_unavailable(),
    };
    let current_actor = match lock_actor(&mut tx, &actor).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let target = match load_member_for_update(&mut tx, id).await {
        Ok(Some(row)) => row,
        Ok(None) => return error_response(axum::http::StatusCode::NOT_FOUND, "Anggota tim tidak ditemukan"),
        Err(_) => return db_unavailable(),
    };
    if let Err(response) = ensure_manage_scope(&current_actor.role, &target.role) {
        return response;
    }
    if sqlx::query("UPDATE users SET two_factor_enabled=FALSE,two_factor_secret=NULL,last_otp_counter=NULL,two_factor_pending_secret=NULL,two_factor_pending_expires_at=NULL,two_factor_enrollment_required_at=CASE WHEN role IN ('owner','admin','cs') THEN now()+interval '24 hours' ELSE NULL END,two_factor_enrollment_completed_at=NULL,session_version=session_version+1,security_generation=security_generation+1,updated_at=now() WHERE id=$1")
        .bind(id).execute(&mut *tx).await.is_err() {
        return db_unavailable();
    }
    if sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=FALSE WHERE user_id=$1 AND state IN ('active','locked')")
        .bind(id).execute(&mut *tx).await.is_err() {
        return db_unavailable();
    }
    if write_team_event(&mut tx, current_actor.id, id, "team_member_2fa_reset", json!({"previouslyEnabled":target.two_factor_enabled})).await.is_err() {
        return db_unavailable();
    }
    if tx.commit().await.is_err() {
        return db_unavailable();
    }
    Json(json!({"message":"Autentikasi dua faktor berhasil direset; anggota harus mengaturnya kembali"})).into_response()
}
