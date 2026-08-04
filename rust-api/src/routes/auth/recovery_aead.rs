//! XChaCha20-Poly1305 recovery-seed encryption per design Section 17.7.

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use mongodb::bson::{oid::ObjectId, DateTime};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

pub const RECOVERY_ENCRYPTION_VERSION: &str = "xchacha20poly1305-v1";
const AAD_LABEL: &[u8] = b"session-refresh-recovery-aead/v1";
const SECURITY_CHANGE_AAD_LABEL: &[u8] = b"security-change-recovery-aead/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryEncryptionError {
    Key,
    Nonce,
    Aad,
    Encrypt,
    Decrypt,
    Version,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedRecoverySeed {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; 24],
    pub key_id: String,
    pub version: String,
}

pub fn build_recovery_aad(
    sid: ObjectId,
    predecessor_generation: u64,
    successor_generation: u64,
    derivation_version: &str,
    rotation_key_id: &str,
    recovery_expires_at: DateTime,
) -> Vec<u8> {
    let sid_bytes = sid.bytes();
    let dv = derivation_version.as_bytes();
    let rk = rotation_key_id.as_bytes();
    let exp_ms = recovery_expires_at.timestamp_millis();
    let mut out = Vec::new();
    out.extend_from_slice(AAD_LABEL);
    out.extend_from_slice(&(sid_bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&sid_bytes);
    out.extend_from_slice(&predecessor_generation.to_be_bytes());
    out.extend_from_slice(&successor_generation.to_be_bytes());
    out.extend_from_slice(&(dv.len() as u32).to_be_bytes());
    out.extend_from_slice(dv);
    out.extend_from_slice(&(rk.len() as u32).to_be_bytes());
    out.extend_from_slice(rk);
    out.extend_from_slice(&exp_ms.to_be_bytes());
    out
}

#[allow(clippy::too_many_arguments)]
pub fn build_security_change_aad(
    operation_id: ObjectId,
    initiating_sid: ObjectId,
    result_sid: Option<ObjectId>,
    user_id: ObjectId,
    target_user_id: ObjectId,
    kind: &str,
    method: &str,
    path: &str,
    previous_epoch: i64,
    result_epoch: i64,
    source_generation: u64,
    recovery_expires_at: DateTime,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(SECURITY_CHANGE_AAD_LABEL);
    for bytes in [
        operation_id.bytes(),
        initiating_sid.bytes(),
        user_id.bytes(),
        target_user_id.bytes(),
    ] {
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&bytes);
    }
    match result_sid {
        Some(sid) => {
            out.push(1);
            out.extend_from_slice(&sid.bytes());
        }
        None => out.push(0),
    }
    for value in [kind, method, path] {
        out.extend_from_slice(&(value.len() as u32).to_be_bytes());
        out.extend_from_slice(value.as_bytes());
    }
    out.extend_from_slice(&previous_epoch.to_be_bytes());
    out.extend_from_slice(&result_epoch.to_be_bytes());
    out.extend_from_slice(&source_generation.to_be_bytes());
    out.extend_from_slice(&recovery_expires_at.timestamp_millis().to_be_bytes());
    out
}

pub fn random_recovery_nonce() -> [u8; 24] {
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

pub fn encrypt_recovery_seed(
    key: &[u8; 32],
    key_id: &str,
    plaintext: &[u8; 32],
    aad: &[u8],
) -> Result<EncryptedRecoverySeed, RecoveryEncryptionError> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| RecoveryEncryptionError::Key)?;
    let nonce = random_recovery_nonce();
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| RecoveryEncryptionError::Encrypt)?;
    Ok(EncryptedRecoverySeed {
        ciphertext,
        nonce,
        key_id: key_id.to_string(),
        version: RECOVERY_ENCRYPTION_VERSION.into(),
    })
}

pub fn decrypt_recovery_seed(
    key: &[u8; 32],
    version: &str,
    nonce: &[u8; 24],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<ZeroizingSeed, RecoveryEncryptionError> {
    if version != RECOVERY_ENCRYPTION_VERSION {
        return Err(RecoveryEncryptionError::Version);
    }
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| RecoveryEncryptionError::Key)?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(nonce),
                chacha20poly1305::aead::Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| RecoveryEncryptionError::Decrypt)?,
    );
    let mut seed = Zeroizing::new([0_u8; 32]);
    if plain.len() != 32 {
        return Err(RecoveryEncryptionError::Decrypt);
    }
    seed.copy_from_slice(&plain);
    Ok(ZeroizingSeed(seed))
}

pub struct ZeroizingSeed(Zeroizing<[u8; 32]>);

impl ZeroizingSeed {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[cfg(test)]
mod recovery_aead_tests {
    use super::*;
    use crate::routes::auth::{
        session_store::derive_recovery_successors,
        session_tokens::{
            derive_rotation_successors, digest_rotation_secret, rotation_digests_equal,
            RotationDigestDomain,
        },
    };

