mod handlers;
mod storage;
mod types;
mod validation;

pub use handlers::{delete_file, list_files, upload_file, upload_multiple};
// Reused by the staff avatar handler so both resolve the same upload root.
pub use storage::upload_root;
