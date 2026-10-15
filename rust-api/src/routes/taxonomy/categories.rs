use std::sync::Arc;
use axum::{extract::{Path,State},http::HeaderMap,response::{Response,IntoResponse},Json};
use crate::{security::require_sql_permission,state::AppState};
use super::*;

pub async fn validation_taxonomy_categories(headers:HeaderMap,State(state):State<Arc<AppState>>)->Response {if let Err(r)=require_sql_permission(&headers,&state,"manageSettings").await{return r;} list(&state.pg_pool).await}
pub async fn categories_admin_all(headers:HeaderMap,State(state):State<Arc<AppState>>)->Response {if let Err(r)=require_sql_permission(&headers,&state,"viewProducts").await{return r;} list(&state.pg_pool).await}
async fn list(pool:&PgPool)->Response {match category_rows(pool).await{Ok(rows)=>Json(rows).into_response(),Err(_)=>internal()}}
pub async fn categories_public(State(state):State<Arc<AppState>>)->Response {match sqlx::query_scalar::<_,Value>("SELECT document FROM catalog_categories WHERE status OR is_active ORDER BY sort_order,name,id").fetch_all(&state.pg_pool).await{Ok(rows)=>Json(rows).into_response(),Err(_)=>internal()}}
pub async fn category_public_detail(State(state):State<Arc<AppState>>,Path(id):Path<String>)->Response {match sqlx::query_scalar::<_,Value>("SELECT document FROM catalog_categories WHERE id=$1 OR slug=$2 ORDER BY id LIMIT 1").bind(uuid(&id)).bind(&id).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>Json(row).into_response(),Ok(None)=>not_found("Category not found"),Err(_)=>internal()}}

