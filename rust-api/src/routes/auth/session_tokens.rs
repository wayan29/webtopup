use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use mongodb::bson::oid::ObjectId;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use super::types::AccessClaims;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshTokenError;

pub type RotationTokenError = RefreshTokenError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationDigestDomain {
    Refresh,
    Recovery,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedSuccessors {
    pub refresh: Zeroizing<[u8; 32]>,
    pub recovery: Zeroizing<[u8; 32]>,
}

pub fn derive_rotation_successors(
    key: &[u8],
    sid: ObjectId,
    successor_generation: u64,
    old_recovery: &[u8; 32],
) -> Result<DerivedSuccessors, RotationTokenError> {
    if key.len() < 32 {
        return Err(RefreshTokenError);
    }
    let sid = sid.bytes();
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| RefreshTokenError)?;
    mac.update(b"session-refresh-rotation/prk/v1");
    mac.update(&(sid.len() as u32).to_be_bytes());
    mac.update(&sid);
    mac.update(&successor_generation.to_be_bytes());
    mac.update(&(old_recovery.len() as u32).to_be_bytes());
    mac.update(old_recovery);
    let prk = Zeroizing::new(<[u8; 32]>::from(mac.finalize().into_bytes()));
    let expand = |label: &[u8]| {
        let mut mac = Hmac::<Sha256>::new_from_slice(prk.as_ref()).expect("fixed HMAC key");
        mac.update(label);
        <[u8; 32]>::from(mac.finalize().into_bytes())
    };
    Ok(DerivedSuccessors {
        refresh: Zeroizing::new(expand(b"session-refresh-rotation/refresh/v1")),
        recovery: Zeroizing::new(expand(b"session-refresh-rotation/recovery/v1")),
    })
}

pub fn digest_rotation_secret(
    domain: RotationDigestDomain,
    secret: &[u8; 32],
    key: &[u8],
) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any size");
    mac.update(match domain {
        RotationDigestDomain::Refresh => b"session-refresh-digest/refresh/v1",
        RotationDigestDomain::Recovery => b"session-refresh-digest/recovery/v1",
    });
    mac.update(&(secret.len() as u32).to_be_bytes());
    mac.update(secret);
    mac.finalize().into_bytes().into()
}

pub fn rotation_digests_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.ct_eq(right).into()
}

pub fn new_refresh_secret() -> [u8; 32] {
    let mut secret = [0_u8; 32];
    while secret.iter().all(|byte| *byte == 0) {
        OsRng.fill_bytes(&mut secret);
    }
    secret
}

pub fn encode_refresh_token(sid: &str, secret: &[u8; 32]) -> Result<String, RefreshTokenError> {
    ObjectId::parse_str(sid).map_err(|_| RefreshTokenError)?;
    if secret.iter().all(|byte| *byte == 0) {
        return Err(RefreshTokenError);
    }
    Ok(format!("{sid}.{}", URL_SAFE_NO_PAD.encode(secret)))
}

pub fn parse_refresh_token(token: &str) -> Result<(String, [u8; 32]), RefreshTokenError> {
    let (sid, encoded) = token.split_once('.').ok_or(RefreshTokenError)?;
    if encoded.contains('=') || token.matches('.').count() != 1 {
        return Err(RefreshTokenError);
    }
    ObjectId::parse_str(sid).map_err(|_| RefreshTokenError)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| RefreshTokenError)?;
    let secret: [u8; 32] = decoded.try_into().map_err(|_| RefreshTokenError)?;
    if secret.iter().all(|byte| *byte == 0) {
        return Err(RefreshTokenError);
    }
    Ok((sid.to_string(), secret))
}

pub fn digest_refresh_secret(secret: &[u8; 32], key: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any size");
    mac.update(secret);
    mac.finalize().into_bytes().into()
}

