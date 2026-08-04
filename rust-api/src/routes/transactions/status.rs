use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::ReturnDocument,
};

use crate::utils::bson::{read_i64, read_string};

use super::{bson_number_to_i64, StatusUpdateError, TransactionStatusSnapshot, TransitionPlan};

pub(super) fn apply_transition_plan(
    current_status: &str,
    refunded: bool,
    amount: i64,
    next_status: &str,
) -> TransitionPlan {
    let mut balance_delta = 0;
    let mut next_refunded = refunded;

    if next_status == "failed" && !refunded {
        balance_delta = amount;
        next_refunded = true;
    } else if next_status != "failed" && refunded {
        balance_delta = -amount;
        next_refunded = false;
    }

    TransitionPlan {
        balance_delta,
        should_award_points: current_status != "success" && next_status == "success",
        should_revoke_points: current_status == "success" && next_status != "success",
        next_refunded,
    }
}

pub(super) async fn apply_user_balance_delta(
    users: &mongodb::Collection<Document>,
    user_id: ObjectId,
    delta: i64,
) -> Result<(), StatusUpdateError> {
    if delta == 0 {
        return Ok(());
    }

    if delta > 0 {
        let updated = users
            .find_one_and_update(
                doc! { "_id": user_id },
                doc! { "$inc": { "balance": delta }, "$set": { "updatedAt": DateTime::now() } },
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(|_| StatusUpdateError::Internal)?;
        return if updated.is_some() {
            Ok(())
        } else {
            Err(StatusUpdateError::UserNotFound)
        };
    }

    let absolute_amount = -delta;
    let updated = users
        .find_one_and_update(
            doc! { "_id": user_id, "balance": { "$gte": absolute_amount } },
            doc! { "$inc": { "balance": delta }, "$set": { "updatedAt": DateTime::now() } },
        )
        .return_document(ReturnDocument::After)
        .await
        .map_err(|_| StatusUpdateError::Internal)?;
    if updated.is_some() {
        return Ok(());
    }

    let existing = users
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "_id": 1 })
        .await
        .map_err(|_| StatusUpdateError::Internal)?;
    if existing.is_none() {
        return Err(StatusUpdateError::UserNotFound);
    }

    Err(StatusUpdateError::InsufficientBalance(absolute_amount))
}

pub(super) async fn get_related_transaction_net_points(
    point_transactions: &mongodb::Collection<Document>,
    user_id: ObjectId,
    transaction_id: ObjectId,
) -> Result<i64, StatusUpdateError> {
    let result = point_transactions
        .aggregate(vec![
            doc! { "$match": { "user": user_id, "relatedTransaction": transaction_id } },
            doc! { "$group": { "_id": Bson::Null, "total": { "$sum": "$points" } } },
        ])
        .await
        .map_err(|_| StatusUpdateError::Internal)?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|_| StatusUpdateError::Internal)?
        .into_iter()
        .next();
    Ok(result
        .map(|document| read_i64(&document, "total"))
        .unwrap_or(0))
}

pub(super) async fn points_per_unit(
    settings: &mongodb::Collection<Document>,
) -> Result<i64, StatusUpdateError> {
    let setting = settings
        .find_one(doc! { "key": "points_per_transaction" })
        .await
        .map_err(|_| StatusUpdateError::Internal)?;
    let value = setting
        .as_ref()
        .and_then(|document| document.get("value"))
        .map(bson_number_to_i64)
        .unwrap_or(100);
    Ok(if value == 0 { 100 } else { value })
}

pub(super) async fn award_points(
    settings: &mongodb::Collection<Document>,
    users: &mongodb::Collection<Document>,
    point_transactions: &mongodb::Collection<Document>,
    user_id: ObjectId,
    transaction_amount: i64,
    transaction_id: ObjectId,
    description: &str,
) -> Result<i64, StatusUpdateError> {
    let existing_net_points =
        get_related_transaction_net_points(point_transactions, user_id, transaction_id).await?;
    if existing_net_points > 0 {
        return Ok(0);
    }

    let earned = (transaction_amount / 10_000) * points_per_unit(settings).await?;
    if earned <= 0 {
        return Ok(0);
    }

    apply_point_mutation(
        users,
        point_transactions,
        user_id,
        earned,
        "earn",
        description,
        transaction_id,
    )
    .await
}

pub(super) async fn revoke_awarded_points(
    users: &mongodb::Collection<Document>,
    point_transactions: &mongodb::Collection<Document>,
    user_id: ObjectId,
    transaction_id: ObjectId,
    description: &str,
) -> Result<i64, StatusUpdateError> {
    let net_points =
        get_related_transaction_net_points(point_transactions, user_id, transaction_id).await?;
    if net_points <= 0 {
        return Ok(0);
    }

    apply_point_mutation(
        users,
        point_transactions,
        user_id,
        -net_points,
        "admin_adjustment",
        description,
        transaction_id,
    )
    .await
}

