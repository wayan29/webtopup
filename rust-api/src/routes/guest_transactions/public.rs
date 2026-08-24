use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    ClientSession,
};
use rand::Rng;

use crate::{
    routes::auth,
    security::ErrorResponse,
    services::{
        bot_protection::{
            cloudflare_turnstile_verifier, enforce_turnstile, kill_switch_enabled,
            load_bot_protection_settings,
        },
        identifier_integrity::{
            classify_invoice_duplicate, require_identifier_indexes, retry_invoice_candidate,
            DuplicateConstraint, MAX_INVOICE_CANDIDATES,
        },
        idempotency::{
            self as idempotency_service, commit_mongo_transaction_with_unknown_retry,
            CompletedSnapshot, DomainMarkerRecovery, DomainRecovery, IdempotencyBegin,
            IdempotencyStore, MongoIdempotencyStore, TransactionCommitOutcome, ROUTE_GUEST_CHECKOUT,
        },
    },
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::*;
use super::idempotency::{
    digest_guest_idempotency_key, execute_after_bounded_response, guest_checkout_digest,
    GuestCheckoutFingerprint, ANONYMOUS_GUEST_ACTOR,
};

const GUEST_CREATE_MESSAGE: &str = "Transaction created, please complete payment";

#[derive(Clone)]
struct NormalizedGuestCreate {
    product_code: String,
    target: String,
    server_id: String,
    whatsapp: String,
    email: String,
    payment_method_id: String,
    use_flash_sale: bool,
    voucher_code: String,
}

impl NormalizedGuestCreate {
    fn from_payload(payload: &GuestCreatePayload) -> Self {
        Self {
            product_code: normalize_payload_text(payload.product_code.as_deref()),
            target: normalize_payload_text(payload.target.as_deref()),
            server_id: normalize_payload_text(payload.server_id.as_deref()),
            whatsapp: normalize_phone(payload.whatsapp.as_deref()),
            email: normalize_payload_text(payload.email.as_deref()),
            payment_method_id: normalize_payload_text(payload.payment_method_id.as_deref()),
            use_flash_sale: payload.use_flash_sale.unwrap_or(false),
            voucher_code: normalize_payload_text(payload.voucher_code.as_deref()).to_uppercase(),
        }
    }

    fn required_fields_present(&self) -> bool {
        !self.product_code.is_empty()
            && !self.target.is_empty()
            && !self.whatsapp.is_empty()
            && !self.payment_method_id.is_empty()
    }
}

pub async fn create_public(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<GuestCreatePayload>,
) -> Response {
    let raw_key = match idempotency_service::require_idempotency_key(&headers) {
        Ok(Some(key)) => key,
        Ok(None) | Err(idempotency_service::IdempotencyError::MissingKey) => {
            return idempotency_service::IdempotencyError::MissingKey.into_response()
        }
        Err(error) => return error.into_response(),
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    if !state.mongo_transactions_enabled {
        return guest_atomicity_unavailable();
    }
    let db = client.database(&state.mongo_db);
    if let Some(message) = active_maintenance_message(&db).await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(OwnedErrorResponse { message }),
        )
            .into_response();
    }
    if !guest_checkout_enabled(&db).await {
        return status_message(StatusCode::FORBIDDEN, "Guest checkout sedang dinonaktifkan");
    }

    let normalized = NormalizedGuestCreate::from_payload(&payload);
    if !normalized.required_fields_present() {
        return status_message(StatusCode::BAD_REQUEST, "Missing required fields");
    }

    let member = auth::resolve_optional_member_access(&headers, &state).await;
    let hmac_key = state.session_token_hash_secret.as_bytes();
    let stored_key = digest_guest_idempotency_key(hmac_key, &raw_key);
    drop(raw_key);
    let request_digest = guest_checkout_digest(
        hmac_key,
        &GuestCheckoutFingerprint {
            product_code: &normalized.product_code,
            target: &normalized.target,
            server_id: &normalized.server_id,
            whatsapp: &normalized.whatsapp,
            email: &normalized.email,
            payment_method_id: &normalized.payment_method_id,
            use_flash_sale: normalized.use_flash_sale,
            voucher_code: &normalized.voucher_code,
            member_id: member.as_ref().map(|access| access.user_id),
        },
    );

    let transactions = db.collection::<Document>("guesttransactions");
    let store = MongoIdempotencyStore::new(&db);
    let recovery = GuestMarkerRecovery {
        transactions: &transactions,
    };
    let lease_generation = match idempotency_service::begin_with_recovery(
        &store,
        &recovery,
        ANONYMOUS_GUEST_ACTOR,
        ROUTE_GUEST_CHECKOUT,
        &stored_key,
        &request_digest,
        DateTime::now(),
    )
    .await
    {
        Ok(IdempotencyBegin::Started { lease_generation }) => lease_generation,
        Ok(IdempotencyBegin::Completed { status, body }) => {
            return idempotency_service::completed_response(status, body)
        }
        Ok(IdempotencyBegin::Conflict) => return idempotency_service::conflict_response(),
        Ok(IdempotencyBegin::InProgress) => return idempotency_service::in_progress_response(),
        Err(error) => return error.into_response(),
    };

    let (stored_enabled, site_key) = load_bot_protection_settings(&db).await;
    let secret = std::env::var("TURNSTILE_SECRET_KEY").unwrap_or_default();
    let kill_switch = kill_switch_enabled(std::env::var("TURNSTILE_DISABLED").ok().as_deref());
    let remote_ip = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    if let Err(response) = enforce_turnstile(
        stored_enabled,
        &site_key,
        &secret,
        kill_switch,
        payload.turnstile_token.as_deref(),
        Some(remote_ip),
        cloudflare_turnstile_verifier(),
    )
    .await
    {
        release_guest_started(
            &store,
            &stored_key,
            &request_digest,
            lease_generation,
        )
        .await;
        return response;
    }

    // Guest checkout has no standalone marker that can prove an absent transaction was never
    // committed. Before any domain work, turn the short execution lease into an indefinite fence.
    // Known pre-effect failures delete it; success completes it; ambiguous work can only recover
    // from the durable transaction marker and can never lease-takeover into a second mutation.
    if let Err(error) = store
        .retain_uncertain_started(
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            &stored_key,
            &request_digest,
            lease_generation,
        )
        .await
    {
        release_guest_started(
            &store,
            &stored_key,
            &request_digest,
            lease_generation,
        )
        .await;
        return error.into_response();
    }

    let prepared = match prepare_guest_checkout(&db, &normalized, member.as_ref()).await {
        Ok(prepared) => prepared,
        Err(response) => {
            release_guest_started(
            &store,
            &stored_key,
            &request_digest,
            lease_generation,
        )
        .await;
            return response;
        }
    };

    let execution = execute_guest_checkout_transaction(
        client,
        &db,
        &normalized,
        member.as_ref().map(|access| access.user_id),
        &prepared,
        &stored_key,
        &request_digest,
    )
    .await;
    let (transaction_id, response_body) = match execution {
        Ok(result) => result,
        Err(GuestExecutionError::PreEffect(response)) => {
            release_guest_started(
            &store,
            &stored_key,
            &request_digest,
            lease_generation,
        )
        .await;
            return response;
        }
        Err(GuestExecutionError::Ambiguous(response)) => return response,
    };

    let snapshot = CompletedSnapshot {
        status: StatusCode::CREATED.as_u16(),
        body: response_body.clone(),
        resource_id: Some(transaction_id.to_hex()),
    };
    // Isolated local verification only: transaction and frozen marker are durable, while the
    // orchestration row intentionally remains started so the retry must execute GuestMarkerRecovery.
    if crate::services::local_fault::consume_guest_post_commit_fault().await {
        return guest_ambiguous_response();
    }
    if let Err(error) = store
        .complete(
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            &stored_key,
            &request_digest,
            lease_generation,
            &snapshot,
            DateTime::now(),
        )
        .await
    {
        eprintln!("Failed to finalize guest checkout idempotency record: {error:?}");
        return error.into_response();
    }
    idempotency_service::completed_response(snapshot.status, response_body)
}

