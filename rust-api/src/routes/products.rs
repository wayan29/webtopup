use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
mod read;
mod mutations;
mod sorting;
mod types;
mod payload;
mod mappers;
mod catalog_audit;
pub use self::read::*;
pub use self::mutations::*;
pub use self::sorting::*;
pub use self::catalog_audit::catalog_audit;
use self::payload::{normalize_non_negative_number, unavailable};
use self::types::*;
fn status_message(status: StatusCode, message: &str) -> Response { error(status, message) }
fn error(status: StatusCode, message: &str) -> Response { (status, Json(serde_json::json!({"message":message}))).into_response() }
fn internal_error() -> Response { error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error") }
fn canonical_id(value: &str) -> Option<uuid::Uuid> { let id=uuid::Uuid::parse_str(value).ok()?; (id.to_string()==value).then_some(id) }
async fn lock_catalog(tx: &mut sqlx::Transaction<'_,sqlx::Postgres>) -> Result<(),sqlx::Error> { sqlx::query("LOCK TABLE categories,operators,product_types,products IN SHARE ROW EXCLUSIVE MODE").execute(&mut **tx).await?; Ok(()) }