pub(super) async fn apply_point_mutation(
    users: &mongodb::Collection<Document>,
    point_transactions: &mongodb::Collection<Document>,
    user_id: ObjectId,
    delta: i64,
    mutation_type: &str,
    description: &str,
    transaction_id: ObjectId,
) -> Result<i64, StatusUpdateError> {
    let abs_delta = delta.abs();
    if abs_delta <= 0 {
        return Ok(0);
    }

    let mut filter = doc! { "_id": user_id };
    if delta < 0 {
        filter.insert("points", doc! { "$gte": abs_delta });
    }
    let updated = users
        .find_one_and_update(
            filter,
            doc! { "$inc": { "points": delta }, "$set": { "updatedAt": DateTime::now() } },
        )
        .return_document(ReturnDocument::After)
        .await
        .map_err(|_| StatusUpdateError::Internal)?;
    if updated.is_none() {
        let existing = users
            .find_one(doc! { "_id": user_id })
            .projection(doc! { "_id": 1 })
            .await
            .map_err(|_| StatusUpdateError::Internal)?;
        return if existing.is_some() {
            Err(StatusUpdateError::InsufficientPoints)
        } else {
            Err(StatusUpdateError::UserNotFound)
        };
    }

    let now = DateTime::now();
    if point_transactions
        .insert_one(doc! {
            "user": user_id,
            "type": mutation_type,
            "points": delta,
            "description": description,
            "relatedTransaction": transaction_id,
            "createdAt": now,
            "updatedAt": now,
            "__v": 0,
        })
        .await
        .is_err()
    {
        let _ = users
            .update_one(
                doc! { "_id": user_id },
                doc! { "$inc": { "points": -delta }, "$set": { "updatedAt": DateTime::now() } },
            )
            .await;
        return Err(StatusUpdateError::Internal);
    }

    Ok(abs_delta)
}

pub(super) fn transaction_status_snapshot(
    document: &Document,
) -> Option<TransactionStatusSnapshot> {
    Some(TransactionStatusSnapshot {
        status: read_string(document, "status"),
        updated_at: *document.get_datetime("updatedAt").ok()?,
        refunded: document.get_bool("refunded").unwrap_or(false),
        vendor_trx_id: document
            .get_str("vendorTrxId")
            .ok()
            .map(ToString::to_string),
        sn: document.get_str("sn").ok().map(ToString::to_string),
        status_updated_by: document.get_object_id("statusUpdatedBy").ok(),
        status_updated_at: document.get_datetime("statusUpdatedAt").ok().copied(),
        status_update_note: document
            .get_str("statusUpdateNote")
            .ok()
            .map(ToString::to_string),
    })
}

pub(super) async fn rollback_transaction_status(
    transactions: &mongodb::Collection<Document>,
    transaction_id: ObjectId,
    snapshot: &TransactionStatusSnapshot,
) {
    let mut set_fields = doc! {
        "status": &snapshot.status,
        "refunded": snapshot.refunded,
        "updatedAt": snapshot.updated_at,
    };
    let mut unset_fields = Document::new();
    insert_optional_string_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "vendorTrxId",
        snapshot.vendor_trx_id.as_deref(),
    );
    insert_optional_string_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "sn",
        snapshot.sn.as_deref(),
    );
    insert_optional_object_id_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "statusUpdatedBy",
        snapshot.status_updated_by,
    );
    insert_optional_datetime_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "statusUpdatedAt",
        snapshot.status_updated_at,
    );
    insert_optional_string_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "statusUpdateNote",
        snapshot.status_update_note.as_deref(),
    );

    let mut update = doc! { "$set": set_fields };
    if !unset_fields.is_empty() {
        update.insert("$unset", unset_fields);
    }
    let _ = transactions
        .update_one(doc! { "_id": transaction_id }, update)
        .await;
}

pub(super) fn apply_optional_payload_string(
    set_fields: &mut Document,
    unset_fields: &mut Document,
    key: &str,
    value: &Option<String>,
) {
    if let Some(value) = value {
        if value.is_empty() {
            unset_fields.insert(key, 1);
        } else {
            set_fields.insert(key, value.clone());
        }
    }
}

pub(super) fn insert_optional_object_id_or_unset(
    set_fields: &mut Document,
    unset_fields: &mut Document,
    key: &str,
    value: Option<ObjectId>,
) {
    if let Some(value) = value {
        set_fields.insert(key, value);
    } else {
        unset_fields.insert(key, 1);
    }
}

pub(super) fn insert_optional_datetime_or_unset(
    set_fields: &mut Document,
    unset_fields: &mut Document,
    key: &str,
    value: Option<DateTime>,
) {
    if let Some(value) = value {
        set_fields.insert(key, value);
    } else {
        unset_fields.insert(key, 1);
    }
}

pub(super) fn insert_optional_string_or_unset(
    set_fields: &mut Document,
    unset_fields: &mut Document,
    key: &str,
    value: Option<&str>,
) {
    if let Some(value) = value {
        set_fields.insert(key, value);
    } else {
        unset_fields.insert(key, 1);
    }
}
