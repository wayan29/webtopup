use axum::response::Response;

use super::responses::status_message;

pub(super) fn normalize_processing_note(
    value: Option<String>,
    required: bool,
) -> Result<String, Response> {
    let note = value.unwrap_or_default().trim().to_string();
    if required && note.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Catatan penolakan wajib diisi",
        ));
    }
    if note.chars().count() > 500 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Catatan proses maksimal 500 karakter",
        ));
    }
    Ok(note)
}
