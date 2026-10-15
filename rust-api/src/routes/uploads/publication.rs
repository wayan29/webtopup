//! Private same-filesystem staging and atomic batch publication for uploads.

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use rand::RngCore;

use super::{
    policy::{CanonicalImage, CanonicalImageFormat},
    types::{UploadErrorBody, UploadErrorEnvelope},
};
use crate::services::managed_asset_registry::CanonicalImageMetadata;

#[derive(Debug)]
pub struct StagedUpload {
    temp_path: PathBuf,
    final_path: PathBuf,
    public_url: String,
    filename: String,
    metadata: CanonicalImageMetadata,
    published: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedUpload {
    pub url: String,
    pub filename: String,
    pub path: PathBuf,
    pub metadata: CanonicalImageMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadStorageError {
    Failed,
    RegistryUnavailable,
    /// The registry commit result is unknown. Published files are intentionally retained so a
    /// later reconciliation can determine whether the corresponding rows committed.
    RegistryReconciliationRequired,
}

impl UploadStorageError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Failed => "UPLOAD_STORAGE_FAILED",
            Self::RegistryUnavailable | Self::RegistryReconciliationRequired => {
                "MANAGED_ASSET_REGISTRY_UNAVAILABLE"
            }
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Failed => "Gagal menyimpan file upload",
            Self::RegistryUnavailable | Self::RegistryReconciliationRequired => {
                "Registry aset terkelola tidak tersedia"
            }
        }
    }

    pub fn requires_reconciliation(self) -> bool {
        matches!(self, Self::RegistryReconciliationRequired)
    }

    fn status(self) -> StatusCode {
        match self {
            Self::Failed => StatusCode::INTERNAL_SERVER_ERROR,
            Self::RegistryUnavailable | Self::RegistryReconciliationRequired => {
                StatusCode::SERVICE_UNAVAILABLE
            }
        }
    }
}

impl IntoResponse for UploadStorageError {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(UploadErrorEnvelope {
                error: UploadErrorBody {
                    code: self.code(),
                    message: self.message(),
                },
            }),
        )
            .into_response()
    }
}

impl StagedUpload {
    pub fn temp_path(&self) -> &Path {
        &self.temp_path
    }

    pub fn final_path(&self) -> &Path {
        &self.final_path
    }

    pub fn public_url(&self) -> &str {
        &self.public_url
    }

    pub fn filename(&self) -> &str {
        &self.filename
    }

    pub fn metadata(&self) -> &CanonicalImageMetadata {
        &self.metadata
    }

    fn mark_published(&mut self) {
        self.published = true;
    }
}

impl Drop for StagedUpload {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.temp_path);
        }
    }
}

pub fn staging_root(upload_root: &Path) -> PathBuf {
    upload_root
        .parent()
        .map(|parent| parent.join(".webtopup-upload-staging"))
        .unwrap_or_else(|| PathBuf::from(".webtopup-upload-staging"))
}

pub fn stage_canonical_image(
    root: &Path,
    folder: &str,
    image: CanonicalImage,
) -> Result<StagedUpload, UploadStorageError> {
    if !matches!(folder, "icons" | "covers" | "popups" | "instructions") {
        return Err(UploadStorageError::Failed);
    }

    let staging = staging_root(root);
    fs::create_dir_all(&staging).map_err(|_| UploadStorageError::Failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&staging, fs::Permissions::from_mode(0o700));
    }

    let final_dir = root.join(folder);
    fs::create_dir_all(&final_dir).map_err(|_| UploadStorageError::Failed)?;

    let metadata = image.registry_metadata();
    let filename = generate_canonical_filename(image.format);
    let temp_name = format!(".{filename}.part");
    let temp_path = staging.join(temp_name);
    let final_path = final_dir.join(&filename);
    let public_url = format!("/uploads/{folder}/{filename}");

    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|_| UploadStorageError::Failed)?;
        file.write_all(&image.bytes)
            .map_err(|_| UploadStorageError::Failed)?;
        file.sync_all().map_err(|_| UploadStorageError::Failed)?;
    }

    Ok(StagedUpload {
        temp_path,
        final_path,
        public_url,
        filename,
        metadata,
        published: false,
    })
}

