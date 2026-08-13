//! Private same-filesystem staging and atomic batch publication for uploads.

use std::{
    future::Future,
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
use crate::services::managed_asset_registry::{
    CanonicalImageMetadata, PublishedAssetRegistration, RegistryError,
};

#[derive(Debug)]
pub struct StagedUpload {
    temp_path: PathBuf,
    final_path: PathBuf,
    public_url: String,
    filename: String,
    metadata: CanonicalImageMetadata,
    published: bool,
    /// Test-only: force rename failure during publish.
    #[cfg(test)]
    force_publish_failure: bool,
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

impl PublishedUpload {
    pub fn registry_registration(&self) -> PublishedAssetRegistration {
        PublishedAssetRegistration {
            url: self.url.clone(),
            filename: self.filename.clone(),
            path: self.path.clone(),
            metadata: self.metadata.clone(),
        }
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
        #[cfg(test)]
        force_publish_failure: false,
    })
}

pub fn publish_batch(mut staged: Vec<StagedUpload>) -> Result<Vec<PublishedUpload>, UploadStorageError> {
    let mut published: Vec<PublishedUpload> = Vec::with_capacity(staged.len());

    for item in &mut staged {
        #[cfg(test)]
        if item.force_publish_failure {
            // Roll back any already-published files from this batch only.
            for done in &published {
                let _ = fs::remove_file(&done.path);
            }
            return Err(UploadStorageError::Failed);
        }

        if let Err(error) = fs::rename(&item.temp_path, &item.final_path) {
            for done in &published {
                let _ = fs::remove_file(&done.path);
            }
            let _ = error;
            return Err(UploadStorageError::Failed);
        }
        item.mark_published();
        published.push(PublishedUpload {
            url: item.public_url.clone(),
            filename: item.filename.clone(),
            path: item.final_path.clone(),
            metadata: item.metadata.clone(),
        });
    }

    // Prevent Drop from deleting published temps (already renamed away).
    for item in &mut staged {
        item.mark_published();
    }

    Ok(published)
}

/// Publish files before invoking the registry callback. Any registry error rolls back every
/// file published by this call, so callers cannot observe a successful upload without a durable
/// managed-assets row.
pub async fn publish_and_register_batch<F, Fut>(
    staged: Vec<StagedUpload>,
    register: F,
) -> Result<Vec<PublishedUpload>, UploadStorageError>
where
    F: FnOnce(&[PublishedUpload]) -> Fut,
    Fut: Future<Output = Result<(), RegistryError>>,
{
    let published = publish_batch(staged)?;
    if let Err(error) = register(&published).await {
        if error.requires_reconciliation() {
            // An UnknownTransactionCommitResult means the server may have committed the rows.
            // Unlinking here could leave durable registry metadata pointing at missing bytes.
            return Err(UploadStorageError::RegistryReconciliationRequired);
        }
        rollback_published_files(&published)?;
        return Err(UploadStorageError::RegistryUnavailable);
    }
    Ok(published)
}

fn rollback_published_files(published: &[PublishedUpload]) -> Result<(), UploadStorageError> {
    let mut cleanup_failed = false;
    for upload in published {
        match fs::remove_file(&upload.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => cleanup_failed = true,
        }
    }
    if cleanup_failed {
        return Err(UploadStorageError::RegistryUnavailable);
    }
    Ok(())
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
    use crate::{
        routes::uploads::policy::{validate_and_reencode_image, CanonicalImageFormat},
        services::managed_asset_registry::RegistryError,
    };
    use image::{DynamicImage, ImageBuffer, ImageEncoder, Rgba};
    use std::{
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

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

    fn valid_staged(root: &Path, folder: &str) -> StagedUpload {
        stage_canonical_image(root, folder, fixture_canonical_png()).unwrap()
    }

    fn forced_publish_failure(root: &Path, folder: &str) -> StagedUpload {
        let mut staged = valid_staged(root, folder);
        staged.force_publish_failure = true;
        staged
    }

    fn create_existing_public_file(root: &Path, folder: &str, name: &str) -> PathBuf {
        let path = root.join(folder).join(name);
        fs::write(&path, b"existing").unwrap();
        path
    }

    fn public_batch_files(root: &Path) -> Vec<PathBuf> {
        public_batch_files_in(root, "icons")
    }

    fn public_batch_files_in(root: &Path, folder: &str) -> Vec<PathBuf> {
        let dir = root.join(folder);
        fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name != "existing.png" && !name.starts_with('.'))
            })
            .collect()
    }

    fn private_stage_files(root: &Path) -> Vec<PathBuf> {
        let staging = staging_root(root);
        match fs::read_dir(staging) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    #[tokio::test]
    async fn published_file_is_removed_when_registry_insert_fails() {
        let root = fixture_root();
        let staged = valid_staged(&root, "covers");
        let result = publish_and_register_batch(vec![staged], |_uploads| async {
            Err(RegistryError::Storage)
        })
        .await;
        assert_eq!(result.unwrap_err().code(), "MANAGED_ASSET_REGISTRY_UNAVAILABLE");
        assert!(public_batch_files_in(&root, "covers").is_empty());
        assert!(private_stage_files(&root).is_empty());
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }

    #[tokio::test]
    async fn ambiguous_registry_commit_fails_closed_and_retains_published_files_for_reconciliation() {
        let root = fixture_root();
        let staged = valid_staged(&root, "covers");
        let result = publish_and_register_batch(vec![staged], |_uploads| async {
            Err(RegistryError::AmbiguousCommit)
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code(), "MANAGED_ASSET_REGISTRY_UNAVAILABLE");
        assert!(error.requires_reconciliation());
        let files = public_batch_files_in(&root, "covers");
        assert_eq!(files.len(), 1);
        assert!(files[0].is_file());
        assert!(private_stage_files(&root).is_empty());
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }

    #[tokio::test]
    async fn duplicate_canonical_path_rolls_back_the_published_batch() {
        let root = fixture_root();
        let first = valid_staged(&root, "covers");
        let mut second = valid_staged(&root, "covers");
        // Force the registry's canonical-path uniqueness constraint while keeping distinct
        // staged/final filesystem paths so rollback must remove both published files.
        second.public_url = first.public_url.clone();
        let staged = vec![first, second];
        let rows = Arc::new(Mutex::new(Vec::<String>::new()));
        let callback_rows = Arc::clone(&rows);
        let result = publish_and_register_batch(staged, move |uploads| {
            let rows = Arc::clone(&callback_rows);
            let paths = uploads.iter().map(|upload| upload.url.clone()).collect::<Vec<_>>();
            async move {
                if paths.windows(2).any(|pair| pair[0] == pair[1]) {
                    // Simulate the unique canonical-path index rejecting the batch. The callback
                    // models a transaction, so no provisional rows remain after the error.
                    rows.lock().unwrap().clear();
                    return Err(RegistryError::ReferenceMismatch);
                }
                rows.lock().unwrap().extend(paths);
                Ok(())
            }
        })
        .await;
        assert_eq!(result.unwrap_err().code(), "MANAGED_ASSET_REGISTRY_UNAVAILABLE");
        assert!(rows.lock().unwrap().is_empty());
        assert!(public_batch_files_in(&root, "covers").is_empty());
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }

    #[tokio::test]
    async fn partial_registry_batch_rolls_back_rows_and_published_files() {
        let root = fixture_root();
        let staged = vec![valid_staged(&root, "covers"), valid_staged(&root, "covers")];
        let rows = Arc::new(Mutex::new(Vec::<String>::new()));
        let callback_rows = Arc::clone(&rows);
        let result = publish_and_register_batch(staged, move |uploads| {
            let rows = Arc::clone(&callback_rows);
            let first = uploads.first().map(|upload| upload.url.clone());
            async move {
                if let Some(first) = first {
                    rows.lock().unwrap().push(first);
                }
                // A transactional registry abort removes the first insert before returning.
                rows.lock().unwrap().clear();
                Err(RegistryError::Storage)
            }
        })
        .await;
        assert_eq!(result.unwrap_err().code(), "MANAGED_ASSET_REGISTRY_UNAVAILABLE");
        assert!(rows.lock().unwrap().is_empty());
        assert!(public_batch_files_in(&root, "covers").is_empty());
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
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
    fn failed_batch_publication_removes_only_files_from_that_batch() {
        let root = fixture_root();
        let existing = create_existing_public_file(&root, "icons", "existing.png");
        let staged = vec![valid_staged(&root, "icons"), forced_publish_failure(&root, "icons")];
        assert!(publish_batch(staged).is_err());
        assert!(existing.exists());
        assert!(public_batch_files(&root).is_empty());
        assert!(private_stage_files(&root).is_empty());
        if let Some(base) = root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }

    #[test]
    fn successful_batch_publishes_canonical_extension_only() {
        let root = fixture_root();
        let staged = valid_staged(&root, "icons");
        let temp = staged.temp_path().to_path_buf();
        let published = publish_batch(vec![staged]).unwrap();
        assert_eq!(published.len(), 1);
        assert!(published[0].filename.ends_with(".png"));
        assert!(!published[0].filename.contains("client"));
        assert!(published[0].path.exists());
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
