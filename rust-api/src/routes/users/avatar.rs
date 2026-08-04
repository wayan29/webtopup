//! Staff avatar upload and removal.
//!
//! Deliberately not routed through `/v2/upload`: every folder there demands
//! `manageProducts`, `managePayment`, or `manageSettings`, which CS staff generally lack, and
//! that handler returns a free-form URL the client sends back for storage. Here the stored path
//! derives from the session, so a staff member can only ever touch their own file.
//!
//! No step-up: step-up guards account-takeover paths (email, password). A photo is not one.

use std::sync::Arc;

use axum::{
    extract::{Multipart, State},
    response::IntoResponse,
    Json,
};
use mongodb::bson::{doc, DateTime, Document};
use rand::RngCore;

use crate::{security::require_team_user, state::AppState, utils::bson::read_string};

use super::{
    avatar_media::{detect_avatar_image, AvatarImageKind, AvatarMediaError, MAX_AVATAR_BYTES},
    responses::{internal_error, status_message, unavailable},
};

const AVATAR_FOLDER: &str = "avatars";

fn bad_request(message: &'static str) -> axum::response::Response {
    status_message(axum::http::StatusCode::BAD_REQUEST, message)
}

fn media_error_response(error: AvatarMediaError) -> axum::response::Response {
    bad_request(match error {
        AvatarMediaError::Empty => "Berkas foto kosong",
        AvatarMediaError::TooLarge => "Ukuran foto maksimal 2MB",
        AvatarMediaError::UnsupportedFormat => "Format foto harus JPEG, PNG, atau WebP",
    })
}

/// Name is built from the session user id plus randomness; nothing from the request reaches it.
fn avatar_file_name(user_id: &str, kind: &AvatarImageKind) -> String {
    let safe_id: String = user_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let mut bytes = [0_u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    let suffix: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{safe_id}-{suffix}.{}", kind.extension())
}

/// Returns the bare filename only when the stored URL really points inside the avatars folder.
fn resolve_removable_avatar(stored: &str) -> Option<String> {
    let prefix = format!("/uploads/{AVATAR_FOLDER}/");
    let name = stored.strip_prefix(&prefix)?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    Some(name.to_string())
}

fn avatar_dir() -> std::path::PathBuf {
    crate::routes::uploads::upload_root().join(AVATAR_FOLDER)
}

fn remove_stored_avatar(stored: &str) {
    if let Some(name) = resolve_removable_avatar(stored) {
        // Best effort: an orphaned file only costs disk, while a dangling avatarUrl shows the
        // user a broken image. The document update is what must succeed.
        if let Err(error) = std::fs::remove_file(avatar_dir().join(name)) {
            tracing::warn!(%error, "failed to remove previous avatar file");
        }
    }
}

pub async fn upload_staff_me_avatar(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> axum::response::Response {
    let staff = match require_team_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let mut payload: Option<Vec<u8>> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.file_name().is_none() {
            continue;
        }
        match field.bytes().await {
            Ok(bytes) => payload = Some(bytes.to_vec()),
            Err(_) => return bad_request("Gagal membaca berkas foto"),
        }
        break;
    }
    let Some(bytes) = payload else {
        return bad_request("Berkas foto wajib diunggah");
    };
    if bytes.len() > MAX_AVATAR_BYTES {
        return media_error_response(AvatarMediaError::TooLarge);
    }
    let kind = match detect_avatar_image(&bytes) {
        Ok(kind) => kind,
        Err(error) => return media_error_response(error),
    };

    let user_id = staff.id.to_hex();
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    let previous = match users
        .find_one(doc! { "_id": staff.id })
        .projection(doc! { "avatarUrl": 1 })
        .await
    {
        Ok(Some(doc)) => read_string(&doc, "avatarUrl"),
        Ok(None) => {
            return status_message(
                axum::http::StatusCode::NOT_FOUND,
                "Akun staff tidak ditemukan",
            )
        }
        Err(_) => return internal_error(),
    };

    let directory = avatar_dir();
    if std::fs::create_dir_all(&directory).is_err() {
        return internal_error();
    }
    let file_name = avatar_file_name(&user_id, &kind);
    if std::fs::write(directory.join(&file_name), &bytes).is_err() {
        return internal_error();
    }
    let avatar_url = format!("/uploads/{AVATAR_FOLDER}/{file_name}");

    // Write the document only after the new file exists, so avatarUrl never points at nothing.
    if users
        .update_one(
            doc! { "_id": staff.id },
            doc! { "$set": { "avatarUrl": &avatar_url, "updatedAt": DateTime::now() } },
        )
        .await
        .is_err()
    {
        let _ = std::fs::remove_file(directory.join(&file_name));
        return internal_error();
    }
    if previous != avatar_url {
        remove_stored_avatar(&previous);
    }

    Json(serde_json::json!({
        "message": "Foto profil berhasil diperbarui",
        "avatarUrl": avatar_url,
    }))
    .into_response()
}

pub async fn delete_staff_me_avatar(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let staff = match require_team_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    let previous = match users
        .find_one(doc! { "_id": staff.id })
        .projection(doc! { "avatarUrl": 1 })
        .await
    {
        Ok(Some(doc)) => read_string(&doc, "avatarUrl"),
        Ok(None) => {
            return status_message(
                axum::http::StatusCode::NOT_FOUND,
                "Akun staff tidak ditemukan",
            )
        }
        Err(_) => return internal_error(),
    };
    if users
        .update_one(
            doc! { "_id": staff.id },
            doc! { "$set": { "avatarUrl": "", "updatedAt": DateTime::now() } },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    remove_stored_avatar(&previous);
    Json(serde_json::json!({
        "message": "Foto profil berhasil dihapus",
        "avatarUrl": "",
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_path_is_scoped_to_the_user_and_takes_its_extension_from_content() {
        let id = "6a6b47f96436027446a33a40";
        let name = avatar_file_name(id, &AvatarImageKind::WebP);
        assert!(name.starts_with(&format!("{id}-")));
        assert!(name.ends_with(".webp"));
        assert_eq!(name.matches('.').count(), 1);
    }

    // A filename is never taken from the request, so traversal has no entry point. Assert it
    // regardless: this is the property that keeps one staff member off another's file.
    #[test]
    fn stored_path_never_contains_separators_or_traversal() {
        let name = avatar_file_name("../../etc/passwd", &AvatarImageKind::Png);
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert!(!name.contains(".."));
    }

    #[test]
    fn two_uploads_by_the_same_user_do_not_collide() {
        let id = "6a6b47f96436027446a33a40";
        assert_ne!(
            avatar_file_name(id, &AvatarImageKind::Png),
            avatar_file_name(id, &AvatarImageKind::Png)
        );
    }

    #[test]
    fn only_files_inside_the_avatars_folder_are_deletable() {
        assert_eq!(
            resolve_removable_avatar("/uploads/avatars/abc.png"),
            Some("abc.png".to_string())
        );
        // Anything pointing outside the avatars folder must not be removable, so a tampered
        // avatarUrl cannot be turned into an arbitrary file delete.
        assert_eq!(resolve_removable_avatar("/uploads/icons/logo.png"), None);
        assert_eq!(
            resolve_removable_avatar("/uploads/avatars/../icons/logo.png"),
            None
        );
        assert_eq!(resolve_removable_avatar("/etc/passwd"), None);
        assert_eq!(resolve_removable_avatar(""), None);
    }
}
