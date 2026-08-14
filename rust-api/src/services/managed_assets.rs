//! Managed upload URL normalization and reference counting.

use std::path::{Path, PathBuf};

use mongodb::{bson::doc, Client, ClientSession, Database};
use serde::Serialize;

use crate::services::{
    idempotency::{commit_mongo_transaction_with_unknown_retry, TransactionCommitOutcome},
    managed_asset_registry::{increment_legacy_acquisition_fence, RegistryError},
};

const MANAGED_FOLDERS: &[&str] = &["icons", "covers", "popups", "instructions"];

/// Folder policy for fields that may contain a managed upload URL.
///
/// Values that are not managed upload URLs (empty values, bundled paths, and external URLs) are
/// intentionally accepted here. The existing filesystem check remains responsible for managed
/// upload existence, while this policy prevents a managed URL from crossing field boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedFieldFolderPolicy {
    Icons,
    Covers,
    Popups,
    Instructions,
    AnyManaged,
}

impl ManagedFieldFolderPolicy {
    fn accepts(self, folder: &str) -> bool {
        match self {
            Self::Icons => folder == "icons",
            Self::Covers => folder == "covers",
            Self::Popups => folder == "popups",
            Self::Instructions => folder == "instructions",
            Self::AnyManaged => MANAGED_FOLDERS.contains(&folder),
        }
    }
}

/// Closed inventory of fields that can currently persist a value from `/uploads/covers/...`.
///
/// `sliders.image` is listed for readiness and source-contract purposes only; slider mutations
/// remain owned by the later slider mutation task.
pub const ACTIVE_COVERS_WRITERS: &[(&str, &str)] = &[
    ("producttypes", "cover"),
    ("flashsales", "banner"),
    ("articles", "image"),
    ("rewards", "imageUrl"),
    ("sliders", "image"),
];

/// Closed inventory of managed fields whose upload folder is restricted.
pub const RESTRICTED_MANAGED_FIELDS: &[(&str, &str, ManagedFieldFolderPolicy)] = &[
    ("products", "icon", ManagedFieldFolderPolicy::Icons),
    ("categories", "icon", ManagedFieldFolderPolicy::Icons),
    ("operators", "icon", ManagedFieldFolderPolicy::Icons),
    (
        "operators",
        "instructionImage",
        ManagedFieldFolderPolicy::Instructions,
    ),
    ("producttypes", "icon", ManagedFieldFolderPolicy::Icons),
    (
        "producttypes",
        "popupInfo.image",
        ManagedFieldFolderPolicy::Popups,
    ),
    ("paymentmethods", "icon", ManagedFieldFolderPolicy::Icons),
    ("paymentcategories", "icon", ManagedFieldFolderPolicy::Icons),
    ("settings", "favicon", ManagedFieldFolderPolicy::Icons),
    ("settings", "logo", ManagedFieldFolderPolicy::Icons),
    (
        "settings",
        "popupBannerImage",
        ManagedFieldFolderPolicy::Popups,
    ),
];

/// Exact registry: (collection, resource label, field path).
const SCALAR_REFERENCES: &[(&str, &str, &str)] = &[
    ("settings", "Settings", "value"),
    ("products", "Products", "icon"),
    ("operators", "Operators", "icon"),
    ("operators", "Operators", "instructionImage"),
    ("producttypes", "Product types", "icon"),
    ("producttypes", "Product types", "cover"),
    ("producttypes", "Product types", "popupInfo.image"),
    ("categories", "Categories", "icon"),
    ("paymentmethods", "Payment methods", "icon"),
    ("paymentcategories", "Payment categories", "icon"),
    ("sliders", "Sliders", "image"),
    ("flashsales", "Flash sales", "banner"),
    ("articles", "Articles", "image"),
    ("rewards", "Rewards", "imageUrl"),
];

