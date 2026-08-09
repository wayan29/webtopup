use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use mongodb::bson::oid::ObjectId;
use sha2::Sha256;

use crate::services::idempotency::{self as service, ROUTE_GUEST_CHECKOUT};

type HmacSha256 = Hmac<Sha256>;

pub(super) const ANONYMOUS_GUEST_ACTOR: ObjectId = ObjectId::from_bytes([0; 12]);

#[derive(Clone, Copy)]
pub(super) struct GuestCheckoutFingerprint<'a> {
    pub(super) product_code: &'a str,
    pub(super) target: &'a str,
    pub(super) server_id: &'a str,
    pub(super) whatsapp: &'a str,
    pub(super) email: &'a str,
    pub(super) payment_method_id: &'a str,
    pub(super) use_flash_sale: bool,
    pub(super) voucher_code: &'a str,
    pub(super) member_id: Option<ObjectId>,
}

pub(super) fn guest_checkout_digest(
    hmac_key: &[u8],
    fingerprint: &GuestCheckoutFingerprint<'_>,
) -> String {
    let flash_sale = if fingerprint.use_flash_sale { "true" } else { "false" };
    let member_id = fingerprint
        .member_id
        .map(|id| id.to_hex())
        .unwrap_or_default();
    guest_v2_digest(
        hmac_key,
        ROUTE_GUEST_CHECKOUT,
        &[
            fingerprint.product_code,
            fingerprint.target,
            fingerprint.server_id,
            fingerprint.whatsapp,
            fingerprint.email,
            fingerprint.payment_method_id,
            flash_sale,
            fingerprint.voucher_code,
            &member_id,
        ],
    )
}

pub(super) fn digest_guest_idempotency_key(hmac_key: &[u8], raw_key: &str) -> String {
    guest_v2_digest(hmac_key, "idempotency-key.storage", &[raw_key])
}

