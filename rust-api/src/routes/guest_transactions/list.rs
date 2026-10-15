use axum::{http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone};
use crate::security::ErrorResponse;
use super::GuestTransactionsQuery;

pub(super) fn validate_guest_list_query(query: &GuestTransactionsQuery) -> Result<(Option<DateTime<FixedOffset>>, Option<DateTime<FixedOffset>>), axum::response::Response> {
    let payment = query.payment_status.as_deref().unwrap_or("").trim().to_lowercase();
    let transaction = query.transaction_status.as_deref().unwrap_or("").trim().to_lowercase();
    if !payment.is_empty() && !matches!(payment.as_str(), "waiting_payment"|"paid"|"expired"|"cancelled") { return Err(status_message("Status pembayaran guest tidak valid")); }
    if !transaction.is_empty() && !matches!(transaction.as_str(), "pending"|"processing"|"success"|"failed") { return Err(status_message("Status transaksi guest tidak valid")); }
    let parse = |v:Option<&str>,end:bool| -> Result<Option<DateTime<FixedOffset>>,axum::response::Response> {
        let Some(v)=v.map(str::trim).filter(|v|!v.is_empty()) else{return Ok(None)};
        let date=NaiveDate::parse_from_str(v,"%Y-%m-%d").map_err(|_|status_message("Format tanggal guest transaction tidak valid"))?;
        let offset=FixedOffset::east_opt(7*3600).unwrap();
        Ok(Some(offset.from_local_datetime(&date.and_hms_milli_opt(if end {23}else{0},if end {59}else{0},if end {59}else{0},if end {999}else{0}).unwrap()).single().unwrap()))
    };
    let start=parse(query.start_date.as_deref(),false)?; let end=parse(query.end_date.as_deref(),true)?;
    if start.zip(end).is_some_and(|(a,b)|a>b){return Err(status_message("Rentang tanggal guest transaction tidak valid"));}
    Ok((start,end))
}

fn status_message(message: &'static str) -> axum::response::Response { (StatusCode::BAD_REQUEST,Json(ErrorResponse{message})).into_response() }