const SETTINGS_IMAGE_KEYS: &[&str] = &["favicon", "logo", "popupBannerImage"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAssetPath {
    pub folder: String,
    pub filename: String,
    pub url: String,
    pub filesystem_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AssetReferenceSummary {
    pub resource: &'static str,
    pub count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedAssetError {
    InvalidPath,
    NotFound,
}

impl ManagedAssetError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPath => "INVALID_ASSET_PATH",
            Self::NotFound => "MANAGED_ASSET_NOT_FOUND",
        }
    }
}

pub fn normalize_managed_asset(
    root: &Path,
    folder: &str,
    filename: &str,
) -> Result<ManagedAssetPath, ManagedAssetError> {
    if !MANAGED_FOLDERS.contains(&folder) {
        return Err(ManagedAssetError::InvalidPath);
    }
    if !is_safe_managed_filename(filename) {
        return Err(ManagedAssetError::InvalidPath);
    }

    let filesystem_path = root.join(folder).join(filename);
    let canonical_root = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf());
    let parent = filesystem_path
        .parent()
        .ok_or(ManagedAssetError::InvalidPath)?;
    // Ensure the parent directory is under root/folder even before the file exists.
    let expected_parent = root.join(folder);
    if parent != expected_parent.as_path() {
        // Compare after normalize of components without requiring existence.
        let parent_components: Vec<_> = parent.components().collect();
        let expected_components: Vec<_> = expected_parent.components().collect();
        if parent_components != expected_components {
            return Err(ManagedAssetError::InvalidPath);
        }
    }
    let _ = canonical_root;

    Ok(ManagedAssetPath {
        folder: folder.to_string(),
        filename: filename.to_string(),
        url: format!("/uploads/{folder}/{filename}"),
        filesystem_path,
    })
}

pub fn parse_managed_upload_url(value: &str) -> Result<(String, String), ManagedAssetError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ManagedAssetError::InvalidPath);
    }
    // Only internal managed paths are considered; absolute https URLs are not managed uploads.
    if !trimmed.starts_with("/uploads/") || trimmed.starts_with("//") {
        return Err(ManagedAssetError::InvalidPath);
    }
    let rest = &trimmed["/uploads/".len()..];
    let mut parts = rest.split('/');
    let folder = parts.next().unwrap_or_default();
    let filename = parts.next().unwrap_or_default();
    if parts.next().is_some() || folder.is_empty() || filename.is_empty() {
        return Err(ManagedAssetError::InvalidPath);
    }
    if !MANAGED_FOLDERS.contains(&folder) || !is_safe_managed_filename(filename) {
        return Err(ManagedAssetError::InvalidPath);
    }
    Ok((folder.to_string(), filename.to_string()))
}

pub async fn managed_asset_exists(root: &Path, value: &str) -> Result<bool, ManagedAssetError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(true);
    }
    // Non-managed safe paths (bundled assets, external https) are not checked here.
    let Ok((folder, filename)) = parse_managed_upload_url(trimmed) else {
        return Ok(true);
    };
    let managed = normalize_managed_asset(root, &folder, &filename)?;
    Ok(tokio::task::spawn_blocking(move || managed.filesystem_path.is_file())
        .await
        .unwrap_or(false))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedAssetReferenceError {
    NotFound,
    WrongFolder,
}

impl ManagedAssetReferenceError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "MANAGED_ASSET_NOT_FOUND",
            Self::WrongFolder => "MANAGED_ASSET_WRONG_FOLDER",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NotFound => "Asset upload tidak ditemukan",
            Self::WrongFolder => "Folder asset upload tidak sesuai field",
        }
    }
}

