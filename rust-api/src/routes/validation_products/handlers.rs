use std::sync::Arc;

use axum::{extract::{Path, Query, State}, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use super::{audit::{build_validation_product_audit_payload, persist_validation_product_audit, resolve_audit_operation, ValidationProductAuditOperation}, concurrency::{revision_for_expected_version, validate_expected_version, version_from_revision}};
use crate::{security::{require_sql_permission, ErrorResponse}, state::AppState};
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ValidationProductPayload {
    pub name: Option<String>, pub code: Option<String>, pub category_id: Option<String>,
    pub operator_id: Option<String>, pub product_type_id: Option<String>, pub cost_price: Option<i64>,
    pub price: Option<ValidationProductPricePayload>, pub status: Option<bool>,
    pub validation_type: Option<String>, pub game: Option<String>, pub target_label: Option<String>,
    pub secondary_target_label: Option<String>, pub result_label: Option<String>, pub version: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ValidationProductVersionQuery { pub version: i64 }
#[derive(Deserialize)]
pub struct ValidationProductPricePayload { pub basic: Option<i64>, pub gold: Option<i64>, pub platinum: Option<i64> }

const MAX_VALIDATION_PRICE: i64 = 100_000_000;
const PRODUCT_SELECT: &str = "SELECT p.*, jsonb_build_object('_id',p.id,'productId',p.product_id,'code',p.code,'name',p.name,'category',p.category,'categoryId',p.category_id,'operatorId',p.operator_id,'productTypeId',p.product_type_id,'paymentType',p.payment_type,'icon',p.icon,'rewardPoints',p.reward_points,'brand',p.brand,'costPrice',p.cost_price,'price',jsonb_build_object('basic',p.price_basic,'gold',p.price_gold,'platinum',p.price_platinum),'vendor',jsonb_build_object('name',p.vendor_name,'sku',p.vendor_sku),'validation',p.validation,'sortOrder',p.sort_order,'status',p.status,'createdAt',p.created_at,'updatedAt',p.updated_at,'__v',p.revision-1) AS raw_document, CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('_id',c.id,'name',c.name,'icon',c.icon,'status',c.status) END AS category_brief, CASE WHEN o.id IS NOT NULL THEN jsonb_build_object('_id',o.id,'name',o.name,'slug',o.slug,'icon',o.icon,'status',o.status) END AS operator_brief, CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('_id',t.id,'name',t.name,'icon',t.icon,'status',t.status) END AS type_brief, false AS inactive_brand FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN operators o ON o.id=p.operator_id LEFT JOIN product_types t ON t.id=p.product_type_id";

fn message(status: StatusCode, message: &'static str) -> Response { (status, Json(ErrorResponse { message })).into_response() }
fn conflict() -> Response { (StatusCode::CONFLICT, Json(json!({"message":"Data produk telah berubah. Muat ulang daftar sebelum mencoba lagi.","code":"VALIDATION_PRODUCT_CONFLICT"}))).into_response() }
fn clean(value: Option<String>, max: usize) -> Option<String> { value.map(|v|v.trim().chars().take(max).collect::<String>()).filter(|v|!v.is_empty()) }
fn id(value: &str) -> Result<Uuid, Response> { Uuid::parse_str(value.trim()).map_err(|_| message(StatusCode::BAD_REQUEST,"ID produk tidak valid")) }
fn product_json(mut value: Value, revision: i64) -> Value { value.as_object_mut().map(|object| {object.remove("__v");}); if let Some(version)=version_from_revision(revision) {value["version"]=json!(version);} value }
fn is_validation(value: &Value) -> bool { value["enabled"] == true }
fn status_only(p: &ValidationProductPayload) -> bool { p.status.is_some() && p.name.is_none() && p.code.is_none() && p.category_id.is_none() && p.operator_id.is_none() && p.product_type_id.is_none() && p.cost_price.is_none() && p.price.is_none() && p.validation_type.is_none() && p.game.is_none() && p.target_label.is_none() && p.secondary_target_label.is_none() && p.result_label.is_none() }

fn map_document(row: &sqlx::postgres::PgRow, populated: bool) -> Value {
    let mut value: Value = row.get("raw_document");
    if populated {
        for (key, column) in [("categoryId", "category_brief"), ("operatorId", "operator_brief"), ("productTypeId", "type_brief")] {
            let brief: Option<Value> = row.get(column);
            value[key] = brief.unwrap_or(Value::Null);
        }
    }
    let name=value["name"].as_str().unwrap_or("").to_lowercase();
    let validation=&mut value["validation"];
    if validation["enabled"]==true {
        if validation["type"]=="nickname" && (name.contains("operator") || validation["targetLabel"].as_str().unwrap_or("").to_lowercase().contains("nomor") || validation["resultLabel"].as_str().unwrap_or("").to_lowercase().contains("operator")) {
            validation["type"]=json!("operator"); validation["game"]=json!(""); validation["targetLabel"]=json!("Nomor HP"); validation["secondaryTargetLabel"]=json!(""); validation["resultLabel"]=json!("Operator");
        } else if validation["type"]=="nickname" && validation["game"]!="mobilelegends" && validation["secondaryTargetLabel"].as_str().unwrap_or("").to_lowercase().contains("zone") { validation["game"]=json!("mobilelegends"); }
    }
    value
}

async fn ensure_references(state: &AppState, category: Uuid, operator: Uuid, product_type: Uuid) -> Result<(), Response> {
    let valid = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM categories WHERE id=$1) AND EXISTS(SELECT 1 FROM operators WHERE id=$2 AND category_id=$1) AND EXISTS(SELECT 1 FROM product_types WHERE id=$3 AND operator_id=$2)")
        .bind(category).bind(operator).bind(product_type).fetch_one(&state.pg_pool).await
        .map_err(|_| internal())?;
    if valid { Ok(()) } else { Err(message(StatusCode::BAD_REQUEST, "Kategori, operator, atau tipe produk tidak sesuai")) }
}
pub async fn list(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(r)=require_sql_permission(&headers,&state,"manageSettings").await{return r;}
    let sql=format!("{PRODUCT_SELECT} WHERE p.validation->>'enabled'='true' AND NOT COALESCE((p.validation->>'archived')::boolean,false) ORDER BY p.updated_at DESC,p.id");
    match sqlx::query(&sql).fetch_all(&state.pg_pool).await {
        Ok(rows)=>Json(json!({"items":rows.iter().map(|row|{let value=map_document(row,true); let revision:i64=row.get("revision"); product_json(value,revision)}).collect::<Vec<_>>()})).into_response(),
        Err(_)=>message(StatusCode::INTERNAL_SERVER_ERROR,"Gagal memuat produk validasi"),
    }
}

pub async fn create(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(p): Json<ValidationProductPayload>) -> Response {
    let actor=match require_sql_permission(&headers,&state,"manageSettings").await{Ok(v)=>v,Err(r)=>return r};
    let Some(name)=clean(p.name,120) else{return message(StatusCode::BAD_REQUEST,"Nama produk wajib diisi")};
    let Some(code)=clean(p.code,80) else{return message(StatusCode::BAD_REQUEST,"Kode produk wajib diisi")};
    let (category,operator,product_type)=match references(p.category_id.as_deref(),p.operator_id.as_deref(),p.product_type_id.as_deref()){Ok(v)=>v,Err(r)=>return r};
    if let Err(r)=ensure_references(&state,category,operator,product_type).await{return r;}
    let validation_type=clean(p.validation_type,20).unwrap_or_else(||"operator".into());
    let game=clean(p.game,30).unwrap_or_default();
    if !matches!(validation_type.as_str(),"nickname"|"operator") || (validation_type=="nickname"&&!matches!(game.as_str(),"freefire"|"mobilelegends")) || (validation_type=="operator"&&!game.is_empty()) {return message(StatusCode::BAD_REQUEST,"Tipe atau game validasi tidak valid")}
    let (basic,gold,platinum)=match normalize_price(p.price.unwrap_or(ValidationProductPricePayload{basic:Some(0),gold:Some(0),platinum:Some(0)})){Ok(v)=>v,Err(r)=>return r};
    let cost=match money(p.cost_price.unwrap_or(0),"Harga modal"){Ok(v)=>v,Err(r)=>return r};
    let validation=json!({"enabled":true,"archived":false,"type":validation_type,"game":game,"targetLabel":clean(p.target_label,60).unwrap_or_else(||"Target".into()),"secondaryTargetLabel":clean(p.secondary_target_label,60).unwrap_or_default(),"resultLabel":clean(p.result_label,60).unwrap_or_else(||"Hasil".into())});
    let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};
    let id=Uuid::new_v4();
    let result=sqlx::query_scalar::<_,Uuid>("INSERT INTO products(id,code,name,category,category_id,operator_id,product_type_id,payment_type,brand,cost_price,price_basic,price_gold,price_platinum,reward_points,icon,vendor_name,vendor_sku,status,sort_order,validation,revision) VALUES($1,$2,$3,'Validation',$4,$5,$6,'prabayar','Validation',$7,$8,$9,$10,0,'','Validation',$2,$11,0,$12,1) RETURNING id")
        .bind(id).bind(&code).bind(&name).bind(category).bind(operator).bind(product_type).bind(cost).bind(basic).bind(gold).bind(platinum).bind(p.status.unwrap_or(true)).bind(validation).fetch_one(&mut *tx).await;
    if let Err(e)=result {if e.as_database_error().is_some_and(|e|e.is_unique_violation()){return duplicate_code(&code)} return internal();}
    let row=match sqlx::query(&format!("{PRODUCT_SELECT} WHERE p.id=$1")).bind(id).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()};
    let after=product_json(map_document(&row,true),1);
    let audit=build_validation_product_audit_payload(&actor,ValidationProductAuditOperation::Create,id,&code,None,Some(&after),&headers);
    if persist_validation_product_audit(&mut tx,actor.id,ValidationProductAuditOperation::Create,audit).await.is_err(){return internal();}
    if tx.commit().await.is_err(){return internal();}
    (StatusCode::CREATED,Json(after)).into_response()
}