struct PreparedGuestCheckout {
    product: Document,
    payment_method: Document,
    base_price: i64,
}

async fn prepare_guest_checkout(
    db: &mongodb::Database,
    normalized: &NormalizedGuestCreate,
    member: Option<&auth::access_session::OptionalMemberAccess>,
) -> Result<PreparedGuestCheckout, Response> {
    let Some(product) = (match db
        .collection::<Document>("products")
        .find_one(doc! { "code": &normalized.product_code })
        .await
    {
        Ok(value) => value,
        Err(_) => return Err(internal_error()),
    }) else {
        return Err(status_message(StatusCode::NOT_FOUND, "Product not found"));
    };
    if product.get_bool("status").ok() == Some(false) {
        return Err(status_message(StatusCode::BAD_REQUEST, "Product is unavailable"));
    }
    let purchase_issues = product_purchase_issues(db, &product).await;
    if !purchase_issues.is_empty() {
        return Err(status_message_owned(
            StatusCode::BAD_REQUEST,
            format!(
                "Produk tidak tersedia untuk dibeli: {}",
                purchase_issues.join(", ")
            ),
        ));
    }

    let Ok(payment_method_id) = ObjectId::parse_str(&normalized.payment_method_id) else {
        return Err(status_message(
            StatusCode::NOT_FOUND,
            "Payment method not found",
        ));
    };
    let Some(payment_method) = (match db
        .collection::<Document>("paymentmethods")
        .find_one(doc! { "_id": payment_method_id })
        .await
    {
        Ok(value) => value,
        Err(_) => return Err(internal_error()),
    }) else {
        return Err(status_message(
            StatusCode::NOT_FOUND,
            "Payment method not found",
        ));
    };
    if read_string_default(&payment_method, "status", "active") != "active" {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Payment method is not available",
        ));
    }
    let Some(category) = resolve_payment_category(db, &payment_method).await else {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Payment category is not available",
        ));
    };
    if read_string_default(&category, "status", "active") != "active" {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Payment category is not available",
        ));
    }
    let operational_start = read_string_default(&payment_method, "operationalStart", "00:00");
    let operational_end = read_string_default(&payment_method, "operationalEnd", "23:59");
    if !is_operational_now(&operational_start, &operational_end) {
        return Err(status_message_owned(
            StatusCode::BAD_REQUEST,
            format!(
                "Payment method is available only between {operational_start} and {operational_end}"
            ),
        ));
    }
    if !is_bank_transfer_category(&category) {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Only bank transfer is allowed for guest checkout",
        ));
    }
    let user_level = member.map(|access| access.level.as_str()).unwrap_or("basic");
    Ok(PreparedGuestCheckout {
        base_price: product_price_for_level(&product, user_level),
        product,
        payment_method,
    })
}