pub fn refresh_digests_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.ct_eq(right).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_secrets_are_random_nonzero_32_byte_values() {
        let first = new_refresh_secret();
        let second = new_refresh_secret();
        assert_eq!(first.len(), 32);
        assert_eq!(second.len(), 32);
        assert_ne!(first, second);
        assert!(first.iter().any(|byte| *byte != 0));
    }

    #[test]
    fn refresh_tokens_round_trip_and_reject_invalid_inputs() {
        let sid = "0123456789abcdef01234567";
        let secret = [7_u8; 32];
        let token = encode_refresh_token(sid, &secret).unwrap();
        assert_eq!(
            parse_refresh_token(&token).unwrap(),
            (sid.to_string(), secret)
        );
        for invalid in [
            "",
            "bad.abc",
            "0123456789abcdef01234567",
            "0123456789abcdef01234567.",
            "0123456789abcdef01234567.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "0123456789abcdef01234567.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "0123456789abcdef01234567.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
        ] {
            assert!(parse_refresh_token(invalid).is_err(), "accepted {invalid}");
        }
        assert!(encode_refresh_token(sid, &[0; 32]).is_err());
        assert!(encode_refresh_token("", &secret).is_err());
    }

    #[test]
    fn refresh_digest_is_deterministic() {
        let key = b"01234567890123456789012345678901";
        let expected = digest_refresh_secret(&[7; 32], key);
        assert_eq!(expected, digest_refresh_secret(&[7; 32], key));
        assert_ne!(expected, digest_refresh_secret(&[8; 32], key));
    }

    #[test]
    fn refresh_digests_equal_accepts_matching_computed_tags() {
        let key = b"01234567890123456789012345678901";
        let digest = digest_refresh_secret(&[9; 32], key);
        assert!(refresh_digests_equal(&digest, &digest));
    }

    #[test]
    fn refresh_digests_equal_rejects_differing_computed_tags() {
        let key = b"01234567890123456789012345678901";
        let left = digest_refresh_secret(&[9; 32], key);
        let mut right = digest_refresh_secret(&[9; 32], key);
        right[0] ^= 0x01;
        assert!(!refresh_digests_equal(&left, &right));
        assert!(!refresh_digests_equal(&left, &[0; 32]));
    }

    #[test]
    fn rotation_derivation_matches_independent_section_17_vector() {
        let key = [0x42_u8; 32];
        let sid = ObjectId::parse_str("0123456789abcdef01234567").unwrap();
        let old_recovery = [0x24_u8; 32];
        let generation = 0x0102_0304_0506_0708_u64;

        let mut input = Vec::new();
        input.extend_from_slice(b"session-refresh-rotation/prk/v1");
        input.extend_from_slice(&(sid.bytes().len() as u32).to_be_bytes());
        input.extend_from_slice(&sid.bytes());
        input.extend_from_slice(&generation.to_be_bytes());
        input.extend_from_slice(&(old_recovery.len() as u32).to_be_bytes());
        input.extend_from_slice(&old_recovery);
        let mut extract = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        extract.update(&input);
        let prk: [u8; 32] = extract.finalize().into_bytes().into();
        let independently_expand = |label: &[u8]| {
            let mut mac = Hmac::<Sha256>::new_from_slice(&prk).unwrap();
            mac.update(label);
            <[u8; 32]>::from(mac.finalize().into_bytes())
        };

        let derived = derive_rotation_successors(&key, sid, generation, &old_recovery).unwrap();
        assert_eq!(
            *derived.refresh,
            independently_expand(b"session-refresh-rotation/refresh/v1")
        );
        assert_eq!(
            *derived.recovery,
            independently_expand(b"session-refresh-rotation/recovery/v1")
        );
        assert_ne!(derived.refresh, derived.recovery);
        assert_eq!(URL_SAFE_NO_PAD.encode(derived.refresh).len(), 43);
        assert_eq!(URL_SAFE_NO_PAD.encode(derived.recovery).len(), 43);
    }

    #[test]
    fn rotation_derivation_and_keyed_digest_are_domain_separated() {
        let key = [0x55_u8; 32];
        let sid = ObjectId::parse_str("fedcba987654321001234567").unwrap();
        let old_recovery = [0x33_u8; 32];
        let first = derive_rotation_successors(&key, sid, 1, &old_recovery).unwrap();
        let next = derive_rotation_successors(&key, sid, 2, &old_recovery).unwrap();
        assert_ne!(first.refresh, next.refresh);
        assert_ne!(first.recovery, next.recovery);

        let refresh_digest =
            digest_rotation_secret(RotationDigestDomain::Refresh, &first.refresh, &key);
        let recovery_digest =
            digest_rotation_secret(RotationDigestDomain::Recovery, &first.refresh, &key);
        assert_ne!(refresh_digest, recovery_digest);
        assert!(rotation_digests_equal(&refresh_digest, &refresh_digest));
        assert!(!rotation_digests_equal(&refresh_digest, &recovery_digest));
    }

    #[test]
    fn access_claims_have_session_bound_shape() {
        let claims = AccessClaims {
            sub: "user-id".into(),
            sid: "session-id".into(),
            session_version: 3,
            role: "member".into(),
            iat: 1_000,
            exp: 1_900,
            jti: "token-id".into(),
            token_type: "access".into(),
        };
        let value = serde_json::to_value(claims).unwrap();
        assert_eq!(value["sub"], "user-id");
        assert_eq!(value["sid"], "session-id");
        assert_eq!(value["sessionVersion"], 3);
        assert_eq!(value["jti"], "token-id");
        assert_eq!(value["tokenType"], "access");
        assert!(value.get("id").is_none());
    }
}
