use std::time::Duration;

use sqlx::{postgres::PgPoolOptions, PgPool};
use uuid::Uuid;

const STAFF_SLOT_LIMIT: i64 = 2;
const MEMBER_SLOT_LIMIT: i64 = 5;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LoginAudience {
    Member,
    Staff,
}

impl LoginAudience {
    fn accepts(self, role: &str) -> bool {
        match self {
            Self::Member => role == "member",
            Self::Staff => matches!(role, "owner" | "admin" | "cs"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Member => "member",
            Self::Staff => "staff",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    InvalidCredentials,
    Unavailable,
    Conflict,
}

pub struct AuthStore {
    pool: PgPool,
}

#[derive(sqlx::FromRow)]
struct UserRow {
    id: Uuid,
    email: String,
    name: String,
    password_hash: String,
    role: String,
    active: bool,
    balance: i64,
    points: i64,
    session_version: i32,
    security_generation: i32,
}

pub struct UserProfile {
    pub id: Uuid,
    pub email: String,
    pub name: String,
    pub role: String,
    pub active: bool,
    pub balance: i64,
    pub points: i64,
}

pub struct LoginSession {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub role: String,
    pub refresh_digest: Vec<u8>,
}

impl AuthStore {
    pub async fn connect(database_url: &str) -> Result<Self, String> {
        if !(database_url.contains("/webtopup_pg_dev") || database_url.contains("/webtopup_ci_candidate")) {
            return Err("database is not allowed".to_string());
        }
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(2))
            .connect(database_url)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self { pool })
    }

    pub async fn profile_by_email(&self, email: &str) -> Result<Option<UserProfile>, AuthError> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, email, name, password_hash, role, active, balance, points, session_version, security_generation
             FROM users WHERE normalized_email = lower(btrim($1))",
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        Ok(row.map(|row| UserProfile {
            id: row.id,
            email: row.email,
            name: row.name,
            role: row.role,
            active: row.active,
            balance: row.balance,
            points: row.points,
        }))
    }

    pub async fn login(
        &self,
        audience: LoginAudience,
        email: &str,
        password: &str,
    ) -> Result<LoginSession, AuthError> {
        let user = sqlx::query_as::<_, UserRow>(
            "SELECT id, email, name, password_hash, role, active, balance, points, session_version, security_generation
             FROM users WHERE normalized_email = lower(btrim($1))",
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        let matched = match user.as_ref() {
            Some(user) => bcrypt::verify(password, &user.password_hash).unwrap_or(false),
            None => false,
        };
        let Some(user) = user else {
            return Err(AuthError::InvalidCredentials);
        };
        if !matched || !user.active || !audience.accepts(&user.role) {
            return Err(AuthError::InvalidCredentials);
        }

        let limit = if audience == LoginAudience::Staff {
            STAFF_SLOT_LIMIT
        } else {
            MEMBER_SLOT_LIMIT
        };
        let mut tx = self.pool.begin().await.map_err(|_| AuthError::Unavailable)?;
        sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
            .bind(user.id)
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
        let occupied: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM auth_sessions WHERE user_id = $1 AND state = 'active'",
        )
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        if occupied >= limit {
            return Err(AuthError::Conflict);
        }
        let session_seed = Uuid::new_v4();
        let refresh_digest = format!("generation-0-{session_seed}").into_bytes();
        let session_id: Uuid = sqlx::query_scalar(
            "INSERT INTO auth_sessions (user_id, session_version, audience, state, generation, refresh_digest, security_generation)
             VALUES ($1, $2, $3, 'active', 0, $4, $5) RETURNING id",
        )
        .bind(user.id)
        .bind(user.session_version)
        .bind(audience.as_str())
        .bind(&refresh_digest)
        .bind(user.security_generation)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        tx.commit().await.map_err(|_| AuthError::Unavailable)?;
        Ok(LoginSession { user_id: user.id, session_id, role: user.role, refresh_digest })
    }

    pub async fn revoke_all(&self, user_id: Uuid) -> Result<(), AuthError> {
        let result = sqlx::query(
            "UPDATE auth_sessions SET state = 'revoked' WHERE user_id = $1 AND state = 'active'",
        )
        .bind(user_id)
        .execute(&self.pool)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        if result.rows_affected() == 0 {
            return Err(AuthError::Conflict);
        }
        Ok(())
    }