enum GuestExecutionError {
    PreEffect(Response),
    Ambiguous(Response),
}

enum GuestDomainError {
    InvoiceDuplicate,
    PreEffect(Response),
}

async fn execute_guest_checkout_transaction(
    client: &mongodb::Client,
    db: &mongodb::Database,
    normalized: &NormalizedGuestCreate,
    member_id: Option<ObjectId>,
    prepared: &PreparedGuestCheckout,
    stored_key: &str,
    request_digest: &str,
) -> Result<(ObjectId, serde_json::Value), GuestExecutionError> {
    if require_identifier_indexes(db).await.is_err() {
        return Err(GuestExecutionError::PreEffect(identifier_index_unavailable()));
    }

    for attempt in 0..MAX_INVOICE_CANDIDATES {
        let mut session = client.start_session().await.map_err(|error| {
            eprintln!("Failed to start guest checkout Mongo session: {error}");
            GuestExecutionError::PreEffect(internal_error())
        })?;
        session.start_transaction().await.map_err(|error| {
            eprintln!("Failed to start guest checkout Mongo transaction: {error}");
            GuestExecutionError::PreEffect(guest_atomicity_unavailable())
        })?;

        let domain_result = build_and_insert_guest_transaction(
            db,
            &mut session,
            normalized,
            member_id,
            prepared,
            stored_key,
            request_digest,
        )
        .await;

        match domain_result {
            Ok(result) => {
                return match commit_mongo_transaction_with_unknown_retry(&mut session).await {
                    TransactionCommitOutcome::Committed => Ok(result),
                    TransactionCommitOutcome::Ambiguous
                    | TransactionCommitOutcome::FailedDefinitely => {
                        eprintln!(
                            "Guest checkout commit was not positively acknowledged; retaining started"
                        );
                        Err(GuestExecutionError::Ambiguous(guest_ambiguous_response()))
                    }
                };
            }
            Err(GuestDomainError::InvoiceDuplicate) => {
                if session.abort_transaction().await.is_err() {
                    eprintln!(
                        "Guest checkout abort after invoice collision failed; retaining started"
                    );
                    return Err(GuestExecutionError::Ambiguous(guest_ambiguous_response()));
                }
                if !retry_invoice_candidate(attempt, DuplicateConstraint::InvoiceNumber) {
                    break;
                }
                continue;
            }
            Err(GuestDomainError::PreEffect(response)) => {
                if session.abort_transaction().await.is_ok() {
                    return Err(GuestExecutionError::PreEffect(response));
                }
                eprintln!(
                    "Guest checkout transaction abort failed; retaining started for recovery"
                );
                return Err(GuestExecutionError::Ambiguous(guest_ambiguous_response()));
            }
        }
    }

    Err(GuestExecutionError::PreEffect(invoice_identifier_exhausted()))
}

