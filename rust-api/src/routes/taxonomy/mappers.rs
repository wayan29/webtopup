use std::collections::HashMap;

use mongodb::bson::{doc, Bson, Document};
use serde_json::Value;

use crate::utils::bson::{read_i64, read_string};

use super::{
    description_html::sanitize_product_description,
    json::{date_string, document_to_json, object_id_string, optional_string},
    types::{
        CategoryBrief, CategoryItem, OperatorBrief, OperatorDetail, OperatorItem, PopupInfo,
        ProductTypeDetail, ProductTypeItem, ServerOption,
    },
};

pub(super) fn category_item_from_doc(
    document: Document,
    direct: &HashMap<String, i64>,
    legacy: &HashMap<String, i64>,
    operators: &HashMap<String, i64>,
    product_types: &HashMap<String, i64>,
) -> CategoryItem {
    let id = document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let legacy_count = legacy
        .get(&read_string(&document, "name"))
        .copied()
        .unwrap_or(0);
    let direct_count = direct.get(&id).copied().unwrap_or(0);
    let operator_count = operators.get(&id).copied().unwrap_or(0);
    let product_type_count = product_types.get(&id).copied().unwrap_or(0);
    let dependency_count = direct_count + legacy_count + operator_count + product_type_count;
    CategoryItem {
        id,
        category_id: read_i64(&document, "categoryId"),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        icon: read_string(&document, "icon"),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
        direct_product_count: direct_count,
        legacy_product_count: legacy_count,
        product_count: direct_count + legacy_count,
        operator_count,
        product_type_count,
        dependency_count,
        can_delete: dependency_count == 0,
    }
}

pub(super) fn operator_item_from_doc(
    document: Document,
    direct: &HashMap<String, i64>,
    product_types: &HashMap<String, i64>,
) -> OperatorItem {
    let id = document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let direct_count = direct.get(&id).copied().unwrap_or(0);
    let product_type_count = product_types.get(&id).copied().unwrap_or(0);
    let dependency_count = direct_count + product_type_count;
    OperatorItem {
        id,
        operator_id: read_i64(&document, "operatorId"),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        category_id: document
            .get_document("categoryData")
            .ok()
            .and_then(category_brief),
        icon: optional_string(&document, "icon"),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        is_custom_product: document.get_bool("isCustomProduct").unwrap_or(false),
        direct_product_count: direct_count,
        legacy_product_count: 0,
        product_count: direct_count,
        product_type_count,
        dependency_count,
        can_delete: dependency_count == 0,
    }
}

pub(super) fn public_operator_from_doc(mut document: Document) -> Value {
    if let Ok(category) = document.get_document("categoryData") {
        let mut category_doc = Document::new();
        for key in ["_id", "name", "icon", "slug", "status", "isActive"] {
            if let Some(value) = category.get(key) {
                category_doc.insert(key, value.clone());
            }
        }
        document.insert("categoryId", Bson::Document(category_doc));
    }
    document.remove("categoryData");
    if !document.contains_key("serverIdType") {
        document.insert("serverIdType", "number");
    }
    document_to_json(document)
}

pub(super) fn public_product_type_from_doc(mut document: Document) -> Value {
    sanitize_product_type_description(&mut document);
    if let Ok(category) = document.get_document("categoryData") {
        let mut category_doc = Document::new();
        for key in ["_id", "name", "icon", "slug", "status", "isActive"] {
            if let Some(value) = category.get(key) {
                category_doc.insert(key, value.clone());
            }
        }
        document.insert("categoryId", Bson::Document(category_doc));
    }
    if let Ok(operator) = document.get_document("operatorData") {
        let mut operator_doc = Document::new();
        for key in ["_id", "name", "icon", "slug", "status"] {
            if let Some(value) = operator.get(key) {
                operator_doc.insert(key, value.clone());
            }
        }
        document.insert("operatorId", Bson::Document(operator_doc));
    }
    document.remove("categoryData");
    document.remove("operatorData");
    ensure_product_type_defaults(&mut document);
    document_to_json(document)
}

