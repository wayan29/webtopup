use std::{collections::HashMap, env, sync::Arc};

use anyhow::Context;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
pub type RecoveryEncryptionKeyRing = RotationKeyRing;

#[derive(Clone, Debug)]
pub struct RotationKeyRing {
    active_key_id: String,
    keys: HashMap<String, [u8; 32]>,
}

impl RotationKeyRing {
    pub fn parse(active_key_id: &str, entries: &str) -> anyhow::Result<Self> {
        let active_key_id = bounded_key_id(active_key_id)?;
        let mut keys = HashMap::new();
        for entry in entries.split(',').map(str::trim).filter(|v| !v.is_empty()) {
            let (id, encoded) = entry
                .split_once(':')
                .context("SESSION_ROTATION_KEYS entries must be keyId:base64url-no-pad")?;
            let id = bounded_key_id(id)?;
            if encoded.contains('=') {
                anyhow::bail!("SESSION_ROTATION_KEYS must use unpadded base64url");
            }
            let decoded = URL_SAFE_NO_PAD
                .decode(encoded)
                .context("SESSION_ROTATION_KEYS contains invalid base64url")?;
            let key: [u8; 32] = decoded.try_into().map_err(|_| {
                anyhow::anyhow!("SESSION_ROTATION_KEYS keys must decode to 32 bytes")
            })?;
            if keys.insert(id, key).is_some() {
                anyhow::bail!("SESSION_ROTATION_KEYS contains a duplicate key ID");
            }
        }
        if !keys.contains_key(&active_key_id) {
            anyhow::bail!("SESSION_ROTATION_ACTIVE_KEY_ID is not present in SESSION_ROTATION_KEYS");
        }
        Ok(Self {
            active_key_id,
            keys,
        })
    }

    pub fn active(&self) -> (&str, &[u8; 32]) {
        (
            &self.active_key_id,
            self.keys
                .get(&self.active_key_id)
                .expect("validated active key"),
        )
    }

    pub fn get(&self, key_id: &str) -> Option<&[u8; 32]> {
        self.keys.get(key_id)
    }

    /// Iterates active and retained keys for fail-closed recovery verification.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &[u8; 32])> {
        self.keys.iter().map(|(id, key)| (id.as_str(), key))
    }
}

fn bounded_key_id(value: &str) -> anyhow::Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        anyhow::bail!("rotation key IDs must be 1..=64 safe ASCII characters");
    }
    Ok(value.to_string())
}

#[derive(Clone)]
pub struct AppState {
    pub pg_pool: sqlx::PgPool,
    pub proxy_secret: String,
    pub jwt_secret: String,
    pub session_token_hash_secret: String,
    pub rotation_keys: RotationKeyRing,
    pub recovery_encryption_keys: RecoveryEncryptionKeyRing,
    pub slider_mutation_readiness: crate::services::slider_readiness::SliderMutationReadiness,
}

impl AppState {
    pub async fn from_env() -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            pg_pool: connect_postgres().await?,
            proxy_secret: proxy_secret_from_env()?,
            jwt_secret: jwt_secret_from_env()?,
            session_token_hash_secret: session_token_hash_secret_from_env()?,
            rotation_keys: RotationKeyRing::parse(
                &env::var("SESSION_ROTATION_ACTIVE_KEY_ID")
                    .context("SESSION_ROTATION_ACTIVE_KEY_ID must be configured")?,
                &env::var("SESSION_ROTATION_KEYS")
                    .context("SESSION_ROTATION_KEYS must be configured")?,
            )?,
            recovery_encryption_keys: RecoveryEncryptionKeyRing::parse(
                &env::var("SESSION_RECOVERY_ENCRYPTION_ACTIVE_KEY_ID")
                    .context("SESSION_RECOVERY_ENCRYPTION_ACTIVE_KEY_ID must be configured")?,
                &env::var("SESSION_RECOVERY_ENCRYPTION_KEYS")
                    .context("SESSION_RECOVERY_ENCRYPTION_KEYS must be configured")?,
            )?,
            slider_mutation_readiness: crate::services::slider_readiness::SliderMutationReadiness::default(),
        }))
    }
}

async fn connect_postgres() -> anyhow::Result<sqlx::PgPool> {
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL must be configured")?;
    let expected = env::var("SQL_DATABASE").context("SQL_DATABASE must identify the target database")?;
    let url = url::Url::parse(&database_url).context("DATABASE_URL must be a PostgreSQL URL")?;
    if !matches!(url.scheme(), "postgres" | "postgresql")
        || url.path().trim_start_matches('/') != expected
        || !expected.starts_with("webtopup_ci_")
    {
        anyhow::bail!("SQL candidate database target rejected");
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect(&database_url)
        .await
        .context("PostgreSQL pool unavailable")?;
    let actual: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&pool).await.context("PostgreSQL target verification failed")?;
    if actual != expected { anyhow::bail!("PostgreSQL connected target mismatch"); }
    Ok(pool)
}

fn proxy_secret_from_env() -> anyhow::Result<String> {
    let secret = env::var("API_V2_PROXY_SECRET")
        .context("API_V2_PROXY_SECRET must be configured for API v2")?
        .trim()
        .to_string();

    if secret.len() < 32 {
        anyhow::bail!("API_V2_PROXY_SECRET must be at least 32 characters for API v2");
    }

    Ok(secret)
}

fn jwt_secret_from_env() -> anyhow::Result<String> {
    secret_from_env("JWT_SECRET")
}

fn session_token_hash_secret_from_env() -> anyhow::Result<String> {
    secret_from_env("SESSION_TOKEN_HASH_SECRET")
}

fn secret_from_env(name: &str) -> anyhow::Result<String> {
    let secret = env::var(name)
        .with_context(|| format!("{name} must be configured for API v2"))?
        .trim()
        .to_string();

    if secret.len() < 32 {
        anyhow::bail!("{name} must be at least 32 characters for API v2");
    }

    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(byte: u8) -> String {
        URL_SAFE_NO_PAD.encode([byte; 32])
    }

    #[test]
    fn rotation_key_ring_retains_old_keys_and_selects_active() {
        let ring = RotationKeyRing::parse("new", &format!("old:{},new:{}", encoded(1), encoded(2)))
            .unwrap();
        assert_eq!(ring.active(), ("new", &[2; 32]));
        assert_eq!(ring.get("old"), Some(&[1; 32]));
        assert!(ring.get("unknown").is_none());
    }

    #[test]
    fn rotation_key_ring_rejects_unknown_duplicate_and_malformed_keys() {
        assert!(RotationKeyRing::parse("missing", &format!("old:{}", encoded(1))).is_err());
        assert!(RotationKeyRing::parse("old", &format!("old:{0},old:{0}", encoded(1))).is_err());
        assert!(RotationKeyRing::parse("old", "old:short").is_err());
        assert!(RotationKeyRing::parse("bad:id", &format!("bad:id:{}", encoded(1))).is_err());
    }

    #[test]
    fn recovery_encryption_key_startup_parses_separate_ring() {
        let ring = RecoveryEncryptionKeyRing::parse(
            "enc-new",
            &format!("enc-old:{},enc-new:{}", encoded(3), encoded(4)),
        )
        .unwrap();
        assert_eq!(ring.active(), ("enc-new", &[4; 32]));
        assert_eq!(ring.get("enc-old"), Some(&[3; 32]));
    }
}