fn guest_v2_digest(hmac_key: &[u8], route_key: &str, parts: &[&str]) -> String {
    let mut mac = HmacSha256::new_from_slice(hmac_key).expect("HMAC accepts keys of any size");
    mac.update(b"guest-idempotency:v2");
    update_length_prefixed(&mut mac, route_key.as_bytes());
    for part in parts {
        update_length_prefixed(&mut mac, part.as_bytes());
    }
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn update_length_prefixed(mac: &mut HmacSha256, bytes: &[u8]) {
    mac.update(&(bytes.len() as u64).to_be_bytes());
    mac.update(bytes);
}

pub(super) fn execute_after_bounded_response(
    body: &serde_json::Value,
    execute: impl FnOnce(),
) -> Result<String, service::IdempotencyError> {
    let encoded = service::bound_response_body(body)?;
    execute();
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    };

    use mongodb::bson::{oid::ObjectId, DateTime};

    use super::{
        digest_guest_idempotency_key, guest_checkout_digest, GuestCheckoutFingerprint,
        ANONYMOUS_GUEST_ACTOR,
    };
    use crate::services::idempotency::{
        begin_with_recovery, CompletedSnapshot, DomainMarkerRecovery, DomainRecovery,
        IdempotencyBegin, IdempotencyStore, MemoryIdempotencyStore, ROUTE_GUEST_CHECKOUT,
    };

    struct NoMarker;

    impl DomainMarkerRecovery for NoMarker {
        async fn recover(
            &self,
            _actor_id: ObjectId,
            _route_key: &str,
            _idempotency_key: &str,
            _request_digest: &str,
        ) -> DomainRecovery {
            DomainRecovery::None
        }
    }

    struct DurableMarker {
        body: serde_json::Value,
    }

    impl DomainMarkerRecovery for DurableMarker {
        async fn recover(
            &self,
            _actor_id: ObjectId,
            _route_key: &str,
            _idempotency_key: &str,
            _request_digest: &str,
        ) -> DomainRecovery {
            DomainRecovery::EffectApplied {
                snapshot: Some(CompletedSnapshot {
                    status: 201,
                    body: self.body.clone(),
                    resource_id: Some("transaction-1".to_string()),
                }),
            }
        }
    }

    fn now() -> DateTime {
        DateTime::from_millis(1_800_000_000_000)
    }

    fn fixture<'a>() -> GuestCheckoutFingerprint<'a> {
        GuestCheckoutFingerprint {
            product_code: "FF-100",
            target: "123456789",
            server_id: "zone-1",
            whatsapp: "628123456789",
            email: "buyer@example.com",
            payment_method_id: "507f1f77bcf86cd799439011",
            use_flash_sale: true,
            voucher_code: "",
            member_id: Some(ObjectId::from_bytes([7; 12])),
        }
    }

    fn digest(input: &GuestCheckoutFingerprint<'_>) -> String {
        guest_checkout_digest(b"fingerprint-secret", input)
    }

    #[test]
    fn guest_checkout_fingerprint_covers_every_order_input() {
        let baseline_fixture = fixture();
        let baseline = digest(&baseline_fixture);
        let member = ObjectId::from_bytes([8; 12]);
        let variants = [
            GuestCheckoutFingerprint {
                product_code: "FF-200",
                ..fixture()
            },
            GuestCheckoutFingerprint {
                target: "987654321",
                ..fixture()
            },
            GuestCheckoutFingerprint {
                server_id: "zone-2",
                ..fixture()
            },
            GuestCheckoutFingerprint {
                whatsapp: "628987654321",
                ..fixture()
            },
            GuestCheckoutFingerprint {
                email: "other@example.com",
                ..fixture()
            },
            GuestCheckoutFingerprint {
                payment_method_id: "507f1f77bcf86cd799439012",
                ..fixture()
            },
            GuestCheckoutFingerprint {
                use_flash_sale: false,
                ..fixture()
            },
            GuestCheckoutFingerprint {
                member_id: Some(member),
                ..fixture()
            },
            GuestCheckoutFingerprint {
                member_id: None,
                ..fixture()
            },
        ];
        for variant in variants {
            assert_ne!(baseline, digest(&variant));
        }
    }

    #[test]
    fn guest_checkout_fingerprint_framing_rejects_embedded_nul_collisions() {
        let left = GuestCheckoutFingerprint {
            product_code: "a\0b",
            target: "c",
            ..fixture()
        };
        let right = GuestCheckoutFingerprint {
            product_code: "a",
            target: "b\0c",
            ..fixture()
        };
        assert_ne!(digest(&left), digest(&right));
    }

    #[test]
    fn post_commit_fault_seam_is_guarded_one_shot_and_before_completion() {
        let source = include_str!("public.rs");
        let seam = source.find("consume_guest_post_commit_fault").expect("fault seam");
        let complete = source.find(".complete(").expect("idempotency completion");
        assert!(seam < complete, "fault seam must run before idempotency completion");
        let guard = include_str!("../../services/local_fault.rs");
        assert!(guard.contains("LOCAL_DESTRUCTIVE_CAPABILITY"));
        assert!(guard.contains("LOCAL_DEV_VERIFICATION"));
    }

    #[test]
    fn guest_checkout_marker_index_is_unique_and_partial() {
        let model = crate::services::idempotency::guest_transaction_idempotency_index_model();
        let options = model.options.expect("index options");
        assert_eq!(options.unique, Some(true));
        assert_eq!(
            model.keys,
            mongodb::bson::doc! {
                "idempotencyRoute": 1,
                "idempotencyKey": 1,
                "idempotencyRequestDigest": 1,
            }
        );
        let partial = options.partial_filter_expression.expect("partial filter");
        assert_eq!(partial.get_str("idempotencyRoute").unwrap(), ROUTE_GUEST_CHECKOUT);
    }

    #[test]
    fn raw_idempotency_key_is_hmac_digested_before_storage() {
        let raw = "550e8400-e29b-41d4-a716-446655440000";
        let stored = digest_guest_idempotency_key(b"secret", raw);
        assert_ne!(stored, raw);
        assert!(!stored.contains(raw));
        assert_eq!(stored, digest_guest_idempotency_key(b"secret", raw));
        assert_ne!(stored, digest_guest_idempotency_key(b"other-secret", raw));
    }

    #[tokio::test]
    async fn guest_checkout_first_request_completes_and_replays_exact_201_for_24_hours() {
        let store = MemoryIdempotencyStore::new();
        let key = "stored-key-digest";
        let digest = "request-digest";
        let body = serde_json::json!({
            "message": "Transaction created, please complete payment",
            "transaction": { "invoiceNumber": "INV-EXACT" },
            "paymentInfo": { "totalAmount": 10123 }
        });
        let first = begin_with_recovery(
            &store,
            &NoMarker,
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(first, IdempotencyBegin::Started { lease_generation: 1 }));
        store
            .complete(
                ANONYMOUS_GUEST_ACTOR,
                ROUTE_GUEST_CHECKOUT,
                key,
                digest,
                1,
                &CompletedSnapshot {
                    status: 201,
                    body: body.clone(),
                    resource_id: Some("transaction-1".to_string()),
                },
                now(),
            )
            .await
            .unwrap();
        assert_eq!(
            store.row_cleanup_at_ms(ANONYMOUS_GUEST_ACTOR, ROUTE_GUEST_CHECKOUT, key),
            Some(now().timestamp_millis() + 24 * 60 * 60 * 1000)
        );
        match begin_with_recovery(
            &store,
            &NoMarker,
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            key,
            digest,
            now(),
        )
        .await
        .unwrap()
        {
            IdempotencyBegin::Completed { status, body: replay } => {
                assert_eq!(status, 201);
                assert_eq!(replay, body);
            }
            other => panic!("expected exact replay, got {other:?}"),
        }
        let conflict = begin_with_recovery(
            &store,
            &NoMarker,
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            key,
            "changed-request-digest",
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(conflict, IdempotencyBegin::Conflict));
    }

    #[tokio::test]
    async fn stale_generation_release_cannot_delete_takeover_or_admit_different_digest() {
        let store = MemoryIdempotencyStore::new();
        let key = "stale-release-key";
        let digest = "first-digest";
        let first = store
            .begin(
                ANONYMOUS_GUEST_ACTOR,
                ROUTE_GUEST_CHECKOUT,
                key,
                digest,
                now(),
            )
            .await
            .unwrap();
        assert!(matches!(first, IdempotencyBegin::Started { lease_generation: 1 }));
        store.force_lease_expired(
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            key,
            now().timestamp_millis() - 1,
        );
        let takeover = store
            .begin(
                ANONYMOUS_GUEST_ACTOR,
                ROUTE_GUEST_CHECKOUT,
                key,
                digest,
                now(),
            )
            .await
            .unwrap();
        assert!(matches!(takeover, IdempotencyBegin::Started { lease_generation: 2 }));
        store
            .release_started(
                ANONYMOUS_GUEST_ACTOR,
                ROUTE_GUEST_CHECKOUT,
                key,
                digest,
                1,
            )
            .await
            .unwrap();
        assert_eq!(
            store.row_status(ANONYMOUS_GUEST_ACTOR, ROUTE_GUEST_CHECKOUT, key).as_deref(),
            Some("started")
        );
        let contender = store
            .begin(
                ANONYMOUS_GUEST_ACTOR,
                ROUTE_GUEST_CHECKOUT,
                key,
                "different-digest",
                now(),
            )
            .await
            .unwrap();
        assert!(matches!(contender, IdempotencyBegin::Conflict));
    }

    #[test]
    fn oversized_frozen_response_is_rejected_before_guest_domain_execution() {
        use std::sync::atomic::{AtomicU32, Ordering};

        let mutations = AtomicU32::new(0);
        let oversized = serde_json::json!({
            "transaction": {
                "target": "x".repeat(20_000),
                "email": "y".repeat(20_000)
            }
        });
        let result = super::execute_after_bounded_response(&oversized, || {
            mutations.fetch_add(1, Ordering::SeqCst);
        });
        assert!(result.is_err());
        assert_eq!(mutations.load(Ordering::SeqCst), 0, "no stock/document mutation");
    }

    #[tokio::test]
    async fn six_concurrent_guest_begins_have_one_executor() {
        let store = Arc::new(MemoryIdempotencyStore::new());
        let started = Arc::new(AtomicU32::new(0));
        let waiting = Arc::new(AtomicU32::new(0));
        let mut tasks = Vec::new();
        for _ in 0..6 {
            let store = Arc::clone(&store);
            let started = Arc::clone(&started);
            let waiting = Arc::clone(&waiting);
            tasks.push(tokio::spawn(async move {
                match begin_with_recovery(
                    store.as_ref(),
                    &NoMarker,
                    ANONYMOUS_GUEST_ACTOR,
                    ROUTE_GUEST_CHECKOUT,
                    "parallel-stored-key",
                    "parallel-request-digest",
                    now(),
                )
                .await
                .unwrap()
                {
                    IdempotencyBegin::Started { .. } => {
                        started.fetch_add(1, Ordering::SeqCst);
                    }
                    IdempotencyBegin::InProgress | IdempotencyBegin::Completed { .. } => {
                        waiting.fetch_add(1, Ordering::SeqCst);
                    }
                    other => panic!("unexpected begin result {other:?}"),
                }
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert_eq!(waiting.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn guest_response_loss_recovers_marker_but_uncertain_start_never_reexecutes() {
        let store = MemoryIdempotencyStore::new();
        let body = serde_json::json!({"transaction":{"invoiceNumber":"INV-RECOVERED"}});
        store.force_started(
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            "response-loss-key",
            "response-loss-digest",
        );
        let recovered = begin_with_recovery(
            &store,
            &DurableMarker { body: body.clone() },
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            "response-loss-key",
            "response-loss-digest",
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(
            recovered,
            IdempotencyBegin::Completed { status: 201, body: replay } if replay == body
        ));

        store.force_started_with_lease(
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            "uncertain-key",
            "uncertain-digest",
            now().timestamp_millis() - 1,
        );
        store.retain_uncertain_started(
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            "uncertain-key",
            "uncertain-digest",
        );
        let uncertain = begin_with_recovery(
            &store,
            &NoMarker,
            ANONYMOUS_GUEST_ACTOR,
            ROUTE_GUEST_CHECKOUT,
            "uncertain-key",
            "uncertain-digest",
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(uncertain, IdempotencyBegin::InProgress));
    }
}