/// Require an exact managed folder when a value is a managed upload URL.
///
/// A non-managed value is deliberately not rejected: existing callers permit empty values,
/// bundled assets, and external HTTPS URLs. Historical values are preserved by callers when the
/// field is not effectively changed; newly submitted values must call this helper before writing.
pub fn require_managed_folder(
    value: &str,
    policy: ManagedFieldFolderPolicy,
) -> Result<(), ManagedAssetReferenceError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let Ok((folder, _filename)) = parse_managed_upload_url(trimmed) else {
        return if trimmed.starts_with("/uploads/") {
            Err(ManagedAssetReferenceError::WrongFolder)
        } else {
            Ok(())
        };
    };
    if policy.accepts(&folder) {
        Ok(())
    } else {
        Err(ManagedAssetReferenceError::WrongFolder)
    }
}

/// Compare a persisted field value with its next value using the same trimming semantics as
/// managed upload validation. A value is effectively changed only when its normalized text differs
/// from the existing value; merely resubmitting a legacy wrong-folder value is therefore allowed.
pub fn effectively_changed_managed_field(previous: Option<&str>, next: &str) -> bool {
    previous.map(str::trim) != Some(next.trim())
}

/// Return only effectively changed managed cover paths, preserving order while deduplicating.
/// Empty, unchanged/non-managed values and managed folders other than `covers` do not fence.
pub fn effectively_changed_cover_path<'a>(
    previous: Option<&str>,
    next: &'a str,
) -> Option<&'a str> {
    let next = next.trim();
    if next.is_empty() || !effectively_changed_managed_field(previous, next) {
        return None;
    }
    match parse_managed_upload_url(next) {
        Ok((folder, _)) if folder == "covers" => Some(next),
        _ => None,
    }
}

fn changed_cover_paths<'a>(changed_paths: &'a [&'a str]) -> Result<Vec<&'a str>, RegistryError> {
    let mut result = Vec::new();
    for path in changed_paths.iter().copied() {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok((folder, _filename)) = crate::services::managed_asset_registry::canonical_managed_path(trimmed) else {
            // Bundled and external values are not managed paths. A malformed `/uploads/...`
            // value is not silently ignored, however: callers must fail closed.
            if trimmed.starts_with("/uploads/") {
                return Err(RegistryError::PathInvalid);
            }
            continue;
        };
        if folder != "covers" || result.contains(&trimmed) {
            continue;
        }
        result.push(trimmed);
    }
    Ok(result)
}

/// Fence legacy non-slider writes in the same transaction as their domain write.
///
/// This deliberately creates no reference rows and never changes `referenceCount`; it only
/// serializes acquisition against registry deletion by incrementing the monotonic fence version.
pub async fn fence_legacy_managed_writes(
    session: &mut ClientSession,
    db: &Database,
    changed_paths: &[&str],
) -> Result<(), RegistryError> {
    for path in changed_cover_paths(changed_paths)? {
        increment_legacy_acquisition_fence(session, db, path).await?;
    }
    Ok(())
}

/// Start the narrow transaction used by a legacy writer when it is persisting a changed cover.
pub async fn start_legacy_managed_write(client: &Client) -> Result<ClientSession, RegistryError> {
    let mut session = client
        .start_session()
        .await
        .map_err(|_| RegistryError::Unavailable)?;
    session
        .start_transaction()
        .await
        .map_err(|_| RegistryError::Unavailable)?;
    Ok(session)
}

/// Abort a legacy writer transaction, preserving the original registry error only when rollback
/// itself is acknowledged.
pub async fn abort_legacy_managed_write(
    session: &mut ClientSession,
    error: RegistryError,
) -> RegistryError {
    match session.abort_transaction().await {
        Ok(()) => error,
        Err(_) => RegistryError::TransactionAbortFailed,
    }
}

/// Commit only the transaction that already contains the domain write and cover fence. An
/// ambiguous commit never becomes a success response; Task 7/readiness reconciliation owns it.
pub async fn commit_legacy_managed_write(
    session: &mut ClientSession,
) -> Result<(), RegistryError> {
    match commit_mongo_transaction_with_unknown_retry(session).await {
        TransactionCommitOutcome::Committed => Ok(()),
        TransactionCommitOutcome::Ambiguous => Err(RegistryError::AmbiguousCommit),
        TransactionCommitOutcome::FailedDefinitely => Err(RegistryError::Unavailable),
    }
}

pub fn managed_asset_registry_unavailable_response() -> axum::response::Response {
    use axum::{response::IntoResponse, Json};
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": {
                "code": "MANAGED_ASSET_REGISTRY_UNAVAILABLE",
                "message": "Managed asset registry tidak tersedia"
            }
        })),
    )
        .into_response()
}