async fn build_and_insert_guest_transaction(
    db: &mongodb::Database,
    session: &mut ClientSession,
    normalized: &NormalizedGuestCreate,
    member_id: Option<ObjectId>,
    prepared: &PreparedGuestCheckout,
    stored_key: &str,
    request_digest: &str,
) -> Result<(ObjectId, serde_json::Value), GuestDomainError> {
    // First durable domain write is the invoice reservation so collisions abort before
    // flash-sale / voucher side effects.
    let invoice_number = generate_invoice_number(db)
        .await
        .map_err(|_| GuestDomainError::PreEffect(internal_error()))?;
    let transaction_id = ObjectId::new();
    let now = DateTime::now();
    let skeleton = doc! {
        "_id": transaction_id,
        "invoiceNumber": &invoice_number,
        "creationState": "invoice_reserved",
        "idempotencyRoute": ROUTE_GUEST_CHECKOUT,
        "idempotencyKey": stored_key,
        "idempotencyRequestDigest": request_digest,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    if let Err(error) = db
        .collection::<Document>("guesttransactions")
        .insert_one(skeleton)
        .session(&mut *session)
        .await
    {
        if classify_invoice_duplicate(&error) {
            return Err(GuestDomainError::InvoiceDuplicate);
        }
        eprintln!("Failed guest invoice reservation insert: {error}");
        return Err(GuestDomainError::PreEffect(internal_error()));
    }

    let preview_flash_price = if normalized.use_flash_sale {
        preview_flash_sale_price_in_session(
            db,
            session,
            prepared.product.get_object_id("_id").ok(),
            prepared.base_price,
        )
        .await
        .map_err(|error| {
            eprintln!("Failed guest flash-sale preview in transaction: {error}");
            GuestDomainError::PreEffect(internal_error())
        })?
    } else {
        None
    };
    let mut price = preview_flash_price.unwrap_or(prepared.base_price);
    let mut applied_discount = None;
    if !normalized.voucher_code.is_empty() {
        let vouchers = db.collection::<Document>("vouchers");
        let product_ctx = crate::routes::vouchers::DiscountProductContext {
            product_id: prepared.product.get_object_id("_id").ok(),
            category_id: prepared.product.get_object_id("categoryId").ok(),
            operator_id: prepared.product.get_object_id("operatorId").ok(),
        };
        match crate::routes::vouchers::consume_discount_voucher(
            &vouchers,
            &normalized.voucher_code,
            price,
            member_id,
            &product_ctx,
        )
        .await
        {
            Ok(applied) => {
                price = applied.final_price;
                applied_discount = Some(applied);
            }
            Err(response) => return Err(GuestDomainError::PreEffect(response)),
        }
    }
    let admin_fee = read_i64(&prepared.payment_method, "adminFee")
        + ((price as f64 * read_f64(&prepared.payment_method, "adminPercent") / 100.0).ceil()
            as i64);
    let unique_code = rand::thread_rng().gen_range(100..=999);
    let total_amount = price + admin_fee + unique_code;
    let min_amount = read_i64_default(&prepared.payment_method, "minAmount", 10_000);
    let max_amount = read_i64_default(&prepared.payment_method, "maxAmount", 5_000_000);
    if total_amount < min_amount {
        if let Some(applied) = applied_discount.as_ref() {
            let vouchers = db.collection::<Document>("vouchers");
            crate::routes::vouchers::release_discount_slot(&vouchers, applied, member_id).await;
        }
        return Err(GuestDomainError::PreEffect(status_message_owned(
            StatusCode::BAD_REQUEST,
            format!("Minimum amount is Rp {}", format_rupiah(min_amount)),
        )));
    }
    if total_amount > max_amount {
        if let Some(applied) = applied_discount.as_ref() {
            let vouchers = db.collection::<Document>("vouchers");
            crate::routes::vouchers::release_discount_slot(&vouchers, applied, member_id).await;
        }
        return Err(GuestDomainError::PreEffect(status_message_owned(
            StatusCode::BAD_REQUEST,
            format!("Maximum amount is Rp {}", format_rupiah(max_amount)),
        )));
    }

    let expired_at = DateTime::from_millis(now.timestamp_millis() + 24 * 60 * 60 * 1000);
    let product_id = prepared
        .product
        .get_object_id("_id")
        .map_err(|_| GuestDomainError::PreEffect(internal_error()))?;
    let payment_method_id = prepared
        .payment_method
        .get_object_id("_id")
        .map_err(|_| GuestDomainError::PreEffect(internal_error()))?;
    let response = guest_response_from_frozen_documents(
        transaction_id,
        &invoice_number,
        product_id,
        &prepared.product,
        payment_method_id,
        &prepared.payment_method,
        member_id,
        normalized,
        price,
        admin_fee,
        unique_code,
        total_amount,
        now,
        expired_at,
    );
    let body = serde_json::to_value(&response)
        .map_err(|_| GuestDomainError::PreEffect(internal_error()))?;
    let encoded_body = execute_after_bounded_response(&body, || {}).map_err(|error| {
        eprintln!("Guest checkout frozen response exceeds replay bound: {error:?}");
        GuestDomainError::PreEffect(error.into_response())
    })?;

    // Snapshot is proven after invoice reservation and before stock mutations.
    let flash_sale_reservation = if normalized.use_flash_sale && preview_flash_price.is_some() {
        reserve_flash_sale_stock_in_session(
            db,
            session,
            prepared.product.get_object_id("_id").ok(),
            prepared.base_price,
        )
        .await
        .map_err(|error| {
            eprintln!("Failed guest flash-sale reservation in transaction: {error}");
            GuestDomainError::PreEffect(internal_error())
        })?
    } else {
        None
    };
    // Flash sale reservation is for stock; price may be further reduced by discount voucher.
    if let Some(reservation) = flash_sale_reservation.as_ref() {
        let expected_pre_discount = preview_flash_price.unwrap_or(prepared.base_price);
        if reservation.price != expected_pre_discount {
            if let Some(applied) = applied_discount.as_ref() {
                let vouchers = db.collection::<Document>("vouchers");
                crate::routes::vouchers::release_discount_slot(&vouchers, applied, member_id).await;
            }
            return Err(GuestDomainError::PreEffect(internal_error()));
        }
    }

    let mut document = doc! {
        "_id": transaction_id,
        "invoiceNumber": &invoice_number,
        "creationState": "complete",
        "product": product_id,
        "target": &normalized.target,
        "whatsapp": &normalized.whatsapp,
        "amount": price,
        "adminFee": admin_fee,
        "uniqueCode": unique_code,
        "totalAmount": total_amount,
        "paymentMethod": payment_method_id,
        "paymentStatus": "waiting_payment",
        "transactionStatus": "pending",
        "expiredAt": expired_at,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
        "idempotencyRoute": ROUTE_GUEST_CHECKOUT,
        "idempotencyKey": stored_key,
        "idempotencyRequestDigest": request_digest,
        "idempotencyResponseStatus": i32::from(StatusCode::CREATED.as_u16()),
        "idempotencyResponseBody": encoded_body,
    };
    if let Some(member_id) = member_id {
        document.insert("user", member_id);
    }
    if !normalized.server_id.is_empty() {
        document.insert("serverId", &normalized.server_id);
    }
    if !normalized.email.is_empty() {
        document.insert("email", &normalized.email);
    }
    if let Some(reservation) = flash_sale_reservation {
        document.insert("flashSale", reservation.flash_sale_id);
    }
    if let Some(applied) = applied_discount.as_ref() {
        document.insert("discountVoucherCode", &applied.code);
        document.insert("discountAmount", applied.discount_amount);
        document.insert("baseAmount", prepared.base_price);
    }
    // Replace the invoice reservation skeleton with the complete frozen document.
    db.collection::<Document>("guesttransactions")
        .replace_one(doc! { "_id": transaction_id }, document)
        .session(&mut *session)
        .await
        .map_err(|error| {
            eprintln!("Failed guest transaction finalize in Mongo transaction: {error}");
            GuestDomainError::PreEffect(internal_error())
        })?;
    Ok((transaction_id, body))
}

#[allow(clippy::too_many_arguments)]
fn guest_response_from_frozen_documents(
    transaction_id: ObjectId,
    invoice_number: &str,
    product_id: ObjectId,
    product: &Document,
    payment_method_id: ObjectId,
    payment_method: &Document,
    member_id: Option<ObjectId>,
    normalized: &NormalizedGuestCreate,
    amount: i64,
    admin_fee: i64,
    unique_code: i64,
    total_amount: i64,
    now: DateTime,
    expired_at: DateTime,
) -> GuestCreateResponse {
    GuestCreateResponse {
        message: GUEST_CREATE_MESSAGE,
        payment_info: GuestPaymentInfo {
            bank_name: read_string(payment_method, "name"),
            account_number: read_string(payment_method, "accountNumber"),
            account_name: read_string(payment_method, "accountName"),
            amount,
            admin_fee,
            unique_code,
            total_amount,
            expired_at: date_time_string(&expired_at),
        },
        transaction: GuestTransactionCheckItem {
            id: transaction_id.to_hex(),
            invoice_number: invoice_number.to_string(),
            user: member_id.map(|id| id.to_hex()),
            product: ProductCheckBrief {
                id: product_id.to_hex(),
                code: read_string(product, "code"),
                name: read_string(product, "name"),
            },
            target: normalized.target.clone(),
            server_id: (!normalized.server_id.is_empty()).then(|| normalized.server_id.clone()),
            whatsapp: normalized.whatsapp.clone(),
            email: (!normalized.email.is_empty()).then(|| normalized.email.clone()),
            amount,
            admin_fee,
            unique_code,
            total_amount,
            payment_method: PaymentMethodCheckBrief {
                id: payment_method_id.to_hex(),
                name: read_string(payment_method, "name"),
                category: object_id_string(payment_method, "category"),
                account_number: optional_string(payment_method, "accountNumber"),
                account_name: optional_string(payment_method, "accountName"),
            },
            payment_status: "waiting_payment".to_string(),
            transaction_status: "pending".to_string(),
            expired_at: date_time_string(&expired_at),
            created_at: date_time_string(&now),
            updated_at: date_time_string(&now),
            version: Some(0),
            paid_at: None,
            vendor_trx_id: None,
            sn: None,
            status_update_note: None,
            status_updated_at: None,
            status_updated_by: None,
        },
    }
}

struct GuestMarkerRecovery<'a> {
    transactions: &'a mongodb::Collection<Document>,
}

