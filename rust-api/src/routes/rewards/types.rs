use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub struct PointTransactionsQuery {
    #[serde(rename = "type")]
    pub(super) transaction_type: Option<String>,
    pub(super) page: Option<i64>,
    pub(super) limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct RewardPayload {
    pub(super) name: Option<Value>,
    pub(super) description: Option<Value>,
    #[serde(rename = "pointsRequired")]
    pub(super) points_required: Option<Value>,
    pub(super) stock: Option<Value>,
    #[serde(rename = "imageUrl")]
    pub(super) image_url: Option<Value>,
    pub(super) category: Option<Value>,
    pub(super) status: Option<Value>,
}

#[derive(Deserialize)]
pub struct PointsSettingsPayload {
    pub(super) value: Option<Value>,
    #[serde(rename = "pointValueRate")]
    pub(super) point_value_rate: Option<Value>,
}

#[derive(Deserialize)]
pub struct PointsAdjustPayload {
    #[serde(rename = "userId")]
    pub(super) user_id: String,
    pub(super) points: i64,
    pub(super) description: String,
}

#[derive(Serialize)]
pub(super) struct RewardItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) description: String,
    #[serde(rename = "pointsRequired")]
    pub(super) points_required: i64,
    pub(super) stock: i64,
    #[serde(rename = "imageUrl", skip_serializing_if = "Option::is_none")]
    pub(super) image_url: Option<String>,
    pub(super) category: String,
    pub(super) status: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct RewardResponse {
    pub(super) message: &'static str,
    pub(super) reward: RewardItem,
}

#[derive(Serialize)]
pub(super) struct RewardDeleteResponse {
    pub(super) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) archived: Option<bool>,
}

#[derive(Serialize)]
pub(super) struct PointsSettingsUpdateResponse {
    pub(super) message: &'static str,
    #[serde(
        rename = "pointsPerTransaction",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) points_per_transaction: Option<i64>,
    #[serde(rename = "pointValueRate", skip_serializing_if = "Option::is_none")]
    pub(super) point_value_rate: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct PointsSettingsResponse {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) key: String,
    pub(super) value: i64,
    pub(super) description: String,
    #[serde(rename = "pointValueRate")]
    pub(super) point_value_rate: i64,
}

#[derive(Serialize)]
pub(super) struct PointsAdjustResponse {
    pub(super) message: &'static str,
    #[serde(rename = "newPoints")]
    pub(super) new_points: i64,
}

#[derive(Serialize)]
pub(super) struct PointsStatsResponse {
    #[serde(rename = "totalPointsEarned")]
    pub(super) total_points_earned: i64,
    #[serde(rename = "totalPointsRedeemed")]
    pub(super) total_points_redeemed: i64,
    #[serde(rename = "activeUsers")]
    pub(super) active_users: i64,
    #[serde(rename = "totalUsers")]
    pub(super) total_users: i64,
    #[serde(rename = "engagementRate")]
    pub(super) engagement_rate: f64,
}

#[derive(Clone, Serialize)]
pub(super) struct UserBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
}

#[derive(Clone, Serialize)]
pub(super) struct RewardBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
}

#[derive(Serialize)]
pub(super) struct PointTransactionItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) user: Option<UserBrief>,
    #[serde(rename = "type")]
    pub(super) transaction_type: String,
    pub(super) points: i64,
    pub(super) description: String,
    #[serde(rename = "relatedReward")]
    pub(super) related_reward: Option<RewardBrief>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct PointTransactionsMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
}

#[derive(Serialize)]
pub(super) struct PointTransactionsResponse {
    pub(super) items: Vec<PointTransactionItem>,
    pub(super) meta: PointTransactionsMeta,
}

#[derive(Clone, Serialize)]
pub(super) struct ProductBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
}

#[derive(Clone, Serialize)]
pub(super) struct RelatedTransactionBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) amount: i64,
    pub(super) target: String,
    pub(super) status: String,
    pub(super) product: Option<ProductBrief>,
}

#[derive(Clone, Serialize)]
pub(super) struct PointsHistoryItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) user: String,
    #[serde(rename = "type")]
    pub(super) transaction_type: String,
    pub(super) points: i64,
    pub(super) description: String,
    #[serde(rename = "relatedReward")]
    pub(super) related_reward: Option<RewardBrief>,
    #[serde(rename = "relatedTransaction")]
    pub(super) related_transaction: Option<RelatedTransactionBrief>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct PointsHistorySummary {
    #[serde(rename = "currentPoints")]
    pub(super) current_points: i64,
    #[serde(rename = "totalEarned")]
    pub(super) total_earned: i64,
    #[serde(rename = "totalRedeemed")]
    pub(super) total_redeemed: i64,
    #[serde(rename = "activityCount")]
    pub(super) activity_count: i64,
    #[serde(rename = "lastActivityAt")]
    pub(super) last_activity_at: Option<String>,
}

#[derive(Serialize)]
pub(super) struct PointsHistoryMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
    #[serde(rename = "type")]
    pub(super) transaction_type: String,
}

#[derive(Serialize)]
pub(super) struct PointsHistoryResponse {
    #[serde(rename = "currentPoints")]
    pub(super) current_points: i64,
    #[serde(rename = "pointValueRate")]
    pub(super) point_value_rate: i64,
    #[serde(rename = "pointsPerTransaction")]
    pub(super) points_per_transaction: i64,
    #[serde(rename = "estimatedValue")]
    pub(super) estimated_value: i64,
    pub(super) items: Vec<PointsHistoryItem>,
    pub(super) history: Vec<PointsHistoryItem>,
    pub(super) summary: PointsHistorySummary,
    pub(super) meta: PointsHistoryMeta,
}

pub(super) struct NormalizedRewardPayload {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) points_required: i64,
    pub(super) stock: i64,
    pub(super) image_url: String,
    pub(super) category: String,
    pub(super) status: bool,
}
