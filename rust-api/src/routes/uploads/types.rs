use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct UploadListQuery {
    #[serde(rename = "type")]
    pub(super) upload_type: Option<String>,
}

#[derive(Serialize)]
pub struct UploadListResponse {
    pub success: bool,
    pub files: Vec<UploadedFile>,
    pub folder: String,
}

#[derive(Deserialize)]
pub struct UploadDeleteQuery {
    #[serde(rename = "type")]
    pub(super) upload_type: Option<String>,
    pub(super) filename: Option<String>,
}

#[derive(Serialize)]
pub struct UploadDeleteResponse {
    pub success: bool,
    pub message: &'static str,
}

#[derive(Serialize)]
pub struct UploadResponse {
    pub success: bool,
    pub url: String,
    pub filename: String,
}

#[derive(Serialize)]
pub struct UploadMultipleResponse {
    pub success: bool,
    pub files: Vec<UploadedFileResponse>,
}

#[derive(Serialize)]
pub struct UploadedFileResponse {
    pub url: String,
    pub filename: String,
}

#[derive(Serialize)]
pub struct UploadedFile {
    pub url: String,
    pub filename: String,
    pub size: u64,
    #[serde(rename = "uploadedAt")]
    pub uploaded_at: String,
}