impl DomainMarkerRecovery for GuestMarkerRecovery<'_> {
    async fn recover(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
    ) -> DomainRecovery {
        if actor_id != ANONYMOUS_GUEST_ACTOR || route_key != ROUTE_GUEST_CHECKOUT {
            return DomainRecovery::None;
        }
        let marker = self
            .transactions
            .find_one(doc! {
                "idempotencyRoute": ROUTE_GUEST_CHECKOUT,
                "idempotencyKey": idempotency_key,
                "idempotencyRequestDigest": request_digest,
            })
            .await
            .ok()
            .flatten();
        let Some(marker) = marker else {
            return DomainRecovery::None;
        };
        let Some(body) = marker
            .get_str("idempotencyResponseBody")
            .ok()
            .and_then(|raw| serde_json::from_str(raw).ok())
        else {
            return DomainRecovery::EffectApplied { snapshot: None };
        };
        DomainRecovery::EffectApplied {
            snapshot: Some(CompletedSnapshot {
                status: marker
                    .get_i32("idempotencyResponseStatus")
                    .ok()
                    .and_then(|status| u16::try_from(status).ok())
                    .unwrap_or(StatusCode::CREATED.as_u16()),
                body,
                resource_id: marker.get_object_id("_id").ok().map(|id| id.to_hex()),
            }),
        }
    }
}

