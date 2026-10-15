use std::sync::Arc;

use axum::{
    extract::{Multipart, Query, State},
    response::{IntoResponse, Response},
    Json,
};

use crate::{
    security::ErrorResponse,
    services::{
        managed_asset_registry::{
            finish_operation, managed_asset_deletion_ready, prepare_deletion, DeleteDecision,
        },
        managed_assets::{managed_asset_registry_unavailable_response, normalize_managed_asset},
    },
    state::AppState,
};

use super::{
    policy::{
        validate_and_reencode_image, ImagePolicyError, MAX_UPLOAD_BATCH_BYTES,
        MAX_UPLOAD_BATCH_FILES, MAX_UPLOAD_BYTES,
    },
    publication::{publish_sql_batch, stage_canonical_image, UploadStorageError},
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
        // Publication is journaled first; the file only becomes public when the journal
        // operation commits the managed-assets rows together with the final rename.
        let published = match publish_sql_batch(&state.pg_pool, &root, vec![staged]).await {
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

    match publish_sql_batch(&state.pg_pool, &root, staged_items).await {
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

    if !managed.filesystem_path.is_file() {
        // A missing file is an integrity/reconciliation finding, not proof that an unregistered
        // historical path may be deleted through this protocol.
        return managed_asset_registry_unavailable_response();
    }

    // The decision locks the managed-asset row: references committed before this call are
    // visible as in-use, and every reference acquired after the commit sees the `deleting`
    // state and fails closed.
    let operation_id = match prepare_deletion(&state.pg_pool, &managed.url).await {
        Ok(DeleteDecision::Ready(operation_id)) => operation_id,
        Ok(DeleteDecision::InUse(references)) => return asset_in_use(references),
        Err(_) => return managed_asset_registry_unavailable_response(),
    };

    if crate::services::local_fault::consume_managed_asset_unlink_fault().await {
        return managed_asset_registry_unavailable_response();
    }

    // The journal owns the unlink and the terminal state transition. An interrupted finish is
    // retried by startup recovery before the listener serves uploads, so no outcome here
    // authorizes an out-of-band filesystem deletion.
    if finish_operation(&state.pg_pool, &root, operation_id)
        .await
        .is_err()
    {
        return managed_asset_registry_unavailable_response();
    }

    Json(UploadDeleteResponse {
        success: true,
        message: "File deleted successfully",
    })
    .into_response()
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

/// Per-folder permission policy of the upload routes. Authorization follows
/// `security::require_sql_permission` semantics: owners pass, any granted permission passes,
/// everything else is forbidden.
async fn require_upload_permission(
    headers: &axum::http::HeaderMap,
    state: &AppState,
    upload_type: Option<&str>,
) -> Result<(), Response> {
    let permissions = upload_permissions(upload_type.unwrap_or_default());
    let user = crate::security::require_sql_user(headers, state).await?;
    if user.role == "owner"
        || user
            .permissions
            .iter()
            .any(|granted| permissions.contains(&granted.as_str()))
    {
        return Ok(());
    }
    Err((
        axum::http::StatusCode::FORBIDDEN,
        Json(serde_json::json!({"message": "Forbidden: Insufficient permissions"})),
    )
        .into_response())
}

fn upload_permissions(upload_type: &str) -> &'static [&'static str] {
    match upload_type {
        "icons" => &["manageProducts", "managePayment", "manageSettings"],
        "covers" | "popups" => &["manageProducts", "manageSettings"],
        "instructions" => &["manageProducts"],
        _ => &["manageProducts", "managePayment", "manageSettings"],
    }
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn batch_error(
    status: axum::http::StatusCode,
    code: &'static str,
    message: &'static str,
) -> Response {
    (
        status,
        Json(UploadErrorEnvelope {
            error: UploadErrorBody { code, message },
        }),
    )
        .into_response()
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
    fn upload_delete_reports_references_before_any_destructive_step() {
        let source = include_str!("handlers.rs");
        let decision = source
            .find("match prepare_deletion")
            .expect("registry deletion decision");
        let in_use = source
            .find("DeleteDecision::InUse")
            .expect("asset-in-use branch");
        let fault = source
            .find("consume_managed_asset_unlink_fault")
            .expect("unlink fault seam");
        let finish = source
            .find("if finish_operation")
            .expect("journal-owned unlink");
        assert!(decision < in_use);
        assert!(in_use < fault);
        assert!(fault < finish);
    }

    #[test]
    fn upload_delete_fail_closed_scenarios_are_explicit() {
        let source = include_str!("handlers.rs");
        for marker in [
            "managed_asset_deletion_ready",
            "is_safe_filename",
            "normalize_managed_asset",
            "managed.filesystem_path.is_file()",
            "prepare_deletion",
            "DeleteDecision::InUse",
            "consume_managed_asset_unlink_fault",
            "finish_operation",
        ] {
            assert!(
                source.contains(marker),
                "missing deletion subproof marker: {marker}"
            );
        }
    }
}

