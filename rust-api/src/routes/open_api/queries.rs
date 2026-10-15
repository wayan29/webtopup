use sqlx::{PgPool, Row};
use uuid::Uuid;

pub struct ApiPrincipal { pub id: Uuid, pub email: String, pub level: String, pub balance: i64 }

pub async fn authenticate(pool: &PgPool, member_code: &str, api_key: &str, signature: &str, ref_id: Option<&str>) -> Result<Option<ApiPrincipal>, sqlx::Error> {
    use chacha20poly1305::{aead::{Aead, KeyInit, Payload}, XChaCha20Poly1305, XNonce};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use subtle::ConstantTimeEq;
    use zeroize::Zeroize;
    let encoded=std::env::var("OPEN_API_ENCRYPTION_KEY").map_err(|_|sqlx::Error::Protocol("OPEN_API_ENCRYPTION_KEY missing".into()))?;
    let raw=URL_SAFE_NO_PAD.decode(encoded).map_err(|_|sqlx::Error::Protocol("OPEN_API_ENCRYPTION_KEY invalid".into()))?;
    let key:[u8;32]=raw.try_into().map_err(|_|sqlx::Error::Protocol("OPEN_API_ENCRYPTION_KEY invalid".into()))?;
    let row=sqlx::query("SELECT u.id,u.email,u.level,u.balance,u.role,u.active,c.secret_nonce,c.secret_ciphertext,c.active AS credential_active FROM open_api_credentials c JOIN users u ON u.id=c.user_id WHERE c.member_code=$1 AND c.api_key=$2")
        .bind(member_code).bind(api_key).fetch_optional(pool).await?;
    let Some(row)=row else{return Ok(None)};
    if row.get::<String,_>("role")!="member" || !row.get::<bool,_>("active") || !row.get::<bool,_>("credential_active"){return Ok(None)}
    let nonce:Vec<u8>=row.get("secret_nonce"); let nonce:[u8;24]=nonce.try_into().map_err(|_|sqlx::Error::Protocol("invalid secret nonce".into()))?;
    let ciphertext:Vec<u8>=row.get("secret_ciphertext"); let aad=format!("open-api-credential-v1:{member_code}:{api_key}");
    let cipher=XChaCha20Poly1305::new_from_slice(&key).map_err(|_|sqlx::Error::Protocol("invalid encryption key".into()))?;
    let mut secret=cipher.decrypt(XNonce::from_slice(&nonce),Payload{msg:&ciphertext,aad:aad.as_bytes()}).map_err(|_|sqlx::Error::Protocol("credential decryption failed".into()))?;
    let material=match ref_id.filter(|v|!v.is_empty()){Some(r)=>format!("{member_code}:{api_key}:{}:{r}",String::from_utf8_lossy(&secret)),None=>format!("{member_code}:{api_key}:{}",String::from_utf8_lossy(&secret))};
    let expected=format!("{:x}",md5::compute(material.as_bytes())); let valid: bool=expected.as_bytes().ct_eq(signature.to_ascii_lowercase().as_bytes()).into(); secret.zeroize();
    if !valid{return Ok(None)}
    Ok(Some(ApiPrincipal{id:row.get("id"),email:row.get("email"),level:row.get("level"),balance:row.get("balance")}))
}