/// Validate one managed-or-external field with an exact folder policy.
pub fn ensure_managed_field(
    root: &Path,
    value: &str,
    policy: ManagedFieldFolderPolicy,
) -> Result<(), axum::response::Response> {
    ensure_managed_field_for_update(root, value, policy, true)
}

/// Validate a submitted field while allowing an unchanged historical value to retain its old
/// folder classification. Existence checks still apply to managed paths in either case.
pub fn ensure_managed_field_for_update(
    root: &Path,
    value: &str,
    policy: ManagedFieldFolderPolicy,
    effectively_changed: bool,
) -> Result<(), axum::response::Response> {
    if effectively_changed {
        if let Err(error) = require_managed_folder(value, policy) {
            return Err(managed_asset_policy_response(error));
        }
    }
    if require_existing_managed_asset_sync(root, value).is_err() {
        return Err(managed_asset_not_found_response());
    }
    Ok(())
}

fn managed_asset_policy_response(error: ManagedAssetReferenceError) -> axum::response::Response {
    use axum::{response::IntoResponse, Json};
    let status = match error {
        ManagedAssetReferenceError::NotFound => axum::http::StatusCode::BAD_REQUEST,
        ManagedAssetReferenceError::WrongFolder => axum::http::StatusCode::BAD_REQUEST,
    };
    (
        status,
        Json(serde_json::json!({
            "error": {
                "code": error.code(),
                "message": error.message()
            }
        })),
    )
        .into_response()
}

/// Empty values, emoji/category glyphs, bundled assets, and external HTTPS URLs pass.
/// Only `/uploads/<folder>/<file>` is treated as a managed reference and must exist.
pub async fn require_existing_managed_asset(
    root: &Path,
    value: &str,
) -> Result<(), ManagedAssetReferenceError> {
    require_existing_managed_asset_sync(root, value)
}

/// Synchronous variant for pure normalizers that already run on the async runtime thread.
pub fn require_existing_managed_asset_sync(
    root: &Path,
    value: &str,
) -> Result<(), ManagedAssetReferenceError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let Ok((folder, filename)) = parse_managed_upload_url(trimmed) else {
        return Ok(());
    };
    let managed = match normalize_managed_asset(root, &folder, &filename) {
        Ok(value) => value,
        Err(_) => return Err(ManagedAssetReferenceError::NotFound),
    };
    if managed.filesystem_path.is_file() {
        Ok(())
    } else {
        Err(ManagedAssetReferenceError::NotFound)
    }
}

/// Axum response helper shared by writers.
pub fn managed_asset_not_found_response() -> axum::response::Response {
    use axum::{
        response::IntoResponse,
        Json,
    };
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": {
                "code": "MANAGED_ASSET_NOT_FOUND",
                "message": "Asset upload tidak ditemukan"
            }
        })),
    )
        .into_response()
}

/// Validate zero or more managed-or-external fields against the provided upload root.
pub fn ensure_managed_fields(
    root: &Path,
    values: &[&str],
) -> Result<(), axum::response::Response> {
    for value in values {
        if require_existing_managed_asset_sync(root, value).is_err() {
            return Err(managed_asset_not_found_response());
        }
    }
    Ok(())
}

