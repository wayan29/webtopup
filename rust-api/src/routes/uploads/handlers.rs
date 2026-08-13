use std::sync::Arc;

use axum::{
    extract::{Multipart, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use crate::{
    security::{require_any_permission, ErrorResponse},
    services::{
        managed_asset_registry::register_published_batch_in_transaction,
        managed_assets::{count_asset_references, normalize_managed_asset},
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
    let root = upload_root();
    let managed = match normalize_managed_asset(&root, &folder, filename) {
        Ok(managed) => managed,
        Err(_) => return status_message(axum::http::StatusCode::NOT_FOUND, "File not found"),
    };

    if !managed.filesystem_path.is_file() {
        return status_message(axum::http::StatusCode::NOT_FOUND, "File not found");
    }

    let Some(client) = state.mongo_client.as_ref() else {
        return status_message(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "Database unavailable",
        );
    };
    let db = client.database(&state.mongo_db);

    let first = match count_asset_references(&db, &managed.url).await {
        Ok(value) => value,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to check asset references",
            )
        }
    };
    if !first.is_empty() {
        return asset_in_use(first);
    }

    // Second immediate scan bounds the filesystem/database race before unlink.
    let second = match count_asset_references(&db, &managed.url).await {
        Ok(value) => value,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to check asset references",
            )
        }
    };
    if !second.is_empty() {
        return asset_in_use(second);
    }

    match std::fs::remove_file(&managed.filesystem_path) {
        Ok(()) => Json(UploadDeleteResponse {
            success: true,
            message: "File deleted successfully",
        })
        .into_response(),
        Err(_) => status_message(axum::http::StatusCode::NOT_FOUND, "File not found"),
    }
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
