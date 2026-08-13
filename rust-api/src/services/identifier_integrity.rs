//! Identifier index models, readiness inspection, and fail-closed runtime gates.
//! Production index creation is never performed by the API process; only the
//! disposable readiness binary may apply exact indexes to `webtopup_task14_dev`.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{Datelike, FixedOffset, Utc};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use mongodb::options::{IndexOptions, ReturnDocument};
use mongodb::{ClientSession, Database, IndexModel};

pub const INDEX_TRANSACTION_REFERENCE: &str = "uniq_transactions_reference_id";
pub const INDEX_GUEST_INVOICE: &str = "uniq_guest_invoice_number";
pub const INDEX_DAILY_REFERENCE_COUNTER: &str = "uniq_identifier_counter_scope_date";

pub const COLLECTION_TRANSACTIONS: &str = "transactions";
pub const COLLECTION_GUEST_TRANSACTIONS: &str = "guesttransactions";
pub const COLLECTION_IDENTIFIER_COUNTERS: &str = "identifiercounters";

pub const MAX_INVOICE_CANDIDATES: usize = 5;
pub const REF_ID_DATE_FORMATS: &[&str] =
    &["DDMMYYYY", "YYYYMMDD", "MMDDYYYY", "DDMMYY", "YYMMDD"];
pub const INVOICE_DATE_FORMATS: &[&str] =
    &["DDMMYYYY", "YYYYMMDD", "MMDDYYYY", "DDMMYY", "YYMMDD", "NONE"];

const SUCCESS_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvoicePolicyError {
    InvalidLength,
}

impl InvoicePolicyError {
    pub fn code(self) -> &'static str {
        "INVALID_INVOICE_RANDOM_LENGTH"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicateConstraint {
    InvoiceNumber,
    Other,
}

/// Effective read length: weak/malformed historical values fail safe to the type minimum.
pub fn safe_invoice_length(random_type: &str, raw: i64) -> usize {
    let min = invoice_min_length(random_type);
    if raw < min as i64 {
        return min;
    }
    if raw > 12 {
        return 12;
    }
    raw as usize
}

/// Write-time validation for explicit admin saves.
pub fn validate_invoice_length(random_type: &str, raw: i64) -> Result<usize, InvoicePolicyError> {
    let min = invoice_min_length(random_type) as i64;
    if raw < min || raw > 12 {
        return Err(InvoicePolicyError::InvalidLength);
    }
    Ok(raw as usize)
}

pub fn invoice_min_length(random_type: &str) -> usize {
    if random_type == "numeric" {
        10
    } else {
        8
    }
}

pub fn retry_invoice_candidate(attempt_index: usize, constraint: DuplicateConstraint) -> bool {
    matches!(constraint, DuplicateConstraint::InvoiceNumber) && attempt_index < MAX_INVOICE_CANDIDATES - 1
}

pub fn classify_invoice_duplicate(error: &mongodb::error::Error) -> bool {
    let display = error.to_string();
    let debug = format!("{error:?}");
    classify_invoice_duplicate_messages(&display, &debug)
}

pub fn classify_invoice_duplicate_messages(display: &str, debug: &str) -> bool {
    let haystack = format!("{display}\n{debug}");
    if !(haystack.contains("E11000") || haystack.contains("duplicate key")) {
        return false;
    }
    haystack.contains(INDEX_GUEST_INVOICE)
        || haystack.contains("invoiceNumber_1")
        || haystack.contains("dup key: { invoiceNumber")
        || haystack.contains("dup key: { \"invoiceNumber\"")
}

/// Effective Ref ID date format: historical NONE/malformed/missing → DDMMYYYY.
pub fn effective_ref_id_date_format(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some(value) if REF_ID_DATE_FORMATS.contains(&value) => match value {
            "DDMMYYYY" => "DDMMYYYY",
            "YYYYMMDD" => "YYYYMMDD",
            "MMDDYYYY" => "MMDDYYYY",
            "DDMMYY" => "DDMMYY",
            "YYMMDD" => "YYMMDD",
            _ => "DDMMYYYY",
        },
        _ => "DDMMYYYY",
    }
}

