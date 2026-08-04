use axum::{response::IntoResponse, Json};
use mongodb::bson::{DateTime, Document};

use crate::security::ErrorResponse;

use super::{SalesSummaryQuery, SimpleDate};

const REPORT_OFFSET: &str = "+07:00";

pub(super) fn build_date_match(
    query: &SalesSummaryQuery,
) -> Result<Document, axum::response::Response> {
    let start = parse_date_boundary(query.start_date.as_deref(), false)?;
    let end = parse_date_boundary(query.end_date.as_deref(), true)?;
    if let (Some(start), Some(end)) = (&start, &end) {
        if start > end {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: "Rentang tanggal laporan tidak valid",
                }),
            )
                .into_response());
        }
    }

    let mut filter = Document::new();
    if start.is_some() || end.is_some() {
        let mut created_at = Document::new();
        if let Some(start) = start {
            created_at.insert("$gte", start);
        }
        if let Some(end) = end {
            created_at.insert("$lte", end);
        }
        filter.insert("createdAt", created_at);
    }

    Ok(filter)
}

fn parse_date_boundary(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<DateTime>, axum::response::Response> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !is_date_text(value) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Format tanggal laporan tidak valid",
            }),
        )
            .into_response());
    }

    let time = if end_of_day {
        "23:59:59.999"
    } else {
        "00:00:00.000"
    };
    let date_text = format!("{value}T{time}{REPORT_OFFSET}");
    DateTime::parse_rfc3339_str(&date_text)
        .map(Some)
        .map_err(|_| {
            (
                axum::http::StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: "Format tanggal laporan tidak valid",
                }),
            )
                .into_response()
        })
}

fn is_date_text(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, value)| index == 4 || index == 7 || value.is_ascii_digit())
}

pub(super) fn jakarta_today_key() -> String {
    format_date_key(&jakarta_date_from_epoch_days(jakarta_epoch_days(
        DateTime::now().timestamp_millis(),
    )))
}

pub(super) fn jakarta_epoch_days(timestamp_millis: i64) -> i64 {
    (timestamp_millis + 7 * 60 * 60 * 1000).div_euclid(86_400_000)
}

pub(super) fn jakarta_date_from_epoch_days(days: i64) -> SimpleDate {
    civil_from_days(days)
}

pub(super) fn shift_date(date: &SimpleDate, delta_days: i64) -> SimpleDate {
    civil_from_days(days_from_civil(date.year, date.month, date.day) + delta_days)
}

pub(super) fn previous_month(date: &SimpleDate) -> SimpleDate {
    if date.month == 1 {
        SimpleDate {
            year: date.year - 1,
            month: 12,
            day: 1,
        }
    } else {
        SimpleDate {
            year: date.year,
            month: date.month - 1,
            day: 1,
        }
    }
}

pub(super) fn format_date_key(date: &SimpleDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year, date.month, date.day)
}

pub(super) fn format_month_key(date: &SimpleDate) -> String {
    format!("{:04}-{:02}", date.year, date.month)
}

fn civil_from_days(days: i64) -> SimpleDate {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    SimpleDate {
        year: (y + if month <= 2 { 1 } else { 0 }) as i32,
        month: month as u32,
        day: day as u32,
    }
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let mut y = year as i64;
    let m = month as i64;
    y -= if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
