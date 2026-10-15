//! Identifier policy helpers shared by live SQL routes (invoice length + reference date formats).

pub const REF_ID_DATE_FORMATS: &[&str] =
    &["DDMMYYYY", "YYYYMMDD", "MMDDYYYY", "DDMMYY", "YYMMDD"];
pub const INVOICE_DATE_FORMATS: &[&str] =
    &["DDMMYYYY", "YYYYMMDD", "MMDDYYYY", "DDMMYY", "YYMMDD", "NONE"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvoicePolicyError {
    InvalidLength,
}

impl InvoicePolicyError {
    pub fn code(self) -> &'static str {
        "INVALID_INVOICE_RANDOM_LENGTH"
    }
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