pub async fn update(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(raw_id): Path<String>, Json(p): Json<ValidationProductPayload>) -> Response {
    let actor=match require_sql_permission(&headers,&state,"manageSettings").await{Ok(v)=>v,Err(r)=>return r};
    let Some(expected)=p.version else{return message(StatusCode::BAD_REQUEST,"Versi produk wajib dikirim")};
    if validate_expected_version(expected).is_err(){return message(StatusCode::BAD_REQUEST,"Versi produk tidak valid")}
    let product_id=match id(&raw_id){Ok(v)=>v,Err(r)=>return r};
    let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};
    let sql=format!("{PRODUCT_SELECT} WHERE p.id=$1 FOR UPDATE OF p");
    let row=match sqlx::query(&sql).bind(product_id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return not_found(),Err(_)=>return internal()};
    let before_revision:i64=row.get("revision");
    let before=product_json(map_document(&row,false),before_revision);
    if !is_validation(&before["validation"]){return not_found()}
    if before["validation"]["archived"]==true{return message(StatusCode::NOT_FOUND,"Produk validasi telah diarsipkan")}
    if version_from_revision(before_revision)!=Some(expected){return conflict()}
    let status_only = status_only(&p);
    let mut validation=before["validation"].clone();
    let next_type=clean(p.validation_type.clone(),20).or_else(||validation["type"].as_str().map(str::to_owned)).unwrap_or_else(||"operator".into());
    let next_game=p.game.clone().map(|v|v.trim().chars().take(30).collect()).or_else(||validation["game"].as_str().map(str::to_owned)).unwrap_or_default();
    if !matches!(next_type.as_str(),"nickname"|"operator") || (next_type=="nickname"&&!matches!(next_game.as_str(),"freefire"|"mobilelegends")) || (next_type=="operator"&&!next_game.is_empty()){return message(StatusCode::BAD_REQUEST,"Tipe atau game validasi tidak valid")}
    validation["type"]=json!(next_type); validation["game"]=json!(next_game);
    if let Some(v)=clean(p.target_label,60){validation["targetLabel"]=json!(v)}
    if p.secondary_target_label.is_some(){validation["secondaryTargetLabel"]=json!(clean(p.secondary_target_label,60).unwrap_or_default())}
    if let Some(v)=clean(p.result_label,60){validation["resultLabel"]=json!(v)}
    let (basic,gold,platinum)=if let Some(price)=p.price{match normalize_price(price){Ok(v)=>v,Err(r)=>return r}}else{(before["price"]["basic"].as_i64().unwrap_or(0),before["price"]["gold"].as_i64().unwrap_or(0),before["price"]["platinum"].as_i64().unwrap_or(0))};
    let cost=if let Some(v)=p.cost_price{match money(v,"Harga modal"){Ok(v)=>v,Err(r)=>return r}}else{before["costPrice"].as_i64().unwrap_or(0)};
    let new_name=clean(p.name.clone(),120).unwrap_or_else(||before["name"].as_str().unwrap_or_default().to_owned());
    let new_code=clean(p.code.clone(),80).unwrap_or_else(||before["code"].as_str().unwrap_or_default().to_owned());
    let (category,operator,product_type)=match references(p.category_id.as_deref().or(before["categoryId"].as_str()),p.operator_id.as_deref().or(before["operatorId"].as_str()),p.product_type_id.as_deref().or(before["productTypeId"].as_str())){Ok(v)=>v,Err(r)=>return r};
    let refs_valid=match sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM categories WHERE id=$1) AND EXISTS(SELECT 1 FROM operators WHERE id=$2 AND category_id=$1) AND EXISTS(SELECT 1 FROM product_types WHERE id=$3 AND operator_id=$2)").bind(category).bind(operator).bind(product_type).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()};
    if !refs_valid{return message(StatusCode::BAD_REQUEST,"Kategori, operator, atau tipe produk tidak sesuai")}
    let next_revision=match revision_for_expected_version(expected){Some(v)=>v+1,None=>return conflict()};
    let updated=sqlx::query("UPDATE products SET name=$3,code=$4,vendor_sku=$4,category_id=$5,operator_id=$6,product_type_id=$7,cost_price=$8,price_basic=$9,price_gold=$10,price_platinum=$11,status=$12,validation=$13,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 AND validation->>'enabled'='true' AND NOT COALESCE((validation->>'archived')::boolean,false)")
        .bind(product_id).bind(revision_for_expected_version(expected).unwrap()).bind(&new_name).bind(&new_code).bind(category).bind(operator).bind(product_type).bind(cost).bind(basic).bind(gold).bind(platinum).bind(p.status.unwrap_or(before["status"].as_bool().unwrap_or(true))).bind(validation).execute(&mut *tx).await;
    match updated {Ok(r) if r.rows_affected()==1=>{},Ok(_)=>return conflict(),Err(e) if e.as_database_error().is_some_and(|e|e.is_unique_violation())=>return duplicate_code(&new_code),Err(_)=>return internal()}
    let row=match sqlx::query(&format!("{PRODUCT_SELECT} WHERE p.id=$1")).bind(product_id).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()};
    let after=product_json(map_document(&row,true),next_revision);
    let operation=resolve_audit_operation(false,status_only);
    let audit=build_validation_product_audit_payload(&actor,operation,product_id,&new_code,Some(&before),Some(&after),&headers);
    if persist_validation_product_audit(&mut tx,actor.id,operation,audit).await.is_err(){return internal();}
    if tx.commit().await.is_err(){return internal()}; Json(after).into_response()
}

