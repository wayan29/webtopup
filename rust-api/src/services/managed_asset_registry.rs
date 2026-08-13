//! Transactional registry foundation for canonical, managed upload assets.
//!
//! The upload publication module is intentionally private to its route module. Task 3 therefore
//! exposes `PublishedAssetRegistration` as the narrow boundary consumed by later upload wiring.
//! Registration itself never assumes a filesystem root or silently enables deletion readiness.

use std::path::PathBuf;

use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::IndexOptions,
    ClientSession, Database, IndexModel,
};

pub const MANAGED_ASSETS_COLLECTION: &str = "managedassets";
pub const MANAGED_ASSET_REFERENCES_COLLECTION: &str = "managedassetreferences";
const AVAILABLE: &str = "available";
const DELETING: &str = "deleting";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedAssetState {
    Available,
    Deleting,
}

impl ManagedAssetState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Available => AVAILABLE,
            Self::Deleting => DELETING,
        }
    }

    fn from_str(value: &str) -> Result<Self, RegistryError> {
        match value {
            AVAILABLE => Ok(Self::Available),
            DELETING => Ok(Self::Deleting),
            _ => Err(RegistryError::Unavailable),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalImageMetadata {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedAssetRegistration {
    pub url: String,
    pub filename: String,
    pub path: PathBuf,
    pub metadata: CanonicalImageMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedReferenceOutcome {
    pub asset_id: ObjectId,
    pub reference_id: ObjectId,
    pub reference_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionOutcome {
    pub asset_id: ObjectId,
    pub state: ManagedAssetState,
    pub reference_count: i64,
    pub acquisition_fence_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceAction {
    Acquire,
    Release,
    /// The exact unique reference row was absent; release must fail closed.
    ReleaseMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryError {
    Unavailable,
    NotFound,
    ReferenceMismatch,
    ReferenceUnderflow,
    PathInvalid,
    AlreadyDeleting,
    Storage,
}

impl RegistryError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "MANAGED_ASSET_REGISTRY_UNAVAILABLE",
            Self::NotFound => "MANAGED_ASSET_NOT_FOUND",
            Self::ReferenceMismatch => "MANAGED_ASSET_REFERENCE_MISMATCH",
            Self::ReferenceUnderflow => "MANAGED_ASSET_REFERENCE_UNDERFLOW",
            Self::PathInvalid => "MANAGED_ASSET_PATH_INVALID",
            Self::AlreadyDeleting => "MANAGED_ASSET_ALREADY_DELETING",
            Self::Storage => "MANAGED_ASSET_STORAGE_FAILURE",
        }
    }
}

fn storage_error(_: mongodb::error::Error) -> RegistryError {
    RegistryError::Storage
}

async fn abort_preserving(
    session: &mut ClientSession,
    error: RegistryError,
) -> RegistryError {
    let _ = session.abort_transaction().await;
    error
}

pub fn managed_asset_index_models() -> Vec<IndexModel> {
    fn model(keys: Document, unique: bool) -> IndexModel {
        IndexModel::builder()
            .keys(keys)
            .options(IndexOptions::builder().unique(unique).build())
            .build()
    }

    vec![
        model(doc! { "canonicalPath": 1 }, true),
        model(doc! { "state": 1, "updatedAt": 1 }, false),
        model(
            doc! { "assetId": 1, "resourceType": 1, "resourceId": 1, "field": 1 },
            true,
        ),
        model(doc! { "resourceType": 1, "resourceId": 1, "field": 1 }, false),
        model(doc! { "assetId": 1 }, false),
    ]
}

pub async fn ensure_managed_asset_indexes(db: &Database) -> Result<(), RegistryError> {
    db.collection::<Document>(MANAGED_ASSETS_COLLECTION)
        .create_indexes(managed_asset_index_models()[..2].to_vec())
        .await
        .map_err(storage_error)?;
    db.collection::<Document>(MANAGED_ASSET_REFERENCES_COLLECTION)
        .create_indexes(managed_asset_index_models()[2..].to_vec())
        .await
        .map_err(storage_error)?;
    Ok(())
}

pub fn reference_transition(
    state: ManagedAssetState,
    reference_count: i64,
    action: ReferenceAction,
) -> Result<i64, RegistryError> {
    match action {
        ReferenceAction::Acquire if state == ManagedAssetState::Deleting => {
            Err(RegistryError::Unavailable)
        }
        ReferenceAction::Acquire => reference_count
            .checked_add(1)
            .ok_or(RegistryError::Storage),
        ReferenceAction::ReleaseMissing => Err(RegistryError::ReferenceMismatch),
        ReferenceAction::Release if reference_count <= 0 => Err(RegistryError::ReferenceUnderflow),
        ReferenceAction::Release => reference_count
            .checked_sub(1)
            .ok_or(RegistryError::ReferenceUnderflow),
    }
}

pub fn increment_acquisition_fence_version(current: i64) -> Result<i64, RegistryError> {
    current.checked_add(1).ok_or(RegistryError::Storage)
}

pub fn canonical_managed_path(path: &str) -> Result<(&str, &str), RegistryError> {
    let path = path.trim();
    let remainder = path
        .strip_prefix("/uploads/")
        .ok_or(RegistryError::PathInvalid)?;
    let mut parts = remainder.split('/');
    let folder = parts.next().ok_or(RegistryError::PathInvalid)?;
    let filename = parts.next().ok_or(RegistryError::PathInvalid)?;
    if parts.next().is_some() || folder != "covers" || !is_safe_filename(filename) {
        return Err(RegistryError::PathInvalid);
    }
    Ok((folder, filename))
}

fn is_safe_filename(filename: &str) -> bool {
    !filename.is_empty()
        && filename != "."
        && filename != ".."
        && filename.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn asset_document(
    asset_id: ObjectId,
    registration: &PublishedAssetRegistration,
    now: DateTime,
) -> Result<Document, RegistryError> {
    let (folder, filename) = canonical_managed_path(&registration.url)?;
    if registration.filename != filename || registration.path.as_os_str().is_empty() {
        return Err(RegistryError::PathInvalid);
    }
    Ok(doc! {
        "_id": asset_id,
        "canonicalPath": &registration.url,
        "folder": folder,
        "filename": filename,
        "format": &registration.metadata.format,
        "size": i64::try_from(registration.metadata.byte_length).map_err(|_| RegistryError::Storage)?,
        "width": i64::from(registration.metadata.width),
        "height": i64::from(registration.metadata.height),
        "state": AVAILABLE,
        "referenceCount": 0_i64,
        "acquisitionFenceVersion": 0_i64,
        "publishedAt": now,
        "deletingAt": Bson::Null,
        "deletedAt": Bson::Null,
        "updatedAt": now,
    })
}

fn document_i64(document: &Document, key: &str) -> Result<i64, RegistryError> {
    document
        .get_i64(key)
        .map_err(|_| RegistryError::Storage)
}

fn asset_outcome(document: Document) -> Result<DeletionOutcome, RegistryError> {
    let asset_id = document
        .get_object_id("_id")
        .map_err(|_| RegistryError::Storage)?;
    let state = ManagedAssetState::from_str(
        document
            .get_str("state")
            .map_err(|_| RegistryError::Storage)?,
    )?;
    Ok(DeletionOutcome {
        asset_id,
        state,
        reference_count: document_i64(&document, "referenceCount")?,
        acquisition_fence_version: document_i64(&document, "acquisitionFenceVersion")?,
    })
}

fn is_duplicate_key(error: &mongodb::error::Error) -> bool {
    let text = format!("{error:?}").to_ascii_lowercase();
    text.contains("duplicate key") || text.contains("e11000") || text.contains("11000")
}

pub async fn register_published_asset(
    db: &Database,
    registration: &PublishedAssetRegistration,
) -> Result<ObjectId, RegistryError> {
    let asset_id = ObjectId::new();
    let document = asset_document(asset_id, registration, DateTime::now())?;
    db.collection::<Document>(MANAGED_ASSETS_COLLECTION)
        .insert_one(document)
        .await
        .map_err(|error| {
            if is_duplicate_key(&error) {
                RegistryError::ReferenceMismatch
            } else {
                RegistryError::Storage
            }
        })?;
    Ok(asset_id)
}

/// Register every published asset in one client-owned MongoDB transaction. The caller is
/// responsible for publishing files before invoking this boundary and for unlinking them if this
/// transaction cannot commit; this foundation deliberately does not invent a filesystem root.
pub async fn register_published_batch_in_transaction(
    db: &Database,
    registrations: &[PublishedAssetRegistration],
) -> Result<Vec<ObjectId>, RegistryError> {
    let mut session = db
        .client()
        .start_session()
        .await
        .map_err(|_| RegistryError::Unavailable)?;
    session
        .start_transaction()
        .await
        .map_err(|_| RegistryError::Unavailable)?;

    let assets = db.collection::<Document>(MANAGED_ASSETS_COLLECTION);
    let mut ids = Vec::with_capacity(registrations.len());
    for registration in registrations {
        let asset_id = ObjectId::new();
        let document = match asset_document(asset_id, registration, DateTime::now()) {
            Ok(document) => document,
            Err(error) => {
                let _ = session.abort_transaction().await;
                return Err(error);
            }
        };
        if let Err(error) = assets.insert_one(document).session(&mut session).await {
            let _ = session.abort_transaction().await;
            return Err(if is_duplicate_key(&error) {
                RegistryError::ReferenceMismatch
            } else {
                RegistryError::Storage
            });
        }
        ids.push(asset_id);
    }

    session
        .commit_transaction()
        .await
        .map_err(|_| RegistryError::Unavailable)?;
    Ok(ids)
}

pub async fn acquire_slider_reference(
    session: &mut ClientSession,
    db: &Database,
    path: &str,
    slider_id: ObjectId,
) -> Result<ManagedReferenceOutcome, RegistryError> {
    canonical_managed_path(path)?;
    let assets = db.collection::<Document>(MANAGED_ASSETS_COLLECTION);
    let references = db.collection::<Document>(MANAGED_ASSET_REFERENCES_COLLECTION);
    let asset = assets
        .find_one(doc! {
            "canonicalPath": path,
            "folder": "covers",
            "state": AVAILABLE,
        })
        .session(&mut *session)
        .await
        .map_err(storage_error)?
        .ok_or(RegistryError::NotFound)?;
    let asset_id = asset
        .get_object_id("_id")
        .map_err(|_| RegistryError::Storage)?;
    let expected_count = document_i64(&asset, "referenceCount")?;
    let next_count = reference_transition(
        ManagedAssetState::Available,
        expected_count,
        ReferenceAction::Acquire,
    )?;
    let reference_id = ObjectId::new();
    if let Err(error) = references
        .insert_one(doc! {
            "_id": reference_id,
            "assetId": asset_id,
            "canonicalPath": path,
            "resourceType": "slider",
            "resourceId": slider_id,
            "field": "image",
            "createdAt": DateTime::now(),
        })
        .session(&mut *session)
        .await
    {
        let mapped = if is_duplicate_key(&error) {
            RegistryError::ReferenceMismatch
        } else {
            RegistryError::Storage
        };
        return Err(abort_preserving(session, mapped).await);
    }
    let result = match assets
        .update_one(
            doc! {
                "_id": asset_id,
                "canonicalPath": path,
                "folder": "covers",
                "state": AVAILABLE,
                "referenceCount": expected_count,
            },
            doc! {
                "$inc": { "referenceCount": 1_i64 },
                "$set": { "updatedAt": DateTime::now() },
            },
        )
        .session(&mut *session)
        .await
    {
        Ok(result) => result,
        Err(error) => return Err(abort_preserving(session, storage_error(error)).await),
    };
    if result.modified_count != 1 {
        return Err(abort_preserving(session, RegistryError::Unavailable).await);
    }
    Ok(ManagedReferenceOutcome {
        asset_id,
        reference_id,
        reference_count: next_count,
    })
}

pub async fn release_slider_reference(
    session: &mut ClientSession,
    db: &Database,
    path: &str,
    slider_id: ObjectId,
) -> Result<ManagedReferenceOutcome, RegistryError> {
    canonical_managed_path(path)?;
    let assets = db.collection::<Document>(MANAGED_ASSETS_COLLECTION);
    let references = db.collection::<Document>(MANAGED_ASSET_REFERENCES_COLLECTION);
    let asset = assets
        .find_one(doc! { "canonicalPath": path, "folder": "covers" })
        .session(&mut *session)
        .await
        .map_err(storage_error)?
        .ok_or(RegistryError::NotFound)?;
    let asset_id = asset
        .get_object_id("_id")
        .map_err(|_| RegistryError::Storage)?;
    let expected_count = document_i64(&asset, "referenceCount")?;
    // find_one_and_delete returns the deleted document (the MongoDB operation is inherently
    // the "before" image; unlike find_one_and_update it has no after-image mode).
    let deleted = match references
        .find_one_and_delete(doc! {
            "assetId": asset_id,
            "canonicalPath": path,
            "resourceType": "slider",
            "resourceId": slider_id,
            "field": "image",
        })
        .session(&mut *session)
        .await
    {
        Ok(Some(document)) => document,
        Ok(None) => return Err(RegistryError::ReferenceMismatch),
        Err(error) => return Err(abort_preserving(session, storage_error(error)).await),
    };
    let reference_id = match deleted.get_object_id("_id") {
        Ok(reference_id) => reference_id,
        Err(_) => return Err(abort_preserving(session, RegistryError::Storage).await),
    };
    let next_count = match reference_transition(
        ManagedAssetState::Available,
        expected_count,
        ReferenceAction::Release,
    ) {
        Ok(next_count) => next_count,
        Err(error) => return Err(abort_preserving(session, error).await),
    };
    let result = match assets
        .update_one(
            doc! {
                "_id": asset_id,
                "canonicalPath": path,
                "referenceCount": expected_count,
                "state": { "$in": [AVAILABLE, DELETING] },
            },
            doc! {
                "$inc": { "referenceCount": -1_i64 },
                "$set": { "updatedAt": DateTime::now() },
            },
        )
        .session(&mut *session)
        .await
    {
        Ok(result) => result,
        Err(error) => return Err(abort_preserving(session, storage_error(error)).await),
    };
    if result.modified_count != 1 {
        return Err(abort_preserving(session, RegistryError::Unavailable).await);
    }
    Ok(ManagedReferenceOutcome {
        asset_id,
        reference_id,
        reference_count: next_count,
    })
}

pub async fn increment_legacy_acquisition_fence(
    session: &mut ClientSession,
    db: &Database,
    path: &str,
) -> Result<(), RegistryError> {
    canonical_managed_path(path)?;
    let result = db
        .collection::<Document>(MANAGED_ASSETS_COLLECTION)
        .update_one(
            doc! { "canonicalPath": path, "folder": "covers", "state": AVAILABLE },
            doc! {
                "$inc": { "acquisitionFenceVersion": 1_i64 },
                "$set": { "updatedAt": DateTime::now() },
            },
        )
        .session(&mut *session)
        .await
        .map_err(storage_error)?;
    if result.modified_count != 1 {
        return Err(RegistryError::Unavailable);
    }
    Ok(())
}

pub async fn begin_asset_deletion(
    session: &mut ClientSession,
    db: &Database,
    path: &str,
) -> Result<DeletionOutcome, RegistryError> {
    canonical_managed_path(path)?;
    let assets = db.collection::<Document>(MANAGED_ASSETS_COLLECTION);
    let now = DateTime::now();
    let updated = assets
        .find_one_and_update(
            doc! {
                "canonicalPath": path,
                "folder": "covers",
                "state": AVAILABLE,
                "referenceCount": 0_i64,
            },
            doc! {
                "$set": {
                    "state": DELETING,
                    "deletingAt": now,
                    "updatedAt": now,
                },
            },
        )
        .return_document(mongodb::options::ReturnDocument::After)
        .session(&mut *session)
        .await
        .map_err(storage_error)?;
    if let Some(document) = updated {
        return asset_outcome(document);
    }
    let existing = assets
        .find_one(doc! { "canonicalPath": path })
        .session(&mut *session)
        .await
        .map_err(storage_error)?
        .ok_or(RegistryError::NotFound)?;
    if existing.get_str("state").ok() == Some(DELETING) {
        return Err(RegistryError::AlreadyDeleting);
    }
    if document_i64(&existing, "referenceCount").unwrap_or(1) != 0 {
        return Err(RegistryError::ReferenceMismatch);
    }
    Err(RegistryError::Unavailable)
}

pub async fn mark_asset_deleted(
    session: &mut ClientSession,
    db: &Database,
    asset_id: ObjectId,
) -> Result<DeletionOutcome, RegistryError> {
    let now = DateTime::now();
    let updated = db
        .collection::<Document>(MANAGED_ASSETS_COLLECTION)
        .find_one_and_update(
            doc! { "_id": asset_id, "state": DELETING },
            doc! { "$set": { "deletedAt": now, "updatedAt": now } },
        )
        .return_document(mongodb::options::ReturnDocument::After)
        .session(&mut *session)
        .await
        .map_err(storage_error)?
        .ok_or(RegistryError::NotFound)?;
    asset_outcome(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    fn assert_index(
        models: &[IndexModel],
        keys: mongodb::bson::Document,
        unique: bool,
        ttl: Option<std::time::Duration>,
    ) {
        let model = models.iter().find(|model| model.keys == keys).unwrap();
        let options = model.options.as_ref().unwrap();
        assert_eq!(options.unique, Some(unique));
        assert_eq!(options.expire_after, ttl);
    }

    fn assert_no_ttl(models: &[IndexModel]) {
        assert!(models.iter().all(|model| {
            model
                .options
                .as_ref()
                .and_then(|options| options.expire_after)
                .is_none()
        }));
    }

    #[test]
    fn registry_indexes_are_unique_only_where_required() {
        let models = managed_asset_index_models();
        assert_index(&models, doc! { "canonicalPath": 1 }, true, None);
        assert_index(
            &models,
            doc! { "assetId": 1, "resourceType": 1, "resourceId": 1, "field": 1 },
            true,
            None,
        );
        assert_index(&models, doc! { "state": 1, "updatedAt": 1 }, false, None);
        assert_index(
            &models,
            doc! { "resourceType": 1, "resourceId": 1, "field": 1 },
            false,
            None,
        );
        assert_index(&models, doc! { "assetId": 1 }, false, None);
        assert_no_ttl(&models);
    }

    #[test]
    fn deleting_assets_never_accept_new_references() {
        assert_eq!(
            reference_transition(ManagedAssetState::Deleting, 0, ReferenceAction::Acquire)
                .unwrap_err()
                .code(),
            "MANAGED_ASSET_REGISTRY_UNAVAILABLE"
        );
    }

    #[test]
    fn reference_transitions_reject_underflow_and_mismatch() {
        assert_eq!(
            reference_transition(ManagedAssetState::Available, 0, ReferenceAction::Release)
                .unwrap_err()
                .code(),
            "MANAGED_ASSET_REFERENCE_UNDERFLOW"
        );
        assert_eq!(
            reference_transition(
                ManagedAssetState::Available,
                1,
                ReferenceAction::ReleaseMissing,
            )
            .unwrap_err()
            .code(),
            "MANAGED_ASSET_REFERENCE_MISMATCH"
        );
    }

    #[test]
    fn acquisition_fence_version_is_monotonic() {
        assert_eq!(increment_acquisition_fence_version(0).unwrap(), 1);
        assert_eq!(increment_acquisition_fence_version(1).unwrap(), 2);
        assert_eq!(increment_acquisition_fence_version(i64::MAX).unwrap_err().code(), "MANAGED_ASSET_STORAGE_FAILURE");
    }

    #[test]
    fn canonical_folder_and_path_checks_are_strict() {
        assert!(canonical_managed_path("/uploads/covers/example.webp").is_ok());
        for path in [
            "/uploads/icons/example.webp",
            "/uploads/covers/../example.webp",
            "/uploads/covers/a/b.webp",
            "/uploads/covers/%2e%2e.webp",
            "https://example.test/example.webp",
        ] {
            assert!(canonical_managed_path(path).is_err(), "{path}");
        }
    }
}
