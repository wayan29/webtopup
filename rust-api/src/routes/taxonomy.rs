use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

mod categories;
mod operators;
mod product_types;
mod description_html;
mod types;
pub use categories::*;
pub use operators::*;
pub use product_types::*;
use types::*;

fn status_message(status: StatusCode, message: &'static str) -> Response { (status, Json(json!({"message":message}))).into_response() }
fn not_found(message: &'static str) -> Response { status_message(StatusCode::NOT_FOUND,message) }
fn internal() -> Response { status_message(StatusCode::INTERNAL_SERVER_ERROR,"Internal Server Error") }
fn bad(message: &'static str) -> Response { status_message(StatusCode::BAD_REQUEST,message) }
fn uuid(value: &str) -> Option<Uuid> { let id=Uuid::parse_str(value).ok()?; (id.to_string()==value).then_some(id) }
fn slugify(value: &str) -> Option<String> {
 let mut slug=String::new(); let mut dash=false;
 for c in value.trim().to_lowercase().chars() { if c.is_ascii_alphanumeric(){slug.push(c);dash=false;}else if !dash&&!slug.is_empty(){slug.push('-');dash=true;} }
 while slug.ends_with('-'){slug.pop();} (!slug.is_empty()).then_some(slug)
}
fn number(value:f64)->i64 { if value.is_finite(){value.max(0.0).trunc() as i64}else{0} }
fn message(value:&'static str)->Response { Json(json!({"message":value})).into_response() }
fn db_error(error:sqlx::Error, duplicate:&'static str)->Response { if error.as_database_error().is_some_and(|e|e.is_unique_violation()){bad(duplicate)}else{internal()} }
async fn lock_catalog(tx:&mut Transaction<'_,Postgres>)->Result<(),sqlx::Error> {
 // Lock every catalog writer, including inserts, so reorder and rename propagation are atomic.
 sqlx::query("LOCK TABLE categories, operators, product_types, products IN SHARE ROW EXCLUSIVE MODE").execute(&mut **tx).await?; Ok(())
}
async fn assets(tx:&mut Transaction<'_,Postgres>, resource:&str, fields:&[(&str,&str)], previous:Option<&Value>)->Result<(),Response>{
 use crate::services::{managed_asset_registry::{acquire_reference,release_reference},managed_assets::{ensure_managed_field_for_update,effectively_changed_managed_field,ManagedFieldFolderPolicy}};
 for (key,value) in fields {
  let policy=match *key {"cover"=>ManagedFieldFolderPolicy::Covers,"instructionImage"=>ManagedFieldFolderPolicy::Instructions,"popupImage"=>ManagedFieldFolderPolicy::Popups,_=>ManagedFieldFolderPolicy::Icons};
  let old=previous.and_then(|v|if *key=="popupImage"{v.get("popupInfo").and_then(|x|x.get("image"))}else{v.get(*key)}).and_then(Value::as_str);
  ensure_managed_field_for_update(&crate::routes::uploads::upload_root(),value,policy,effectively_changed_managed_field(old,value))?;
  let resource_key=format!("{resource}:{key}");
  if old!=Some(*value){
   if let Some(old)=old.filter(|path|path.starts_with("/uploads/")){ release_reference(tx,old,&resource_key).await.map_err(|_|status_message(StatusCode::SERVICE_UNAVAILABLE,"Managed asset registry unavailable"))?; }
   if value.starts_with("/uploads/"){ acquire_reference(tx,value,&resource_key).await.map_err(|_|status_message(StatusCode::SERVICE_UNAVAILABLE,"Managed asset registry unavailable"))?; }
  }
 }
 Ok(())
}
async fn category_rows(pool:&PgPool)->Result<Vec<Value>,sqlx::Error>{sqlx::query_scalar("SELECT document || jsonb_build_object('directProductCount',direct_count,'legacyProductCount',legacy_count,'productCount',direct_count+legacy_count,'operatorCount',operator_count,'productTypeCount',type_count,'dependencyCount',direct_count+legacy_count+operator_count+type_count,'canDelete',direct_count+legacy_count+operator_count+type_count=0) FROM catalog_categories ORDER BY sort_order,name,id").fetch_all(pool).await}
async fn operator_rows(pool:&PgPool)->Result<Vec<Value>,sqlx::Error>{sqlx::query_scalar("SELECT document || jsonb_build_object('categoryId',category_brief,'directProductCount',direct_count,'legacyProductCount',0,'productCount',direct_count,'productTypeCount',type_count,'dependencyCount',direct_count+type_count,'canDelete',direct_count+type_count=0) FROM catalog_operators ORDER BY sort_order,name,id").fetch_all(pool).await}
async fn type_rows(pool:&PgPool)->Result<Vec<Value>,sqlx::Error>{sqlx::query_scalar("SELECT document || jsonb_build_object('productCount',product_count,'dependencyCount',product_count,'canDelete',product_count=0) FROM catalog_product_types ORDER BY sort_order,name,id").fetch_all(pool).await}
fn sanitize_type(mut value:Value)->Value{if let Some(description)=value.get("description").and_then(Value::as_str){value["description"]=json!(description_html::sanitize_product_description(description));} value}