    #[test]
    fn security_change_aad_is_domain_separated_and_tamper_evident() {
        let key = [0x31; 32];
        let operation = ObjectId::parse_str("0123456789abcdef01234567").unwrap();
        let sid = ObjectId::parse_str("1123456789abcdef01234567").unwrap();
        let user = ObjectId::parse_str("2123456789abcdef01234567").unwrap();
        let target = ObjectId::parse_str("3123456789abcdef01234567").unwrap();
        let expiry = DateTime::from_millis(60_000);
        let aad = build_security_change_aad(
            operation,
            sid,
            Some(sid),
            user,
            target,
            "two_factor_confirm",
            "POST",
            "/api/v2/auth/2fa/confirm",
            7,
            8,
            2,
            expiry,
        );
        let mut independent = Vec::new();
        independent.extend_from_slice(b"security-change-recovery-aead/v1");
        for bytes in [operation.bytes(), sid.bytes(), user.bytes(), target.bytes()] {
            independent.extend_from_slice(&12_u32.to_be_bytes());
            independent.extend_from_slice(&bytes);
        }
        independent.push(1);
        independent.extend_from_slice(&sid.bytes());
        for value in ["two_factor_confirm", "POST", "/api/v2/auth/2fa/confirm"] {
            independent.extend_from_slice(&(value.len() as u32).to_be_bytes());
            independent.extend_from_slice(value.as_bytes());
        }
        independent.extend_from_slice(&7_i64.to_be_bytes());
        independent.extend_from_slice(&8_i64.to_be_bytes());
        independent.extend_from_slice(&2_u64.to_be_bytes());
        independent.extend_from_slice(&60_000_i64.to_be_bytes());
        assert_eq!(aad, independent);
        let session_aad = build_recovery_aad(sid, 2, 3, "v1", "key", expiry);
        assert_ne!(aad, session_aad);
        let encrypted = encrypt_recovery_seed(&key, "key", &[9; 32], &aad).unwrap();
        assert!(decrypt_recovery_seed(
            &key,
            &encrypted.version,
            &encrypted.nonce,
            &encrypted.ciphertext,
            &session_aad
        )
        .is_err());
        let altered = build_security_change_aad(
            operation,
            sid,
            Some(sid),
            user,
            target,
            "two_factor_confirm",
            "POST",
            "/api/v2/auth/2fa/confirm/",
            7,
            8,
            2,
            expiry,
        );
        assert!(decrypt_recovery_seed(
            &key,
            &encrypted.version,
            &encrypted.nonce,
            &encrypted.ciphertext,
            &altered
        )
        .is_err());
    }

    #[test]
    fn recovery_aead_roundtrip_and_independent_aad_vector() {
        let key = [0x11_u8; 32];
        let sid = ObjectId::parse_str("0123456789abcdef01234567").unwrap();
        let aad = build_recovery_aad(
            sid,
            3,
            4,
            "v1",
            "rot-key-1",
            DateTime::from_millis(1_700_000_000_000),
        );
        let mut manual = Vec::new();
        manual.extend_from_slice(b"session-refresh-recovery-aead/v1");
        manual.extend_from_slice(&(sid.bytes().len() as u32).to_be_bytes());
        manual.extend_from_slice(&sid.bytes());
        manual.extend_from_slice(&3u64.to_be_bytes());
        manual.extend_from_slice(&4u64.to_be_bytes());
        manual.extend_from_slice(&(b"v1".len() as u32).to_be_bytes());
        manual.extend_from_slice(b"v1");
        manual.extend_from_slice(&(b"rot-key-1".len() as u32).to_be_bytes());
        manual.extend_from_slice(b"rot-key-1");
        manual.extend_from_slice(&1_700_000_000_000i64.to_be_bytes());
        assert_eq!(aad, manual);

        let plain = [0x22_u8; 32];
        let enc = encrypt_recovery_seed(&key, "enc-active", &plain, &aad).unwrap();
        assert_ne!(enc.nonce, [0_u8; 24]);
        let dec =
            decrypt_recovery_seed(&key, &enc.version, &enc.nonce, &enc.ciphertext, &aad).unwrap();
        assert_eq!(dec.as_bytes(), &plain);
    }

