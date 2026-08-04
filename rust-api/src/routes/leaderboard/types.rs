use mongodb::bson::oid::ObjectId;
use serde::{ser::SerializeStruct, Deserialize, Serialize};

#[derive(Deserialize)]
pub struct LeaderboardQuery {
    pub(super) period: Option<String>,
}

#[derive(Serialize)]
pub struct LeaderboardResponse {
    pub items: Vec<LeaderboardItem>,
    #[serde(rename = "currentUser")]
    pub current_user: Option<CurrentUser>,
    pub meta: LeaderboardMeta,
}

pub struct LeaderboardItem {
    pub id: Option<String>,
    pub total_transactions: i64,
    pub total_amount: i64,
    pub name: String,
    pub level: String,
    pub rank: i64,
    pub is_current_user: bool,
}

impl Serialize for LeaderboardItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("LeaderboardItem", 7)?;
        state.serialize_field("_id", &self.id)?;
        state.serialize_field("totalTransactions", &self.total_transactions)?;
        state.serialize_field("totalAmount", &self.total_amount)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("level", &self.level)?;
        state.serialize_field("rank", &self.rank)?;
        state.serialize_field("isCurrentUser", &self.is_current_user)?;
        state.end()
    }
}

#[derive(Serialize)]
pub struct CurrentUser {
    pub id: String,
    pub name: String,
    pub rank: i64,
    #[serde(rename = "totalTransactions")]
    pub total_transactions: i64,
    #[serde(rename = "totalAmount")]
    pub total_amount: i64,
    #[serde(rename = "inTopList")]
    pub in_top_list: bool,
}

#[derive(Serialize)]
pub struct LeaderboardMeta {
    pub period: String,
    #[serde(rename = "participantCount")]
    pub participant_count: i64,
    #[serde(rename = "totalTransactions")]
    pub total_transactions: i64,
    #[serde(rename = "totalAmount")]
    pub total_amount: i64,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

#[derive(Clone)]
pub struct CurrentMember {
    pub id: ObjectId,
    pub name: String,
}