fn ensure_product_type_defaults(document: &mut Document) {
    if !document.contains_key("icon") {
        document.insert("icon", "");
    }
    if !document.contains_key("cover") {
        document.insert("cover", "");
    }
    if !document.contains_key("openTime") {
        document.insert("openTime", "00:00");
    }
    if !document.contains_key("closeTime") {
        document.insert("closeTime", "23:59");
    }
    if !document.contains_key("open24Hours") {
        document.insert("open24Hours", true);
    }
    if !document.contains_key("estimatedDelivery") {
        document.insert("estimatedDelivery", "");
    }
    if !document.contains_key("processType") {
        document.insert("processType", "auto");
    }
    if !document.contains_key("description") {
        document.insert("description", "");
    }
    if !document.contains_key("popupInfo") {
        document.insert(
            "popupInfo",
            doc! { "title": "", "content": "", "image": "", "buttonText": "", "buttonLink": "", "enabled": false },
        );
    }
}

pub(super) fn product_type_item_from_doc(
    document: Document,
    products: &HashMap<String, i64>,
) -> ProductTypeItem {
    let id = document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let product_count = products.get(&id).copied().unwrap_or(0);
    ProductTypeItem {
        id,
        type_id: read_i64(&document, "typeId"),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        category_id: document
            .get_document("categoryData")
            .ok()
            .and_then(category_brief),
        operator_id: document
            .get_document("operatorData")
            .ok()
            .and_then(operator_brief),
        icon: read_string(&document, "icon"),
        cover: read_string(&document, "cover"),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        product_count,
        dependency_count: product_count,
        can_delete: product_count == 0,
    }
}