pub async fn archive(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(raw_id): Path<String>, Query(q): Query<ValidationProductVersionQuery>) -> Response {
    let actor=match require_sql_permission(&headers,&state,"manageSettings").await{Ok(v)=>v,Err(r)=>return r};
    if validate_expected_version(q.version).is_err(){return message(StatusCode::BAD_REQUEST,"Versi produk tidak valid")}
    let product_id=match id(&raw_id){Ok(v)=>v,Err(r)=>return r};
    let revision=revision_for_expected_version(q.version).unwrap();
    let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};
    let sql=format!("{PRODUCT_SELECT} WHERE p.id=$1 FOR UPDATE OF p");
    let row=match sqlx::query(&sql).bind(product_id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return not_found(),Err(_)=>return internal()};
    let before_revision:i64=row.get("revision"); let before=product_json(map_document(&row,false),before_revision);
    if !is_validation(&before["validation"]){return not_found()} if before["validation"]["archived"]==true{return message(StatusCode::NOT_FOUND,"Produk validasi telah diarsipkan")} if version_from_revision(before_revision)!=Some(q.version){return conflict()}
    let mut validation=before["validation"].clone();validation["archived"]=json!(true);
    let changed=sqlx::query("UPDATE products SET status=false,validation=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 AND validation->>'enabled'='true' AND NOT COALESCE((validation->>'archived')::boolean,false)").bind(product_id).bind(revision).bind(validation).execute(&mut *tx).await;
    match changed{Ok(r)if r.rows_affected()==1=>{},Ok(_)=>return conflict(),Err(_)=>return internal()}
    let row=match sqlx::query(&format!("{PRODUCT_SELECT} WHERE p.id=$1")).bind(product_id).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal()};
    let after=product_json(map_document(&row,false),revision+1);let sku=after["code"].as_str().unwrap_or_default();
    let audit=build_validation_product_audit_payload(&actor,ValidationProductAuditOperation::Archive,product_id,sku,Some(&before),Some(&after),&headers);
    if persist_validation_product_audit(&mut tx,actor.id,ValidationProductAuditOperation::Archive,audit).await.is_err(){return internal()};
    if tx.commit().await.is_err(){return internal()};Json(json!({"message":"Produk validasi berhasil diarsipkan"})).into_response()
}

