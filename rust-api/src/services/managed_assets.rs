//! Managed upload URL normalization and reference counting.

use std::path::{Path, PathBuf};

use mongodb::{bson::doc, Database};
use serde::Serialize;

const MANAGED_FOLDERS: &[&str] = &["icons", "covers", "popups", "instructions"];

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
}
