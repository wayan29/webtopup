use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{aead::{Aead, Payload}, KeyInit, XChaCha20Poly1305, XNonce};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use subtle::ConstantTimeEq;

fn invalid() -> AuthError { AuthError::new(StatusCode::UNAUTHORIZED, "AUTH_TOKEN_INVALID", "Invalid credential") }
fn unavailable() -> AuthError { AuthError::new(StatusCode::SERVICE_UNAVAILABLE, "AUTH_UNAVAILABLE", "Credential encryption unavailable") }
pub(super) fn new_secret() -> [u8;32] { let mut value=[0;32]; loop { OsRng.fill_bytes(&mut value); if value.iter().any(|v| *v != 0) { return value; } } }
pub(super) fn encode_token(sid: Uuid, secret: &[u8;32]) -> String { format!("{sid}.{}",URL_SAFE_NO_PAD.encode(secret)) }
pub(super) fn parse_token(token:&str)->Result<(Uuid,[u8;32]),AuthError> {
    let (id,raw)=token.split_once('.').ok_or_else(invalid)?;
    let sid=Uuid::parse_str(id).map_err(|_|invalid())?;
    if sid.to_string()!=id || raw.contains('=') { return Err(invalid()); }
    let secret:[u8;32]=URL_SAFE_NO_PAD.decode(raw).map_err(|_|invalid())?.try_into().map_err(|_|invalid())?;
    if secret.iter().all(|v|*v==0) || URL_SAFE_NO_PAD.encode(secret)!=raw { return Err(invalid()); }
    Ok((sid,secret))
}
pub(super) fn digest(secret:&[u8;32],hash_key:&str,domain:&str)->Vec<u8> {
    let mut mac=<Hmac<Sha256> as Mac>::new_from_slice(hash_key.as_bytes()).expect("HMAC accepts any key");
    mac.update(b"session-refresh-digest/");mac.update(domain.as_bytes());mac.update(b"/v1");mac.update(&32_u32.to_be_bytes());mac.update(secret);mac.finalize().into_bytes().to_vec()
}
pub(super) fn equal(left:&[u8],right:&[u8])->bool { bool::from(left.ct_eq(right)) }
pub(super) fn derive(state:&AppState,key_id:&str,sid:Uuid,generation:i64,recovery:&[u8;32])->Result<([u8;32],[u8;32]),AuthError> {
    let key=state.rotation_keys.get(key_id).ok_or_else(unavailable)?;
    if generation<0 { return Err(invalid()); }
    let mut mac=<Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_|unavailable())?;
    mac.update(b"session-refresh-rotation/prk/v1");mac.update(&16_u32.to_be_bytes());mac.update(sid.as_bytes());mac.update(&(generation as u64).to_be_bytes());mac.update(&32_u32.to_be_bytes());mac.update(recovery);
    let prk=zeroize::Zeroizing::new(<[u8;32]>::from(mac.finalize().into_bytes()));
    let expand=|label:&[u8]| { let mut m=<Hmac<Sha256> as Mac>::new_from_slice(prk.as_ref()).expect("fixed key");m.update(label);<[u8;32]>::from(m.finalize().into_bytes()) };
    Ok((expand(b"session-refresh-rotation/refresh/v1"),expand(b"session-refresh-rotation/recovery/v1")))
}
// Self-describing encrypted records retain the key identifier for key-ring rotation.
pub(super) fn seal(state:&AppState,aad:&str,plaintext:&[u8])->Result<Vec<u8>,AuthError> {
    let (id,key)=state.recovery_encryption_keys.active();let mut nonce=[0;24];OsRng.fill_bytes(&mut nonce);
    let cipher=XChaCha20Poly1305::new_from_slice(key).map_err(|_|unavailable())?;
    let mut out=Vec::with_capacity(2+id.len()+24+plaintext.len()+16);out.push(1);out.push(id.len() as u8);out.extend_from_slice(id.as_bytes());out.extend_from_slice(&nonce);
    out.extend(cipher.encrypt(XNonce::from_slice(&nonce),Payload{msg:plaintext,aad:aad.as_bytes()}).map_err(|_|unavailable())?);Ok(out)
}
pub(super) fn open(state:&AppState,aad:&str,ciphertext:&[u8])->Result<Vec<u8>,AuthError> {
    if ciphertext.len()<2 || ciphertext[0]!=1 { return Err(unavailable()); }
    let n=ciphertext[1] as usize;if n==0 || ciphertext.len()<2+n+24+16 { return Err(unavailable()); }
    let id=std::str::from_utf8(&ciphertext[2..2+n]).map_err(|_|unavailable())?;let key=state.recovery_encryption_keys.get(id).ok_or_else(unavailable)?;
    XChaCha20Poly1305::new_from_slice(key).map_err(|_|unavailable())?.decrypt(XNonce::from_slice(&ciphertext[2+n..2+n+24]),Payload{msg:&ciphertext[2+n+24..],aad:aad.as_bytes()}).map_err(|_|unavailable())
}
pub(super) async fn password(password:&str,hash:&str)->Result<bool,AuthError> { let password=password.to_owned();let hash=hash.to_owned();tokio::task::spawn_blocking(move||bcrypt::verify(password, &hash).unwrap_or(false)).await.map_err(|_|unavailable()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn uuid_credentials_are_canonical_and_domain_separated() { let sid=Uuid::new_v4();let secret=[9;32];assert_eq!(parse_token(&encode_token(sid,&secret)).unwrap().0,sid);assert!(parse_token(&format!("{}.{}",sid.to_string().to_uppercase(),URL_SAFE_NO_PAD.encode(secret))).is_err());assert_ne!(digest(&secret,"key","refresh"),digest(&secret,"key","recovery"));assert!(parse_token(&encode_token(sid,&[0;32])).is_err()); }
}
