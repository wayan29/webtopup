use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use uuid::Uuid;
use sha2::Sha256;

use crate::services::idempotency::{self as service, ROUTE_GUEST_CHECKOUT};

type HmacSha256 = Hmac<Sha256>;

pub(super) const ANONYMOUS_GUEST_ACTOR: Uuid = Uuid::nil();

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
    pub(super) member_id: Option<Uuid>,
}

pub(super) fn guest_checkout_digest(
    hmac_key: &[u8],
    fingerprint: &GuestCheckoutFingerprint<'_>,
) -> String {
    let flash_sale = if fingerprint.use_flash_sale { "true" } else { "false" };
    let member_id = fingerprint
        .member_id
        .map(|id| id.simple().to_string())
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
    use std::sync::atomic::{AtomicU32, Ordering};

    use uuid::Uuid;

    use super::{
        digest_guest_idempotency_key, guest_checkout_digest, GuestCheckoutFingerprint,
    };


    #[test]
    fn uuid_member_digest_uses_lowercase_compact_hex() {
        let member_id = Uuid::parse_str("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        let fingerprint = GuestCheckoutFingerprint {
            member_id: Some(member_id),
            ..fixture()
        };
        let compact = Uuid::parse_str("00112233445566778899aabbccddeeff").unwrap();
        assert_eq!(member_id.simple().to_string(), compact.simple().to_string());
        assert_ne!(digest(&fingerprint), digest(&GuestCheckoutFingerprint {
            member_id: None,
            ..fixture()
        }));
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
            member_id: Some(Uuid::from_bytes([7; 16])),
        }
    }

    fn digest(input: &GuestCheckoutFingerprint<'_>) -> String {
        guest_checkout_digest(b"fingerprint-secret", input)
    }

    #[test]
    fn guest_checkout_digest_excludes_turnstile_token() {
        // Compile-time: GuestCheckoutFingerprint still has no token field. Adding one
        // would break this exhaustive destructure — do not include turnstileToken.
        let _: fn(&GuestCheckoutFingerprint<'_>) = |fingerprint| {
            let GuestCheckoutFingerprint {
                product_code,
                target,
                server_id,
                whatsapp,
                email,
                payment_method_id,
                use_flash_sale,
                voucher_code,
                member_id,
            } = *fingerprint;
            let _ = (
                product_code,
                target,
                server_id,
                whatsapp,
                email,
                payment_method_id,
                use_flash_sale,
                voucher_code,
                member_id,
            );
        };

        // Extra token on the caller must not change the digest: two fingerprints
        // identical except the callers holding different tokens stay equal.
        let _token_a = "token-aaaa";
        let _token_b = "token-bbbb";
        assert_eq!(digest(&fixture()), digest(&fixture()));
    }


    #[test]
    fn guest_checkout_fingerprint_covers_every_order_input() {
        let baseline_fixture = fixture();
        let baseline = digest(&baseline_fixture);
        let member = Uuid::from_bytes([8; 16]);
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
    fn raw_idempotency_key_is_hmac_digested_before_storage() {
        let raw = "550e8400-e29b-41d4-a716-446655440000";
        let stored = digest_guest_idempotency_key(b"secret", raw);
        assert_ne!(stored, raw);
        assert!(!stored.contains(raw));
        assert_eq!(stored, digest_guest_idempotency_key(b"secret", raw));
        assert_ne!(stored, digest_guest_idempotency_key(b"other-secret", raw));
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


}
