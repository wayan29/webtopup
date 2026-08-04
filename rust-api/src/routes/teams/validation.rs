use std::collections::HashMap;

use axum::response::Response;
use mongodb::bson::{doc, oid::ObjectId, Document};
use serde_json::Value;

use crate::utils::bson::escape_regex;

use super::{responses::status_message, TEAM_PERMISSIONS};

pub(super) fn build_team_filter(query: &HashMap<String, String>) -> Document {
    let mut filter = doc! { "role": { "$in": ["owner", "admin", "cs"] } };
    if let Some(search) = query
        .get("search")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let pattern = escape_regex(search);
        filter.insert(
            "$or",
            vec![
                doc! { "name": { "$regex": &pattern, "$options": "i" } },
                doc! { "email": { "$regex": &pattern, "$options": "i" } },
            ],
        );
    }
    filter
}

pub(super) fn parse_team_member_id(id: &str) -> Result<ObjectId, Response> {
    ObjectId::parse_str(id).map_err(|_| {
        status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID anggota tim tidak valid",
        )
    })
}

pub(super) fn normalize_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(super) fn is_valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn default_permissions(role: &str) -> Document {
    let enabled = if role == "admin" {
        [
            "viewDashboard",
            "viewReports",
            "viewTransactions",
            "processManualTransaction",
            "viewDeposits",
            "approveDeposits",
            "viewProducts",
            "manageProducts",
            "manageVouchers",
            "viewPayment",
            "managePayment",
            "viewUsers",
            "manageUsers",
            "viewTeam",
            "viewVendors",
        ]
        .as_slice()
    } else {
        [
            "viewDashboard",
            "viewTransactions",
            "processManualTransaction",
            "viewDeposits",
        ]
        .as_slice()
    };
    let mut document = Document::new();
    for key in TEAM_PERMISSIONS {
        document.insert(key, enabled.contains(&key));
    }
    document
}

pub(super) fn build_permissions(input: Option<&Value>, role: &str) -> Document {
    let mut permissions = default_permissions(role);
    if let Some(Value::Object(map)) = input {
        for key in TEAM_PERMISSIONS {
            if let Some(Value::Bool(value)) = map.get(key) {
                permissions.insert(key, *value);
            }
        }
    }
    if permissions.get_bool("manageTeam").unwrap_or(false) {
        permissions.insert("viewTeam", true);
    }
    if permissions.get_bool("manageProducts").unwrap_or(false) {
        permissions.insert("viewProducts", true);
        permissions.insert("manageVouchers", true);
    }
    if permissions.get_bool("managePayment").unwrap_or(false) {
        permissions.insert("viewPayment", true);
    }
    if permissions.get_bool("manageUsers").unwrap_or(false) {
        permissions.insert("viewUsers", true);
    }
    if permissions.get_bool("manageSettings").unwrap_or(false) {
        permissions.insert("viewSettings", true);
    }
    if permissions.get_bool("manageVendors").unwrap_or(false) {
        permissions.insert("viewVendors", true);
    }
    permissions
}

pub(super) fn clamp_permissions_to_actor(
    mut permissions: Document,
    actor_permissions: &Document,
) -> Document {
    for key in TEAM_PERMISSIONS {
        if permissions.get_bool(key).unwrap_or(false)
            && !actor_permissions.get_bool(key).unwrap_or(false)
        {
            permissions.insert(key, false);
        }
    }
    permissions.insert("viewDashboard", true);
    permissions
}

pub(super) fn ensure_manage_scope(actor_role: &str, target_role: &str) -> Result<(), Response> {
    if actor_role == "owner" || target_role == "cs" {
        return Ok(());
    }
    Err(status_message(
        axum::http::StatusCode::FORBIDDEN,
        "Hanya owner yang dapat mengelola akun admin",
    ))
}

pub(super) fn ensure_assignable_role(actor_role: &str, target_role: &str) -> Result<(), Response> {
    if target_role != "admin" && target_role != "cs" {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Role anggota tim harus admin atau cs",
        ));
    }
    if actor_role == "owner" || target_role == "cs" {
        return Ok(());
    }
    Err(status_message(
        axum::http::StatusCode::FORBIDDEN,
        "Hanya owner yang dapat membuat atau mempromosikan admin",
    ))
}

pub(super) fn build_update_summary(changes: &[&str]) -> String {
    if changes.is_empty() {
        return "Tidak ada perubahan terdeteksi".to_string();
    }
    format!("Memperbarui {}", changes.join(", "))
}
