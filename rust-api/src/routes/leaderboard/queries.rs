use std::collections::HashMap;

use chrono::{Datelike, Local, TimeZone};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use crate::utils::bson::{read_i64, read_string};

use super::types::{CurrentMember, CurrentUser, LeaderboardItem};

pub fn period_from_query(value: Option<&str>) -> &'static str {
    match value {
        Some("weekly") => "weekly",
        Some("monthly") => "monthly",
        _ => "alltime",
    }
}

pub fn base_pipeline(period: &str) -> Vec<Document> {
    let mut match_stage = doc! { "status": "success" };
    if let Some(start) = period_start(period) {
        match_stage.insert("createdAt", doc! { "$gte": start });
    }
    vec![
        doc! { "$match": match_stage },
        doc! { "$group": { "_id": "$user", "totalTransactions": { "$sum": 1 }, "totalAmount": { "$sum": "$amount" } } },
        doc! { "$lookup": { "from": "users", "localField": "_id", "foreignField": "_id", "as": "userInfo" } },
        doc! { "$unwind": "$userInfo" },
        doc! { "$match": { "userInfo.role": "member", "userInfo.active": { "$ne": false } } },
    ]
}

pub async fn top_docs(db: &mongodb::Database, base_pipeline: &[Document]) -> Vec<Document> {
    aggregate_docs(
        db,
        base_pipeline
            .iter()
            .cloned()
            .chain([
                doc! { "$sort": { "totalAmount": -1, "totalTransactions": -1, "userInfo.createdAt": 1 } },
                doc! { "$limit": 10 },
                doc! { "$project": { "_id": 1, "name": "$userInfo.name", "level": "$userInfo.level", "totalTransactions": 1, "totalAmount": 1 } },
            ])
            .collect(),
    )
    .await
}

pub async fn totals(db: &mongodb::Database, base_pipeline: &[Document]) -> Vec<Document> {
    aggregate_docs(
        db,
        base_pipeline
            .iter()
            .cloned()
            .chain([doc! { "$group": { "_id": Bson::Null, "participantCount": { "$sum": 1 }, "totalTransactions": { "$sum": "$totalTransactions" }, "totalAmount": { "$sum": "$totalAmount" } } }])
            .collect(),
    )
    .await
}

pub async fn resolve_current_member(
    headers: &axum::http::HeaderMap,
    db: &mongodb::Database,
) -> Option<CurrentMember> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = header.strip_prefix("Bearer ")?;
    let secret = std::env::var("JWT_SECRET").ok()?;
    let decoded = jsonwebtoken::decode::<HashMap<String, serde_json::Value>>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    )
    .ok()?;
    let user_id = decoded.claims.get("id")?.as_str()?;
    let user_id = ObjectId::parse_str(user_id).ok()?;
    let user = db
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "name": 1, "role": 1, "active": 1 })
        .await
        .ok()??;
    if read_string(&user, "role") != "member" || user.get_bool("active") == Ok(false) {
        return None;
    }
    Some(CurrentMember {
        id: user_id,
        name: read_string(&user, "name"),
    })
}

pub fn leaderboard_item_from_doc(
    doc: Document,
    rank: i64,
    current_member: Option<&CurrentMember>,
) -> LeaderboardItem {
    let id = doc.get_object_id("_id").map(|id| id.to_hex()).ok();
    LeaderboardItem {
        is_current_user: current_member
            .map(|member| Some(member.id.to_hex()) == id)
            .unwrap_or(false),
        id,
        name: read_string(&doc, "name"),
        level: read_string(&doc, "level"),
        total_transactions: read_i64(&doc, "totalTransactions"),
        total_amount: read_i64(&doc, "totalAmount"),
        rank,
    }
}

pub async fn current_user(
    db: &mongodb::Database,
    period: &str,
    current_member: Option<&CurrentMember>,
    items: &[LeaderboardItem],
    base_pipeline: &[Document],
) -> Option<CurrentUser> {
    let member = current_member?;
    let mut filter = doc! { "status": "success", "user": member.id };
    if let Some(start) = period_start(period) {
        filter.insert("createdAt", doc! { "$gte": start });
    }
    let totals = aggregate_docs(
        db,
        vec![
            doc! { "$match": filter },
            doc! { "$group": { "_id": "$user", "totalTransactions": { "$sum": 1 }, "totalAmount": { "$sum": "$amount" } } },
        ],
    )
    .await;
    let total = totals.first()?;
    let current_total_amount = read_i64(total, "totalAmount");
    let current_total_transactions = read_i64(total, "totalTransactions");
    let higher = aggregate_docs(
        db,
        base_pipeline
            .iter()
            .cloned()
            .chain([
                doc! { "$match": { "$or": [ { "totalAmount": { "$gt": current_total_amount } }, { "totalAmount": current_total_amount, "totalTransactions": { "$gt": current_total_transactions } } ] } },
                doc! { "$count": "count" },
            ])
            .collect(),
    )
    .await;
    let rank = higher
        .first()
        .map(|doc| read_i64(doc, "count"))
        .unwrap_or(0)
        + 1;
    let id = member.id.to_hex();
    Some(CurrentUser {
        id: id.clone(),
        name: member.name.clone(),
        rank,
        total_transactions: current_total_transactions,
        total_amount: current_total_amount,
        in_top_list: items.iter().any(|item| item.id.as_deref() == Some(&id)),
    })
}

pub fn read_i64_field(doc: &Document, key: &str) -> i64 {
    read_i64(doc, key)
}

async fn aggregate_docs(db: &mongodb::Database, pipeline: Vec<Document>) -> Vec<Document> {
    match db
        .collection::<Document>("transactions")
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn period_start(period: &str) -> Option<DateTime> {
    let now = Local::now();
    if period == "weekly" {
        let diff_to_monday = i64::from(now.weekday().num_days_from_monday());
        let date = now.date_naive() - chrono::Duration::days(diff_to_monday);
        return Local
            .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
            .single()
            .map(|value| DateTime::from_millis(value.timestamp_millis()));
    }
    if period == "monthly" {
        let date = chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)?;
        return Local
            .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
            .single()
            .map(|value| DateTime::from_millis(value.timestamp_millis()));
    }
    None
}
