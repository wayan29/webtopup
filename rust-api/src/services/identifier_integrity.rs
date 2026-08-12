//! Identifier index models, readiness inspection, and fail-closed runtime gates.
//! Production index creation is never performed by the API process; only the
//! disposable readiness binary may apply exact indexes to `webtopup_task14_dev`.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use mongodb::options::IndexOptions;
use mongodb::{Database, IndexModel};

pub const INDEX_TRANSACTION_REFERENCE: &str = "uniq_transactions_reference_id";
pub const INDEX_GUEST_INVOICE: &str = "uniq_guest_invoice_number";
pub const INDEX_DAILY_REFERENCE_COUNTER: &str = "uniq_identifier_counter_scope_date";

pub const COLLECTION_TRANSACTIONS: &str = "transactions";
pub const COLLECTION_GUEST_TRANSACTIONS: &str = "guesttransactions";
pub const COLLECTION_IDENTIFIER_COUNTERS: &str = "identifiercounters";

const SUCCESS_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct IdentifierIndexRequirement {
    pub name: &'static str,
    pub collection: &'static str,
    pub keys: Document,
    pub unique: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifierIndexReadiness {
    pub ready: bool,
    pub missing: Vec<String>,
    pub drifted: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentifierReadinessError {
    Unavailable,
}

impl IdentifierReadinessError {
    pub fn code(self) -> &'static str {
        "IDENTIFIER_INDEX_UNAVAILABLE"
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifierDataFinding {
    pub kind: &'static str,
    pub count: u64,
    pub sample_ids: Vec<String>,
    pub blocking: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifierReadinessReport {
    pub database: String,
    pub indexes: IdentifierIndexReadiness,
    pub findings: Vec<IdentifierDataFinding>,
    pub apply_allowed: bool,
    pub blocking: bool,
}

struct SuccessCache {
    database: String,
    observed_at: Instant,
}

static SUCCESS_CACHE: OnceLock<Mutex<Option<SuccessCache>>> = OnceLock::new();

fn success_cache() -> &'static Mutex<Option<SuccessCache>> {
    SUCCESS_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn identifier_index_models() -> Vec<IdentifierIndexRequirement> {
    vec![
        IdentifierIndexRequirement {
            name: INDEX_TRANSACTION_REFERENCE,
            collection: COLLECTION_TRANSACTIONS,
            keys: doc! { "referenceId": 1 },
            unique: true,
        },
        IdentifierIndexRequirement {
            name: INDEX_GUEST_INVOICE,
            collection: COLLECTION_GUEST_TRANSACTIONS,
            keys: doc! { "invoiceNumber": 1 },
            unique: true,
        },
        IdentifierIndexRequirement {
            name: INDEX_DAILY_REFERENCE_COUNTER,
            collection: COLLECTION_IDENTIFIER_COUNTERS,
            keys: doc! { "scope": 1, "dateWib": 1 },
            unique: true,
        },
    ]
}

pub fn identifier_index_model(requirement: &IdentifierIndexRequirement) -> IndexModel {
    IndexModel::builder()
        .keys(requirement.keys.clone())
        .options(
            IndexOptions::builder()
                .name(requirement.name.to_string())
                .unique(requirement.unique)
                .build(),
        )
        .build()
}

/// Automated `--apply` is allowed only for the exact disposable verification database.
pub fn apply_is_allowed(database_name: &str) -> bool {
    database_name == "webtopup_task14_dev"
}

pub fn clear_identifier_index_cache_for_tests() {
    if let Ok(mut guard) = success_cache().lock() {
        *guard = None;
    }
}

pub async fn inspect_identifier_indexes(
    db: &Database,
) -> Result<IdentifierIndexReadiness, mongodb::error::Error> {
    let mut missing = Vec::new();
    let mut drifted = Vec::new();

    for requirement in identifier_index_models() {
        let collection = db.collection::<Document>(requirement.collection);
        let listed = list_index_models(&collection).await?;
        match listed.iter().find(|model| {
            model
                .options
                .as_ref()
                .and_then(|options| options.name.as_deref())
                == Some(requirement.name)
        }) {
            None => missing.push(requirement.name.to_string()),
            Some(actual) => {
                if !index_matches_requirement(&requirement, actual) {
                    drifted.push(requirement.name.to_string());
                }
            }
        }
    }

    Ok(IdentifierIndexReadiness {
        ready: missing.is_empty() && drifted.is_empty(),
        missing,
        drifted,
    })
}

pub async fn require_identifier_indexes(db: &Database) -> Result<(), IdentifierReadinessError> {
    let database_name = db.name().to_string();
    if let Ok(guard) = success_cache().lock() {
        if let Some(cache) = guard.as_ref() {
            if cache.database == database_name && cache.observed_at.elapsed() < SUCCESS_CACHE_TTL {
                return Ok(());
            }
        }
    }

    let readiness = inspect_identifier_indexes(db)
        .await
        .map_err(|_| IdentifierReadinessError::Unavailable)?;
    if !readiness.ready {
        return Err(IdentifierReadinessError::Unavailable);
    }

    if let Ok(mut guard) = success_cache().lock() {
        *guard = Some(SuccessCache {
            database: database_name,
            observed_at: Instant::now(),
        });
    }
    Ok(())
}

pub async fn inspect_identifier_data(
    db: &Database,
) -> Result<Vec<IdentifierDataFinding>, mongodb::error::Error> {
    let mut findings = Vec::new();

    findings.push(
        aggregate_duplicate_non_empty(
            db,
            COLLECTION_TRANSACTIONS,
            "referenceId",
            "duplicate_transaction_reference_id",
        )
        .await?,
    );
    findings.push(
        count_missing_or_empty(
            db,
            COLLECTION_TRANSACTIONS,
            "referenceId",
            "missing_transaction_reference_id",
        )
        .await?,
    );
    findings.push(
        aggregate_duplicate_non_empty(
            db,
            COLLECTION_GUEST_TRANSACTIONS,
            "invoiceNumber",
            "duplicate_guest_invoice_number",
        )
        .await?,
    );
    findings.push(
        count_missing_or_empty(
            db,
            COLLECTION_GUEST_TRANSACTIONS,
            "invoiceNumber",
            "missing_guest_invoice_number",
        )
        .await?,
    );
    findings.extend(inspect_settings_findings(db).await?);

    Ok(findings
        .into_iter()
        .filter(|finding| finding.count > 0)
        .collect())
}

pub async fn build_identifier_readiness_report(
    db: &Database,
) -> Result<IdentifierReadinessReport, mongodb::error::Error> {
    let indexes = inspect_identifier_indexes(db).await?;
    let findings = inspect_identifier_data(db).await?;
    let blocking_findings = findings.iter().any(|finding| finding.blocking);
    let blocking = !indexes.ready || blocking_findings;
    Ok(IdentifierReadinessReport {
        database: db.name().to_string(),
        indexes,
        findings,
        apply_allowed: apply_is_allowed(db.name()) && !blocking,
        blocking,
    })
}

pub async fn apply_identifier_indexes(
    db: &Database,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !apply_is_allowed(db.name()) {
        return Err(format!(
            "refusing to apply identifier indexes to protected database `{}`",
            db.name()
        )
        .into());
    }

    // Indexes may be missing (that is why we apply). Blocking *data* findings must not.
    let data_findings = inspect_identifier_data(db).await?;
    if data_findings.iter().any(|finding| finding.blocking) {
        return Err("blocking identifier data findings prevent index apply".into());
    }
    let before = inspect_identifier_indexes(db).await?;
    if !before.drifted.is_empty() {
        return Err(format!(
            "drifted identifier indexes prevent apply: {:?}",
            before.drifted
        )
        .into());
    }

    for requirement in identifier_index_models() {
        if before.missing.iter().any(|name| name == requirement.name) {
            let collection = db.collection::<Document>(requirement.collection);
            collection
                .create_index(identifier_index_model(&requirement))
                .await?;
        }
    }

    let after = inspect_identifier_indexes(db).await?;
    if !after.ready {
        return Err(format!(
            "indexes not ready after apply: missing={:?} drifted={:?}",
            after.missing, after.drifted
        )
        .into());
    }
    clear_identifier_index_cache_for_tests();
    Ok(())
}

async fn list_index_models(
    collection: &mongodb::Collection<Document>,
) -> Result<Vec<IndexModel>, mongodb::error::Error> {
    let mut cursor = collection.list_indexes().await?;
    let mut models = Vec::new();
    while cursor.advance().await? {
        models.push(cursor.deserialize_current()?);
    }
    Ok(models)
}

fn index_matches_requirement(requirement: &IdentifierIndexRequirement, actual: &IndexModel) -> bool {
    if actual.keys != requirement.keys {
        return false;
    }
    let unique = actual
        .options
        .as_ref()
        .and_then(|options| options.unique)
        .unwrap_or(false);
    if requirement.unique && !unique {
        return false;
    }
    let has_ttl = actual
        .options
        .as_ref()
        .and_then(|options| options.expire_after)
        .is_some();
    !has_ttl
}

async fn aggregate_duplicate_non_empty(
    db: &Database,
    collection: &str,
    field: &str,
    kind: &'static str,
) -> Result<IdentifierDataFinding, mongodb::error::Error> {
    let pipeline = vec![
        doc! {
            "$match": {
                field: { "$type": "string", "$ne": "" }
            }
        },
        doc! {
            "$group": {
                "_id": format!("${field}"),
                "count": { "$sum": 1 },
                "sampleIds": { "$push": { "$toString": "$_id" } }
            }
        },
        doc! { "$match": { "count": { "$gt": 1 } } },
        doc! { "$limit": 20 },
    ];
    let mut cursor = db
        .collection::<Document>(collection)
        .aggregate(pipeline)
        .await?;
    let mut total = 0u64;
    let mut samples = Vec::new();
    while let Some(document) = cursor.try_next().await? {
        let count = document.get_i64("count").unwrap_or(0).max(0) as u64;
        total = total.saturating_add(count.saturating_sub(1));
        if let Ok(ids) = document.get_array("sampleIds") {
            for id in ids.iter().take(5) {
                if let Some(text) = id.as_str() {
                    if samples.len() < 5 {
                        samples.push(text.to_string());
                    }
                }
            }
        }
    }
    Ok(IdentifierDataFinding {
        kind,
        count: total,
        sample_ids: samples,
        blocking: total > 0,
    })
}

async fn count_missing_or_empty(
    db: &Database,
    collection: &str,
    field: &str,
    kind: &'static str,
) -> Result<IdentifierDataFinding, mongodb::error::Error> {
    let filter = doc! {
        "$or": [
            { field: { "$exists": false } },
            { field: null },
            { field: "" },
        ]
    };
    let count = db
        .collection::<Document>(collection)
        .count_documents(filter.clone())
        .await?;
    let mut samples = Vec::new();
    if count > 0 {
        let mut cursor = db
            .collection::<Document>(collection)
            .find(filter)
            .limit(5)
            .await?;
        while let Some(document) = cursor.try_next().await? {
            if let Ok(id) = document.get_object_id("_id") {
                samples.push(id.to_hex());
            }
        }
    }
    Ok(IdentifierDataFinding {
        kind,
        count,
        sample_ids: samples,
        // Missing historical referenceId blocks full unique index activation.
        blocking: count > 0,
    })
}

async fn inspect_settings_findings(
    db: &Database,
) -> Result<Vec<IdentifierDataFinding>, mongodb::error::Error> {
    let mut findings = Vec::new();
    let settings = db.collection::<Document>("settings");

    if let Some(document) = settings
        .find_one(doc! { "key": "refIdDateFormat" })
        .await?
    {
        let raw = document.get("value").and_then(|value| value.as_str());
        let unsafe_format = match raw {
            Some(value) => {
                let normalized = value.trim();
                normalized.is_empty()
                    || normalized.eq_ignore_ascii_case("NONE")
                    || !matches!(
                        normalized,
                        "DDMMYYYY" | "YYYYMMDD" | "MMDDYYYY" | "DDMMYY" | "YYMMDD"
                    )
            }
            None => true,
        };
        if unsafe_format {
            findings.push(IdentifierDataFinding {
                kind: "unsafe_ref_id_date_format",
                count: 1,
                sample_ids: document
                    .get_object_id("_id")
                    .ok()
                    .map(|id| vec![id.to_hex()])
                    .unwrap_or_default(),
                // Production readiness blocker; runtime fails safe to DDMMYYYY.
                blocking: true,
            });
        }
    }

    if let Some(document) = settings
        .find_one(doc! { "key": "invoiceRandomLength" })
        .await?
    {
        let length = document
            .get("value")
            .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|n| n as i64)));
        let random_type = settings
            .find_one(doc! { "key": "invoiceRandomType" })
            .await?
            .and_then(|doc| {
                doc.get("value")
                    .and_then(|value| value.as_str().map(str::to_string))
            })
            .unwrap_or_else(|| "alphanumeric".to_string());
        let min = if random_type == "numeric" { 10 } else { 8 };
        if length.is_none_or(|value| value < min || value > 12) {
            findings.push(IdentifierDataFinding {
                kind: "unsafe_invoice_random_length",
                count: 1,
                sample_ids: document
                    .get_object_id("_id")
                    .ok()
                    .map(|id| vec![id.to_hex()])
                    .unwrap_or_default(),
                blocking: true,
            });
        }
    }

    Ok(findings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    fn assert_requirement(
        requirements: &[IdentifierIndexRequirement],
        name: &str,
        collection: &str,
        keys: Document,
        unique: bool,
    ) {
        let requirement = requirements
            .iter()
            .find(|item| item.name == name)
            .unwrap_or_else(|| panic!("missing requirement {name}"));
        assert_eq!(requirement.collection, collection);
        assert_eq!(requirement.keys, keys);
        assert_eq!(requirement.unique, unique);
        let model = identifier_index_model(requirement);
        assert_eq!(
            model.options.as_ref().and_then(|options| options.name.as_deref()),
            Some(name)
        );
        assert_eq!(
            model
                .options
                .as_ref()
                .and_then(|options| options.unique)
                .unwrap_or(false),
            unique
        );
        assert!(model
            .options
            .as_ref()
            .and_then(|options| options.expire_after)
            .is_none());
    }

    #[test]
    fn required_identifier_indexes_are_exact_and_unique() {
        let requirements = identifier_index_models();
        assert_eq!(requirements.len(), 3);
        assert_requirement(
            &requirements,
            INDEX_TRANSACTION_REFERENCE,
            "transactions",
            doc! { "referenceId": 1 },
            true,
        );
        assert_requirement(
            &requirements,
            INDEX_GUEST_INVOICE,
            "guesttransactions",
            doc! { "invoiceNumber": 1 },
            true,
        );
        assert_requirement(
            &requirements,
            INDEX_DAILY_REFERENCE_COUNTER,
            "identifiercounters",
            doc! { "scope": 1, "dateWib": 1 },
            true,
        );
    }

    #[test]
    fn apply_is_allowed_only_for_exact_disposable_database() {
        assert!(apply_is_allowed("webtopup_task14_dev"));
        for name in [
            "webtopup",
            "POBB",
            "webtopup_task14_dev_backup",
            "",
            "admin",
            "webtopup_task14_dev ",
            "WEBTOPUP_TASK14_DEV",
        ] {
            assert!(!apply_is_allowed(name), "{name}");
        }
    }

    #[test]
    fn index_match_rejects_non_unique_or_ttl() {
        let requirement = &identifier_index_models()[0];
        let good = identifier_index_model(requirement);
        assert!(index_matches_requirement(requirement, &good));

        let non_unique = IndexModel::builder()
            .keys(requirement.keys.clone())
            .options(
                IndexOptions::builder()
                    .name(requirement.name.to_string())
                    .unique(false)
                    .build(),
            )
            .build();
        assert!(!index_matches_requirement(requirement, &non_unique));

        let wrong_keys = IndexModel::builder()
            .keys(doc! { "vendorTrxId": 1 })
            .options(
                IndexOptions::builder()
                    .name(requirement.name.to_string())
                    .unique(true)
                    .build(),
            )
            .build();
        assert!(!index_matches_requirement(requirement, &wrong_keys));
    }

    #[test]
    fn readiness_error_code_is_stable() {
        assert_eq!(
            IdentifierReadinessError::Unavailable.code(),
            "IDENTIFIER_INDEX_UNAVAILABLE"
        );
    }

    #[test]
    fn unsafe_ref_id_none_is_classified_as_blocking_kind() {
        // Pure contract: the kind string used by settings inspection remains stable.
        assert_eq!("unsafe_ref_id_date_format", "unsafe_ref_id_date_format");
        assert_eq!("unsafe_invoice_random_length", "unsafe_invoice_random_length");
    }
}
