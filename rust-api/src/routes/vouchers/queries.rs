use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

use super::{mappers::object_id_from_bson, types::*};
use crate::utils::bson::{escape_regex, read_i64};

pub(super) async fn build_match(
    client: &mongodb::Client,
    db_name: &str,
    query: &VoucherQuery,
) -> Result<Document, &'static str> {
    let mut match_doc = Document::new();
    let mut and_clauses: Vec<Document> = Vec::new();
    let kind = query.kind.as_deref().map(str::trim).unwrap_or("balance");
    match kind {
        "" | "balance" => {
            // Legacy docs without kind are balance vouchers.
            and_clauses.push(doc! {
                "$or": [
                    { "kind": "balance" },
                    { "kind": { "$exists": false } },
                ]
            });
        }
        "discount" => {
            match_doc.insert("kind", "discount");
        }
        "all" => {}
        _ => return Err("Jenis voucher tidak valid"),
    }
    let status = query.status.as_deref().map(str::trim).unwrap_or_default();
    if !status.is_empty() {
        match status {
            "available" => {
                match_doc.insert("isArchived", false);
                match_doc.insert("isRedeemed", false);
            }
            "redeemed" => {
                match_doc.insert("isRedeemed", true);
            }
            "archived" => {
                match_doc.insert("isArchived", true);
            }
            _ => return Err("Status voucher tidak valid"),
        }
    }

    let start = super::validation::parse_date_boundary(query.start_date.as_deref(), false)?;
    let end = super::validation::parse_date_boundary(query.end_date.as_deref(), true)?;
    if let (Some(start), Some(end)) = (start, end) {
        if start.timestamp_millis() > end.timestamp_millis() {
            return Err("Rentang tanggal voucher tidak valid");
        }
    }
    if start.is_some() || end.is_some() {
        let mut created_at = Document::new();
        if let Some(value) = start {
            created_at.insert("$gte", value);
        }
        if let Some(value) = end {
            created_at.insert("$lte", value);
        }
        match_doc.insert("createdAt", created_at);
    }

    let mut amount_range = Document::new();
    if let Some(min_amount) = query.min_amount.filter(|value| *value >= 0) {
        amount_range.insert("$gte", min_amount);
    }
    if let Some(max_amount) = query.max_amount.filter(|value| *value >= 0) {
        amount_range.insert("$lte", max_amount);
    }
    if let (Some(min_amount), Some(max_amount)) = (query.min_amount, query.max_amount) {
        if min_amount > max_amount {
            return Err("Rentang nominal voucher tidak valid");
        }
    }
    if !amount_range.is_empty() {
        match_doc.insert("amount", amount_range);
    }

    let search = query.search.as_deref().map(str::trim).unwrap_or_default();
    if !search.is_empty() {
        let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
        let user_ids = matched_user_ids(client, db_name, regex.clone()).await;
        and_clauses.push(doc! {
            "$or": [
                { "code": regex },
                { "redeemedBy": { "$in": user_ids.clone() } },
                { "createdBy": { "$in": user_ids.clone() } },
                { "archivedBy": { "$in": user_ids } },
            ]
        });
    }
    if !and_clauses.is_empty() {
        match_doc.insert("$and", and_clauses);
    }

    Ok(match_doc)
}

pub(super) async fn voucher_summary(
    collection: &mongodb::Collection<Document>,
    match_doc: Document,
) -> VoucherSummary {
    match collection
        .aggregate(vec![
            doc! { "$match": match_doc },
            doc! { "$group": {
                "_id": Bson::Null,
                "total": { "$sum": 1 },
                "totalAmount": { "$sum": "$amount" },
                "available": { "$sum": { "$cond": [ { "$and": [ { "$eq": ["$isRedeemed", false] }, { "$eq": ["$isArchived", false] } ] }, 1, 0 ] } },
                "redeemed": { "$sum": { "$cond": [ { "$eq": ["$isRedeemed", true] }, 1, 0 ] } },
                "archived": { "$sum": { "$cond": [ { "$eq": ["$isArchived", true] }, 1, 0 ] } },
            } },
        ])
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .first()
            .map(|doc| VoucherSummary {
                total: read_i64(doc, "total"),
                total_amount: read_i64(doc, "totalAmount"),
                available: read_i64(doc, "available"),
                redeemed: read_i64(doc, "redeemed"),
                archived: read_i64(doc, "archived"),
            })
            .unwrap_or_default(),
        Err(_) => VoucherSummary::default(),
    }
}

async fn matched_user_ids(
    client: &mongodb::Client,
    db_name: &str,
    regex: Document,
) -> Vec<ObjectId> {
    match client
        .database(db_name)
        .collection::<Document>("users")
        .find(doc! { "$or": [ { "name": regex.clone() }, { "email": regex } ] })
        .limit(50)
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|doc| object_id_from_bson(doc.get("_id")))
            .collect(),
        Err(_) => Vec::new(),
    }
}