    pub async fn rotate(&self, session_id: Uuid, predecessor: &[u8]) -> Result<i32, AuthError> {
        let mut tx = self.pool.begin().await.map_err(|_| AuthError::Unavailable)?;
        let current: Option<(i32, Vec<u8>)> = sqlx::query_as(
            "SELECT generation, refresh_digest FROM auth_sessions WHERE id = $1 AND state = 'active' FOR UPDATE",
        )
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        let Some((generation, digest)) = current else { return Err(AuthError::Conflict); };
        if digest.as_slice() != predecessor { return Err(AuthError::InvalidCredentials); }
        let next = generation.checked_add(1).ok_or(AuthError::Conflict)?;
        let mut successor = predecessor.to_vec();
        successor.push(next as u8);
        sqlx::query("UPDATE auth_sessions SET generation = $2, predecessor_digest = refresh_digest, refresh_digest = $3 WHERE id = $1")
            .bind(session_id).bind(next).bind(successor).execute(&mut *tx).await.map_err(|_| AuthError::Unavailable)?;
        tx.commit().await.map_err(|_| AuthError::Unavailable)?;
        Ok(next)
    }

    pub async fn change_role(&self, user_id: Uuid, role: &str) -> Result<i32, AuthError> {
        if !matches!(role, "owner" | "admin" | "cs" | "member") { return Err(AuthError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| AuthError::Unavailable)?;
        let generation: Option<i32> = sqlx::query_scalar(
            "UPDATE users SET role = $2, session_version = session_version + 1, security_generation = security_generation + 1, role_updated_at = now(), updated_at = now() WHERE id = $1 RETURNING security_generation",
        ).bind(user_id).bind(role).fetch_optional(&mut *tx).await.map_err(|_| AuthError::Unavailable)?;
        let Some(generation) = generation else { return Err(AuthError::Conflict); };
        sqlx::query("UPDATE auth_sessions SET state = 'revoked' WHERE user_id = $1 AND state = 'active' AND security_generation < $2")
            .bind(user_id).bind(generation).execute(&mut *tx).await.map_err(|_| AuthError::Unavailable)?;
        tx.commit().await.map_err(|_| AuthError::Unavailable)?;
        Ok(generation)
    }

    pub async fn authorize(&self, session_id: Uuid, permission: &str) -> Result<bool, AuthError> {
        let allowed: Option<bool> = sqlx::query_scalar(
            "SELECT (u.role = 'owner' OR $2 = ANY(u.permissions)) AND s.security_generation = u.security_generation FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.state = 'active' AND u.active",
        ).bind(session_id).bind(permission).fetch_optional(&self.pool).await.map_err(|_| AuthError::Unavailable)?;
        Ok(allowed.unwrap_or(false))
    }

    pub async fn enroll_two_factor(&self, user_id: Uuid, secret: &[u8]) -> Result<(), AuthError> {
        if secret.len() < 16 { return Err(AuthError::Conflict); }
        let changed = sqlx::query("UPDATE users SET two_factor_secret = $2, two_factor_enabled = FALSE, updated_at = now() WHERE id = $1 AND two_factor_enabled = FALSE")
            .bind(user_id).bind(secret).execute(&self.pool).await.map_err(|_| AuthError::Unavailable)?;
        if changed.rows_affected() != 1 { return Err(AuthError::Conflict); }
        Ok(())
    }

    pub async fn confirm_two_factor(&self, user_id: Uuid, code: &str) -> Result<(), AuthError> {
        if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) { return Err(AuthError::InvalidCredentials); }
        let mut tx = self.pool.begin().await.map_err(|_| AuthError::Unavailable)?;
        let secret: Option<Vec<u8>> = sqlx::query_scalar("SELECT two_factor_secret FROM users WHERE id = $1 FOR UPDATE")
            .bind(user_id).fetch_optional(&mut *tx).await.map_err(|_| AuthError::Unavailable)?.flatten();
        let Some(secret) = secret.filter(|value| !value.is_empty()) else { return Err(AuthError::Conflict); };
        let counter = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| AuthError::Unavailable)?.as_secs() / 30) as i64;
        if totp(&secret, counter) != code { return Err(AuthError::InvalidCredentials); }
        sqlx::query("UPDATE users SET two_factor_enabled = TRUE, two_factor_last_counter = $2, security_generation = security_generation + 1, updated_at = now() WHERE id = $1")
            .bind(user_id).bind(counter).execute(&mut *tx).await.map_err(|_| AuthError::Unavailable)?;
        sqlx::query("UPDATE auth_sessions SET state = 'revoked' WHERE user_id = $1 AND state = 'active'")
            .bind(user_id).execute(&mut *tx).await.map_err(|_| AuthError::Unavailable)?;
        tx.commit().await.map_err(|_| AuthError::Unavailable)?;
        Ok(())
    }
}

fn totp(secret: &[u8], counter: i64) -> String {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("hmac accepts this key length");
    mac.update(&(counter.max(0) as u64).to_be_bytes());
    let result = mac.finalize().into_bytes();
    let offset = (result[19] & 0x0f) as usize;
    let binary = (((result[offset] & 0x7f) as u32) << 24) | ((result[offset + 1] as u32) << 16) | ((result[offset + 2] as u32) << 8) | result[offset + 3] as u32;
    format!("{:06}", binary % 1_000_000)
}
