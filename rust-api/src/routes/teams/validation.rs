use axum::response::Response;
use serde_json::Value;

use super::{responses::status_message, TEAM_PERMISSIONS};

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

fn default_permissions(role: &str) -> Value {
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
    let mut permissions = serde_json::Map::new();
    for key in TEAM_PERMISSIONS {
        permissions.insert(key.to_string(), Value::Bool(enabled.contains(&key)));
    }
    Value::Object(permissions)
}

fn permission_flag(permissions: &Value, key: &str) -> bool {
    permissions.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn set_permission(permissions: &mut Value, key: &str, value: bool) {
    if let Some(map) = permissions.as_object_mut() {
        map.insert(key.to_string(), Value::Bool(value));
    }
}

pub(super) fn build_permissions(input: Option<&Value>, role: &str) -> Value {
    let mut permissions = default_permissions(role);
    if let Some(Value::Object(map)) = input {
        for key in TEAM_PERMISSIONS {
            if let Some(Value::Bool(value)) = map.get(key) {
                set_permission(&mut permissions, key, *value);
            }
        }
    }
    if permission_flag(&permissions, "manageTeam") {
        set_permission(&mut permissions, "viewTeam", true);
    }
    if permission_flag(&permissions, "manageProducts") {
        set_permission(&mut permissions, "viewProducts", true);
        set_permission(&mut permissions, "manageVouchers", true);
    }
    if permission_flag(&permissions, "managePayment") {
        set_permission(&mut permissions, "viewPayment", true);
    }
    if permission_flag(&permissions, "manageUsers") {
        set_permission(&mut permissions, "viewUsers", true);
    }
    if permission_flag(&permissions, "manageSettings") {
        set_permission(&mut permissions, "viewSettings", true);
    }
    if permission_flag(&permissions, "manageVendors") {
        set_permission(&mut permissions, "viewVendors", true);
    }
    if permission_flag(&permissions, "approveDeposits") {
        set_permission(&mut permissions, "viewDeposits", true);
    }
    permissions
}

pub(super) fn clamp_permissions_to_actor(
    mut permissions: Value,
    actor_permissions: &Value,
) -> Value {
    for key in TEAM_PERMISSIONS {
        if permission_flag(&permissions, key) && !has_effective_permission(actor_permissions, key) {
            set_permission(&mut permissions, key, false);
        }
    }
    set_permission(&mut permissions, "viewDashboard", true);
    permissions
}

fn has_effective_permission(permissions: &Value, permission: &str) -> bool {
    permission_flag(permissions, permission)
        || match permission {
            "viewDeposits" => permission_flag(permissions, "approveDeposits"),
            "viewProducts" | "manageVouchers" => permission_flag(permissions, "manageProducts"),
            "viewPayment" => permission_flag(permissions, "managePayment"),
            "viewUsers" => permission_flag(permissions, "manageUsers"),
            "viewTeam" => permission_flag(permissions, "manageTeam"),
            "viewSettings" => permission_flag(permissions, "manageSettings"),
            "viewVendors" => permission_flag(permissions, "manageVendors"),
            _ => false,
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deposit_permission_normalization_sets_view() {
        let input = serde_json::json!({
            "approveDeposits": true,
            "viewDeposits": false,
        });
        let permissions = build_permissions(Some(&input), "cs");
        assert_eq!(permissions.get("approveDeposits"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(permissions.get("viewDeposits"), Some(&serde_json::Value::Bool(true)));
    }

    #[test]
    fn deposit_permission_clamp_uses_effective_actor() {
        let target = serde_json::json!({
            "approveDeposits": true,
            "viewDeposits": true,
        });
        let actor = serde_json::json!({
            "approveDeposits": true,
            "viewDeposits": false,
        });

        let clamped = clamp_permissions_to_actor(target, &actor);
        assert_eq!(clamped.get("approveDeposits"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(clamped.get("viewDeposits"), Some(&serde_json::Value::Bool(true)));
    }
}