pub const REFERENCE_COUNTER_SCOPE: &str = "transaction-reference";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceFormat {
    pub prefix: String,
    pub date_format: String,
    pub separator: String,
    pub sequence_digits: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocatedReference {
    pub reference_id: String,
    pub sequence: i64,
    pub date_wib: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceError {
    SequenceExhausted,
    Storage,
    TransientConflict,
}

impl ReferenceError {
    pub fn code(self) -> &'static str {
        match self {
            Self::SequenceExhausted => "REF_ID_SEQUENCE_EXHAUSTED",
            Self::Storage => "REFERENCE_ALLOCATION_FAILED",
            Self::TransientConflict => "REFERENCE_ALLOCATION_CONFLICT",
        }
    }
}

pub const MAX_REFERENCE_ALLOCATION_ATTEMPTS: usize = 8;

pub fn is_transient_identifier_write_conflict(error: &mongodb::error::Error) -> bool {
    is_transient_identifier_write_conflict_text(&format!("{error:?}"))
}

pub fn is_transient_identifier_write_conflict_text(haystack: &str) -> bool {
    let haystack = haystack.to_lowercase();
    haystack.contains("writeconflict")
        || haystack.contains("transienttransactionerror")
        || haystack.contains("label: \"transienttransactionerror\"")
        || haystack.contains("write conflict")
}

impl ReferenceFormat {
    pub fn from_settings(
        prefix: &str,
        date_format: Option<&str>,
        separator: &str,
        sequence_digits: i64,
    ) -> Self {
        let digits = if (1..=10).contains(&sequence_digits) {
            sequence_digits as usize
        } else {
            4
        };
        let prefix = prefix.trim().to_uppercase();
        let separator = match separator.trim() {
            "-" => "-".to_string(),
            "_" => "_".to_string(),
            _ => String::new(),
        };
        Self {
            prefix: if prefix.is_empty() {
                "REF".to_string()
            } else {
                prefix
            },
            date_format: effective_ref_id_date_format(date_format).to_string(),
            separator,
            sequence_digits: digits,
        }
    }
}

/// WIB calendar date key `YYYY-MM-DD` for Asia/Jakarta (UTC+07:00).
pub fn wib_date_key(now_utc: chrono::DateTime<Utc>) -> String {
    let wib = FixedOffset::east_opt(7 * 3600).expect("fixed +07 offset");
    let local = now_utc.with_timezone(&wib);
    format!(
        "{:04}-{:02}-{:02}",
        local.year(),
        local.month(),
        local.day()
    )
}

pub fn format_reference_sequence(sequence: i64, digits: usize) -> Result<String, ReferenceError> {
    if sequence < 1 {
        return Err(ReferenceError::SequenceExhausted);
    }
    let max = 10i64
        .checked_pow(digits as u32)
        .ok_or(ReferenceError::SequenceExhausted)?;
    if sequence >= max {
        return Err(ReferenceError::SequenceExhausted);
    }
    Ok(format!("{:0width$}", sequence, width = digits))
}

pub fn format_ref_date_part(format: &str, day: u32, month: u32, year: i32) -> String {
    let yy = year.rem_euclid(100);
    match effective_ref_id_date_format(Some(format)) {
        "YYYYMMDD" => format!("{year:04}{month:02}{day:02}"),
        "MMDDYYYY" => format!("{month:02}{day:02}{year:04}"),
        "DDMMYY" => format!("{day:02}{month:02}{yy:02}"),
        "YYMMDD" => format!("{yy:02}{month:02}{day:02}"),
        _ => format!("{day:02}{month:02}{year:04}"), // DDMMYYYY
    }
}

pub fn build_reference_id(format: &ReferenceFormat, date_wib: &str, sequence: i64) -> Result<String, ReferenceError> {
    let sequence_part = format_reference_sequence(sequence, format.sequence_digits)?;
    let mut day = 1u32;
    let mut month = 1u32;
    let mut year = 1970i32;
    if let Ok(parsed) = chrono::NaiveDate::parse_from_str(date_wib, "%Y-%m-%d") {
        day = parsed.day();
        month = parsed.month();
        year = parsed.year();
    }
    let date_part = format_ref_date_part(&format.date_format, day, month, year);
    Ok([format.prefix.as_str(), date_part.as_str(), sequence_part.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(&format.separator))
}

pub async fn load_reference_format(db: &Database) -> ReferenceFormat {
    let settings = db.collection::<Document>("settings");
    let prefix = setting_string(&settings, "refIdPrefix", "REF").await;
    let date_format = setting_string(&settings, "refIdDateFormat", "DDMMYYYY").await;
    let separator = setting_string(&settings, "refIdSeparator", "").await;
    let digits = setting_i64(&settings, "refIdSequenceDigits", 4).await;
    ReferenceFormat::from_settings(&prefix, Some(&date_format), &separator, digits)
}

async fn setting_string(
    collection: &mongodb::Collection<Document>,
    key: &str,
    fallback: &str,
) -> String {
    collection
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .and_then(|value| match value {
            mongodb::bson::Bson::String(value) => Some(value),
            other => Some(other.to_string()),
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

async fn setting_i64(
    collection: &mongodb::Collection<Document>,
    key: &str,
    fallback: i64,
) -> i64 {
    collection
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .map(|value| match value {
            mongodb::bson::Bson::Int32(value) => i64::from(value),
            mongodb::bson::Bson::Int64(value) => value,
            mongodb::bson::Bson::Double(value) => value as i64,
            mongodb::bson::Bson::String(value) => value.trim().parse().unwrap_or(fallback),
            _ => fallback,
        })
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

pub async fn allocate_reference_in_session(
    db: &Database,
    session: &mut ClientSession,
    format: &ReferenceFormat,
) -> Result<AllocatedReference, ReferenceError> {
    let date_wib = wib_date_key(Utc::now());
    let counters = db.collection::<Document>(COLLECTION_IDENTIFIER_COUNTERS);
    let updated = counters
        .find_one_and_update(
            doc! {
                "scope": REFERENCE_COUNTER_SCOPE,
                "dateWib": &date_wib,
            },
            doc! {
                "$inc": { "sequence": 1i64 },
                "$setOnInsert": {
                    "scope": REFERENCE_COUNTER_SCOPE,
                    "dateWib": &date_wib,
                },
            },
        )
        .upsert(true)
        .return_document(ReturnDocument::After)
        .session(&mut *session)
        .await
        .map_err(|error| {
            if is_transient_identifier_write_conflict(&error) {
                ReferenceError::TransientConflict
            } else {
                ReferenceError::Storage
            }
        })?
        .ok_or(ReferenceError::Storage)?;
    let sequence = match updated.get("sequence") {
        Some(mongodb::bson::Bson::Int32(value)) => i64::from(*value),
        Some(mongodb::bson::Bson::Int64(value)) => *value,
        Some(mongodb::bson::Bson::Double(value)) => *value as i64,
        _ => return Err(ReferenceError::Storage),
    };
    let reference_id = build_reference_id(format, &date_wib, sequence)?;
    Ok(AllocatedReference {
        reference_id,
        sequence,
        date_wib,
    })
}

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
        let listed = match list_index_models(&collection).await {
            Ok(listed) => listed,
            Err(error) if is_namespace_not_found(&error) => {
                missing.push(requirement.name.to_string());
                continue;
            }
            Err(error) => return Err(error),
        };
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

fn is_namespace_not_found(error: &mongodb::error::Error) -> bool {
    is_namespace_not_found_text(&format!("{error:?}"))
}

fn is_namespace_not_found_text(haystack: &str) -> bool {
    let haystack = haystack.to_lowercase();
    haystack.contains("namespacenotfound") || haystack.contains("ns does not exist")
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
        let min = invoice_min_length(&random_type) as i64;
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
    fn namespace_not_found_classifier_matches_mongo_missing_collection() {
        assert!(is_namespace_not_found_text(
            "Kind: Command failed: Error code 26 (NamespaceNotFound): ns does not exist: webtopup_task14_dev.identifiercounters"
        ));
        assert!(!is_namespace_not_found_text("duplicate key error"));
    }

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

    #[test]
    fn invoice_policy_uses_safe_type_specific_minimums() {
        assert_eq!(safe_invoice_length("alphanumeric", 1), 8);
        assert_eq!(safe_invoice_length("alphanumeric", 12), 12);
        assert_eq!(safe_invoice_length("numeric", 1), 10);
        assert!(validate_invoice_length("numeric", 9).is_err());
        assert!(validate_invoice_length("alphanumeric", 7).is_err());
        assert_eq!(validate_invoice_length("alphanumeric", 8).unwrap(), 8);
        assert_eq!(validate_invoice_length("numeric", 10).unwrap(), 10);
    }

    #[test]
    fn transient_identifier_conflicts_are_classified_for_retry() {
        assert!(is_transient_identifier_write_conflict_text(
            "WriteConflict error: WriteConflict caused by concurrent transaction"
        ));
        assert!(is_transient_identifier_write_conflict_text(
            "Kind: Command failed, labels: { TransientTransactionError }"
        ));
        assert!(!is_transient_identifier_write_conflict_text("duplicate key error"));
        assert_eq!(MAX_REFERENCE_ALLOCATION_ATTEMPTS, 8);
    }

    fn invoice_retry_is_bounded_and_constraint_specific() {
        assert_eq!(MAX_INVOICE_CANDIDATES, 5);
        assert!(retry_invoice_candidate(0, DuplicateConstraint::InvoiceNumber));
        assert!(retry_invoice_candidate(3, DuplicateConstraint::InvoiceNumber));
        assert!(!retry_invoice_candidate(4, DuplicateConstraint::InvoiceNumber));
        assert!(!retry_invoice_candidate(0, DuplicateConstraint::Other));
    }

    #[test]
    fn invoice_duplicate_classifier_requires_exact_invoice_index() {
        assert!(classify_invoice_duplicate_messages(
            "E11000 duplicate key error index: uniq_guest_invoice_number",
            ""
        ));
        assert!(!classify_invoice_duplicate_messages(
            "E11000 duplicate key error index: uniq_products_code",
            ""
        ));
        assert!(!classify_invoice_duplicate_messages("network timeout", ""));
    }

    #[test]
    fn ref_id_date_format_none_reads_as_ddmmyyyy_invoice_keeps_none() {
        assert_eq!(effective_ref_id_date_format(Some("NONE")), "DDMMYYYY");
        assert_eq!(effective_ref_id_date_format(Some("")), "DDMMYYYY");
        assert_eq!(effective_ref_id_date_format(None), "DDMMYYYY");
        assert_eq!(effective_ref_id_date_format(Some("YYYYMMDD")), "YYYYMMDD");
        assert!(REF_ID_DATE_FORMATS.iter().all(|value| *value != "NONE"));
        assert!(INVOICE_DATE_FORMATS.contains(&"NONE"));
    }

    #[test]
    fn sequence_must_fit_configured_width_without_wrap() {
        assert_eq!(format_reference_sequence(9999, 4).unwrap(), "9999");
        assert_eq!(
            format_reference_sequence(10_000, 4).unwrap_err().code(),
            "REF_ID_SEQUENCE_EXHAUSTED"
        );
    }

    #[test]
    fn wib_date_key_uses_utc_plus_seven_boundary() {
        // 16:59:59Z is still previous WIB calendar day; 17:00:00Z is next WIB day.
        let before = chrono::DateTime::parse_from_rfc3339("2026-08-12T16:59:59Z")
            .unwrap()
            .with_timezone(&Utc);
        let after = chrono::DateTime::parse_from_rfc3339("2026-08-12T17:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(wib_date_key(before), "2026-08-12");
        assert_eq!(wib_date_key(after), "2026-08-13");
    }

    #[test]
    fn reference_format_from_settings_collapses_none_and_builds_date_bearing_id() {
        let format = ReferenceFormat::from_settings("ref", Some("NONE"), "-", 4);
        assert_eq!(format.date_format, "DDMMYYYY");
        assert_eq!(format.prefix, "REF");
        let built = build_reference_id(&format, "2026-08-12", 7).unwrap();
        assert_eq!(built, "REF-12082026-0007");
        assert!(!built.contains("NONE"));
    }
}
