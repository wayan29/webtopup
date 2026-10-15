use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

pub(super) const PRODUCT_SELECT: &str = "SELECT p.*, jsonb_build_object('_id',p.id,'productId',p.product_id,'code',p.code,'name',p.name,'category',p.category,'categoryId',p.category_id,'operatorId',p.operator_id,'productTypeId',p.product_type_id,'paymentType',p.payment_type,'icon',p.icon,'rewardPoints',p.reward_points,'brand',p.brand,'costPrice',p.cost_price,'price',jsonb_build_object('basic',p.price_basic,'gold',p.price_gold,'platinum',p.price_platinum),'vendor',jsonb_build_object('name',p.vendor_name,'sku',p.vendor_sku),'validation',p.validation,'sortOrder',p.sort_order,'status',p.status,'createdAt',p.created_at,'updatedAt',p.updated_at,'__v',p.revision-1) AS raw_document, CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('_id',c.id,'name',c.name,'icon',c.icon,'slug',c.slug,'status',c.status) END AS category_brief, CASE WHEN o.id IS NOT NULL THEN jsonb_build_object('_id',o.id,'name',o.name,'status',o.status) END AS operator_brief, CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('_id',t.id,'name',t.name,'status',t.status) END AS type_brief, EXISTS(SELECT 1 FROM operators io WHERE NOT io.status AND lower(io.name)=lower(p.brand)) AS inactive_brand FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN operators o ON o.id=p.operator_id LEFT JOIN product_types t ON t.id=p.product_type_id";

pub(in crate::routes) fn document(row: &sqlx::postgres::PgRow, populated: bool, visibility: bool) -> Value {
    let mut value: Value=row.get("raw_document");
    let mut issues=Vec::new();
    for (key,column,message) in [("categoryId","category_brief","Kategori nonaktif"),("operatorId","operator_brief","Operator nonaktif"),("productTypeId","type_brief","Jenis produk nonaktif")] {
        let brief:Option<Value>=row.get(column);
        if brief.as_ref().is_some_and(|v|v["status"]==false) {issues.push(message);}
        if key=="operatorId" && brief.is_none() && row.get::<bool,_>("inactive_brand") {issues.push(message);}
        if populated {value[key]=brief.unwrap_or(Value::Null);}
    }
    normalize_validation(&mut value);
    if visibility {value["canPurchase"]=Value::Bool(issues.is_empty()); value["visibilityIssues"]=serde_json::json!(issues);}
    value
}
pub(in crate::routes) fn normalize_validation(value: &mut Value) {
    let name=value["name"].as_str().unwrap_or("").to_lowercase();
    let v=&mut value["validation"];
    if v["enabled"]!=true {return;}
    if v["type"]=="nickname" && (name.contains("operator") || v["targetLabel"].as_str().unwrap_or("").to_lowercase().contains("nomor") || v["resultLabel"].as_str().unwrap_or("").to_lowercase().contains("operator")) {
        v["type"]="operator".into();v["game"]="".into();v["targetLabel"]="Nomor HP".into();v["secondaryTargetLabel"]="".into();v["resultLabel"]="Operator".into();
    } else if v["type"]=="nickname" && v["game"]!="mobilelegends" && v["secondaryTargetLabel"].as_str().unwrap_or("").to_lowercase().contains("zone") {v["game"]="mobilelegends".into();}
}
pub(in crate::routes) async fn load(conn:&mut PgConnection,id:Uuid,populated:bool)->Result<Option<Value>,sqlx::Error> {
    let sql=format!("{} WHERE p.id=$1",PRODUCT_SELECT);
    Ok(sqlx::query(&sql).bind(id).fetch_optional(conn).await?.map(|r|document(&r,populated,false)))
}
