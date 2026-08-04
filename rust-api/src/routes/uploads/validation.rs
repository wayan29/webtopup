pub fn resolve_upload_folder(value: Option<&str>) -> String {
    match value.unwrap_or_default() {
        "icons" | "covers" | "popups" | "instructions" => value.unwrap().to_string(),
        _ => "icons".to_string(),
    }
}

pub fn is_allowed_mime_type(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    )
}

pub fn is_safe_filename(filename: &str) -> bool {
    !filename.contains('/')
        && !filename.contains('\\')
        && filename != "."
        && filename != ".."
        && !filename.is_empty()
}

pub fn is_image_file(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".webp"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}