pub async fn category_admin_create(headers:HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<CreateCategoryPayload>)->Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageProducts").await{return r;}
 let name=payload.name.as_deref().unwrap_or("").trim(); if name.is_empty(){return bad("Nama kategori wajib diisi");}
 let Some(slug)=slugify(name)else{return bad("Nama kategori tidak valid untuk dijadikan slug");};
 let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return internal()};if lock_catalog(&mut tx).await.is_err(){return internal();}
 let id=Uuid::new_v4();let icon=payload.icon.unwrap_or_else(||"📦".into());
 if let Err(r)=assets(&mut tx,&format!("category:{id}"),&[("icon",&icon)],None).await{return r;}
 let order=match payload.sort_order.filter(|v|v.is_finite()){Some(v)=>number(v),None=>match sqlx::query_scalar::<_,i64>("SELECT COALESCE(max(sort_order),0)+1 FROM categories").fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()}};
 if let Err(e)=sqlx::query("INSERT INTO categories(id,name,slug,icon,sort_order,status) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(name).bind(slug).bind(icon).bind(order).bind(payload.status.unwrap_or(true)).execute(&mut *tx).await{return db_error(e,"Category with this name already exists");}
 let row=match sqlx::query_scalar::<_,Value>("SELECT document FROM catalog_categories WHERE id=$1").bind(id).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()};if tx.commit().await.is_err(){return internal();}
 (StatusCode::CREATED,Json(json!({"message":"Category created successfully","category":row}))).into_response()
}
pub async fn category_admin_update(headers:HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>,Json(payload):Json<UpdateCategoryPayload>)->Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageProducts").await{return r;}let Some(id)=uuid(&id)else{return not_found("Category not found");};
 let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return internal()};if lock_catalog(&mut tx).await.is_err(){return internal();}
 let old=match sqlx::query_scalar::<_,Value>("SELECT document FROM catalog_categories WHERE id=$1").bind(id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return not_found("Category not found"),Err(_)=>return internal()};
 let name=payload.name.as_deref().unwrap_or_else(||old["name"].as_str().unwrap_or("")).trim();if name.is_empty(){return bad("Nama kategori wajib diisi");}let Some(slug)=slugify(name)else{return bad("Nama kategori tidak valid untuk dijadikan slug");};
 let icon=payload.icon.as_deref().unwrap_or_else(||old["icon"].as_str().unwrap_or(""));if let Err(r)=assets(&mut tx,&format!("category:{id}"),&[("icon",icon)],Some(&old)).await{return r;}
 if let Err(e)=sqlx::query("UPDATE categories SET name=$2,slug=$3,icon=$4,sort_order=COALESCE($5,sort_order),status=COALESCE($6,status),updated_at=now() WHERE id=$1").bind(id).bind(name).bind(slug).bind(icon).bind(payload.sort_order.map(number)).bind(payload.status).execute(&mut *tx).await{return db_error(e,"Category with this name already exists");}
 if sqlx::query("UPDATE products SET category=$2 WHERE category_id=$1 OR category=$3").bind(id).bind(name).bind(old["name"].as_str().unwrap_or("")).execute(&mut *tx).await.is_err(){return internal();}
 let row=match sqlx::query_scalar::<_,Value>("SELECT document || jsonb_build_object('directProductCount',direct_count,'legacyProductCount',legacy_count,'productCount',direct_count+legacy_count,'operatorCount',operator_count,'productTypeCount',type_count,'dependencyCount',direct_count+legacy_count+operator_count+type_count,'canDelete',direct_count+legacy_count+operator_count+type_count=0) FROM catalog_categories WHERE id=$1").bind(id).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()};if tx.commit().await.is_err(){return internal();}Json(json!({"message":"Category updated successfully","category":row})).into_response()
}
pub async fn category_admin_delete(headers:HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageProducts").await{return r;}let Some(id)=uuid(&id)else{return not_found("Category not found");};let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return internal()};if lock_catalog(&mut tx).await.is_err(){return internal();}
 let row=match sqlx::query_as::<_,(i64,i64,i64,i64)>("SELECT direct_count,legacy_count,operator_count,type_count FROM catalog_categories WHERE id=$1").bind(id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return not_found("Category not found"),Err(_)=>return internal()};let(d,l,o,t)=row;let total=d+l+o+t;
 if total>0{let mut parts=Vec::new();if d>0{parts.push(format!("{d} produk"));}if l>0{parts.push(format!("{l} referensi legacy"));}if o>0{parts.push(format!("{o} operator"));}if t>0{parts.push(format!("{t} tipe produk"));}return (StatusCode::BAD_REQUEST,Json(json!({"message":format!("Kategori masih dipakai oleh {}. Nonaktifkan kategori jika belum ingin ditampilkan.",parts.join(", ")),"dependencies":{"directProductCount":d,"legacyProductCount":l,"productCount":d+l,"operatorCount":o,"productTypeCount":t,"dependencyCount":total,"canDelete":false}}))).into_response();}
 if sqlx::query("DELETE FROM asset_references WHERE resource=$1").bind(format!("category:{id}")).execute(&mut *tx).await.is_err()||sqlx::query("DELETE FROM categories WHERE id=$1").bind(id).execute(&mut *tx).await.is_err(){return internal();}if tx.commit().await.is_err(){return internal();}message("Category deleted successfully")
}
pub async fn categories_update_sort_order(headers:HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<SortOrderPayload>)->Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageProducts").await{return r;}let Some(orders)=payload.orders.filter(|v|!v.is_empty())else{return bad("Orders array is required");};let mut ids=Vec::with_capacity(orders.len());for item in orders{let Some(id)=uuid(item.id.trim())else{return bad("Ada ID kategori yang tidak valid");};if ids.contains(&id){return bad("Urutan kategori mengandung ID duplikat");}ids.push(id);}
 let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return internal()};if lock_catalog(&mut tx).await.is_err(){return internal();}let existing=match sqlx::query_scalar::<_,Uuid>("SELECT id FROM categories").fetch_all(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()};if ids.len()!=existing.len(){return bad("Urutan kategori harus memuat semua kategori");}if ids.iter().any(|id|!existing.contains(id)){return bad("Ada kategori yang tidak ditemukan pada payload urutan");}
 if sqlx::query("UPDATE categories c SET sort_order=u.position FROM unnest($1::uuid[]) WITH ORDINALITY u(id,position) WHERE c.id=u.id").bind(ids).execute(&mut *tx).await.is_err(){return internal();}if tx.commit().await.is_err(){return internal();}message("Sort order updated successfully")
}