    #[test]
    fn recovery_aead_tamper_ciphertext_nonce_and_aad_fields() {
        let key = [0x33_u8; 32];
        let sid = ObjectId::parse_str("fedcba987654321001234567").unwrap();
        let aad = build_recovery_aad(sid, 1, 2, "v1", "k1", DateTime::from_millis(9_000));
        let plain = [0x44_u8; 32];
        let enc = encrypt_recovery_seed(&key, "k1", &plain, &aad).unwrap();
        let mut bad_cipher = enc.ciphertext.clone();
        if let Some(b) = bad_cipher.first_mut() {
            *b ^= 0xff;
        }
        assert!(decrypt_recovery_seed(&key, &enc.version, &enc.nonce, &bad_cipher, &aad).is_err());
        let mut bad_nonce = enc.nonce;
        bad_nonce[0] ^= 0x01;
        assert!(
            decrypt_recovery_seed(&key, &enc.version, &bad_nonce, &enc.ciphertext, &aad).is_err()
        );
        let mut bad_aad = aad.clone();
        bad_aad.push(0x01);
        assert!(
            decrypt_recovery_seed(&key, &enc.version, &enc.nonce, &enc.ciphertext, &bad_aad)
                .is_err()
        );
    }

    #[test]
    fn recovery_aead_rejects_wrong_version() {
        let key = [0x55_u8; 32];
        let sid = ObjectId::new();
        let aad = build_recovery_aad(sid, 0, 1, "v1", "k", DateTime::from_millis(1));
        let enc = encrypt_recovery_seed(&key, "k", &[1; 32], &aad).unwrap();
        assert!(
            decrypt_recovery_seed(&key, "bad-version", &enc.nonce, &enc.ciphertext, &aad).is_err()
        );
    }

    #[test]
    fn recovery_aead_nonce_uniqueness_across_rotations() {
        let key = [0x66_u8; 32];
        let sid = ObjectId::new();
        let aad = build_recovery_aad(sid, 0, 1, "v1", "k", DateTime::from_millis(1));
        let n1 = encrypt_recovery_seed(&key, "k", &[2; 32], &aad)
            .unwrap()
            .nonce;
        let n2 = encrypt_recovery_seed(&key, "k", &[2; 32], &aad)
            .unwrap()
            .nonce;
        assert_ne!(n1, n2);
    }

    #[test]
    fn recovery_aead_decrypts_through_zeroizing_derivation_boundary() {
        let encryption_key = [0x77_u8; 32];
        let rotation_key = [0x78_u8; 32];
        let sid = ObjectId::parse_str("0123456789abcdef01234567").unwrap();
        let seed = [0x79_u8; 32];
        let aad = build_recovery_aad(sid, 2, 3, "v1", "rot", DateTime::from_millis(60_000));
        let encrypted = encrypt_recovery_seed(&encryption_key, "enc", &seed, &aad).unwrap();
        let decrypted = decrypt_recovery_seed(
            &encryption_key,
            &encrypted.version,
            &encrypted.nonce,
            &encrypted.ciphertext,
            &aad,
        )
        .unwrap();
        let derived = derive_recovery_successors(&rotation_key, sid, 3, &decrypted).unwrap();
        let expected = derive_rotation_successors(&rotation_key, sid, 3, &seed).unwrap();
        let refresh_digest = digest_rotation_secret(
            RotationDigestDomain::Refresh,
            &derived.refresh,
            &rotation_key,
        );
        let expected_refresh_digest = digest_rotation_secret(
            RotationDigestDomain::Refresh,
            &expected.refresh,
            &rotation_key,
        );
        let recovery_digest = digest_rotation_secret(
            RotationDigestDomain::Recovery,
            &derived.recovery,
            &rotation_key,
        );
        let expected_recovery_digest = digest_rotation_secret(
            RotationDigestDomain::Recovery,
            &expected.recovery,
            &rotation_key,
        );
        assert!(rotation_digests_equal(
            &refresh_digest,
            &expected_refresh_digest
        ));
        assert!(rotation_digests_equal(
            &recovery_digest,
            &expected_recovery_digest
        ));
    }

    #[test]
    fn recovery_aead_post_decrypt_derivation_digest_mismatch_detected() {
        let rot_key = [0x88_u8; 32];
        let enc_key = [0x99_u8; 32];
        let sid = ObjectId::parse_str("0123456789abcdef01234567").unwrap();
        let old_recovery = [0xaa_u8; 32];
        let aad = build_recovery_aad(sid, 0, 1, "v1", "rot1", DateTime::from_millis(60_000));
        let enc = encrypt_recovery_seed(&enc_key, "enc1", &old_recovery, &aad).unwrap();
        let decrypted =
            decrypt_recovery_seed(&enc_key, &enc.version, &enc.nonce, &enc.ciphertext, &aad)
                .unwrap();
        let derived = derive_rotation_successors(&rot_key, sid, 1, decrypted.as_bytes()).unwrap();
        let refresh_digest =
            digest_rotation_secret(RotationDigestDomain::Refresh, &derived.refresh, &rot_key);
        let mut wrong = refresh_digest;
        wrong[0] ^= 0x01;
        assert!(!rotation_digests_equal(&refresh_digest, &wrong));
    }
}
