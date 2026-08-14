use std::sync::Arc;

use axum::{
    extract::{Multipart, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use crate::{
    security::{require_any_permission, ErrorResponse},
    services::{
        idempotency::{commit_mongo_transaction_with_unknown_retry, TransactionCommitOutcome},
        managed_asset_registry::{
            count_slider_references_for_deletion, load_asset_for_deletion,
            managed_asset_deletion_ready, register_published_batch_in_transaction,
            transition_asset_to_deleting, deletion_reference_check, DeletionOutcome,
            DeletionReferenceCheck, ManagedAssetState, RegistryError,
        },
        managed_assets::{
            count_asset_references_in_session, normalize_managed_asset,
            managed_asset_registry_unavailable_response,
        },
    },
    state::AppState,
};

use super::{
    policy::{
        validate_and_reencode_image, ImagePolicyError, MAX_UPLOAD_BATCH_BYTES,
        MAX_UPLOAD_BATCH_FILES, MAX_UPLOAD_BYTES,
    },
    publication::{stage_canonical_image, UploadStorageError},
    storage::{list_uploaded_files, upload_root},
    types::{
        AssetInUseErrorBody, AssetInUseErrorEnvelope, UploadDeleteQuery, UploadDeleteResponse,
        UploadErrorBody, UploadErrorEnvelope, UploadListQuery, UploadListResponse,
        UploadMultipleResponse, UploadResponse, UploadedFileResponse,
    },
    validation::{is_safe_filename, resolve_upload_folder},
};

pub async fn list_files(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<UploadListQuery>,
) -> Response {
    if let Err(response) =
        require_upload_permission(&headers, &state, query.upload_type.as_deref()).await
    {
        return response;
    }

    let (folder, files) = list_uploaded_files(query.upload_type.as_deref());
    Json(UploadListResponse {
        success: true,
        files,
        folder,
    })
    .into_response()
}

pub async fn upload_file(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<UploadListQuery>,
    mut multipart: Multipart,
) -> Response {
    if let Err(response) =
        require_upload_permission(&headers, &state, query.upload_type.as_deref()).await
    {
        return response;
    }

    while let Ok(Some(mut field)) = multipart.next_field().await {
        if field.file_name().is_none() {
            continue;
        }

        let bytes = match read_bounded_field(&mut field).await {
            Ok(bytes) => bytes,
            Err(error) => return error.into_response(),
        };
        let image = match validate_and_reencode_image(&bytes) {
            Ok(image) => image,
            Err(error) => return error.into_response(),
        };

        let folder = resolve_upload_folder(query.upload_type.as_deref());
        let root = upload_root();
        let staged = match stage_canonical_image(&root, &folder, image) {
            Ok(staged) => staged,
            Err(error) => return error.into_response(),
        };
        let published = match publish_and_register_with_state(&state, vec![staged]).await {
            Ok(published) => published,
            Err(error) => return error.into_response(),
        };
        let Some(file) = published.into_iter().next() else {
            return UploadStorageError::Failed.into_response();
        };

        return Json(UploadResponse {
            success: true,
            url: file.url,
            filename: file.filename,
        })
        .into_response();
    }

    status_message(axum::http::StatusCode::BAD_REQUEST, "No file uploaded")
}

pub async fn upload_multiple(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<UploadListQuery>,
    mut multipart: Multipart,
) -> Response {
    if let Err(response) =
        require_upload_permission(&headers, &state, query.upload_type.as_deref()).await
    {
        return response;
    }

    let folder = resolve_upload_folder(query.upload_type.as_deref());
    let root = upload_root();
    let mut staged_items = Vec::new();
    let mut file_count = 0usize;
    let mut aggregate_bytes = 0usize;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        if field.file_name().is_none() {
            continue;
        }

        file_count = file_count.saturating_add(1);
        if file_count > MAX_UPLOAD_BATCH_FILES {
            return ImagePolicyError::UploadBatchLimitExceeded.into_response();
        }

        let bytes = match read_bounded_field(&mut field).await {
            Ok(bytes) => bytes,
            Err(error) => return error.into_response(),
        };
        aggregate_bytes = aggregate_bytes.saturating_add(bytes.len());
        if aggregate_bytes > MAX_UPLOAD_BATCH_BYTES {
            return ImagePolicyError::UploadBatchLimitExceeded.into_response();
        }

        let image = match validate_and_reencode_image(&bytes) {
            Ok(image) => image,
            Err(error) => return error.into_response(),
        };
        match stage_canonical_image(&root, &folder, image) {
            Ok(staged) => staged_items.push(staged),
            Err(error) => return error.into_response(),
        }
    }

    if staged_items.is_empty() {
        return batch_error(
            axum::http::StatusCode::BAD_REQUEST,
            "NO_FILES_UPLOADED",
            "Tidak ada file yang diunggah",
        );
    }

    match publish_and_register_with_state(&state, staged_items).await {
        Ok(published) => Json(UploadMultipleResponse {
            success: true,
            files: published
                .into_iter()
                .map(|file| UploadedFileResponse {
                    url: file.url,
                    filename: file.filename,
                })
                .collect(),
        })
        .into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn delete_file(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<UploadDeleteQuery>,
) -> Response {
    if let Err(response) =
        require_upload_permission(&headers, &state, query.upload_type.as_deref()).await
    {
        return response;
    }

    let Some(filename) = query.filename.as_deref().filter(|value| !value.is_empty()) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Filename is required");
    };

    if !is_safe_filename(filename) {
        return status_message(axum::http::StatusCode::NOT_FOUND, "File not found");
    }

    let folder = resolve_upload_folder(query.upload_type.as_deref());
    if !managed_asset_deletion_ready(&folder) {
        return managed_asset_registry_unavailable_response();
    }
    let root = upload_root();
    let managed = match normalize_managed_asset(&root, &folder, filename) {
        Ok(managed) => managed,
        Err(_) => return status_message(axum::http::StatusCode::NOT_FOUND, "File not found"),
    };

    let Some(client) = state.mongo_client.as_ref() else {
        return managed_asset_registry_unavailable_response();
    };
    if !state.mongo_transactions_enabled {
        return managed_asset_registry_unavailable_response();
    }
    let db = client.database(&state.mongo_db);
    if !managed.filesystem_path.is_file() {
        // A missing file is an integrity/reconciliation finding, not proof that an unregistered
        // historical path may be deleted through this protocol.
        return managed_asset_registry_unavailable_response();
    }

    let outcome = match transact_asset_deletion(&db, &managed.url).await {
        DeletionTransactionOutcome::Committed(outcome) => outcome,
        DeletionTransactionOutcome::AssetInUse(references) => return asset_in_use(references),
        DeletionTransactionOutcome::Unavailable => return managed_asset_registry_unavailable_response(),
    };

    if crate::services::local_fault::consume_managed_asset_unlink_fault().await {
        return managed_asset_registry_unavailable_response();
    }

    let unlink_result = std::fs::remove_file(&managed.filesystem_path);
    if let Err(error) = unlink_result {
        if error.kind() != std::io::ErrorKind::NotFound {
            return managed_asset_registry_unavailable_response();
        }
    }

    if !mark_asset_deleted_after_unlink(&db, outcome.asset_id).await {
        return managed_asset_registry_unavailable_response();
    }

    Json(UploadDeleteResponse {
        success: true,
        message: "File deleted successfully",
    })
    .into_response()
}

async fn publish_and_register_with_state(
    state: &AppState,
    staged: Vec<super::publication::StagedUpload>,
) -> Result<Vec<super::publication::PublishedUpload>, UploadStorageError> {
    let Some(client) = state.mongo_client.as_ref() else {
        return Err(UploadStorageError::RegistryUnavailable);
    };
    if !state.mongo_transactions_enabled {
        return Err(UploadStorageError::RegistryUnavailable);
    }
    let db = client.database(&state.mongo_db);
    super::publication::publish_and_register_batch(staged, move |published| {
        let registrations = published
            .iter()
            .map(super::publication::PublishedUpload::registry_registration)
            .collect::<Vec<_>>();
        async move {
            register_published_batch_in_transaction(&db, &registrations)
                .await
                .map(|_| ())
        }
    })
    .await
}

async fn read_bounded_field(
    field: &mut axum::extract::multipart::Field<'_>,
) -> Result<Vec<u8>, ImagePolicyError> {
    let mut bytes = Vec::new();
    loop {
        match field.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len().saturating_add(chunk.len()) > MAX_UPLOAD_BYTES {
                    return Err(ImagePolicyError::UploadTooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Err(ImagePolicyError::InvalidImageContent),
        }
    }
    if bytes.is_empty() {
        return Err(ImagePolicyError::UnsupportedImageFormat);
    }
    Ok(bytes)
}

async fn require_upload_permission(
    headers: &axum::http::HeaderMap,
    state: &AppState,
    upload_type: Option<&str>,
) -> Result<(), Response> {
    let permissions: &[&str] = match upload_type.unwrap_or_default() {
        "icons" => &["manageProducts", "managePayment", "manageSettings"],
        "covers" | "popups" => &["manageProducts", "manageSettings"],
        "instructions" => &["manageProducts"],
        _ => &["manageProducts", "managePayment", "manageSettings"],
    };
    require_any_permission(headers, state, permissions)
        .await
        .map(|_| ())
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn batch_error(status: axum::http::StatusCode, code: &'static str, message: &'static str) -> Response {
    (
        status,
        Json(UploadErrorEnvelope {
            error: UploadErrorBody { code, message },
        }),
    )
        .into_response()
}

#[derive(Debug)]
enum DeletionTransactionOutcome {
    Committed(DeletionOutcome),
    AssetInUse(Vec<crate::services::managed_assets::AssetReferenceSummary>),
    Unavailable,
}

const MAX_DELETION_TRANSACTION_RETRIES: usize = 3;

/// Only registry errors explicitly mapped from Mongo's retryable labels may restart the complete
/// deletion transaction. All other registry failures remain fail closed.
fn is_retryable_deletion_error(error: RegistryError) -> bool {
    matches!(error, RegistryError::TransientTransaction)
}

/// Run the deletion decision in a transaction, restarting every read (including the legacy
/// inventory scan) after a transient conflict. The same managed asset document is read and
/// conditionally updated, fencing registry acquisition and Task 5 legacy writers.
async fn transact_asset_deletion(
    db: &mongodb::Database,
    path: &str,
) -> DeletionTransactionOutcome {
    for _attempt in 0..MAX_DELETION_TRANSACTION_RETRIES {
        let mut session = match db.client().start_session().await {
            Ok(session) => session,
            Err(_) => return DeletionTransactionOutcome::Unavailable,
        };
        if session.start_transaction().await.is_err() {
            return DeletionTransactionOutcome::Unavailable;
        }

        let snapshot = match load_asset_for_deletion(&mut session, db, path).await {
            Ok(snapshot) => snapshot,
            Err(RegistryError::NotFound)
            | Err(RegistryError::PathInvalid)
            | Err(RegistryError::Storage)
            | Err(RegistryError::Unavailable)
            | Err(RegistryError::AlreadyDeleting)
            | Err(RegistryError::ReferenceMismatch)
            | Err(RegistryError::ReferenceUnderflow)
            | Err(RegistryError::TransactionAbortFailed)
            | Err(RegistryError::AmbiguousCommit) => {
                let _ = session.abort_transaction().await;
                return DeletionTransactionOutcome::Unavailable;
            }
            Err(RegistryError::TransientTransaction) => {
                if session.abort_transaction().await.is_ok() {
                    continue;
                }
                return DeletionTransactionOutcome::Unavailable;
            }
        };
        if snapshot.state != ManagedAssetState::Available {
            let _ = session.abort_transaction().await;
            return DeletionTransactionOutcome::Unavailable;
        }

        let actual_slider_references = match count_slider_references_for_deletion(
            &mut session,
            db,
            snapshot.asset_id,
            path,
        )
        .await
        {
            Ok(count) => count,
            Err(error) => {
                let abort_ok = session.abort_transaction().await.is_ok();
                if is_retryable_deletion_error(error) && abort_ok {
                    continue;
                }
                return DeletionTransactionOutcome::Unavailable;
            }
        };
        let legacy_references = match count_asset_references_in_session(&mut session, db, path).await
        {
            Ok(references) => references,
            Err(error) => {
                let retryable = error.contains_label(mongodb::error::TRANSIENT_TRANSACTION_ERROR)
                    || error.contains_label(mongodb::error::RETRYABLE_WRITE_ERROR)
                    || error.contains_label(mongodb::error::RETRYABLE_ERROR);
                let abort_ok = session.abort_transaction().await.is_ok();
                if retryable && abort_ok {
                    continue;
                }
                return DeletionTransactionOutcome::Unavailable;
            }
        };

        let reference_check = deletion_reference_check(
            snapshot.reference_count,
            actual_slider_references,
            !legacy_references.is_empty(),
        );
        match reference_check {
            DeletionReferenceCheck::AssetInUse => {
                let _ = session.abort_transaction().await;
                let mut references = legacy_references;
                if actual_slider_references > 0 && !references.iter().any(|reference| {
                    reference.resource == "Sliders"
                }) {
                    references.push(crate::services::managed_assets::AssetReferenceSummary {
                        resource: "Sliders",
                        count: actual_slider_references as u64,
                    });
                }
                return DeletionTransactionOutcome::AssetInUse(references);
            }
            DeletionReferenceCheck::RegistryUnavailable => {
                let _ = session.abort_transaction().await;
                return DeletionTransactionOutcome::Unavailable;
            }
            DeletionReferenceCheck::Clear => {}
        }

        let outcome = match transition_asset_to_deleting(&mut session, db, path, &snapshot).await {
            Ok(outcome) => outcome,
            Err(RegistryError::Unavailable) | Err(RegistryError::TransientTransaction) => {
                // A conditional update miss is a transaction conflict. Retry from a fresh
                // transaction so the legacy scan cannot be reused after a writer race.
                let abort_ok = session.abort_transaction().await.is_ok();
                if abort_ok {
                    continue;
                }
                return DeletionTransactionOutcome::Unavailable;
            }
            Err(_) => {
                let _ = session.abort_transaction().await;
                return DeletionTransactionOutcome::Unavailable;
            }
        };

        match commit_mongo_transaction_with_unknown_retry(&mut session).await {
            TransactionCommitOutcome::Committed => {
                return DeletionTransactionOutcome::Committed(outcome);
            }
            TransactionCommitOutcome::Ambiguous | TransactionCommitOutcome::FailedDefinitely => {
                // No commit outcome authorizes unlink. The asset remains deleting or is left for
                // reconciliation; never retry this decision with a potentially durable transition.
                return DeletionTransactionOutcome::Unavailable;
            }
        }
    }
    DeletionTransactionOutcome::Unavailable
}

async fn mark_asset_deleted_after_unlink(db: &mongodb::Database, asset_id: mongodb::bson::oid::ObjectId) -> bool {
    let Ok(mut session) = db.client().start_session().await else {
        return false;
    };
    if session.start_transaction().await.is_err() {
        return false;
    }
    if crate::services::managed_asset_registry::mark_asset_deleted(&mut session, db, asset_id)
        .await
        .is_err()
    {
        let _ = session.abort_transaction().await;
        return false;
    }
    matches!(
        commit_mongo_transaction_with_unknown_retry(&mut session).await,
        TransactionCommitOutcome::Committed
    )
}

fn asset_in_use(
    references: Vec<crate::services::managed_assets::AssetReferenceSummary>,
) -> Response {
    (
        axum::http::StatusCode::CONFLICT,
        Json(AssetInUseErrorEnvelope {
            error: AssetInUseErrorBody {
                code: "ASSET_IN_USE",
                message: "Asset masih digunakan",
                references,
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    #[test]
    fn upload_delete_registry_retries_transient_slider_scan_and_reruns_legacy_scan() {
        let source = include_str!("handlers.rs");
        let transaction_start = source
            .find("for _attempt in 0..MAX_DELETION_TRANSACTION_RETRIES")
            .expect("deletion transaction retry loop");
        let slider_scan_start = source
            .find("let actual_slider_references = match count_slider_references_for_deletion")
            .expect("slider reference scan");
        let legacy_scan_start = source
            .find("let legacy_references = match count_asset_references_in_session")
            .expect("legacy reference scan");
        assert!(transaction_start < slider_scan_start);
        assert!(slider_scan_start < legacy_scan_start);

        let slider_scan = &source[slider_scan_start..legacy_scan_start];
        assert!(slider_scan.contains("Err(error)"), "slider errors must be classified");
        assert!(slider_scan.contains("is_retryable_deletion_error"));
        assert!(slider_scan.contains("abort_transaction"));
        assert!(slider_scan.contains("continue"));
        assert!(!slider_scan.contains("legacy_references"));
    }
}
