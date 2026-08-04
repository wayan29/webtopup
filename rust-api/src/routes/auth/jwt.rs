use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use mongodb::bson::Document;

use super::{
    now_seconds, read_i64,
    types::{AccessClaims, Claims},
};
use crate::utils::bson::read_string;

pub(super) fn token_for_user(
    user: &Document,
    ttl_seconds: usize,
    secret: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    sign_token(
        &Claims {
            id: user
                .get_object_id("_id")
                .map(|id| id.to_hex())
                .unwrap_or_default(),
            email: Some(read_string(user, "email")),
            role: Some(read_string(user, "role")),
            level: Some(read_string(user, "level")),
            session_version: read_i64(user, "sessionVersion"),
            purpose: None,
            login_audience: None,
            iat: now_seconds(),
            exp: now_seconds() + ttl_seconds,
        },
        secret,
    )
}

pub(super) fn sign_token(
    claims: &Claims,
    secret: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub(super) fn sign_access_token(
    claims: &AccessClaims,
    secret: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub(super) fn decode_access_token(
    token: &str,
    secret: &str,
) -> Result<AccessClaims, jsonwebtoken::errors::Error> {
    decode::<AccessClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
}

pub(super) fn decode_token(
    token: &str,
    secret: &str,
) -> Result<Claims, jsonwebtoken::errors::Error> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
}