fn references(category:Option<&str>,operator:Option<&str>,product_type:Option<&str>)->Result<(Uuid,Uuid,Uuid),Response>{
    let parse=|raw:Option<&str>,label:&'static str|->Result<Uuid,Response>{raw.and_then(|s|Uuid::parse_str(s.trim()).ok()).ok_or_else(||message(StatusCode::BAD_REQUEST,label))};
    let c=parse(category,"Kategori tidak ditemukan")?;let o=parse(operator,"Operator tidak ditemukan")?;let t=parse(product_type,"Tipe produk tidak ditemukan")?;
    Ok((c,o,t))
}
fn money(v:i64,label:&'static str)->Result<i64,Response>{if !(0..=MAX_VALIDATION_PRICE).contains(&v){return Err(message(StatusCode::BAD_REQUEST,if label=="Harga modal"{"Harga modal melebihi batas maksimal Rp100.000.000"}else{"Harga jual melebihi batas maksimal Rp100.000.000"}))}Ok(v)}
fn normalize_price(p:ValidationProductPricePayload)->Result<(i64,i64,i64),Response>{let b=money(p.basic.unwrap_or(0),"Harga jual")?;let g=money(p.gold.unwrap_or(b),"Harga jual")?;let t=money(p.platinum.unwrap_or(g),"Harga jual")?;if g<b||t<g{return Err(message(StatusCode::BAD_REQUEST,"Urutan harga wajib Basic <= Gold <= Platinum"))}Ok((b,g,t))}
fn duplicate_code(code:&str)->Response{(StatusCode::CONFLICT,Json(json!({"message":"Kode produk sudah digunakan, gunakan kode unik lain","field":"code","duplicate":code}))).into_response()}
fn internal()->Response{message(StatusCode::INTERNAL_SERVER_ERROR,"Gagal menyimpan produk validasi")}
fn unavailable()->Response{message(StatusCode::SERVICE_UNAVAILABLE,"Layanan database belum tersedia")}
fn not_found()->Response{message(StatusCode::NOT_FOUND,"Produk validasi tidak ditemukan")}
