//! Read-only slider foundation readiness inspection and the disposable apply gate.
//!
//! This module deliberately owns no slider mutation behavior.  It inventories the filesystem,
//! registry, slider metadata, and claim/index foundation so later mutation handlers can fail closed
//! until every prerequisite is proven.  The only write path is `apply_slider_foundation`, and that
//! function is guarded by the exact disposable database name.

use std::{collections::{HashMap, HashSet}, env, fmt, path::{Path, PathBuf}};

use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document},
    options::IndexOptions,
    Database, IndexModel,
};
use serde::Serialize;

use super::managed_asset_registry::{
    canonical_managed_path, managed_asset_deletion_ready, MANAGED_ASSETS_COLLECTION,
    MANAGED_ASSET_REFERENCES_COLLECTION, MANAGED_ASSET_DELETION_READINESS,
};

pub const SLIDERS_COLLECTION: &str = "sliders";
pub const SLIDER_METADATA_COLLECTION: &str = "slidermetadata";
pub const SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION: &str = "slideridempotencyclaims";
pub const GLOBAL_SLIDER_METADATA_ID: &str = "global";
pub const MAX_FINDINGS: usize = 64;
pub const MAX_FINDING_SAMPLES: usize = 5;
pub const MAX_CURRENT_SLIDERS: i64 = 20;
pub const MAX_ACTIVE_SLIDERS: i64 = 8;

