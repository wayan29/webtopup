use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub(super) struct UsersResponse {
    pub(super) users: Vec<UserItem>,
    #[serde(rename = "currentPage")]
    pub(super) current_page: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
    #[serde(rename = "totalUsers")]
    pub(super) total_users: i64,
    #[serde(rename = "pageSize")]
    pub(super) page_size: i64,
    pub(super) summary: UserSummary,
}

#[derive(Serialize)]
pub(super) struct UserItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) level: String,
    pub(super) balance: f64,
    pub(super) points: i64,
    pub(super) active: bool,
    /// Stable Open API member identity when present; never includes secrets.
    #[serde(rename = "memberCode", skip_serializing_if = "Option::is_none")]
    pub(super) member_code: Option<String>,
    /// True when an Open API key is currently stored for this member.
    #[serde(rename = "hasOpenApiKey")]
    pub(super) has_open_api_key: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Default, Serialize)]
pub(super) struct UserSummary {
    #[serde(rename = "_id")]
    pub(super) id: Option<Value>,
    #[serde(rename = "totalMembers")]
    pub(super) total_members: i64,
    #[serde(rename = "activeMembers")]
    pub(super) active_members: i64,
    #[serde(rename = "inactiveMembers")]
    pub(super) inactive_members: i64,
    #[serde(rename = "totalBalance")]
    pub(super) total_balance: f64,
}

#[derive(Serialize)]
pub(super) struct BalanceAdjustmentsResponse {
    pub(super) items: Vec<BalanceAdjustmentItem>,
}

#[derive(Serialize)]
pub(super) struct BalanceAdjustmentItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) user: Option<String>,
    #[serde(rename = "adjustedBy")]
    pub(super) adjusted_by: Option<AdjustmentActor>,
    #[serde(rename = "type")]
    pub(super) adjustment_type: String,
    pub(super) amount: f64,
    #[serde(rename = "balanceBefore")]
    pub(super) balance_before: f64,
    #[serde(rename = "balanceAfter")]
    pub(super) balance_after: f64,
    pub(super) reason: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct MyProfileResponse {
    pub(super) profile: MyProfile,
}

#[derive(Serialize)]
pub(super) struct MyProfile {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) phone: String,
    pub(super) address: String,
    pub(super) role: String,
    pub(super) level: String,
    pub(super) balance: f64,
    pub(super) points: i64,
    pub(super) active: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    pub(super) preferences: MyPreferences,
}

#[derive(Serialize)]
pub(super) struct MyPreferences {
    #[serde(rename = "emailNotifications")]
    pub(super) email_notifications: bool,
    #[serde(rename = "smsNotifications")]
    pub(super) sms_notifications: bool,
    #[serde(rename = "showBalance")]
    pub(super) show_balance: bool,
    #[serde(rename = "uiTheme")]
    pub(super) ui_theme: String,
}

#[derive(Serialize)]
pub(super) struct MyPreferencesResponse {
    pub(super) preferences: MyPreferences,
}

#[derive(Deserialize)]
pub struct UpdateMyProfilePayload {
    pub(super) name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) phone: Option<String>,
    pub(super) address: Option<String>,
}

/// Staff self-service profile edit. Intentionally has no `role` field: privilege changes
/// belong to team management, not to self-service.
#[derive(Deserialize)]
pub struct UpdateStaffProfilePayload {
    pub(super) name: Option<String>,
    pub(super) email: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateUserPayload {
    pub(super) name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) level: Option<String>,
}

#[derive(Deserialize)]
pub struct UserStatusPayload {
    pub(super) active: Option<bool>,
}

#[derive(Deserialize)]
pub struct AdjustBalancePayload {
    pub(super) amount: Option<Value>,
    #[serde(rename = "type")]
    pub(super) adjustment_type: Option<String>,
    pub(super) reason: Option<String>,
}

#[derive(Serialize)]
pub(super) struct UserMutationResponse {
    pub(super) message: &'static str,
    pub(super) user: UserItem,
}

#[derive(Serialize)]
pub(super) struct BalanceAuditResponse {
    pub(super) amount: f64,
    #[serde(rename = "type")]
    pub(super) adjustment_type: String,
    pub(super) reason: String,
    #[serde(rename = "balanceBefore")]
    pub(super) balance_before: f64,
    #[serde(rename = "balanceAfter")]
    pub(super) balance_after: f64,
}

#[derive(Serialize)]
pub(super) struct AdjustBalanceResponse {
    pub(super) message: &'static str,
    pub(super) user: UserItem,
    pub(super) audit: BalanceAuditResponse,
}

#[derive(Serialize)]
pub(super) struct UpdateMyProfileResponse {
    pub(super) message: &'static str,
    pub(super) profile: MyProfile,
}

#[derive(Deserialize)]
pub struct UpdateMyPreferencesPayload {
    #[serde(rename = "emailNotifications")]
    pub(super) email_notifications: Option<bool>,
    #[serde(rename = "smsNotifications")]
    pub(super) sms_notifications: Option<bool>,
    #[serde(rename = "showBalance")]
    pub(super) show_balance: Option<bool>,
    #[serde(rename = "uiTheme")]
    pub(super) ui_theme: Option<String>,
}

#[derive(Deserialize)]
pub struct ChangeMyPasswordPayload {
    #[serde(rename = "currentPassword")]
    pub(super) current_password: Option<String>,
    #[serde(rename = "newPassword")]
    pub(super) new_password: Option<String>,
    #[serde(rename = "confirmPassword")]
    pub(super) confirm_password: Option<String>,
}

#[derive(Serialize)]
pub(super) struct UpdateMyPreferencesResponse {
    pub(super) message: &'static str,
    pub(super) preferences: MyPreferences,
}

#[derive(Serialize)]
pub(super) struct LoginActivityResponse {
    pub(super) items: Vec<LoginActivityItem>,
}

#[derive(Serialize)]
pub(super) struct LoginActivityItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) ip: String,
    #[serde(rename = "userAgent")]
    pub(super) user_agent: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
}

#[derive(Serialize)]
pub(super) struct BalanceHistoryResponse {
    pub(super) items: Vec<BalanceHistoryItem>,
}

#[derive(Serialize)]
pub(super) struct BalanceHistoryItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) source: String,
    #[serde(rename = "type")]
    pub(super) item_type: String,
    pub(super) amount: f64,
    pub(super) description: String,
    pub(super) reference: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "balanceBefore", skip_serializing_if = "Option::is_none")]
    pub(super) balance_before: Option<f64>,
    #[serde(rename = "balanceAfter", skip_serializing_if = "Option::is_none")]
    pub(super) balance_after: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) meta: Option<Value>,
}

#[derive(Clone, Serialize)]
pub(super) struct AdjustmentActor {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) role: String,
}
