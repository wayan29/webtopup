//! XChaCha20-Poly1305 encryption for the recoverable legacy-migration issuance envelope.

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use mongodb::bson::{oid::ObjectId, DateTime};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::state::RecoveryEncryptionKeyRing;

pub const MIGRATION_ENCRYPTION_VERSION: &str = "xchacha20poly1305-v1";
const MIGRATION_AAD_DOMAIN: &[u8] = b"legacy-session-migration-issuance-aead/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationIssuancePlaintext {
    pub refresh_secret: [u8; 32],
    pub recovery_secret: [u8; 32],
    pub csrf_value: String,
}

impl Zeroize for MigrationIssuancePlaintext {
    fn zeroize(&mut self) {
        self.refresh_secret.zeroize();
        self.recovery_secret.zeroize();
        self.csrf_value.zeroize();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedMigrationIssuance {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; 24],
    pub key_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationAeadError {
    Key,
    Version,
    Encode,
    Encrypt,
    Decrypt,
}

pub trait MigrationNonceSource: Sync {
    fn fill_migration_nonce(&self, nonce: &mut [u8; 24]);
}

pub struct OsMigrationNonce;
impl MigrationNonceSource for OsMigrationNonce {
    fn fill_migration_nonce(&self, nonce: &mut [u8; 24]) {
        OsRng.fill_bytes(nonce);
    }
}

pub fn migration_issuance_aad(
    fingerprint: &[u8; 32],
    user_id: ObjectId,
    target_sid: ObjectId,
    legacy_expires_at: DateTime,
    migration_cutoff_at: DateTime,
    recovery_until: DateTime,
) -> Vec<u8> {
    let user = user_id.bytes();
    let sid = target_sid.bytes();
    let mut aad = Vec::with_capacity(MIGRATION_AAD_DOMAIN.len() + 4 + 32 + 4 + 12 + 4 + 12 + 24);
    aad.extend_from_slice(MIGRATION_AAD_DOMAIN);
    for bytes in [fingerprint.as_slice(), user.as_slice(), sid.as_slice()] {
        aad.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        aad.extend_from_slice(bytes);
    }
    for millis in [
        legacy_expires_at.timestamp_millis(),
        migration_cutoff_at.timestamp_millis(),
        recovery_until.timestamp_millis(),
    ] {
        aad.extend_from_slice(&millis.to_be_bytes());
    }
    aad
}

pub fn encrypt_migration_issuance(
    keys: &RecoveryEncryptionKeyRing,
    plaintext: &MigrationIssuancePlaintext,
    aad: &[u8],
    random: &dyn MigrationNonceSource,
) -> Result<EncryptedMigrationIssuance, MigrationAeadError> {
    let encoded =
        Zeroizing::new(serde_json::to_vec(plaintext).map_err(|_| MigrationAeadError::Encode)?);
    let (key_id, key) = keys.active();
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| MigrationAeadError::Key)?;
    let mut nonce = [0_u8; 24];
    random.fill_migration_nonce(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &encoded, aad })
        .map_err(|_| MigrationAeadError::Encrypt)?;
    Ok(EncryptedMigrationIssuance {
        ciphertext,
        nonce,
        key_id: key_id.to_owned(),
        version: MIGRATION_ENCRYPTION_VERSION.to_owned(),
    })
}