async fn release_guest_started(
    store: &MongoIdempotencyStore<'_>,
    stored_key: &str,
    request_digest: &str,
    lease_generation: u64,
) {
    let _ = store
        .release_started(
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            stored_key,
            request_digest,
            lease_generation,
        )
        .await;
}

fn guest_atomicity_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "message": "Guest checkout membutuhkan transaksi database",
            "error": {
                "code": "GUEST_CHECKOUT_ATOMICITY_UNAVAILABLE",
                "message": "Guest checkout membutuhkan transaksi database"
            }
        })),
    )
        .into_response()
}

fn identifier_index_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "message": "Index identifier belum siap",
            "error": {
                "code": "IDENTIFIER_INDEX_UNAVAILABLE",
                "message": "Index identifier belum siap"
            }
        })),
    )
        .into_response()
}

fn invoice_identifier_exhausted() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "message": "Nomor invoice sementara tidak tersedia",
            "error": {
                "code": "INVOICE_IDENTIFIER_EXHAUSTED",
                "message": "Nomor invoice sementara tidak tersedia"
            }
        })),
    )
        .into_response()
}

fn guest_ambiguous_response() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "message": "Status guest checkout belum dapat dipastikan. Coba ulang dengan Idempotency-Key yang sama.",
            "error": {
                "code": "GUEST_CHECKOUT_COMMIT_AMBIGUOUS",
                "message": "Status guest checkout belum dapat dipastikan. Coba ulang dengan Idempotency-Key yang sama."
            }
        })),
    )
        .into_response()
}

pub async fn check_public(
    State(state): State<Arc<AppState>>,
    Path(invoice_number): Path<String>,
    Query(query): Query<CheckGuestTransactionQuery>,
) -> Response {
    let normalized_whatsapp = normalize_phone(query.whatsapp.as_deref());
    if normalized_whatsapp.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Nomor WhatsApp wajib diisi untuk cek transaksi",
            }),
        )
            .into_response();
    }

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let pipeline = vec![
        doc! { "$match": { "invoiceNumber": invoice_number } },
        lookup_stage("products", "product", "product"),
        unwind_stage("$product"),
        lookup_stage("paymentmethods", "paymentMethod", "paymentMethod"),
        unwind_stage("$paymentMethod"),
        doc! { "$limit": 1 },
    ];

    let Some(document) = first_document(
        client
            .database(&state.mongo_db)
            .collection::<Document>("guesttransactions")
            .aggregate(pipeline)
            .await,
    )
    .await
    else {
        return transaction_not_found();
    };

    if normalize_phone(Some(&read_string(&document, "whatsapp"))) != normalized_whatsapp {
        return transaction_not_found();
    }

    match guest_transaction_check_from_doc(&document) {
        Some(item) => Json(item).into_response(),
        None => transaction_not_found(),
    }
}
