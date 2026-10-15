use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use zeroize::{Zeroize, Zeroizing};
use chacha20poly1305::{aead::{Aead, KeyInit, Payload}, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};

const PREFIX: &str = "seller-secret-v1:";

fn key() -> Result<Zeroizing<[u8; 32]>, ()> {
    let mut encoded = std::env::var("OPEN_API_ENCRYPTION_KEY").map_err(|_| ())?;
    let mut bytes = match URL_SAFE_NO_PAD.decode(encoded.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => { encoded.zeroize(); return Err(()); }
    };
    encoded.zeroize();
    if bytes.len() != 32 { bytes.zeroize(); return Err(()); }
    let mut result = Zeroizing::new([0_u8; 32]);
    result.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(result)
}

fn aad(provider: &str, field: &str) -> Vec<u8> {
    format!("seller-settings-v1:{provider}:{field}").into_bytes()
}

pub fn seal(provider: &str, field: &str, plaintext: &str) -> Result<String, ()> {
    let key = key()?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| ())?;
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let aad = aad(provider, field);
    let encrypted = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad: &aad }).map_err(|_| ())?;
    let mut bytes = Vec::with_capacity(nonce.len() + encrypted.len());
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&encrypted);
    Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

pub fn open(provider: &str, field: &str, stored: &str) -> Result<String, ()> {
    let encoded = stored.strip_prefix(PREFIX).ok_or(())?;
    let mut bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| ())?;
    if bytes.len() < 24 + 16 { bytes.zeroize(); return Err(()); }
    let (nonce, ciphertext) = bytes.split_at(24);
    let key = match key() { Ok(key) => key, Err(error) => { bytes.zeroize(); return Err(error); } };
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| ())?;
    let aad = aad(provider, field);
    let plaintext = match cipher.decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad: &aad }) {
        Ok(plaintext) => plaintext,
        Err(_) => { bytes.zeroize(); return Err(()); }
    };
    bytes.zeroize();
    match String::from_utf8(plaintext) {
        Ok(value) => Ok(value),
        Err(error) => { let mut bytes = error.into_bytes(); bytes.zeroize(); Err(()) }
    }
}

pub fn is_valid(provider: &str, field: &str, stored: &str) -> bool {
    let Ok(mut plaintext) = open(provider, field, stored) else { return false; };
    plaintext.zeroize();
    true
}

pub fn is_envelope(value: &str) -> bool { value.starts_with(PREFIX) }