pub fn decrypt_migration_issuance(
    keys: &RecoveryEncryptionKeyRing,
    encrypted: &EncryptedMigrationIssuance,
    aad: &[u8],
) -> Result<Zeroizing<MigrationIssuancePlaintext>, MigrationAeadError> {
    if encrypted.version != MIGRATION_ENCRYPTION_VERSION {
        return Err(MigrationAeadError::Version);
    }
    let key = keys.get(&encrypted.key_id).ok_or(MigrationAeadError::Key)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| MigrationAeadError::Key)?;
    let decoded = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&encrypted.nonce),
                Payload {
                    msg: &encrypted.ciphertext,
                    aad,
                },
            )
            .map_err(|_| MigrationAeadError::Decrypt)?,
    );
    serde_json::from_slice(&decoded)
        .map(Zeroizing::new)
        .map_err(|_| MigrationAeadError::Encode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

    struct FixedNonce(u8);
    impl MigrationNonceSource for FixedNonce {
        fn fill_migration_nonce(&self, nonce: &mut [u8; 24]) {
            nonce.fill(self.0);
        }
    }
    fn keys() -> RecoveryEncryptionKeyRing {
        RecoveryEncryptionKeyRing::parse(
            "new",
            &format!(
                "old:{},new:{}",
                URL_SAFE_NO_PAD.encode([1; 32]),
                URL_SAFE_NO_PAD.encode([2; 32])
            ),
        )
        .unwrap()
    }
    fn fields() -> ([u8; 32], ObjectId, ObjectId, DateTime, DateTime, DateTime) {
        (
            [7; 32],
            ObjectId::parse_str("0123456789abcdef01234567").unwrap(),
            ObjectId::parse_str("fedcba987654321001234567").unwrap(),
            DateTime::from_millis(10),
            DateTime::from_millis(20),
            DateTime::from_millis(15),
        )
    }

    #[test]
    fn legacy_migration_aead_vectors() {
        let (f, u, s, l, c, r) = fields();
        let aad = migration_issuance_aad(&f, u, s, l, c, r);
        let mut expected = MIGRATION_AAD_DOMAIN.to_vec();
        for bytes in [f.as_slice(), u.bytes().as_slice(), s.bytes().as_slice()] {
            expected.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            expected.extend_from_slice(bytes);
        }
        for millis in [10_i64, 20, 15] {
            expected.extend_from_slice(&millis.to_be_bytes());
        }
        assert_eq!(aad, expected);
        assert!(!aad.starts_with(b"session-refresh-recovery-aead/v1"));
    }

    #[test]
    fn legacy_migration_aead_tamper() {
        let (f, u, s, l, c, r) = fields();
        let aad = migration_issuance_aad(&f, u, s, l, c, r);
        let plain = MigrationIssuancePlaintext {
            refresh_secret: [3; 32],
            recovery_secret: [4; 32],
            csrf_value: "csrf".into(),
        };
        let encrypted = encrypt_migration_issuance(&keys(), &plain, &aad, &FixedNonce(9)).unwrap();
        assert_eq!(
            &*decrypt_migration_issuance(&keys(), &encrypted, &aad).unwrap(),
            &plain
        );
        for index in [0, aad.len() - 1] {
            let mut changed = aad.clone();
            changed[index] ^= 1;
            assert_eq!(
                decrypt_migration_issuance(&keys(), &encrypted, &changed),
                Err(MigrationAeadError::Decrypt)
            );
        }
        let mut changed = encrypted.clone();
        changed.ciphertext[0] ^= 1;
        assert_eq!(
            decrypt_migration_issuance(&keys(), &changed, &aad),
            Err(MigrationAeadError::Decrypt)
        );
        changed = encrypted.clone();
        changed.nonce[0] ^= 1;
        assert_eq!(
            decrypt_migration_issuance(&keys(), &changed, &aad),
            Err(MigrationAeadError::Decrypt)
        );
        changed = encrypted;
        changed.version = "other".into();
        assert_eq!(
            decrypt_migration_issuance(&keys(), &changed, &aad),
            Err(MigrationAeadError::Version)
        );
    }

    #[test]
    fn legacy_migration_zeroization() {
        let mut plain = MigrationIssuancePlaintext {
            refresh_secret: [3; 32],
            recovery_secret: [4; 32],
            csrf_value: "csrf-secret".into(),
        };
        plain.zeroize();
        assert_eq!(plain.refresh_secret, [0; 32]);
        assert_eq!(plain.recovery_secret, [0; 32]);
        assert!(plain.csrf_value.is_empty());
        let mut encoded = Zeroizing::new(vec![7_u8; 128]);
        encoded.zeroize();
        assert!(encoded.iter().all(|byte| *byte == 0));
    }
}
