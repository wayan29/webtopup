use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    Database,
};
use std::{collections::HashSet, error::Error, fmt};

use super::session_store::AUTH_SESSIONS_COLLECTION;
use crate::state::RecoveryEncryptionKeyRing;

#[derive(Debug, Clone, Copy)]
pub struct SessionMigrationLimits {
    pub max_candidates: u64,
    pub update_batch_size: usize,
    pub max_reported_ids: usize,
}

impl Default for SessionMigrationLimits {
    fn default() -> Self {
        Self {
            max_candidates: 10_000,
            update_batch_size: 500,
            max_reported_ids: 20,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionMigrationReport {
    pub renamed: u64,
    pub equal_legacy_removed: u64,
    pub reported_session_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PredecessorEncryptionReport {
    pub unexpired_predecessor_rows: u64,
    pub referenced_encryption_key_ids: Vec<String>,
    pub incomplete_predecessor_rows: u64,
}

#[derive(Debug)]
pub enum SessionMigrationError {
    CandidateLimit,
    UnsafeRow,
    Residue,
    UnknownEncryptionKey { key_id: String, count: u64 },
    IncompletePredecessorEncryption { count: u64 },
    Database(mongodb::error::Error),
}

impl fmt::Display for SessionMigrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::CandidateLimit => "session-version migration candidate limit exceeded",
            Self::UnsafeRow => "unsafe or malformed session migration row",
            Self::Residue => "conflicting or missing canonical session version remains",
            Self::UnknownEncryptionKey { .. } => {
                "unexpired predecessor references unknown encryption key"
            }
            Self::IncompletePredecessorEncryption { .. } => {
                "unexpired predecessor missing encrypted seed fields"
            }
            Self::Database(_) => "session migration database error",
        })
    }
}
impl Error for SessionMigrationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            _ => None,
        }
    }
}
impl From<mongodb::error::Error> for SessionMigrationError {
    fn from(value: mongodb::error::Error) -> Self {
        Self::Database(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowAction {
    Rename,
    UnsetLegacy,
    Clean,
    Unsafe,
}

fn classify(row: &Document) -> RowAction {
    let legacy = row.get_i64("sessionVersion").ok();
    let canonical = row.get_i64("sessionVersionAtIssue").ok();
    match (legacy, canonical) {
        (Some(_), None) => RowAction::Rename,
        (Some(a), Some(b)) if a == b => RowAction::UnsetLegacy,
        (None, Some(_)) => RowAction::Clean,
        _ => RowAction::Unsafe,
    }
}

fn plan_update_batches(
    rows: Vec<Document>,
    batch_size: usize,
) -> Result<Vec<Vec<Document>>, SessionMigrationError> {
    if batch_size == 0 {
        return Err(SessionMigrationError::CandidateLimit);
    }
    let mut actionable = Vec::new();
    for row in rows {
        match classify(&row) {
            RowAction::Rename | RowAction::UnsetLegacy => actionable.push(row),
            RowAction::Clean => {}
            RowAction::Unsafe => return Err(SessionMigrationError::UnsafeRow),
        }
    }
    Ok(actionable
        .chunks(batch_size)
        .map(|chunk| chunk.to_vec())
        .collect())
}

fn validated_id(row: &Document) -> Result<ObjectId, SessionMigrationError> {
    let sid = row
        .get_object_id("sessionId")
        .map_err(|_| SessionMigrationError::UnsafeRow)?;
    ObjectId::parse_str(sid.to_hex()).map_err(|_| SessionMigrationError::UnsafeRow)
}

pub async fn migrate_session_version_at_issue(
    db: &Database,
    limits: SessionMigrationLimits,
) -> Result<SessionMigrationReport, SessionMigrationError> {
    if limits.max_candidates == 0 || limits.update_batch_size == 0 {
        return Err(SessionMigrationError::CandidateLimit);
    }
    let collection = db.collection::<Document>(AUTH_SESSIONS_COLLECTION);
    let candidate_filter = doc! { "$or": [
        { "sessionVersion": { "$exists": true } },
        { "sessionVersionAtIssue": { "$exists": false } }
    ]};
    let count = collection.count_documents(candidate_filter.clone()).await?;
    if count > limits.max_candidates {
        return Err(SessionMigrationError::CandidateLimit);
    }

    let mut cursor = collection
        .find(candidate_filter)
        .projection(
            doc! { "_id": 0, "sessionId": 1, "sessionVersion": 1, "sessionVersionAtIssue": 1 },
        )
        .await?;
    let mut rows = Vec::new();
    while cursor.advance().await? {
        rows.push(cursor.deserialize_current()?);
    }
    let mut report = SessionMigrationReport::default();
    for batch in plan_update_batches(rows, limits.update_batch_size)? {
        for row in batch {
            let sid = validated_id(&row)?;
            if report.reported_session_ids.len() < limits.max_reported_ids {
                report.reported_session_ids.push(sid.to_hex());
            }
            let (update, counter) = match classify(&row) {
                RowAction::Rename => (
                    doc! { "$rename": { "sessionVersion": "sessionVersionAtIssue" } },
                    0,
                ),
                RowAction::UnsetLegacy => (doc! { "$unset": { "sessionVersion": "" } }, 1),
                RowAction::Clean => continue,
                RowAction::Unsafe => return Err(SessionMigrationError::UnsafeRow),
            };
            let result = collection
                .update_one(doc! { "sessionId": sid }, update)
                .await?;
            if result.modified_count != 1 {
                return Err(SessionMigrationError::Residue);
            }
            if counter == 0 {
                report.renamed += 1;
            } else {
                report.equal_legacy_removed += 1;
            }
        }
    }
    let residue = collection
        .count_documents(doc! { "$or": [
            { "sessionVersion": { "$exists": true } },
            { "sessionVersionAtIssue": { "$exists": false } }
        ]})
        .await?;
    if residue != 0 {
        return Err(SessionMigrationError::Residue);
    }
    Ok(report)
}

fn binary_bytes(value: &mongodb::bson::Bson) -> Option<&[u8]> {
    match value {
        mongodb::bson::Bson::Binary(b) => Some(b.bytes.as_slice()),
        _ => None,
    }
}

fn predecessor_encryption_complete(pred: &Document) -> bool {
    let nonce = pred.get("recoverySeedNonce").and_then(binary_bytes);
    let cipher = pred.get("recoverySeedCiphertext").and_then(binary_bytes);
    let key_id = pred.get_str("recoveryEncryptionKeyId").ok();
    let version = pred.get_str("recoveryEncryptionVersion").ok();
    let expires = pred.get_datetime("recoveryExpiresAt").ok();
    nonce.map(|b| b.len() == 24).unwrap_or(false)
        && cipher.map(|b| !b.is_empty()).unwrap_or(false)
        && key_id.map(|s| !s.is_empty()).unwrap_or(false)
        && version
            .map(|s| s == "xchacha20poly1305-v1")
            .unwrap_or(false)
        && expires.is_some()
}

pub async fn verify_predecessor_encryption_residue(
    db: &Database,
    encryption_keys: &RecoveryEncryptionKeyRing,
    limits: SessionMigrationLimits,
) -> Result<PredecessorEncryptionReport, SessionMigrationError> {
    let now = DateTime::now();
    let collection = db.collection::<Document>(AUTH_SESSIONS_COLLECTION);
    let filter = doc! {
        "immediatePredecessor.recoveryExpiresAt": { "$gte": now }
    };
    let count = collection.count_documents(filter.clone()).await?;
    if count > limits.max_candidates {
        return Err(SessionMigrationError::CandidateLimit);
    }
    let mut cursor = collection
        .find(filter)
        .projection(doc! {
            "_id": 0,
            "sessionId": 1,
            "immediatePredecessor": 1
        })
        .await?;
    let mut report = PredecessorEncryptionReport::default();
    let mut key_ids = HashSet::new();
    while cursor.advance().await? {
        let row = cursor.deserialize_current()?;
        report.unexpired_predecessor_rows += 1;
        let Some(pred) = row.get_document("immediatePredecessor").ok() else {
            report.incomplete_predecessor_rows += 1;
            continue;
        };
        if !predecessor_encryption_complete(pred) {
            report.incomplete_predecessor_rows += 1;
        }
        if let Ok(id) = pred.get_str("recoveryEncryptionKeyId") {
            if !id.is_empty() {
                key_ids.insert(id.to_string());
            }
        }
    }
    if report.incomplete_predecessor_rows > 0 {
        return Err(SessionMigrationError::IncompletePredecessorEncryption {
            count: report.incomplete_predecessor_rows,
        });
    }
    for key_id in &key_ids {
        if encryption_keys.get(key_id).is_none() {
            return Err(SessionMigrationError::UnknownEncryptionKey {
                key_id: key_id.clone(),
                count: 1,
            });
        }
        if report.referenced_encryption_key_ids.len() < limits.max_reported_ids {
            report.referenced_encryption_key_ids.push(key_id.clone());
        }
    }
    Ok(report)
}

#[cfg(test)]
mod session_migration_tests {
    use super::*;

    #[test]
    fn session_migration_classifies_all_four_field_shapes() {
        assert_eq!(
            classify(&doc! { "sessionVersion": 2_i64 }),
            RowAction::Rename
        );
        assert_eq!(
            classify(&doc! { "sessionVersion": 2_i64, "sessionVersionAtIssue": 2_i64 }),
            RowAction::UnsetLegacy
        );
        assert_eq!(
            classify(&doc! { "sessionVersionAtIssue": 2_i64 }),
            RowAction::Clean
        );
        assert_eq!(
            classify(&doc! { "sessionVersion": 2_i64, "sessionVersionAtIssue": 3_i64 }),
            RowAction::Unsafe
        );
        assert_eq!(classify(&doc! {}), RowAction::Unsafe);
    }

    #[test]
    fn session_migration_rejects_malformed_ids_and_bounds_report_ids() {
        assert!(validated_id(&doc! { "sessionId": "not-an-object-id" }).is_err());
        let limits = SessionMigrationLimits::default();
        assert!(limits.max_reported_ids <= limits.max_candidates as usize);
        assert!(limits.update_batch_size <= limits.max_candidates as usize);
    }

    #[test]
    fn session_migration_batches_are_bounded_and_reruns_are_idempotent() {
        let rows = vec![
            doc! { "sessionId": ObjectId::new(), "sessionVersion": 1_i64 },
            doc! { "sessionId": ObjectId::new(), "sessionVersion": 2_i64 },
            doc! { "sessionId": ObjectId::new(), "sessionVersion": 3_i64 },
        ];
        let batches = plan_update_batches(rows.clone(), 2).unwrap();
        assert_eq!(batches.iter().map(Vec::len).collect::<Vec<_>>(), vec![2, 1]);

        let mut interrupted = rows;
        for row in &mut interrupted[..2] {
            let value = row.remove("sessionVersion").unwrap();
            row.insert("sessionVersionAtIssue", value);
        }
        let rerun = plan_update_batches(interrupted, 2).unwrap();
        assert_eq!(rerun.iter().map(Vec::len).collect::<Vec<_>>(), vec![1]);
        assert!(plan_update_batches(
            vec![doc! { "sessionId": ObjectId::new(), "sessionVersionAtIssue": 3_i64 }],
            2
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn predecessor_encryption_complete_requires_all_fields() {
        let mut pred = doc! {
            "recoverySeedNonce": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![0; 24] },
            "recoverySeedCiphertext": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![1, 2] },
            "recoveryEncryptionKeyId": "enc1",
            "recoveryEncryptionVersion": "xchacha20poly1305-v1",
            "recoveryExpiresAt": DateTime::now(),
        };
        assert!(predecessor_encryption_complete(&pred));
        pred.insert(
            "recoverySeedNonce",
            mongodb::bson::Binary {
                subtype: mongodb::bson::spec::BinarySubtype::Generic,
                bytes: vec![0; 8],
            },
        );
        assert!(!predecessor_encryption_complete(&pred));
    }
}