/// The exact database name permitted to receive automated readiness writes.
pub fn apply_allowed(database_name: &str) -> bool {
    database_name == "webtopup_task14_dev"
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderReadinessFinding {
    pub kind: String,
    pub count: u64,
    pub sample_ids: Vec<String>,
    pub blocking: bool,
}

impl SliderReadinessFinding {
    pub fn blocking(kind: impl Into<String>, count: u64, sample_ids: Vec<String>) -> Self {
        Self { kind: kind.into(), count, sample_ids: sample_ids.into_iter().take(MAX_FINDING_SAMPLES).collect(), blocking: true }
    }

    pub fn advisory(kind: impl Into<String>, count: u64, sample_ids: Vec<String>) -> Self {
        Self { kind: kind.into(), count, sample_ids: sample_ids.into_iter().take(MAX_FINDING_SAMPLES).collect(), blocking: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderIndexReadiness {
    pub ready: bool,
    pub missing: Vec<String>,
    pub drifted: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderFolderReadiness {
    pub folder: String,
    pub writer_gate: bool,
    pub deletion_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderReadinessReport {
    pub database: String,
    pub indexes: SliderIndexReadiness,
    pub folder_readiness: Vec<SliderFolderReadiness>,
    pub findings: Vec<SliderReadinessFinding>,
    pub apply_allowed: bool,
    pub blocking: bool,
}

/// Capability state shared with future mutation handlers.  It is deliberately false by default;
/// a clean, read-only inspection plus transaction capability is required before Task 9 can enable
/// any write route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderMutationReadiness {
    pub transaction_capable: bool,
    pub exact_indexes_ready: bool,
    pub registry_ready: bool,
    pub readiness_clean: bool,
    pub mutation_ready: bool,
}

impl Default for SliderMutationReadiness {
    fn default() -> Self {
        Self {
            transaction_capable: false,
            exact_indexes_ready: false,
            registry_ready: false,
            readiness_clean: false,
            mutation_ready: false,
        }
    }
}

impl SliderMutationReadiness {
    pub fn from_report(report: &SliderReadinessReport, transaction_capable: bool) -> Self {
        let exact_indexes_ready = report.indexes.ready;
        let readiness_clean = !report.blocking;
        let registry_ready = exact_indexes_ready
            && report.folder_readiness.iter().any(|folder| folder.folder == "covers" && folder.writer_gate);
        Self {
            transaction_capable,
            exact_indexes_ready,
            registry_ready,
            readiness_clean,
            mutation_ready: transaction_capable && exact_indexes_ready && registry_ready && readiness_clean,
        }
    }
}

impl SliderReadinessReport {
    pub fn empty(database: impl Into<String>) -> Self {
        Self {
            database: database.into(),
            indexes: SliderIndexReadiness { ready: true, missing: Vec::new(), drifted: Vec::new() },
            folder_readiness: folder_readiness(),
            findings: Vec::new(),
            apply_allowed: false,
            blocking: false,
        }
    }

    pub fn push_finding(&mut self, finding: SliderReadinessFinding) {
        self.blocking |= finding.blocking;
        if self.findings.len() < MAX_FINDINGS {
            self.findings.push(finding);
        }
    }

    pub fn data_blocking(&self) -> bool {
        self.findings.iter().any(|finding| finding.blocking)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SliderReadinessError {
    Storage(String),
    ApplyRefused(String),
    ApplyBlocked(String),
}

impl fmt::Display for SliderReadinessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(message) => write!(formatter, "slider readiness storage failure: {message}"),
            Self::ApplyRefused(database) => write!(formatter, "refusing slider readiness apply for database `{database}`"),
            Self::ApplyBlocked(message) => write!(formatter, "slider readiness apply blocked: {message}"),
        }
    }
}

impl std::error::Error for SliderReadinessError {}

#[derive(Debug, Clone)]
pub struct SliderIndexRequirement {
    pub name: &'static str,
    pub collection: &'static str,
    pub keys: Document,
    pub unique: bool,
}

/// Exact semantic indexes required before slider mutation capability can ever be enabled.
/// Existing indexes with equivalent keys/options are accepted regardless of their names.
pub fn slider_foundation_index_requirements() -> Vec<SliderIndexRequirement> {
    vec![
        SliderIndexRequirement { name: "slider_metadata_id", collection: SLIDER_METADATA_COLLECTION, keys: doc! { "_id": 1 }, unique: true },
        SliderIndexRequirement { name: "slider_claim_key_unique", collection: SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION, keys: doc! { "key": 1 }, unique: true },
        SliderIndexRequirement { name: "slider_claim_state_lease", collection: SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION, keys: doc! { "state": 1, "leaseExpiresAt": 1 }, unique: false },
        SliderIndexRequirement { name: "slider_claim_commit_unknown", collection: SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION, keys: doc! { "commitUnknown": 1, "transactionStartedAt": 1 }, unique: false },
        SliderIndexRequirement { name: "managed_asset_canonical_path", collection: MANAGED_ASSETS_COLLECTION, keys: doc! { "canonicalPath": 1 }, unique: true },
        SliderIndexRequirement { name: "managed_asset_state_updated_at", collection: MANAGED_ASSETS_COLLECTION, keys: doc! { "state": 1, "updatedAt": 1 }, unique: false },
        SliderIndexRequirement { name: "managed_asset_reference_unique", collection: MANAGED_ASSET_REFERENCES_COLLECTION, keys: doc! { "assetId": 1, "resourceType": 1, "resourceId": 1, "field": 1 }, unique: true },
        SliderIndexRequirement { name: "managed_asset_reference_resource", collection: MANAGED_ASSET_REFERENCES_COLLECTION, keys: doc! { "resourceType": 1, "resourceId": 1, "field": 1 }, unique: false },
        SliderIndexRequirement { name: "managed_asset_reference_asset", collection: MANAGED_ASSET_REFERENCES_COLLECTION, keys: doc! { "assetId": 1 }, unique: false },
        SliderIndexRequirement { name: "slider_snapshot_foundation", collection: SLIDERS_COLLECTION, keys: doc! { "lifecycle": 1, "status": 1, "sortOrder": 1, "_id": 1 }, unique: false },
    ]
}

/// Build exact index models for disposable apply.  No TTL is used by any slider foundation index.
pub fn slider_foundation_index_models() -> Vec<IndexModel> {
    slider_foundation_index_requirements().into_iter().map(|requirement| {
        IndexModel::builder()
            .keys(requirement.keys)
            .options(IndexOptions::builder().name(requirement.name.to_string()).unique(requirement.unique).build())
            .build()
    }).collect()
}

pub fn folder_readiness() -> Vec<SliderFolderReadiness> {
    MANAGED_ASSET_DELETION_READINESS.iter().map(|(folder, writer_gate)| SliderFolderReadiness {
        folder: (*folder).to_string(),
        writer_gate: *writer_gate,
        deletion_ready: *writer_gate && managed_asset_deletion_ready(folder),
    }).collect()
}

/// Return the repository upload root without creating directories or touching the filesystem.
pub fn default_upload_root() -> PathBuf {
    if let Ok(path) = env::var("UPLOAD_DIR") {
        return PathBuf::from(path);
    }
    if let Ok(current) = env::current_dir() {
        for candidate in [current.join("uploads"), current.join("../uploads"), current.join("server/uploads"), current.join("../server/uploads")] {
            if candidate.exists() { return candidate; }
        }
    }
    PathBuf::from("../uploads")
}

/// Inspect all readiness inputs.  This function is read-only and is safe to invoke at production
/// startup; it never creates indexes, registers files, repairs rows, or enables writes.
pub async fn inspect_slider_foundation(
    db: &Database,
    upload_root: &Path,
) -> Result<SliderReadinessReport, SliderReadinessError> {
    let indexes = inspect_slider_indexes(db).await.map_err(storage_error)?;
    let mut report = SliderReadinessReport::empty(db.name());
    report.indexes = indexes.clone();
    if !indexes.missing.is_empty() {
        for name in indexes.missing.iter().take(MAX_FINDINGS) {
            report.push_finding(SliderReadinessFinding::blocking("missing_exact_index", 1, vec![name.clone()]));
        }
    }
    if !indexes.drifted.is_empty() {
        for name in indexes.drifted.iter().take(MAX_FINDINGS) {
            report.push_finding(SliderReadinessFinding::blocking("drifted_exact_index", 1, vec![name.clone()]));
        }
    }

    let findings = inspect_slider_data(db, upload_root).await?;
    for finding in findings { report.push_finding(finding); }
    report.blocking |= !report.indexes.ready;
    report.apply_allowed = apply_allowed(db.name()) && report.indexes.drifted.is_empty() && !report.data_blocking();
    Ok(report)
}

async fn inspect_slider_indexes(db: &Database) -> Result<SliderIndexReadiness, mongodb::error::Error> {
    let mut missing = Vec::new();
    let mut drifted = Vec::new();
    for requirement in slider_foundation_index_requirements() {
        let listed = match list_indexes(db.collection::<Document>(requirement.collection)).await {
            Ok(listed) => listed,
            Err(error) if namespace_missing(&error) => { missing.push(requirement.name.to_string()); continue; }
            Err(error) => return Err(error),
        };
        let semantic = listed.iter().find(|model| model.keys == requirement.keys);
        match semantic {
            None => missing.push(requirement.name.to_string()),
            Some(model) if !index_matches(&requirement, model) => drifted.push(requirement.name.to_string()),
            Some(_) => {}
        }
    }
    Ok(SliderIndexReadiness { ready: missing.is_empty() && drifted.is_empty(), missing, drifted })
}

async fn list_indexes(collection: mongodb::Collection<Document>) -> Result<Vec<IndexModel>, mongodb::error::Error> {
    let mut cursor = collection.list_indexes().await?;
    let mut models = Vec::new();
    while cursor.advance().await? { models.push(cursor.deserialize_current()?); }
    Ok(models)
}

fn index_matches(requirement: &SliderIndexRequirement, actual: &IndexModel) -> bool {
    if requirement.keys == doc! { "_id": 1 } {
        return actual.keys == requirement.keys
            && actual.options.as_ref().and_then(|options| options.name.as_deref()) == Some("_id_")
            && actual.options.as_ref().and_then(|options| options.expire_after).is_none();
    }
    if actual.keys != requirement.keys {
        return false;
    }

    let Some(options) = actual.options.as_ref() else {
        return !requirement.unique;
    };

    // Index names are operational labels rather than safety semantics. MongoDB's built-in `_id_`
    // index is therefore accepted by its key/options, even though its name cannot be selected by
    // this requirement model. The server-populated index version is also metadata, but an unknown
    // or obsolete version is not accepted.
    let unique = options.unique.unwrap_or(false);
    let sparse = options.sparse.unwrap_or(false);
    let hidden = options.hidden.unwrap_or(false);
    let version_compatible = matches!(
        options.version.as_ref(),
        None
            | Some(mongodb::options::IndexVersion::V1)
            | Some(mongodb::options::IndexVersion::V2)
    );

    unique == requirement.unique
        && !sparse
        && !hidden
        && options.expire_after.is_none()
        && options.partial_filter_expression.is_none()
        && options.collation.is_none()
        && options.storage_engine.is_none()
        && options.default_language.is_none()
        && options.language_override.is_none()
        && options.text_index_version.is_none()
        && options.weights.is_none()
        && options.sphere_2d_index_version.is_none()
        && options.bits.is_none()
        && options.max.is_none()
        && options.min.is_none()
        && options.bucket_size.is_none()
        && options.wildcard_projection.is_none()
        && options.clustered().unwrap_or(false) == false
        && version_compatible
}

fn namespace_missing(error: &mongodb::error::Error) -> bool {
    let text = format!("{error:?}").to_ascii_lowercase();
    text.contains("namespacenotfound") || text.contains("ns does not exist")
}

fn storage_error(error: mongodb::error::Error) -> SliderReadinessError {
    SliderReadinessError::Storage(format!("{error:?}"))
}

async fn inspect_slider_data(db: &Database, upload_root: &Path) -> Result<Vec<SliderReadinessFinding>, SliderReadinessError> {
    let mut findings = Vec::new();
    let mut add = |finding: SliderReadinessFinding| { if findings.len() < MAX_FINDINGS { findings.push(finding); } };

    let files = cover_files(upload_root)?;
    let assets = load_documents(db, MANAGED_ASSETS_COLLECTION).await?;
    let references = load_documents(db, MANAGED_ASSET_REFERENCES_COLLECTION).await?;
    let sliders = load_documents(db, SLIDERS_COLLECTION).await?;
    let claims = load_documents(db, SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION).await?;

    let mut file_paths = HashSet::new();
    for (path, filename) in files.iter() {
        file_paths.insert(path.clone());
        if !is_safe_cover_filename(filename) {
            add(SliderReadinessFinding::blocking("invalid_cover_filename", 1, vec![path.clone()]));
        }
    }
    let mut asset_by_path: HashMap<String, Vec<&Document>> = HashMap::new();
    let mut asset_by_id: HashMap<String, &Document> = HashMap::new();
    for asset in &assets {
        let id = document_id(asset);
        if !id.is_empty() { asset_by_id.insert(id, asset); }
        let Some(path) = asset.get_str("canonicalPath").ok().map(str::to_string) else {
            add(SliderReadinessFinding::blocking("managed_asset_path_missing", 1, vec![document_id(asset)]));
            continue;
        };
        asset_by_path.entry(path.clone()).or_default().push(asset);
        match canonical_managed_path(&path) {
            Ok((folder, _)) if folder == "covers" => {}
            _ => add(SliderReadinessFinding::blocking("managed_asset_path_invalid", 1, vec![path.clone()])),
        }
        let state = asset.get_str("state").unwrap_or("");
        if matches!(state, "deleting" | "deleted") || asset.get("deletedAt").is_some_and(|value| !matches!(value, Bson::Null)) {
            add(SliderReadinessFinding::blocking("managed_asset_stuck_or_deleted", 1, vec![document_id(asset)]));
        } else if state != "available" {
            add(SliderReadinessFinding::blocking("managed_asset_state_invalid", 1, vec![document_id(asset)]));
        }
        let Some((_, filename)) = canonical_managed_path(&path).ok() else { continue; };
        let expected = upload_root.join("covers").join(filename);
        if !expected.is_file() {
            add(SliderReadinessFinding::blocking("managed_asset_missing_file", 1, vec![path]));
        }
    }
    for (path, _) in files.iter() {
        if !asset_by_path.contains_key(path) {
            add(SliderReadinessFinding::blocking("orphan_cover_file", 1, vec![path.clone()]));
        }
    }
    for (path, rows) in asset_by_path.iter() {
        if rows.len() > 1 {
            add(SliderReadinessFinding::blocking("duplicate_canonical_path", (rows.len() - 1) as u64, vec![path.clone()]));
        }
    }

    let mut reference_groups: HashMap<String, u64> = HashMap::new();
    let mut references_by_asset: HashMap<String, u64> = HashMap::new();
    let mut slider_reference_keys = HashSet::new();
    for reference in &references {
        let asset_id = reference.get("assetId").map(bson_identity).unwrap_or_default();
        let resource_type = reference.get_str("resourceType").unwrap_or("");
        let resource_id = reference.get("resourceId").map(bson_identity).unwrap_or_default();
        let field = reference.get_str("field").unwrap_or("");
        if asset_id.is_empty() || resource_type.is_empty() || resource_id.is_empty() || field.is_empty() {
            add(SliderReadinessFinding::blocking("invalid_reference_row", 1, vec![document_id(reference)]));
            continue;
        }
        let key = format!("{asset_id}|{resource_type}|{resource_id}|{field}");
        let count = reference_groups.entry(key.clone()).or_default();
        *count = count.saturating_add(1);
        if *count > 1 { add(SliderReadinessFinding::blocking("duplicate_reference", *count - 1, vec![key.clone()])); }
        *references_by_asset.entry(asset_id.clone()).or_default() += 1;
        if resource_type == "slider" && field == "image" { slider_reference_keys.insert((asset_id.clone(), resource_id)); }
        if let Some(asset) = asset_by_id.get(&asset_id) {
            if reference.get_str("canonicalPath").ok() != asset.get_str("canonicalPath").ok() {
                add(SliderReadinessFinding::blocking("reference_path_mismatch", 1, vec![document_id(reference)]));
            }
        } else {
            add(SliderReadinessFinding::blocking("reference_asset_missing", 1, vec![asset_id]));
        }
    }
    for asset in &assets {
        let id = document_id(asset);
        let actual = references_by_asset.get(&id).copied().unwrap_or(0);
        let Some(expected) = integer_field(asset, "referenceCount") else {
            add(SliderReadinessFinding::blocking("reference_count_missing", 1, vec![id]));
            continue;
        };
        if expected < 0 || expected as u64 != actual {
            add(SliderReadinessFinding::blocking("reference_count_mismatch", 1, vec![document_id(asset)]));
        }
    }

    let mut current_orders = Vec::new();
    let mut current_count = 0_i64;
    let mut active_count = 0_i64;
    let metadata = db.collection::<Document>(SLIDER_METADATA_COLLECTION).find_one(doc! { "_id": GLOBAL_SLIDER_METADATA_ID }).await.map_err(storage_error)?;
    match metadata {
        None => add(SliderReadinessFinding::blocking("missing_slider_revision_metadata", 1, vec![GLOBAL_SLIDER_METADATA_ID.to_string()])),
        Some(document) => match integer_field(&document, "revision") {
            Some(revision) if revision >= 0 => {}
            _ => add(SliderReadinessFinding::blocking("invalid_slider_revision_metadata", 1, vec![GLOBAL_SLIDER_METADATA_ID.to_string()])),
        },
    }
    let mut slider_ids = HashSet::new();
    for slider in &sliders {
        let id = document_id(slider);
        slider_ids.insert(id.clone());
        let lifecycle = slider.get_str("lifecycle").ok();
        if lifecycle.is_none() { add(SliderReadinessFinding::blocking("missing_slider_lifecycle", 1, vec![id.clone()])); }
        if lifecycle.is_some_and(|value| value != "active" && value != "archived") {
            add(SliderReadinessFinding::blocking("invalid_slider_lifecycle", 1, vec![id.clone()]));
        }
        let archived = lifecycle == Some("archived");
        if !archived {
            current_count += 1;
            match integer_field(slider, "sortOrder") {
                Some(order) if order >= 0 => current_orders.push((order, id.clone())),
                _ => add(SliderReadinessFinding::blocking("invalid_current_order", 1, vec![id.clone()])),
            }
            if slider.get_bool("status").unwrap_or(false) { active_count += 1; }
        }
        let image = slider.get_str("image").unwrap_or("");
        let canonical = canonical_managed_path(image).ok().filter(|(folder, _)| *folder == "covers");
        let Some((_, filename)) = canonical else {
            add(SliderReadinessFinding::blocking("legacy_or_invalid_slider_image", 1, vec![id.clone()]));
            continue;
        };
        let canonical_path = format!("/uploads/covers/{filename}");
        if !file_paths.contains(&canonical_path) { add(SliderReadinessFinding::blocking("slider_missing_file", 1, vec![id.clone()])); }
        let Some(asset_rows) = asset_by_path.get(&canonical_path) else {
            add(SliderReadinessFinding::blocking("slider_unregistered_asset", 1, vec![id.clone()]));
            continue;
        };
        if asset_rows.len() != 1 { continue; }
        let asset_id = document_id(asset_rows[0]);
        let has_reference = slider_reference_keys.contains(&(asset_id, id.clone()));
        if archived {
            if has_reference { add(SliderReadinessFinding::blocking("archived_slider_reference_present", 1, vec![id.clone()])); }
        } else if !has_reference {
            add(SliderReadinessFinding::blocking("slider_reference_missing", 1, vec![id.clone()]));
        }
        if !is_valid_slider_link(slider.get_str("link").unwrap_or("")) {
            add(SliderReadinessFinding::blocking("legacy_invalid_slider_link", 1, vec![id]));
        }
    }
    current_orders.sort_by_key(|(order, id)| (*order, id.clone()));
    if current_orders.iter().enumerate().any(|(expected, (actual, _))| *actual != expected as i64) {
        add(SliderReadinessFinding::blocking("invalid_current_order", 1, current_orders.iter().map(|(_, id)| id.clone()).collect()));
    }
    if current_count > MAX_CURRENT_SLIDERS { add(SliderReadinessFinding::blocking("slider_total_limit_exceeded", current_count as u64, Vec::new())); }
    if active_count > MAX_ACTIVE_SLIDERS { add(SliderReadinessFinding::blocking("slider_active_limit_exceeded", active_count as u64, Vec::new())); }

    for claim in claims {
        if !valid_slider_claim_foundation(&claim) {
            add(SliderReadinessFinding::blocking("invalid_slider_claim_foundation", 1, vec![document_id(&claim)]));
        }
    }
    Ok(findings)
}

fn cover_files(root: &Path) -> Result<Vec<(String, String)>, SliderReadinessError> {
    let entries = std::fs::read_dir(root.join("covers")).map_err(|error| {
        SliderReadinessError::Storage(format!("unable to read covers directory: {error}"))
    })?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            SliderReadinessError::Storage(format!("unable to read covers directory entry: {error}"))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            SliderReadinessError::Storage(format!("unable to inspect covers entry: {error}"))
        })?;
        if !file_type.is_file() {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        files.push((format!("/uploads/covers/{filename}"), filename));
    }
    Ok(files)
}

fn is_safe_cover_filename(filename: &str) -> bool {
    !filename.is_empty() && filename != "." && filename != ".." && filename.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_valid_slider_link(value: &str) -> bool {
    if value.is_empty() { return true; }
    if value.starts_with('/') {
        return !value.starts_with("//") && !value.contains('\\') && !value.chars().any(char::is_control) && !value.split(['?', '#']).next().unwrap_or(value).split('/').any(|segment| segment == "." || segment == "..") && !value.to_ascii_lowercase().contains("%2f") && !value.to_ascii_lowercase().contains("%5c") && !value.to_ascii_lowercase().contains("%2e");
    }
    let Ok(url) = url::Url::parse(value) else { return false; };
    url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none() && !value.chars().any(char::is_control)
}

fn integer_field(document: &Document, key: &str) -> Option<i64> {
    match document.get(key) {
        Some(Bson::Int32(value)) => Some(i64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value),
        Some(Bson::Double(value)) if value.is_finite() && value.fract() == 0.0 && *value >= i64::MIN as f64 && *value <= i64::MAX as f64 => Some(*value as i64),
        _ => None,
    }
}

fn bson_identity(value: &Bson) -> String {
    match value {
        Bson::ObjectId(id) => id.to_hex(),
        Bson::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn document_id(document: &Document) -> String {
    document.get("_id").map(bson_identity).unwrap_or_default()
}

async fn load_documents(db: &Database, collection: &str) -> Result<Vec<Document>, SliderReadinessError> {
    let mut cursor = db.collection::<Document>(collection).find(doc! {}).await.map_err(storage_error)?;
    let mut documents = Vec::new();
    while let Some(document) = cursor.try_next().await.map_err(storage_error)? { documents.push(document); }
    Ok(documents)
}

/// Claims are only inspected here. This validates the durable foundation fields without
/// implementing claim lifecycle/recovery (which belongs to Task 8).
pub fn valid_slider_claim_foundation(document: &Document) -> bool {
    let key = document.get_str("key").ok();
    let contract = document.get_str("contractVersion").ok();
    let state = document.get_str("state").ok();
    let action = document.get_str("action").ok();
    let expected_revision = integer_field(document, "expectedRevision");
    let operator_id = document.get_object_id("operatorId").ok();
    let target_id = document.get("targetId");
    let payload_digest = document.get_str("payloadDigest").ok();
    let claim_token = document.get_str("claimToken").ok();
    let lease_generation = integer_field(document, "leaseGeneration");
    let commit_unknown = document.get_bool("commitUnknown").ok();
    let transaction_started_at = match document.get("transactionStartedAt") {
        None => None,
        Some(Bson::DateTime(value)) => Some(value),
        Some(_) => return false,
    };

    let key_valid = key.is_some_and(|value| {
        (8..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    });
    let contract_valid = contract == Some("slider-revision-v1");
    let action_valid = action.is_some_and(|value| {
        matches!(value, "create" | "update" | "archive" | "restore" | "reorder")
    });
    let target_valid = match (action, target_id) {
        (Some("create" | "reorder"), Some(Bson::Null)) => true,
        (Some("update" | "archive" | "restore"), Some(Bson::ObjectId(_))) => true,
        _ => false,
    };
    let digest_valid = payload_digest.is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    });
    let token_valid = claim_token.is_some_and(|value| {
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
    });
    let generation_valid = lease_generation.is_some_and(|value| value >= 1);
    let Some(commit_unknown) = commit_unknown else {
        return false;
    };
    let Some(state) = state else {
        return false;
    };
    let state_valid = matches!(
        state,
        "started" | "completed" | "inProgress" | "in_progress" | "retryable" | "commitUnknown" | "commit_unknown"
    );
    let lifecycle_consistent = match (state, commit_unknown, transaction_started_at) {
        // A commit-unknown flag is permanently fenced and must identify that fence. Task 8 may
        // retain the ordinary in-progress state while setting this flag.
        (_, true, Some(_)) => true,
        // A completed claim necessarily crossed the durable transaction-start fence.
        ("completed", false, Some(_)) => true,
        // Pre-transaction claims may not have a start timestamp yet. A fenced in-progress claim
        // may retain one while it is being recovered by Task 8.
        ("started" | "inProgress" | "in_progress" | "retryable", false, _) => true,
        _ => false,
    };

    key_valid
        && contract_valid
        && state_valid
        && action_valid
        && expected_revision.is_some_and(|value| value >= 0)
        && operator_id.is_some()
        && target_valid
        && digest_valid
        && token_valid
        && generation_valid
        && lifecycle_consistent
}

/// Create exact indexes and reconcile only safe metadata/count fields on the disposable database.
/// No filesystem or image/link data is invented and this function can never target production.
pub async fn apply_slider_foundation(db: &Database, upload_root: &Path) -> Result<SliderReadinessReport, SliderReadinessError> {
    if !apply_allowed(db.name()) { return Err(SliderReadinessError::ApplyRefused(db.name().to_string())); }
    let before = inspect_slider_foundation(db, upload_root).await?;
    if !before.indexes.drifted.is_empty() { return Err(SliderReadinessError::ApplyBlocked(format!("drifted indexes: {:?}", before.indexes.drifted))); }
    let unrepairable = before.findings.iter().filter(|finding| finding.blocking && !matches!(finding.kind.as_str(), "missing_exact_index" | "missing_slider_lifecycle" | "missing_slider_revision_metadata" | "reference_count_mismatch" | "reference_count_missing")).collect::<Vec<_>>();
    if !unrepairable.is_empty() { return Err(SliderReadinessError::ApplyBlocked(format!("findings: {:?}", unrepairable.iter().map(|finding| &finding.kind).collect::<Vec<_>>()))); }

    for requirement in slider_foundation_index_requirements() {
        let collection = db.collection::<Document>(requirement.collection);
        let listed = list_indexes(collection.clone()).await.map_err(storage_error)?;
        if listed.iter().any(|model| model.keys == requirement.keys && index_matches(&requirement, model)) { continue; }
        // MongoDB creates the built-in _id index when metadata is first inserted.  Creating it
        // explicitly is both unnecessary and rejected by some server versions.
        if requirement.collection == SLIDER_METADATA_COLLECTION { continue; }
        collection.create_index(IndexModel::builder().keys(requirement.keys).options(IndexOptions::builder().name(requirement.name.to_string()).unique(requirement.unique).build()).build()).await.map_err(storage_error)?;
    }
    db.collection::<Document>(SLIDERS_COLLECTION).update_many(doc! { "lifecycle": { "$exists": false } }, doc! { "$set": { "lifecycle": "active" } }).await.map_err(storage_error)?;
    db.collection::<Document>(SLIDER_METADATA_COLLECTION).update_one(doc! { "_id": GLOBAL_SLIDER_METADATA_ID }, doc! { "$setOnInsert": { "revision": 0_i64, "updatedAt": mongodb::bson::DateTime::now() } }).upsert(true).await.map_err(storage_error)?;

    // Reconcile counts only after duplicate/path integrity has been proven by the preflight.
    let references = load_documents(db, MANAGED_ASSET_REFERENCES_COLLECTION).await?;
    let mut counts: HashMap<String, i64> = HashMap::new();
    for reference in references { let id = reference.get("assetId").map(bson_identity).unwrap_or_default(); if !id.is_empty() { *counts.entry(id).or_default() += 1; } }
    for asset in load_documents(db, MANAGED_ASSETS_COLLECTION).await? {
        let id = document_id(&asset);
        if !id.is_empty() { db.collection::<Document>(MANAGED_ASSETS_COLLECTION).update_one(doc! { "_id": asset.get("_id").cloned().unwrap_or(Bson::Null) }, doc! { "$set": { "referenceCount": counts.get(&id).copied().unwrap_or(0), "updatedAt": mongodb::bson::DateTime::now() } }).await.map_err(storage_error)?; }
    }
    inspect_slider_foundation(db, upload_root).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_refuses_every_database_except_exact_disposable_name() {
        for name in ["webtopup", "webtopup_task14", "webtopup_task14_dev_backup", ""] { assert!(!apply_allowed(name)); }
        assert!(apply_allowed("webtopup_task14_dev"));
    }

    #[test]
    fn readiness_finding_bound_is_fail_closed() {
        let mut report = SliderReadinessReport::empty("webtopup");
        for index in 0..(MAX_FINDINGS + 10) { report.push_finding(SliderReadinessFinding::blocking("synthetic", 1, vec![index.to_string()])); }
        assert_eq!(report.findings.len(), MAX_FINDINGS);
        assert!(report.blocking);
    }

    #[test]
    fn exact_readiness_indexes_include_registry_slider_and_claim_foundation() {
        let requirements = slider_foundation_index_requirements();
        assert!(requirements.iter().any(|requirement| requirement.collection == MANAGED_ASSETS_COLLECTION && requirement.keys == doc! { "canonicalPath": 1 } && requirement.unique));
        assert!(requirements.iter().any(|requirement| requirement.collection == SLIDERS_COLLECTION && requirement.keys == doc! { "lifecycle": 1, "status": 1, "sortOrder": 1, "_id": 1 } && !requirement.unique));
        assert!(requirements.iter().any(|requirement| requirement.collection == SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION && requirement.keys == doc! { "key": 1 } && requirement.unique));
    }

    #[test]
    fn deletion_readiness_is_writer_fenced_only_for_covers() {
        let report = SliderReadinessReport::empty("webtopup_task14_dev");
        assert_eq!(report.folder_readiness.len(), 4);
        assert!(report.folder_readiness.iter().find(|folder| folder.folder == "covers").unwrap().writer_gate);
        for folder in ["icons", "popups", "instructions"] { assert!(!report.folder_readiness.iter().find(|item| item.folder == folder).unwrap().deletion_ready); }
    }

    #[test]
    fn invalid_claim_foundation_is_blocking_without_claim_lifecycle_behavior() {
        assert!(!valid_slider_claim_foundation(&doc! { "key": "", "state": "completed" }));
    }

    #[test]
    fn cover_inventory_missing_directory_is_a_storage_error() {
        let root = std::env::temp_dir().join(format!(
            "webtopup-slider-readiness-missing-{}",
            mongodb::bson::oid::ObjectId::new()
        ));
        let result = cover_files(&root);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            SliderReadinessError::Storage(_)
        ));
    }

    #[test]
    fn builtin_metadata_id_index_is_semantically_accepted() {
        let requirement = slider_foundation_index_requirements()
            .into_iter()
            .find(|requirement| requirement.collection == SLIDER_METADATA_COLLECTION)
            .unwrap();
        let builtin = IndexModel::builder()
            .keys(doc! { "_id": 1 })
            .options(IndexOptions::builder().name("_id_".to_string()).build())
            .build();
        assert!(index_matches(&requirement, &builtin));
    }

    #[test]
    fn index_matching_rejects_incompatible_options_but_ignores_name() {
        let requirement = SliderIndexRequirement {
            name: "expected",
            collection: SLIDERS_COLLECTION,
            keys: doc! { "lifecycle": 1 },
            unique: false,
        };
        let safe = |options| IndexModel::builder().keys(doc! { "lifecycle": 1 }).options(options).build();
        assert!(index_matches(
            &requirement,
            &safe(IndexOptions::builder().name("equivalent-existing-name".to_string()).build()),
        ));

        let incompatible = [
            IndexOptions::builder().partial_filter_expression(doc! { "status": true }).build(),
            IndexOptions::builder().sparse(true).build(),
            IndexOptions::builder().hidden(true).build(),
            IndexOptions::builder()
                .collation(mongodb::options::Collation::builder().locale("en").build())
                .build(),
            IndexOptions::builder()
                .expire_after(std::time::Duration::from_secs(60))
                .build(),
            IndexOptions::builder().storage_engine(doc! { "wiredTiger": {} }).build(),
        ];
        for options in incompatible {
            assert!(!index_matches(&requirement, &safe(options)));
        }
    }

    fn claim_foundation_fixture() -> Document {
        doc! {
            "key": "slider-key",
            "contractVersion": "slider-revision-v1",
            "operatorId": mongodb::bson::oid::ObjectId::new(),
            "targetId": Bson::Null,
            "action": "create",
            "expectedRevision": 0_i64,
            "payloadDigest": "a".repeat(64),
            "state": "started",
            "claimToken": "claim-token",
            "leaseGeneration": 1_i64,
            "commitUnknown": false,
        }
    }

    #[test]
    fn claim_requires_durable_foundation_fields() {
        for field in [
            "operatorId",
            "targetId",
            "payloadDigest",
            "claimToken",
            "leaseGeneration",
            "commitUnknown",
        ] {
            let mut claim = claim_foundation_fixture();
            claim.remove(field);
            assert!(
                !valid_slider_claim_foundation(&claim),
                "claim without {field} must be rejected"
            );
        }
    }

    #[test]
    fn claim_commit_unknown_requires_a_transaction_start_timestamp() {
        let mut claim = claim_foundation_fixture();
        claim.insert("commitUnknown", true);
        assert!(!valid_slider_claim_foundation(&claim));

        claim.insert("transactionStartedAt", mongodb::bson::DateTime::now());
        assert!(valid_slider_claim_foundation(&claim));

        claim.insert("transactionStartedAt", "not-a-date");
        assert!(!valid_slider_claim_foundation(&claim));
    }
}