/// Source-contract inventory used by security tests and readiness policy. Every production call
/// site of `ensure_managed_fields` must be represented by one of these field entries.
pub const ENSURE_MANAGED_FIELDS_SOURCE_INVENTORY: &[(&str, &str, ManagedFieldFolderPolicy)] = &[
    ("products", "icon", ManagedFieldFolderPolicy::Icons),
    ("categories", "icon", ManagedFieldFolderPolicy::Icons),
    ("operators", "icon", ManagedFieldFolderPolicy::Icons),
    ("operators", "instructionImage", ManagedFieldFolderPolicy::Instructions),
    ("producttypes", "icon", ManagedFieldFolderPolicy::Icons),
    ("producttypes", "cover", ManagedFieldFolderPolicy::Covers),
    ("producttypes", "popupInfo.image", ManagedFieldFolderPolicy::Popups),
    ("paymentmethods", "icon", ManagedFieldFolderPolicy::Icons),
    ("paymentcategories", "icon", ManagedFieldFolderPolicy::Icons),
    ("settings", "favicon", ManagedFieldFolderPolicy::Icons),
    ("settings", "logo", ManagedFieldFolderPolicy::Icons),
    ("settings", "popupBannerImage", ManagedFieldFolderPolicy::Popups),
    ("flashsales", "banner", ManagedFieldFolderPolicy::Covers),
    ("articles", "image", ManagedFieldFolderPolicy::Covers),
    ("rewards", "imageUrl", ManagedFieldFolderPolicy::Covers),
    ("sliders", "image", ManagedFieldFolderPolicy::Covers),
];

pub async fn count_asset_references(
    db: &Database,
    url: &str,
) -> Result<Vec<AssetReferenceSummary>, mongodb::error::Error> {
    let mut summaries = Vec::new();
    for (collection, resource, field) in SCALAR_REFERENCES {
        let filter = if *collection == "settings" && *field == "value" {
            doc! {
                "key": { "$in": SETTINGS_IMAGE_KEYS },
                "value": url,
            }
        } else {
            doc! { *field: url }
        };
        let count = db
            .collection::<mongodb::bson::Document>(collection)
            .count_documents(filter)
            .await?;
        if count > 0 {
            // Aggregate counts for the same resource label (e.g. operators has two fields).
            if let Some(existing) = summaries
                .iter_mut()
                .find(|item: &&mut AssetReferenceSummary| item.resource == *resource)
            {
                existing.count = existing.count.saturating_add(count);
            } else {
                summaries.push(AssetReferenceSummary {
                    resource,
                    count,
                });
            }
        }
    }
    Ok(summaries)
}