/// Persist publication intent before exposing any file; recovery owns all staged paths after
/// this commit, including ambiguous outcomes. No rollback unlinks a possibly committed asset.
pub async fn publish_sql_batch(
    pool: &sqlx::PgPool,
    root: &Path,
    mut staged: Vec<StagedUpload>,
) -> Result<Vec<PublishedUpload>, UploadStorageError> {
    let payload = serde_json::Value::Array(
        staged
            .iter()
            .map(|item| {
                serde_json::json!({
                    "url": item.public_url,
                    "metadata": {
                        "format": item.metadata.format,
                        "width": item.metadata.width,
                        "height": item.metadata.height,
                        "byteLength": item.metadata.byte_length
                    }
                })
            })
            .collect(),
    );
    // Retain durable staging on every uncertain journal insertion outcome. A database outage
    // may leave private staging garbage, but must never destroy data needed by recovery.
    for item in &mut staged {
        item.mark_published();
    }
    let id = crate::services::managed_asset_registry::prepare_publication(pool, &payload)
        .await
        .map_err(|_| UploadStorageError::RegistryReconciliationRequired)?;
    crate::services::managed_asset_registry::finish_operation(pool, root, id)
        .await
        .map_err(|_| UploadStorageError::RegistryReconciliationRequired)?;
    Ok(staged
        .into_iter()
        .map(|item| PublishedUpload {
            url: item.public_url.clone(),
            filename: item.filename.clone(),
            path: item.final_path.clone(),
            metadata: item.metadata.clone(),
        })
        .collect())
}
fn generate_canonical_filename(format: CanonicalImageFormat) -> String {
    let mut bytes = [0_u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hash = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}.{}",
        Utc::now().timestamp_millis(),
        hash,
        format.extension()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::uploads::policy::{validate_and_reencode_image, CanonicalImageFormat};
    use image::{DynamicImage, ImageBuffer, ImageEncoder, Rgba};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Unique parent so sibling staging `.webtopup-upload-staging` does not collide across
        // parallel tests that would otherwise share std::env::temp_dir().
        let base = std::env::temp_dir().join(format!("webtopup-upload-test-{nanos}"));
        let root = base.join("uploads");
        fs::create_dir_all(root.join("icons")).unwrap();
        root
    }

    fn fixture_canonical_png() -> CanonicalImage {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(2, 2, |x, y| Rgba([x as u8 * 40, y as u8 * 40, 10, 200]));
        let dynamic = DynamicImage::ImageRgba8(img);
        let mut out = Vec::new();
        let rgba = dynamic.to_rgba8();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        validate_and_reencode_image(&out).unwrap()
    }

    #[test]
    fn dropped_staged_upload_removes_private_temp_file() {
        let root = fixture_root();
        let staged = stage_canonical_image(&root, "icons", fixture_canonical_png()).unwrap();
        let temp = staged.temp_path().to_path_buf();
        assert!(temp.exists());
        drop(staged);
        assert!(!temp.exists());
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }

    #[test]
    fn staging_filename_uses_format_extension_not_client_name() {
        let root = fixture_root();
        let image = CanonicalImage {
            bytes: fixture_canonical_png().bytes,
            format: CanonicalImageFormat::Jpeg,
            width: 2,
            height: 2,
        };
        // Even if we label format Jpeg, filename extension comes from format enum.
        let staged = stage_canonical_image(&root, "icons", image).unwrap();
        assert!(staged.filename().ends_with(".jpg"));
        assert!(!staged.filename().contains('/'));
        drop(staged);
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }

    #[test]
    fn open_options_create_new_rejects_existing_temp() {
        let root = fixture_root();
        let staging = staging_root(&root);
        fs::create_dir_all(&staging).unwrap();
        let path = staging.join("collision.part");
        File::create(&path).unwrap();
        let result = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path);
        assert!(result.is_err());
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }
}