pub(super) fn product_type_response_json(
    mut document: Document,
    product_count: i64,
) -> serde_json::Map<String, Value> {
    sanitize_product_type_description(&mut document);
    if let Ok(category) = document.get_document("categoryData") {
        let mut category_doc = Document::new();
        for key in ["_id", "name", "icon", "slug", "status"] {
            if let Some(value) = category.get(key) {
                category_doc.insert(key, value.clone());
            }
        }
        document.insert("categoryId", Bson::Document(category_doc));
    }
    if let Ok(operator) = document.get_document("operatorData") {
        let mut operator_doc = Document::new();
        for key in ["_id", "name", "icon", "slug", "status"] {
            if let Some(value) = operator.get(key) {
                operator_doc.insert(key, value.clone());
            }
        }
        document.insert("operatorId", Bson::Document(operator_doc));
    }
    document.remove("categoryData");
    document.remove("operatorData");
    let mut product_type_json = match document_to_json(document) {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    product_type_json.insert("productCount".to_string(), serde_json::json!(product_count));
    product_type_json
}

pub(super) fn operator_detail_from_doc(document: Document) -> OperatorDetail {
    OperatorDetail {
        id: object_id_string(&document, "_id"),
        operator_id: read_i64(&document, "operatorId"),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        category_id: document
            .get_document("categoryData")
            .ok()
            .and_then(category_brief),
        icon: read_string(&document, "icon"),
        instruction_image: read_string(&document, "instructionImage"),
        check_username: document.get_bool("checkUsername").unwrap_or(false),
        username_label: read_string(&document, "usernameLabel"),
        validation_type: read_string(&document, "validationType").if_empty("none"),
        description: read_string(&document, "description"),
        is_custom_product: document.get_bool("isCustomProduct").unwrap_or(false),
        user_id_label: read_string(&document, "userIdLabel").if_empty("User ID"),
        user_id_type: read_string(&document, "userIdType").if_empty("number"),
        has_server_id: document.get_bool("hasServerId").unwrap_or(false),
        server_id_label: read_string(&document, "serverIdLabel").if_empty("Server ID"),
        server_id_dropdown: document.get_bool("serverIdDropdown").unwrap_or(false),
        server_id_type: read_string(&document, "serverIdType").if_empty("number"),
        server_options: server_options(&document),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn product_type_detail_from_doc(document: Document) -> ProductTypeDetail {
    let description = sanitize_product_description(&read_string(&document, "description"));
    ProductTypeDetail {
        id: object_id_string(&document, "_id"),
        type_id: read_i64(&document, "typeId"),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        category_id: document
            .get_document("categoryData")
            .ok()
            .and_then(category_brief),
        operator_id: document
            .get_document("operatorData")
            .ok()
            .and_then(operator_brief),
        icon: read_string(&document, "icon"),
        cover: read_string(&document, "cover"),
        open_time: read_string(&document, "openTime").if_empty("00:00"),
        close_time: read_string(&document, "closeTime").if_empty("23:59"),
        open_24_hours: document.get_bool("open24Hours").unwrap_or(true),
        estimated_delivery: read_string(&document, "estimatedDelivery"),
        process_type: read_string(&document, "processType").if_empty("auto"),
        description,
        popup_info: popup_info(document.get_document("popupInfo").ok()),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

fn sanitize_product_type_description(document: &mut Document) {
    let sanitized = sanitize_product_description(&read_string(document, "description"));
    document.insert("description", sanitized);
}

fn server_options(document: &Document) -> Vec<ServerOption> {
    match document.get_array("serverOptions") {
        Ok(values) => values
            .iter()
            .filter_map(|value| value.as_document())
            .map(|document| ServerOption {
                label: read_string(document, "label"),
                value: read_string(document, "value"),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn popup_info(document: Option<&Document>) -> PopupInfo {
    PopupInfo {
        title: document
            .map(|doc| read_string(doc, "title"))
            .unwrap_or_default(),
        content: document
            .map(|doc| read_string(doc, "content"))
            .unwrap_or_default(),
        image: document
            .map(|doc| read_string(doc, "image"))
            .unwrap_or_default(),
        button_text: document
            .map(|doc| read_string(doc, "buttonText"))
            .unwrap_or_default(),
        button_link: document
            .map(|doc| read_string(doc, "buttonLink"))
            .unwrap_or_default(),
        enabled: document
            .and_then(|doc| doc.get_bool("enabled").ok())
            .unwrap_or(false),
    }
}

fn category_brief(document: &Document) -> Option<CategoryBrief> {
    Some(CategoryBrief {
        id: document.get_object_id("_id").ok()?.to_hex(),
        name: read_string(document, "name"),
        icon: read_string(document, "icon"),
        slug: read_string(document, "slug"),
        status: document.get_bool("status").unwrap_or(true),
    })
}

fn operator_brief(document: &Document) -> Option<OperatorBrief> {
    Some(OperatorBrief {
        id: document.get_object_id("_id").ok()?.to_hex(),
        name: read_string(document, "name"),
        icon: read_string(document, "icon"),
        slug: read_string(document, "slug"),
        status: document.get_bool("status").unwrap_or(true),
    })
}

trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use mongodb::bson::{doc, oid::ObjectId};

    use super::{
        product_type_detail_from_doc, product_type_response_json, public_product_type_from_doc,
    };

    #[test]
    fn historical_unsafe_product_type_description_is_sanitized_in_every_mapper() {
        let unsafe_description = "<p onclick='x'>Aman <strong>tebal</strong></p><script>alert(1)</script><a href='http://example.com'>HTTP</a>";
        let document = doc! {
            "_id": ObjectId::new(),
            "typeId": 1_i64,
            "name": "Type",
            "slug": "type",
            "description": unsafe_description,
        };
        let expected = "<p>Aman <strong>tebal</strong></p><a rel=\"noopener noreferrer\">HTTP</a>";

        let public = public_product_type_from_doc(document.clone());
        assert_eq!(public["description"], expected);
        let public_description = public["description"].as_str().unwrap();
        assert!(!public_description.contains("<script"));
        assert!(!public_description.contains("onclick"));
        assert!(!public_description.contains("http://"));

        let response = product_type_response_json(document.clone(), 0);
        assert_eq!(response["description"], expected);

        let detail = product_type_detail_from_doc(document);
        assert_eq!(detail.description, expected);
    }
}