fn is_safe_managed_filename(filename: &str) -> bool {
    if filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('%')
    {
        return false;
    }
    filename
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn managed_field_folder_policy_rejects_wrong_managed_folder_but_allows_legacy_values() {
        assert!(require_managed_folder(
            "/uploads/icons/logo.png",
            ManagedFieldFolderPolicy::Icons,
        )
        .is_ok());
        assert_eq!(
            require_managed_folder(
                "/uploads/covers/banner.webp",
                ManagedFieldFolderPolicy::Icons,
            )
            .unwrap_err(),
            ManagedAssetReferenceError::WrongFolder,
        );
        assert!(require_managed_folder(
            "/uploads/covers/banner.webp",
            ManagedFieldFolderPolicy::Covers,
        )
        .is_ok());
        assert!(require_managed_folder("", ManagedFieldFolderPolicy::Icons).is_ok());
        assert!(require_managed_folder("/danayasa-logo.svg", ManagedFieldFolderPolicy::Icons).is_ok());
        assert!(require_managed_folder("https://cdn.example/logo.png", ManagedFieldFolderPolicy::Icons).is_ok());
    }

    #[test]
    fn unchanged_historical_wrong_folder_is_preserved() {
        let root = temp_root();
        let historical = root.join("covers").join("legacy-cover.png");
        std::fs::create_dir_all(historical.parent().unwrap()).unwrap();
        std::fs::write(&historical, b"legacy").unwrap();

        assert!(ensure_managed_field_for_update(
            &root,
            "/uploads/covers/legacy-cover.png",
            ManagedFieldFolderPolicy::Icons,
            false,
        )
        .is_ok());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn changed_wrong_folder_is_rejected() {
        assert_eq!(
            require_managed_folder(
                "/uploads/covers/new-cover.png",
                ManagedFieldFolderPolicy::Icons,
            )
            .unwrap_err(),
            ManagedAssetReferenceError::WrongFolder,
        );
    }

    #[test]
    fn malformed_upload_namespace_is_not_treated_as_external() {
        assert_eq!(
            require_managed_folder(
                "/uploads/covers/../new-cover.png",
                ManagedFieldFolderPolicy::Covers,
            )
            .unwrap_err(),
            ManagedAssetReferenceError::WrongFolder,
        );
    }

    #[test]
    fn effectively_changed_managed_field_distinguishes_unchanged_and_changed_values() {
        assert!(!effectively_changed_managed_field(
            Some("/uploads/covers/legacy-cover.png"),
            "/uploads/covers/legacy-cover.png",
        ));
        assert!(effectively_changed_managed_field(
            Some("/uploads/covers/legacy-cover.png"),
            "/uploads/covers/repaired-cover.png",
        ));
        assert!(effectively_changed_managed_field(
            None,
            "/uploads/icons/new-icon.png",
        ));
    }

    #[test]
    fn effectively_changed_cover_selection_only_returns_changed_covers() {
        assert_eq!(
            effectively_changed_cover_path(
                Some("/uploads/covers/old.webp"),
                "/uploads/covers/new.webp",
            ),
            Some("/uploads/covers/new.webp"),
        );
        assert_eq!(
            effectively_changed_cover_path(
                Some("/uploads/covers/same.webp"),
                "/uploads/covers/same.webp",
            ),
            None,
        );
        assert_eq!(
            effectively_changed_cover_path(Some("/uploads/icons/old.png"), "/uploads/icons/new.png"),
            None,
        );
        assert_eq!(effectively_changed_cover_path(None, ""), None);
    }

    #[test]
    fn covers_writer_inputs_are_deduplicated_and_non_cover_paths_are_ignored() {
        let paths = changed_cover_paths(&[
            "",
            "/uploads/icons/icon.png",
            "/uploads/covers/banner.webp",
            "/uploads/covers/banner.webp",
            "/uploads/covers/other.webp",
        ])
        .unwrap();
        assert_eq!(paths, vec!["/uploads/covers/banner.webp", "/uploads/covers/other.webp"]);
    }

    #[test]
    fn legacy_fence_does_not_mutate_reference_rows_or_reference_count() {
        let source = include_str!("managed_assets.rs");
        let fence = source
            .split("pub async fn fence_legacy_managed_writes")
            .nth(1)
            .and_then(|rest| rest.split("/// Start the narrow transaction").next())
            .expect("legacy fence source contract");
        assert!(fence.contains("increment_legacy_acquisition_fence"));
        assert!(!fence.contains("referenceCount"));
        assert!(!fence.contains("managedassetreferences"));
    }

    #[test]
    fn legacy_fence_cannot_persist_after_asset_enters_deleting() {
        let source = include_str!("managed_asset_registry.rs");
        let fence = source
            .split("pub async fn increment_legacy_acquisition_fence")
            .nth(1)
            .and_then(|rest| rest.split("pub async fn begin_asset_deletion").next())
            .expect("registry fence source contract");
        assert!(fence.contains("\"folder\": \"covers\""));
        assert!(fence.contains("\"state\": AVAILABLE"));
        assert!(fence.contains("acquisitionFenceVersion"));
        assert!(fence.contains("modified_count != 1"));
    }

    #[test]
    fn closed_inventory_constants_are_exact() {
        assert_eq!(
            ACTIVE_COVERS_WRITERS,
            &[
                ("producttypes", "cover"),
                ("flashsales", "banner"),
                ("articles", "image"),
                ("rewards", "imageUrl"),
                ("sliders", "image"),
            ]
        );
        assert_eq!(RESTRICTED_MANAGED_FIELDS.len(), 11);
        assert_eq!(ENSURE_MANAGED_FIELDS_SOURCE_INVENTORY.len(), 16);
    }

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("webtopup-managed-assets-{nanos}"));
        std::fs::create_dir_all(root.join("icons")).unwrap();
        root
    }

    #[test]
    fn normalize_rejects_path_traversal_and_unsafe_names() {
        let root = temp_root();
        for name in ["", ".", "..", "../x.png", "x\\y.png", "%2fetc.png", "%5cetc.png"] {
            assert!(
                normalize_managed_asset(&root, "icons", name).is_err(),
                "{name}"
            );
        }
        assert!(normalize_managed_asset(&root, "not-a-folder", "a.png").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_accepts_server_generated_basenames() {
        let root = temp_root();
        let managed =
            normalize_managed_asset(&root, "icons", "1710000000000-deadbeef.png").unwrap();
        assert_eq!(managed.folder, "icons");
        assert_eq!(managed.filename, "1710000000000-deadbeef.png");
        assert_eq!(managed.url, "/uploads/icons/1710000000000-deadbeef.png");
        assert_eq!(
            managed.filesystem_path,
            root.join("icons").join("1710000000000-deadbeef.png")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parse_managed_upload_url_only_accepts_internal_upload_paths() {
        assert!(parse_managed_upload_url("/uploads/icons/a.png").is_ok());
        assert!(parse_managed_upload_url("https://cdn.example/a.png").is_err());
        assert!(parse_managed_upload_url("/danayasa-logo.svg").is_err());
        assert!(parse_managed_upload_url("/uploads/icons/../x.png").is_err());
        assert!(parse_managed_upload_url("/uploads/icons/a/b.png").is_err());
    }

    #[test]
    fn registry_covers_authoritative_product_and_flash_banner_not_embedded_icons() {
        assert!(SCALAR_REFERENCES
            .iter()
            .any(|(c, _, f)| *c == "products" && *f == "icon"));
        assert!(SCALAR_REFERENCES
            .iter()
            .any(|(c, _, f)| *c == "flashsales" && *f == "banner"));
        assert!(!SCALAR_REFERENCES
            .iter()
            .any(|(_, _, f)| f.contains("products") || *f == "products.icon"));
        assert!(SCALAR_REFERENCES
            .iter()
            .any(|(c, _, f)| *c == "producttypes" && *f == "popupInfo.image"));
    }

    #[test]
    fn settings_image_keys_are_closed() {
        assert_eq!(SETTINGS_IMAGE_KEYS, &["favicon", "logo", "popupBannerImage"]);
    }

    #[tokio::test]
    async fn managed_reference_requires_an_existing_canonical_file() {
        let root = temp_root();
        assert!(require_existing_managed_asset(&root, "").await.is_ok());
        assert!(require_existing_managed_asset(&root, "📦").await.is_ok());
        assert!(require_existing_managed_asset(&root, "https://cdn.invalid/x.png")
            .await
            .is_ok());
        assert!(require_existing_managed_asset(&root, "/danayasa-logo.svg")
            .await
            .is_ok());
        assert_eq!(
            require_existing_managed_asset(&root, "/uploads/icons/missing.png")
                .await
                .unwrap_err()
                .code(),
            "MANAGED_ASSET_NOT_FOUND",
        );

        let existing = root.join("icons").join("present.png");
        std::fs::write(&existing, b"x").unwrap();
        assert!(require_existing_managed_asset(&root, "/uploads/icons/present.png")
            .await
            .is_ok());
        let _ = std::fs::remove_dir_all(root);
    }
}
