use std::{env, path::PathBuf};

use chrono::{DateTime, Utc};
use rand::RngCore;

use super::{
    types::UploadedFile,
    validation::{is_image_file, resolve_upload_folder},
};

pub fn list_uploaded_files(upload_type: Option<&str>) -> (String, Vec<UploadedFile>) {
    let folder = resolve_upload_folder(upload_type);
    let folder_path = upload_root().join(&folder);
    let files = match std::fs::read_dir(folder_path) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| uploaded_file_from_entry(&folder, entry))
            .collect(),
        Err(_) => Vec::new(),
    };

    let mut files: Vec<UploadedFile> = files;
    files.sort_by(|left, right| right.uploaded_at.cmp(&left.uploaded_at));
    (folder, files)
}

pub fn upload_root() -> PathBuf {
    if let Ok(path) = env::var("UPLOAD_DIR") {
        return PathBuf::from(path);
    }

    if let Ok(path) = env::current_dir() {
        let repo_root_uploads = path.join("uploads");
        if repo_root_uploads.exists() {
            return repo_root_uploads;
        }

        if let Some(parent) = path.parent() {
            let sibling_uploads = parent.join("uploads");
            if sibling_uploads.exists() {
                return sibling_uploads;
            }
        }

        let legacy_repo_root_uploads = path.join("server/uploads");
        if legacy_repo_root_uploads.exists() {
            return legacy_repo_root_uploads;
        }

        if let Some(parent) = path.parent() {
            let legacy_sibling_uploads = parent.join("server/uploads");
            if legacy_sibling_uploads.exists() {
                return legacy_sibling_uploads;
            }
        }
    }

    PathBuf::from("../uploads")
}

pub fn generate_file_name(original_name: &str) -> String {
    let extension = std::path::Path::new(original_name)
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .filter(|extension| !extension.is_empty())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let mut bytes = [0_u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hash = bytes
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>();
    format!("{}-{}{}", Utc::now().timestamp_millis(), hash, extension)
}

fn uploaded_file_from_entry(folder: &str, entry: std::fs::DirEntry) -> Option<UploadedFile> {
    let file_type = entry.file_type().ok()?;
    if !file_type.is_file() {
        return None;
    }

    let filename = entry.file_name().to_string_lossy().to_string();
    if !is_image_file(&filename) {
        return None;
    }

    let metadata = entry.metadata().ok()?;
    let uploaded_at = metadata
        .modified()
        .ok()
        .map(|time| {
            DateTime::<Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|| {
            DateTime::<Utc>::UNIX_EPOCH.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });

    Some(UploadedFile {
        url: format!("/uploads/{folder}/{filename}"),
        filename,
        size: metadata.len(),
        uploaded_at,
    })
}
