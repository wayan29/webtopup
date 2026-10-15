//! SQL transaction orchestration for revisioned slider mutations.

use std::sync::Arc;

use axum::{extract::State, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    services::managed_asset_registry::{acquire_reference, release_reference, RegistryError},
    state::AppState,
};

use super::slider_idempotency::{
    begin_slider_claim, complete_slider_claim, mark_slider_commit_unknown, mark_slider_transaction_started,
    normalize_slider_claim_binding, normalize_slider_idempotency_key, recover_slider_commit, release_slider_claim,
    store_recovery_identifiers, SliderClaimBegin, SliderClaimBinding, SliderClaimError,
};
use super::slider_snapshot::{lock_rows, SliderRow};
use super::{
    effective_requires_step_up, normalize_create, normalize_update, validate_slider_order_entries,
    SliderAction, SliderCreateRequest, SliderLifecycleRequest, SliderReorderRequest, SliderSnapshotItem,
    SliderUpdateRequest, MAX_CURRENT_SLIDERS, MAX_PUBLIC_SLIDERS, SLIDER_MUTATION_CONTRACT,
};

const SENSITIVE_GROUP: &str = "settings.sensitive";

pub async fn slider_create(headers: HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<Value>) -> Response {
    execute(state, headers, SliderAction::Create, None, payload).await
}
pub async fn slider_update(headers: HeaderMap, State(state): State<Arc<AppState>>, axum::extract::Path(id): axum::extract::Path<String>, Json(payload): Json<Value>) -> Response {
    let Some(target) = parse_id(&id) else { return fail(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"); };
    execute(state, headers, SliderAction::Update, Some(target), payload).await
}
pub async fn slider_archive(headers: HeaderMap, State(state): State<Arc<AppState>>, axum::extract::Path(id): axum::extract::Path<String>, Json(payload): Json<Value>) -> Response {
    let Some(target) = parse_id(&id) else { return fail(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"); };
    execute(state, headers, SliderAction::Archive, Some(target), payload).await
}
pub async fn slider_restore(headers: HeaderMap, State(state): State<Arc<AppState>>, axum::extract::Path(id): axum::extract::Path<String>, Json(payload): Json<Value>) -> Response {
    let Some(target) = parse_id(&id) else { return fail(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"); };
    execute(state, headers, SliderAction::Restore, Some(target), payload).await
}
pub async fn slider_reorder(headers: HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<Value>) -> Response {
    execute(state, headers, SliderAction::Reorder, None, payload).await
}

pub async fn execute_slider_mutation(state: Arc<AppState>, headers: HeaderMap, action: SliderAction, target: Option<Uuid>, payload: Value) -> Response {
    execute(state, headers, action, target, payload).await
}

fn parse_id(raw: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(raw.trim()).ok()?;
    if id.to_string() == raw.trim().to_ascii_lowercase() { Some(id) } else { None }
}

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"message": message, "error": {"code": code, "message": message}}))).into_response()
}

fn claim_error(error: SliderClaimError) -> Response {
    match error {
        SliderClaimError::InvalidKey => fail(StatusCode::BAD_REQUEST, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key tidak valid"),
        SliderClaimError::Fenced => fail(StatusCode::CONFLICT, "SLIDER_CLAIM_FENCE_LOST", "Klaim mutasi slider tidak dapat diamankan"),
        SliderClaimError::Storage => fail(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_CLAIM_UNAVAILABLE", "Klaim mutasi slider tidak tersedia"),
    }
}

enum Prepared {
    Create(super::NormalizedSliderChanges),
    Update { current: SliderRow, next: super::NormalizedSliderChanges },
    Lifecycle { current: SliderRow, expected: i64 },
    Reorder { expected: i64, orders: Vec<(Uuid, i64)> },
}

fn prepare(action: SliderAction, payload: Value, rows: &[SliderRow], target: Option<Uuid>) -> Result<Prepared, Response> {
    match action {
        SliderAction::Create => {
            let request: SliderCreateRequest = serde_json::from_value(payload).map_err(|_| fail(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            normalize_create(request).map(Prepared::Create).map_err(|error| fail(StatusCode::BAD_REQUEST, error.code(), error.message()))
        }
        SliderAction::Update => {
            let current = rows.iter().find(|row| Some(row.id) == target).cloned().ok_or_else(|| fail(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?;
            let request: SliderUpdateRequest = serde_json::from_value(payload).map_err(|_| fail(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            normalize_update(request, &snapshot(&current)).map(|next| Prepared::Update { current, next }).map_err(|error| fail(StatusCode::BAD_REQUEST, error.code(), error.message()))
        }
        SliderAction::Archive | SliderAction::Restore => {
            let current = rows.iter().find(|row| Some(row.id) == target).cloned().ok_or_else(|| fail(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?;
            let request: SliderLifecycleRequest = serde_json::from_value(payload).map_err(|_| fail(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            if request.expected_revision < 0 { return Err(fail(StatusCode::BAD_REQUEST, "SLIDER_REVISION_INVALID", "expectedRevision harus bilangan bulat non-negatif")); }
            Ok(Prepared::Lifecycle { current, expected: request.expected_revision })
        }
        SliderAction::Reorder => {
            let request: SliderReorderRequest = serde_json::from_value(payload).map_err(|_| fail(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            if request.expected_revision < 0 { return Err(fail(StatusCode::BAD_REQUEST, "SLIDER_REVISION_INVALID", "expectedRevision harus bilangan bulat non-negatif")); }
            let orders = request.orders.iter().map(|item| parse_id(&item.id).map(|id| (id, item.sort_order))).collect::<Option<Vec<_>>>().ok_or_else(|| fail(StatusCode::BAD_REQUEST, "SLIDER_ORDER_INVALID", "Urutan slider harus mencakup semua ID tepat sekali dengan sortOrder 0..n-1"))?;
            validate_slider_order_entries(&orders).map_err(|error| fail(StatusCode::BAD_REQUEST, error.code(), error.message()))?;
            Ok(Prepared::Reorder { expected: request.expected_revision, orders })
        }
    }
}

fn snapshot(row: &SliderRow) -> SliderSnapshotItem {
    SliderSnapshotItem { id: row.id, name: row.name.clone(), image: row.image.clone(), link: row.link.clone(), sort_order: row.sort_order, status: row.status, lifecycle: row.lifecycle.clone() }
}

fn expected_of(prepared: &Prepared) -> i64 {
    match prepared {
        Prepared::Create(value) | Prepared::Update { next: value, .. } => value.expected_revision,
        Prepared::Lifecycle { expected, .. } | Prepared::Reorder { expected, .. } => *expected,
    }
}

fn canonical_payload(prepared: &Prepared) -> Value {
    match prepared {
        Prepared::Create(value) | Prepared::Update { next: value, .. } => serde_json::to_value(value).unwrap_or(Value::Null),
        Prepared::Lifecycle { expected, current } => json!({"expectedRevision": expected, "id": current.id.to_string()}),
        Prepared::Reorder { expected, orders } => json!({"expectedRevision": expected, "orders": orders.iter().map(|(id, order)| json!({"id": id.to_string(), "sortOrder": order})).collect::<Vec<_>>()}),
    }
}

fn resource(id: Uuid) -> String { format!("sliders:{id}:image") }

async fn reference(tx: &mut Transaction<'_, Postgres>, old: Option<&str>, new: &str, id: Uuid) -> Result<(), RegistryError> {
    if old != Some(new) {
        if let Some(previous) = old { release_reference(tx, previous, &resource(id)).await?; }
        acquire_reference(tx, new, &resource(id)).await?;
    }
    Ok(())
}

async fn apply(tx: &mut Transaction<'_, Postgres>, action: SliderAction, prepared: &Prepared, actor: Uuid, rows: &[SliderRow]) -> Result<(Uuid, Value), Response> {
    let active: Vec<&SliderRow> = rows.iter().filter(|row| row.lifecycle == "active").collect();
    match prepared {
        Prepared::Create(next) => {
            if active.len() as i64 >= MAX_CURRENT_SLIDERS { return Err(fail(StatusCode::CONFLICT, "SLIDER_LIMIT_REACHED", "Jumlah slider aktif mencapai batas")); }
            if next.status && active.iter().filter(|row| row.status).count() as i64 >= MAX_PUBLIC_SLIDERS { return Err(fail(StatusCode::CONFLICT, "SLIDER_PUBLIC_LIMIT_REACHED", "Jumlah slider publik mencapai batas")); }
            let id = Uuid::new_v4();
            let order = active.iter().map(|row| row.sort_order).max().unwrap_or(-1) + 1;
            reference(tx, None, &next.image, id).await.map_err(registry_error)?;
            sqlx::query("INSERT INTO content_sliders(id, name, image, link, status, lifecycle, sort_order, revision) VALUES($1,$2,$3,$4,$5,'active',$6,1)")
                .bind(id).bind(&next.name).bind(&next.image).bind(&next.link).bind(next.status).bind(order).execute(&mut **tx).await.map_err(|_| unavailable())?;
            Ok((id, json!({"message": "Slider dibuat", "slider": {"_id": id.to_string(), "name": next.name, "image": next.image, "link": next.link, "status": next.status, "sortOrder": order}})))
        }
        Prepared::Update { current, next } => {
            if current.lifecycle == "active" && !current.status && next.status && active.iter().filter(|row| row.status).count() as i64 >= MAX_PUBLIC_SLIDERS {
                return Err(fail(StatusCode::CONFLICT, "SLIDER_PUBLIC_LIMIT_REACHED", "Jumlah slider publik mencapai batas"));
            }
            reference(tx, Some(&current.image), &next.image, current.id).await.map_err(registry_error)?;
            sqlx::query("UPDATE content_sliders SET name=$2, image=$3, link=$4, status=$5, revision=revision+1, updated_at=now() WHERE id=$1")
                .bind(current.id).bind(&next.name).bind(&next.image).bind(&next.link).bind(next.status).execute(&mut **tx).await.map_err(|_| unavailable())?;
            Ok((current.id, json!({"message": "Slider diperbarui", "slider": {"_id": current.id.to_string(), "name": next.name, "image": next.image, "link": next.link, "status": next.status}})))
        }
        Prepared::Lifecycle { current, .. } if action == SliderAction::Archive => {
            if current.lifecycle != "active" { return Err(fail(StatusCode::CONFLICT, "SLIDER_NOT_CURRENT", "Slider bukan slider aktif")); }
            let compacted = active.iter().filter(|row| row.id != current.id).enumerate();
            for (index, row) in compacted {
                sqlx::query("UPDATE content_sliders SET sort_order=$2, revision=revision+1, updated_at=now() WHERE id=$1 AND sort_order<>$2").bind(row.id).bind(index as i64).execute(&mut **tx).await.map_err(|_| unavailable())?;
            }
            release_reference(tx, &current.image, &resource(current.id)).await.map_err(registry_error)?;
            sqlx::query("UPDATE content_sliders SET lifecycle='archived', sort_order=0, status=false, archived_at=now(), archived_by=$2, revision=revision+1, updated_at=now() WHERE id=$1")
                .bind(current.id).bind(actor).execute(&mut **tx).await.map_err(|_| unavailable())?;
            Ok((current.id, json!({"message": "Slider diarsipkan", "slider": {"_id": current.id.to_string(), "lifecycle": "archived"}})))
        }
        Prepared::Lifecycle { current, .. } => {
            if current.lifecycle != "archived" { return Err(fail(StatusCode::CONFLICT, "SLIDER_NOT_ARCHIVED", "Slider bukan arsip")); }
            if active.len() as i64 >= MAX_CURRENT_SLIDERS { return Err(fail(StatusCode::CONFLICT, "SLIDER_LIMIT_REACHED", "Jumlah slider aktif mencapai batas")); }
            let order = active.len() as i64;
            acquire_reference(tx, &current.image, &resource(current.id)).await.map_err(registry_error)?;
            sqlx::query("UPDATE content_sliders SET lifecycle='active', status=false, sort_order=$2, archived_at=NULL, archived_by=NULL, revision=revision+1, updated_at=now() WHERE id=$1")
                .bind(current.id).bind(order).execute(&mut **tx).await.map_err(|_| unavailable())?;
            Ok((current.id, json!({"message": "Slider dipulihkan", "slider": {"_id": current.id.to_string(), "lifecycle": "active", "sortOrder": order, "status": false}})))
        }
        Prepared::Reorder { orders, .. } => {
            let current_ids: Vec<Uuid> = active.iter().map(|row| row.id).collect();
            if current_ids.len() != orders.len() || orders.iter().any(|(id, _)| !current_ids.contains(id)) {
                return Err(fail(StatusCode::CONFLICT, "SLIDER_ORDER_STALE", "Daftar urutan tidak sama dengan slider aktif"));
            }
            for (id, order) in orders {
                sqlx::query("UPDATE content_sliders SET sort_order=$2, revision=revision+1, updated_at=now() WHERE id=$1").bind(id).bind(order).execute(&mut **tx).await.map_err(|_| unavailable())?;
            }
            Ok((orders.first().map(|(id, _)| *id).unwrap_or(Uuid::nil()), json!({"message": "Urutan slider diperbarui"})))
        }
    }
}

fn registry_error(error: RegistryError) -> Response {
    let status = match error { RegistryError::NotFound | RegistryError::AlreadyDeleting | RegistryError::ReferenceMismatch => StatusCode::CONFLICT, RegistryError::PathInvalid => StatusCode::BAD_REQUEST, _ => StatusCode::SERVICE_UNAVAILABLE };
    fail(status, error.code(), "Referensi gambar slider tidak dapat diperbarui")
}
fn unavailable() -> Response { fail(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_UNAVAILABLE", "Slider tidak tersedia") }

fn needs_step_up(action: SliderAction, prepared: &Prepared, rows: &[SliderRow]) -> bool {
    let public_order = |rows: &[SliderRow]| rows.iter().filter(|row| row.lifecycle == "active" && row.status).map(|row| row.id).collect::<Vec<_>>();
    match prepared {
        Prepared::Create(next) => effective_requires_step_up(action, None, Some(&SliderSnapshotItem { id: Uuid::nil(), name: next.name.clone(), image: next.image.clone(), link: next.link.clone(), sort_order: 0, status: next.status, lifecycle: "active".into() }), &[], &[]),
        Prepared::Update { current, next } => effective_requires_step_up(action, Some(&snapshot(current)), Some(&SliderSnapshotItem { id: current.id, name: next.name.clone(), image: next.image.clone(), link: next.link.clone(), sort_order: current.sort_order, status: next.status, lifecycle: current.lifecycle.clone() }), &[], &[]),
        Prepared::Lifecycle { current, .. } => effective_requires_step_up(action, Some(&snapshot(current)), None, &[], &[]),
        Prepared::Reorder { orders, .. } => {
            let mut next = rows.iter().filter(|row| row.lifecycle == "active").cloned().collect::<Vec<_>>();
            for row in &mut next { if let Some((_, order)) = orders.iter().find(|(id, _)| *id == row.id) { row.sort_order = *order; } }
            next.sort_by_key(|row| row.sort_order);
            effective_requires_step_up(action, None, None, &public_order(rows), &public_order(&next))
        }
    }
}

async fn execute(state: Arc<AppState>, headers: HeaderMap, action: SliderAction, target: Option<Uuid>, payload: Value) -> Response {
    let operator = match crate::security::require_sql_permission(&headers, &state, "manageSettings").await { Ok(user) => user, Err(response) => return response };
    let key = match headers.get("idempotency-key").and_then(|value| value.to_str().ok()).ok_or(SliderClaimError::InvalidKey).and_then(normalize_slider_idempotency_key) {
        Ok(key) => key, Err(error) => return claim_error(error),
    };
    let initial_rows = match sqlx::query("SELECT id, name, image, link, sort_order, status, lifecycle, revision, created_at, updated_at, archived_at, archived_by FROM content_sliders").fetch_all(&state.pg_pool).await {
        Ok(rows) => rows.iter().map(|row| SliderRow { id: row.get("id"), name: row.get("name"), image: row.get("image"), link: row.get("link"), sort_order: row.get("sort_order"), status: row.get("status"), lifecycle: row.get("lifecycle"), revision: row.get("revision"), created_at: row.get("created_at"), updated_at: row.get("updated_at"), archived_at: row.get("archived_at"), archived_by: row.get("archived_by") }).collect::<Vec<_>>(),
        Err(_) => return unavailable(),
    };
    let prepared = match prepare(action, payload, &initial_rows, target) { Ok(value) => value, Err(response) => return response };
    let digest = crate::services::idempotency::sha256_hex(serde_json::to_vec(&json!({"action": action.as_str(), "contract": SLIDER_MUTATION_CONTRACT, "target": target.map(|id| id.to_string()), "payload": canonical_payload(&prepared)})).unwrap_or_default().as_slice());
    let binding = match normalize_slider_claim_binding(&SliderClaimBinding { key, contract_version: SLIDER_MUTATION_CONTRACT.into(), operator_id: operator.id, action: action.as_str().into(), target_id: target, expected_revision: expected_of(&prepared), payload_digest: digest }) {
        Ok(binding) => binding, Err(error) => return claim_error(error),
    };
    let (token, generation) = match begin_slider_claim(&state.pg_pool, &binding).await {
        Ok(SliderClaimBegin::Completed { status, body, .. }) => return (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), Json(body)).into_response(),
        Ok(SliderClaimBegin::Conflict) => return fail(StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah digunakan untuk payload lain"),
        Ok(SliderClaimBegin::InProgress) => return fail(StatusCode::CONFLICT, "IDEMPOTENCY_IN_PROGRESS", "Mutasi slider masih diproses"),
        Ok(SliderClaimBegin::CommitUnknown) => return match recover_slider_commit(&state.pg_pool, &binding).await { Ok(Some(found)) => (StatusCode::from_u16(found.status).unwrap_or(StatusCode::OK), Json(found.body)).into_response(), _ => fail(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan") },
        Ok(SliderClaimBegin::Started { claim_token, lease_generation }) => (claim_token, lease_generation),
        Err(error) => return claim_error(error),
    };
    if needs_step_up(action, &prepared, &initial_rows) {
        if let Err(auth) = crate::sql_auth::verify_step_up(&headers, &state, &operator, SENSITIVE_GROUP, Utc::now()) {
            let _ = release_slider_claim(&state.pg_pool, &binding, &token, generation).await;
            return fail(StatusCode::FORBIDDEN, auth.code, "Verifikasi ulang diperlukan");
        }
    }
    let candidate = match &prepared { Prepared::Create(_) => Some(Uuid::new_v4()), _ => target };
    if store_recovery_identifiers(&state.pg_pool, &binding, &token, generation, candidate, expected_of(&prepared) + 1).await.is_err() { return claim_error(SliderClaimError::Fenced); }
    if mark_slider_transaction_started(&state.pg_pool, &binding, &token, generation).await.is_err() { return claim_error(SliderClaimError::Fenced); }
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return fail(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"); } };
    let (revision, rows) = match lock_rows(&mut tx).await { Ok(value) => value, Err(_) => { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return fail(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"); } };
    if revision != expected_of(&prepared) {
        let body = json!({"message": "Revisi slider sudah berubah", "error": {"code": "SLIDER_REVISION_CONFLICT", "message": "Revisi slider sudah berubah"}, "revision": revision});
        if complete_slider_claim(&mut tx, &binding, &token, generation, 409, &body, revision).await.is_err() { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return claim_error(SliderClaimError::Fenced); }
        if tx.commit().await.is_err() { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return fail(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"); }
        return (StatusCode::CONFLICT, Json(body)).into_response();
    }
    let (id, mut body) = match apply(&mut tx, action, &prepared, operator.id, &rows).await { Ok(value) => value, Err(response) => { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return response; } };
    let next_revision = match sqlx::query_scalar::<_, i64>("UPDATE content_revisions SET revision=revision+1 WHERE domain='sliders' RETURNING revision").fetch_one(&mut *tx).await { Ok(value) => value, Err(_) => { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return unavailable(); } };
    if let Some(object) = body.as_object_mut() { object.insert("revision".to_string(), json!(next_revision)); }
    let _ = sqlx::query("INSERT INTO audit_events(actor, action, outcome, correlation, payload) VALUES($1, $2, 'success', $3, $4)")
        .bind(operator.id.to_string()).bind(format!("slider.{action}", action = action.as_str())).bind(id.to_string()).bind(json!({"target": id.to_string(), "revision": next_revision})).execute(&mut *tx).await;
    if complete_slider_claim(&mut tx, &binding, &token, generation, 200, &body, next_revision).await.is_err() { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return claim_error(SliderClaimError::Fenced); }
    if tx.commit().await.is_err() { let _ = mark_slider_commit_unknown(&state.pg_pool, &binding, &token, generation).await; return fail(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"); }
    (StatusCode::OK, Json(body)).into_response()
}
