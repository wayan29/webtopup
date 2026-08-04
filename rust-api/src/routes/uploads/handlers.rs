use std::sync::Arc;

use axum::{
    extract::{Multipart, Query, State},
    response::{IntoResponse, Response},
    Json,
};

use crate::{
    security::{require_any_permission, ErrorResponse},
    state::AppState,
};

use super::{
    storage::{generate_file_name, list_uploaded_files, upload_root},
    types::{
        UploadDeleteQuery, UploadDeleteResponse, UploadListQuery, UploadListResponse,
        UploadMultipleResponse, UploadResponse, UploadedFileResponse,
    },
    validation::{is_allowed_mime_type, is_safe_filename, resolve_upload_folder},
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

    while let Ok(Some(field)) = multipart.next_field().await {
        let Some(original_name) = field.file_name().map(ToString::to_string) else {
            continue;
        };
        let mime_type = field
            .content_type()
            .map(ToString::to_string)
            .unwrap_or_default();

        if !is_allowed_mime_type(&mime_type) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Invalid file type. Only images allowed.",
            );
        }

        let folder = resolve_upload_folder(query.upload_type.as_deref());
        let filename = generate_file_name(&original_name);
        let folder_path = upload_root().join(&folder);
        if std::fs::create_dir_all(&folder_path).is_err() {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to upload file",
            );
        }
        let file_path = folder_path.join(&filename);
        let Ok(bytes) = field.bytes().await else {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to upload file",
            );
        };
        if std::fs::write(&file_path, bytes).is_err() {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to upload file",
            );
        }

        return Json(UploadResponse {
            success: true,
            url: format!("/uploads/{folder}/{filename}"),
            filename,
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
    let folder_path = upload_root().join(&folder);
    if std::fs::create_dir_all(&folder_path).is_err() {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to upload files",
        );
    }

    let mut uploaded_files = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let Some(original_name) = field.file_name().map(ToString::to_string) else {
            continue;
        };
        let mime_type = field
            .content_type()
            .map(ToString::to_string)
            .unwrap_or_default();
        if !is_allowed_mime_type(&mime_type) {
            continue;
        }

        let filename = generate_file_name(&original_name);
        let file_path = folder_path.join(&filename);
        let Ok(bytes) = field.bytes().await else {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to upload files",
            );
        };
        if std::fs::write(&file_path, bytes).is_err() {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to upload files",
            );
        }
        uploaded_files.push(UploadedFileResponse {
            url: format!("/uploads/{folder}/{filename}"),
            filename,
        });
    }

    Json(UploadMultipleResponse {
        success: true,
        files: uploaded_files,
    })
    .into_response()
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
    let file_path = upload_root().join(&folder).join(filename);
    match std::fs::remove_file(file_path) {
        Ok(()) => Json(UploadDeleteResponse {
            success: true,
            message: "File deleted successfully",
        })
        .into_response(),
        Err(_) => status_message(axum::http::StatusCode::NOT_FOUND, "File not found"),
    }
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
