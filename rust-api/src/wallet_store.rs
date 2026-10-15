use chacha20poly1305::{aead::{Aead, KeyInit, Payload}, XChaCha20Poly1305, XNonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;
use sqlx::{postgres::PgPoolOptions, PgPool};
use hmac::{Hmac, Mac};
use sha1::Sha1;

fn hmac_sha1_hex(secret: &[u8], body: &[u8]) -> String {
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sign_webhook(secret: &[u8], body: &[u8]) -> String { hmac_sha1_hex(secret, body) }
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub enum WalletError { Insufficient, Conflict, Unavailable }

pub struct WalletStore { pool: PgPool, open_api_encryption_key: Option<[u8; 32]> }

impl WalletStore {
    pub async fn connect(database_url: &str) -> Result<Self, WalletError> {
        if !(database_url.contains("/webtopup_pg_dev") || database_url.contains("/webtopup_ci_")) { return Err(WalletError::Unavailable); }
        let pool = PgPoolOptions::new().max_connections(5).acquire_timeout(Duration::from_secs(2)).connect(database_url).await.map_err(|error| { eprintln!("wallet connect failed: {error}"); WalletError::Unavailable })?;
        let open_api_encryption_key = std::env::var("OPEN_API_ENCRYPTION_KEY").ok()
            .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
        Ok(Self { pool, open_api_encryption_key })
    }
    pub fn from_pool(pool: PgPool) -> Self {
        let open_api_encryption_key = std::env::var("OPEN_API_ENCRYPTION_KEY").ok()
            .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
        Self { pool, open_api_encryption_key }
    }

    pub async fn credit(&self, user_id: Uuid, source: &str, amount: i64) -> Result<i64, WalletError> {
        self.post(user_id, source, "credit", 1, amount, false).await
    }

    pub async fn debit(&self, user_id: Uuid, source: &str, amount: i64) -> Result<i64, WalletError> {
        self.post(user_id, source, "debit", -1, amount, false).await
    }

    pub async fn refund(&self, user_id: Uuid, source: &str, amount: i64) -> Result<i64, WalletError> {
        self.post(user_id, source, "refund", 1, amount, false).await
    }

    pub async fn credit_then_abort(&self, user_id: Uuid, source: &str, amount: i64) -> Result<i64, WalletError> {
        self.post(user_id, source, "credit", 1, amount, true).await
    }

    pub async fn reconcile(&self, user_id: Uuid) -> Result<bool, WalletError> {
        let consistent: bool = sqlx::query_scalar(
            "SELECT u.balance = COALESCE(SUM(direction * amount), 0) FROM users u LEFT JOIN ledger_entries e ON e.user_id = u.id WHERE u.id = $1 GROUP BY u.balance",
        ).bind(user_id).fetch_one(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        Ok(consistent)
    }

    async fn post(&self, user_id: Uuid, source: &str, kind: &str, direction: i16, amount: i64, abort: bool) -> Result<i64, WalletError> {
        if amount <= 0 || source.is_empty() { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let balance: Option<i64> = sqlx::query_scalar("SELECT balance FROM users WHERE id = $1 FOR UPDATE")
            .bind(user_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some(balance) = balance else { return Err(WalletError::Conflict); };
        let next = balance + i64::from(direction) * amount;
        if next < 0 { return Err(WalletError::Insufficient); }
        let inserted = sqlx::query("INSERT INTO ledger_entries (user_id, source, kind, direction, amount, balance_after) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(user_id).bind(source).bind(kind).bind(direction).bind(amount).bind(next)
            .execute(&mut *tx).await;
        if inserted.is_err() { return Err(WalletError::Conflict); }
        sqlx::query("UPDATE users SET balance = $2, updated_at = now() WHERE id = $1")
            .bind(user_id).bind(next).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if abort {
            tx.rollback().await.map_err(|_| WalletError::Unavailable)?;
            return Ok(balance);
        }
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(next)
    }

    pub async fn idempotent_credit(&self, user_id: Uuid, key: &str, digest: &str, amount: i64) -> Result<i64, WalletError> {
        if amount <= 0 || key.is_empty() || digest.is_empty() { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let existing: Option<(String, Option<i64>)> = sqlx::query_as("SELECT payload_digest, (response->>'balance')::bigint FROM idempotency_claims WHERE key = $1 FOR UPDATE")
            .bind(key).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if let Some((stored, response)) = existing {
            if stored != digest { return Err(WalletError::Conflict); }
            return response.ok_or(WalletError::Unavailable);
        }
        sqlx::query("INSERT INTO idempotency_claims (key, payload_digest) VALUES ($1, $2)").bind(key).bind(digest).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        let balance: i64 = sqlx::query_scalar("UPDATE users SET balance = balance + $2, updated_at = now() WHERE id = $1 RETURNING balance")
            .bind(user_id).bind(amount).fetch_one(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("INSERT INTO ledger_entries (user_id, source, kind, direction, amount, balance_after) VALUES ($1,$2,'credit',1,$3,$4)")
            .bind(user_id).bind(key).bind(amount).bind(balance).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        sqlx::query("UPDATE idempotency_claims SET response = jsonb_build_object('balance', $2::bigint), completed_at = now() WHERE key = $1")
            .bind(key).bind(balance).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(balance)
    }

    pub async fn enqueue_provider(&self, ref_id: &str, payload: &str) -> Result<(), WalletError> {
        sqlx::query("INSERT INTO provider_outbox (ref_id, payload, state) VALUES ($1, $2::jsonb, 'pending')")
            .bind(ref_id).bind(payload).execute(&self.pool).await.map(|_| ()).or(Err(WalletError::Conflict))
    }

    pub async fn claim_provider(&self, ref_id: &str) -> Result<i64, WalletError> {
        let generation: Option<i64> = sqlx::query_scalar("UPDATE provider_outbox SET state = 'sending', lease_generation = lease_generation + 1 WHERE ref_id = $1 AND state = 'pending' RETURNING lease_generation")
            .bind(ref_id).fetch_optional(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        generation.ok_or(WalletError::Conflict)
    }

    pub async fn mark_provider_ambiguous(&self, ref_id: &str, generation: i64) -> Result<(), WalletError> {
        let changed = sqlx::query("UPDATE provider_outbox SET state = 'ambiguous' WHERE ref_id = $1 AND state = 'sending' AND lease_generation = $2")
            .bind(ref_id).bind(generation).execute(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        if changed.rows_affected() != 1 { return Err(WalletError::Conflict); }
        Ok(())
    }

    pub async fn reconcile_provider(&self, ref_id: &str, result: &str) -> Result<(), WalletError> {
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let current: Option<(String, Option<String>)> = sqlx::query_as("SELECT state, provider_result FROM provider_outbox WHERE ref_id = $1 FOR UPDATE")
            .bind(ref_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((state, stored)) = current else { return Err(WalletError::Conflict); };
        if let Some(stored) = stored { return if stored == result { Ok(()) } else { Err(WalletError::Conflict) }; }
        if state != "ambiguous" && state != "sending" { return Err(WalletError::Conflict); }
        sqlx::query("UPDATE provider_outbox SET state = 'sent', provider_result = $2 WHERE ref_id = $1")
            .bind(ref_id).bind(result).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(())
    }

    pub async fn checkout(&self, user_id: Uuid, key: &str, digest: &str, product_code: &str, level: &str) -> Result<i64, WalletError> {
        self.checkout_inner(user_id, key, digest, product_code, level, false).await
    }

    pub async fn checkout_then_abort(&self, user_id: Uuid, key: &str, digest: &str, product_code: &str, level: &str) -> Result<i64, WalletError> {
        self.checkout_inner(user_id, key, digest, product_code, level, true).await
    }

    async fn checkout_inner(&self, user_id: Uuid, key: &str, digest: &str, product_code: &str, level: &str, abort: bool) -> Result<i64, WalletError> {
        if key.is_empty() || digest.is_empty() || product_code.is_empty() { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let existing: Option<(String, i64)> = sqlx::query_as("SELECT o.payload_digest, u.balance FROM orders o JOIN users u ON u.id = o.user_id WHERE o.idempotency_key = $1 FOR UPDATE OF o")
            .bind(key).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if let Some((stored, balance)) = existing { return if stored == digest { Ok(balance) } else { Err(WalletError::Conflict) }; }
        let column = match level { "gold" => "price_gold", "platinum" => "price_platinum", _ => "price_basic" };
        let price: Option<i64> = sqlx::query_scalar(&format!("SELECT {column} FROM products WHERE code = $1"))
            .bind(product_code).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some(price) = price.filter(|price| *price > 0) else { return Err(WalletError::Conflict); };
        let balance: Option<i64> = sqlx::query_scalar("SELECT balance FROM users WHERE id = $1 FOR UPDATE")
            .bind(user_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some(balance) = balance else { return Err(WalletError::Conflict); };
        if balance < price { return Err(WalletError::Insufficient); }
        let next = balance - price;
        sqlx::query("UPDATE users SET balance = $2, updated_at = now() WHERE id = $1").bind(user_id).bind(next).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("INSERT INTO ledger_entries (user_id, source, kind, direction, amount, balance_after) VALUES ($1,$2,'debit',-1,$3,$4)")
            .bind(user_id).bind(key).bind(price).bind(next).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        sqlx::query("INSERT INTO orders (user_id, idempotency_key, payload_digest, product_code, level, price, provider_ref) VALUES ($1,$2,$3,$4,$5,$6,$2)")
            .bind(user_id).bind(key).bind(digest).bind(product_code).bind(level).bind(price).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        sqlx::query("INSERT INTO provider_outbox (ref_id, payload, state) VALUES ($1, jsonb_build_object('product', $2::text, 'price', $3::bigint), 'pending')")
            .bind(key).bind(product_code).bind(price).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        if abort { tx.rollback().await.map_err(|_| WalletError::Unavailable)?; return Ok(balance); }
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(next)
    }

    pub async fn approve_deposit(&self, actor: Uuid, owner: bool, deposit_id: Uuid) -> Result<i64, WalletError> {
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let row: Option<(Uuid, i64, i64, String, Option<Uuid>)> = sqlx::query_as("SELECT user_id, amount, admin_fee, status, assigned_to FROM deposits WHERE id = $1 FOR UPDATE")
            .bind(deposit_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((user_id, amount, fee, status, assigned)) = row else { return Err(WalletError::Conflict); };
        if status == "approved" { return Err(WalletError::Conflict); }
        if status != "pending" || (!owner && assigned.is_some_and(|assigned| assigned != actor)) { return Err(WalletError::Conflict); }
        let net = amount - fee;
        if net <= 0 { return Err(WalletError::Conflict); }
        let source = format!("deposit-approve:{deposit_id}");
        let balance = self.credit_in_tx(&mut tx, user_id, &source, net).await?;
        sqlx::query("UPDATE deposits SET status = 'approved', action_key = $2 WHERE id = $1").bind(deposit_id).bind(&source).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        sqlx::query("INSERT INTO financial_audits (actor_id, action, subject_id, amount, operation_key) VALUES ($1, 'deposit-approve', $2, $3, $4)").bind(actor).bind(deposit_id).bind(net).bind(&source).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(balance)
    }

    pub async fn refund_deposit(&self, actor: Uuid, deposit_id: Uuid, key: &str) -> Result<i64, WalletError> {
        if key.is_empty() { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let replay: Option<i64> = sqlx::query_scalar("SELECT u.balance FROM financial_audits a JOIN deposits d ON d.id = a.subject_id JOIN users u ON u.id = d.user_id WHERE a.action = 'deposit-refund' AND a.subject_id = $1")
            .bind(deposit_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if let Some(balance) = replay { return Ok(balance); }
        let row: Option<(Uuid, String)> = sqlx::query_as("SELECT user_id, status FROM deposits WHERE id = $1 FOR UPDATE").bind(deposit_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((user_id, status)) = row else { return Err(WalletError::Conflict); };
        if status != "approved" { return Err(WalletError::Conflict); }
        let amount: i64 = sqlx::query_scalar("SELECT amount FROM ledger_entries WHERE source = $1").bind(format!("deposit-approve:{deposit_id}")).fetch_one(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        let balance = self.debit_in_tx(&mut tx, user_id, key, amount).await?;
        sqlx::query("UPDATE deposits SET status = 'refunded' WHERE id = $1").bind(deposit_id).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("INSERT INTO financial_audits (actor_id, action, subject_id, amount, operation_key) VALUES ($1, 'deposit-refund', $2, $3, $4)").bind(actor).bind(deposit_id).bind(amount).bind(key).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(balance)
    }

    pub async fn adjust_balance(&self, actor: Uuid, user_id: Uuid, key: &str, amount: i64) -> Result<i64, WalletError> {
        if key.is_empty() || amount == 0 { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let replay: Option<i64> = sqlx::query_scalar("SELECT balance_after FROM ledger_entries WHERE source = $1 AND user_id = $2")
            .bind(key).bind(user_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if let Some(balance) = replay { return Ok(balance); }
        let (kind, direction, value) = if amount > 0 { ("adjustment", 1, amount) } else { ("adjustment", -1, amount.abs()) };
        let balance = self.post_in_tx(&mut tx, user_id, key, kind, direction, value).await?;
        sqlx::query("INSERT INTO financial_audits (actor_id, action, subject_id, amount, operation_key) VALUES ($1, 'adjustment', $2, $3, $4)")
            .bind(actor).bind(user_id).bind(value).bind(key).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(balance)
    }

    pub async fn guest_checkout(&self, key: &str, digest: &str, invoice: &str, product_code: &str, at: chrono::NaiveTime) -> Result<i64, WalletError> {
        if key.is_empty() || digest.is_empty() || invoice.is_empty() { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let existing: Option<(String, i64)> = sqlx::query_as("SELECT payload_digest, price FROM guest_orders WHERE idempotency_key = $1 FOR UPDATE")
            .bind(key).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if let Some((stored, price)) = existing { return if stored == digest { Ok(price) } else { Err(WalletError::Conflict) }; }
        let product: Option<(i64, Option<i32>, bool, Option<chrono::NaiveTime>, Option<chrono::NaiveTime>)> = sqlx::query_as("SELECT price_basic, stock, active, opens_at, closes_at FROM products WHERE code = $1 FOR UPDATE")
            .bind(product_code).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((price, stock, active, opens, closes)) = product else { return Err(WalletError::Conflict); };
        if !active || price <= 0 || stock == Some(0) { return Err(WalletError::Conflict); }
        if let (Some(opens), Some(closes)) = (opens, closes) { if at < opens || at >= closes { return Err(WalletError::Conflict); } }
        if stock.is_some() { sqlx::query("UPDATE products SET stock = stock - 1 WHERE code = $1 AND stock > 0").bind(product_code).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?; }
        sqlx::query("INSERT INTO guest_orders (invoice, idempotency_key, payload_digest, product_code, price, payment_status, provider_ref) VALUES ($1,$2,$3,$4,$5,'unpaid',$2)")
            .bind(invoice).bind(key).bind(digest).bind(product_code).bind(price).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        sqlx::query("INSERT INTO provider_outbox (ref_id, payload, state) VALUES ($1, jsonb_build_object('invoice', $2::text), 'pending')")
            .bind(key).bind(invoice).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(price)
    }

    pub async fn public_guest_lookup(&self, invoice: &str) -> Result<Option<(String, i64, String)>, WalletError> {
        sqlx::query_as("SELECT invoice, price, payment_status FROM guest_orders WHERE invoice = $1")
            .bind(invoice).fetch_optional(&self.pool).await.map_err(|_| WalletError::Unavailable)
    }
    pub async fn claim_seller_callback(&self, channel: &str, ref_id: &str) -> Result<bool, WalletError> {
        let inserted = sqlx::query("INSERT INTO seller_callbacks (channel, ref_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING")
            .bind(channel).bind(ref_id).execute(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        Ok(inserted.rows_affected() == 1)
    }
    pub async fn fail_seller_callback(&self, channel: &str, ref_id: &str) -> Result<bool, WalletError> {
        let updated = sqlx::query("UPDATE seller_callbacks SET status = 'failed', next_retry_at = now(), last_error = 'vendor pending' WHERE channel = $1 AND ref_id = $2 AND status <> 'failed'")
            .bind(channel).bind(ref_id).execute(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        Ok(updated.rows_affected() == 1)
    }


    pub async fn process_due_seller_callbacks(&self, limit: i64) -> Result<(i64, i64, i64, i64), WalletError> {
        let rows: Vec<(String, String, i64)> = sqlx::query_as("SELECT channel, ref_id, attempt_count FROM seller_callbacks WHERE status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= now()) ORDER BY next_retry_at NULLS FIRST, ref_id LIMIT $1")
            .bind(limit).fetch_all(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        for (channel, ref_id, attempts) in &rows {
            let next_attempts = attempts + 1;
            let delay_minutes = i32::try_from([1_i64, 5, 15, 60][usize::try_from(*attempts).unwrap_or(3).min(3)]).unwrap_or(60);
            sqlx::query("UPDATE seller_callbacks SET attempt_count = $3, next_retry_at = now() + make_interval(mins => $4), last_error = 'callback upstream unavailable' WHERE channel = $1 AND ref_id = $2")
                .bind(channel).bind(ref_id).bind(next_attempts).bind(delay_minutes).execute(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        }
        let processed = i64::try_from(rows.len()).unwrap_or(0);
        let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM seller_callbacks WHERE status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= now())")
            .fetch_one(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        Ok((processed, 0, processed, remaining))
    }
    pub async fn register_managed_asset(&self, path: &str, folder: &str) -> Result<bool, WalletError> {
        let inserted = sqlx::query("INSERT INTO managed_assets (path, folder) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(path).bind(folder).execute(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        Ok(inserted.rows_affected() == 1)
    }

    pub async fn acquire_asset_reference(&self, path: &str, resource: &str) -> Result<(), WalletError> {
        sqlx::query("INSERT INTO asset_references (path, resource) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(path).bind(resource).execute(&self.pool).await.map(|_| ()).map_err(|_| WalletError::Unavailable)
    }

    pub async fn delete_managed_asset(&self, path: &str) -> Result<bool, WalletError> {
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let references: i64 = sqlx::query_scalar("SELECT count(*) FROM asset_references WHERE path = $1")
            .bind(path).fetch_one(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if references > 0 { return Ok(false); }
        let deleted = sqlx::query("DELETE FROM managed_assets WHERE path = $1")
            .bind(path).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(deleted.rows_affected() == 1)
    }
    pub async fn public_site_settings(&self) -> Result<Vec<(String, serde_json::Value, i64)>, WalletError> {
        sqlx::query_as("SELECT key, value, revision FROM site_settings WHERE key NOT ILIKE '%secret%' AND key NOT ILIKE '%password%' AND key NOT ILIKE '%token%' ORDER BY key")
            .fetch_all(&self.pool).await.map_err(|_| WalletError::Unavailable)
    }

    pub async fn update_site_setting(&self, key: &str, value: serde_json::Value, expected_revision: i64) -> Result<Option<i64>, WalletError> {
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let current: Option<i64> = sqlx::query_scalar("SELECT revision FROM site_settings WHERE key = $1 FOR UPDATE")
            .bind(key).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let next = match current {
            Some(revision) if revision == expected_revision => revision + 1,
            Some(_) => return Ok(None),
            None if expected_revision == 0 => 1,
            None => return Ok(None),
        };
        sqlx::query("INSERT INTO site_settings (key, value, revision) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = EXCLUDED.revision, updated_at = now()")
            .bind(key).bind(value).bind(next).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(Some(next))
    }
    pub async fn create_slider(&self, name: &str, image: &str, link: &str, publish: bool, schema_ready: bool) -> Result<Option<(i64, i32)>, WalletError> {
        if !schema_ready { return Ok(None); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let order: i64 = sqlx::query_scalar("SELECT count(*) FROM sliders WHERE lifecycle = 'active'").fetch_one(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let row: (i64, i32) = sqlx::query_as("INSERT INTO sliders (name, image, link, sort_order, status, lifecycle) VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id, sort_order")
            .bind(name).bind(image).bind(link).bind(order as i32).bind(publish).fetch_one(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("INSERT INTO asset_references (path, resource) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(image).bind(format!("slider:{}", row.0)).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(Some(row))
    }

    pub async fn archive_slider(&self, id: i64, expected_revision: i64) -> Result<Option<Vec<(i64, i32)>>, WalletError> {
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let current: Option<(i64, String)> = sqlx::query_as("SELECT revision, lifecycle FROM sliders WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((revision, lifecycle)) = current else { return Ok(None); };
        if revision != expected_revision || lifecycle != "active" { return Ok(None); }
        sqlx::query("UPDATE sliders SET lifecycle = 'archived', status = false, revision = revision + 1 WHERE id = $1").bind(id).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let rows: Vec<(i64, i32)> = sqlx::query_as("SELECT id, sort_order FROM sliders WHERE lifecycle = 'active' AND id <> $1 ORDER BY sort_order, id FOR UPDATE").bind(id).fetch_all(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        for (index, (slider_id, _)) in rows.iter().enumerate() {
            sqlx::query("UPDATE sliders SET sort_order = $2 WHERE id = $1").bind(slider_id).bind(index as i32).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        }
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(Some(rows.into_iter().enumerate().map(|(index, (slider_id, _))| (slider_id, index as i32)).collect()))
    }

    pub async fn restore_slider(&self, id: i64, expected_revision: i64) -> Result<Option<i32>, WalletError> {
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let current: Option<(i64, String)> = sqlx::query_as("SELECT revision, lifecycle FROM sliders WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((revision, lifecycle)) = current else { return Ok(None); };
        if revision != expected_revision || lifecycle != "archived" { return Ok(None); }
        let order: i64 = sqlx::query_scalar("SELECT count(*) FROM sliders WHERE lifecycle = 'active'").fetch_one(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("UPDATE sliders SET lifecycle = 'active', status = false, sort_order = $2, revision = revision + 1 WHERE id = $1").bind(id).bind(order as i32).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(Some(order as i32))
    }

    pub async fn public_sliders(&self) -> Result<Vec<(i64, String, String, String, i32)>, WalletError> {
        sqlx::query_as("SELECT id, name, image, link, sort_order FROM sliders WHERE lifecycle = 'active' AND status = true ORDER BY sort_order, id")
            .fetch_all(&self.pool).await.map_err(|_| WalletError::Unavailable)
    }
    pub async fn create_reward(&self, name: &str, points_required: i64, stock: i32) -> Result<i64, WalletError> {
        sqlx::query_scalar("INSERT INTO rewards (name, points_required, stock) VALUES ($1, $2, $3) RETURNING id")
            .bind(name).bind(points_required).bind(stock).fetch_one(&self.pool).await.map_err(|_| WalletError::Unavailable)
    }

    pub async fn claim_reward(&self, user_ref: &str, reward_id: i64, claim_key: &str) -> Result<&'static str, WalletError> {
        let user_id = Uuid::parse_str(user_ref).map_err(|_| WalletError::Conflict)?;
        if claim_key.is_empty() { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let reward: Option<(i64, i32, bool)> = sqlx::query_as("SELECT points_required, stock, status FROM rewards WHERE id = $1 FOR UPDATE")
            .bind(reward_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((points_required, stock, status)) = reward else { return Ok("missing"); };
        let existing: Option<i64> = sqlx::query_scalar("SELECT points FROM point_ledger WHERE reward_id = $1 AND claim_key = $2")
            .bind(reward_id).bind(claim_key).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if existing.is_some() { return Ok("replay"); }
        if !status { return Ok("missing"); }
        if stock < 1 { return Ok("exhausted"); }
        let balance: Option<i64> = sqlx::query_scalar("SELECT points FROM users WHERE id = $1 AND role = 'member' FOR UPDATE")
            .bind(user_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some(balance) = balance else { return Ok("missing"); };
        if balance < points_required { return Ok("insufficient"); }
        sqlx::query("UPDATE rewards SET stock = stock - 1, updated_at=now() WHERE id = $1").bind(reward_id).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("UPDATE users SET points = points - $2, updated_at=now() WHERE id = $1")
            .bind(user_id).bind(points_required).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("INSERT INTO point_ledger (user_ref, reward_id, claim_key, points, transaction_type, description) VALUES ($1, $2, $3, $4, 'redeem', $5)")
            .bind(user_ref).bind(reward_id).bind(claim_key).bind(-points_required).bind("Reward redemption").execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok("claimed")
    }

    pub async fn refund_reward_claim(&self, user_ref: &str, claim_key: &str) -> Result<&'static str, WalletError> {
        let user_id = Uuid::parse_str(user_ref).map_err(|_| WalletError::Conflict)?;
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let claim: Option<(i64, i64)> = sqlx::query_as("SELECT reward_id, points FROM point_ledger WHERE user_ref = $1 AND claim_key = $2 AND transaction_type='redeem' AND points < 0 FOR UPDATE")
            .bind(user_ref).bind(claim_key).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some((reward_id, points)) = claim else { return Ok("missing"); };
        let refund_key = format!("refund:{claim_key}");
        let refunded: Option<i64> = sqlx::query_scalar("SELECT id FROM point_ledger WHERE reward_id = $1 AND claim_key = $2")
            .bind(reward_id).bind(&refund_key).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if refunded.is_some() { return Ok("replay"); }
        sqlx::query("SELECT id FROM rewards WHERE id = $1 FOR UPDATE").bind(reward_id).execute(&mut *tx).await.map_err(|_| WalletError::Conflict)?;
        sqlx::query("UPDATE rewards SET stock = stock + 1, updated_at=now() WHERE id = $1").bind(reward_id).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("UPDATE users SET points = points - $2, updated_at=now() WHERE id = $1").bind(user_id).bind(points).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        sqlx::query("INSERT INTO point_ledger (user_ref, reward_id, claim_key, points, transaction_type, description) VALUES ($1, $2, $3, $4, 'admin_adjustment', $5)")
            .bind(user_ref).bind(reward_id).bind(refund_key).bind(-points).bind("Reward redemption refund").execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok("refunded")
    }

    pub async fn delete_reward(&self, reward_id: i64) -> Result<bool, WalletError> {
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let history: i64 = sqlx::query_scalar("SELECT count(*) FROM point_ledger WHERE reward_id = $1")
            .bind(reward_id).fetch_one(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        if history > 0 { return Ok(false); }
        let deleted = sqlx::query("DELETE FROM rewards WHERE id = $1").bind(reward_id).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok(deleted.rows_affected() == 1)
    }
    pub async fn issue_open_api_credential(&self, user_id: Uuid, member_code: &str) -> Result<(String, String), WalletError> {
        let key = self.open_api_encryption_key.as_ref().ok_or(WalletError::Unavailable)?;
        let mut api_key_bytes = [0_u8; 24];
        let mut secret_bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut api_key_bytes);
        rand::thread_rng().fill_bytes(&mut secret_bytes);
        let api_key = format!("tv_{}", api_key_bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        let secret = secret_bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| WalletError::Unavailable)?;
        let mut nonce = [0_u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce);
        let aad = format!("open-api-credential-v1:{member_code}:{api_key}");
        let encrypted = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: secret.as_bytes(), aad: aad.as_bytes() }).map_err(|_| WalletError::Unavailable)?;
        let digest = format!("{:x}", md5::compute(secret.as_bytes()));
        sqlx::query("INSERT INTO open_api_credentials (user_id, member_code, api_key, secret_hash, secret_nonce, secret_ciphertext) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (member_code) DO UPDATE SET user_id = EXCLUDED.user_id, api_key = EXCLUDED.api_key, secret_hash = EXCLUDED.secret_hash, secret_nonce = EXCLUDED.secret_nonce, secret_ciphertext = EXCLUDED.secret_ciphertext, active = true, ref_id = NULL, issued_at = now()")
            .bind(user_id).bind(member_code).bind(&api_key).bind(digest).bind(nonce.as_slice()).bind(encrypted).execute(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        Ok((api_key, secret))
    }

    pub async fn open_api_credential_status(&self, member_code: &str) -> Result<Option<(String, bool)>, WalletError> {
        sqlx::query_as("SELECT api_key, active FROM open_api_credentials WHERE member_code = $1")
            .bind(member_code).fetch_optional(&self.pool).await.map_err(|_| WalletError::Unavailable)
    }

    pub async fn revoke_open_api_credential(&self, member_code: &str) -> Result<bool, WalletError> {
        let updated = sqlx::query("UPDATE open_api_credentials SET active = false, secret_nonce = NULL, secret_ciphertext = NULL WHERE member_code = $1 AND active = true")
            .bind(member_code).execute(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        Ok(updated.rows_affected() == 1)
    }

    pub async fn verify_open_api_signature(&self, member_code: &str, api_key: &str, signature: &str, ref_id: Option<&str>) -> Result<&'static str, WalletError> {
        let key = self.open_api_encryption_key.as_ref().ok_or(WalletError::Unavailable)?;
        let row: Option<(Option<Vec<u8>>, Option<Vec<u8>>, bool)> = sqlx::query_as("SELECT secret_nonce, secret_ciphertext, active FROM open_api_credentials WHERE member_code = $1 AND api_key = $2")
            .bind(member_code).bind(api_key).fetch_optional(&self.pool).await.map_err(|_| WalletError::Unavailable)?;
        let Some((Some(nonce), Some(ciphertext), active)) = row else { return Ok("invalid"); };
        if !active { return Ok("revoked"); }
        let nonce: [u8; 24] = nonce.try_into().map_err(|_| WalletError::Unavailable)?;
        let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| WalletError::Unavailable)?;
        let aad = format!("open-api-credential-v1:{member_code}:{api_key}");
        let mut secret = cipher.decrypt(XNonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: aad.as_bytes() }).map_err(|_| WalletError::Unavailable)?;
        let material = match ref_id.filter(|value| !value.is_empty()) {
            Some(value) => format!("{member_code}:{api_key}:{}:{value}", String::from_utf8_lossy(&secret)),
            None => format!("{member_code}:{api_key}:{}", String::from_utf8_lossy(&secret)),
        };
        let expected = format!("{:x}", md5::compute(material.as_bytes()));
        let valid: bool = expected.as_bytes().ct_eq(signature.to_ascii_lowercase().as_bytes()).into();
        secret.zeroize();
        Ok(if valid { "valid" } else { "invalid" })
    }


    pub async fn record_audit_event(&self, actor: &str, action: &str, outcome: &str, correlation: &str, payload: serde_json::Value) -> Result<i64, WalletError> {
        let redacted = redact_audit_value(payload);
        sqlx::query_scalar("INSERT INTO audit_events (actor, action, outcome, correlation, payload) VALUES ($1, $2, $3, $4, $5) RETURNING id")
            .bind(actor).bind(action).bind(outcome).bind(correlation).bind(redacted).fetch_one(&self.pool).await.map_err(|_| WalletError::Unavailable)
    }

    pub async fn audit_events(&self, outcome: Option<&str>) -> Result<Vec<(i64, String, String, String, serde_json::Value)>, WalletError> {
        match outcome {
            Some(value) => sqlx::query_as("SELECT id, actor, action, outcome, payload FROM audit_events WHERE outcome = $1 ORDER BY id")
                .bind(value).fetch_all(&self.pool).await.map_err(|_| WalletError::Unavailable),
            None => sqlx::query_as("SELECT id, actor, action, outcome, payload FROM audit_events ORDER BY id")
                .fetch_all(&self.pool).await.map_err(|_| WalletError::Unavailable),
        }
    }

    pub async fn mark_notification_read(&self, notification_id: &str) -> Result<(), WalletError> {
        sqlx::query("INSERT INTO notification_states (notification_id, read_at) VALUES ($1, now()) ON CONFLICT (notification_id) DO UPDATE SET read_at = COALESCE(notification_states.read_at, now())")
            .bind(notification_id).execute(&self.pool).await.map(|_| ()).map_err(|_| WalletError::Unavailable)
    }

    pub async fn dismiss_notification(&self, notification_id: &str) -> Result<(), WalletError> {
        sqlx::query("INSERT INTO notification_states (notification_id, read_at, dismissed_at) VALUES ($1, now(), now()) ON CONFLICT (notification_id) DO UPDATE SET read_at = COALESCE(notification_states.read_at, now()), dismissed_at = COALESCE(notification_states.dismissed_at, now())")
            .bind(notification_id).execute(&self.pool).await.map(|_| ()).map_err(|_| WalletError::Unavailable)
    }

    pub async fn notification_states(&self) -> Result<Vec<(String, bool, bool)>, WalletError> {
        sqlx::query_as("SELECT notification_id, read_at IS NOT NULL, dismissed_at IS NOT NULL FROM notification_states ORDER BY notification_id")
            .fetch_all(&self.pool).await.map_err(|_| WalletError::Unavailable)
    }
    pub async fn report_summary(&self, day: chrono::NaiveDate) -> Result<(i64, i64, i64, i64, i64), WalletError> {
        let start = day.and_hms_opt(0, 0, 0).ok_or(WalletError::Conflict)?.and_local_timezone(chrono::FixedOffset::east_opt(7 * 3600).ok_or(WalletError::Conflict)?).single().ok_or(WalletError::Conflict)?;
        let end = start + chrono::Duration::days(1);
        let omzet: i64 = sqlx::query_scalar("SELECT COALESCE(sum(price), 0)::bigint FROM orders WHERE created_at >= $1 AND created_at < $2")
            .bind(start).bind(end).fetch_one(&self.pool).await.map_err(|error| { eprintln!("report omzet: {error}"); WalletError::Unavailable })?;
        let success_count: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM orders WHERE created_at >= $1 AND created_at < $2")
            .bind(start).bind(end).fetch_one(&self.pool).await.map_err(|error| { eprintln!("report success: {error}"); WalletError::Unavailable })?;
        let failed_count: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM seller_callbacks WHERE status = 'failed' AND delivered_at >= $1 AND delivered_at < $2")
            .bind(start).bind(end).fetch_one(&self.pool).await.map_err(|error| { eprintln!("report failed: {error}"); WalletError::Unavailable })?;
        let balance: i64 = sqlx::query_scalar("SELECT COALESCE(sum(balance), 0)::bigint FROM users").fetch_one(&self.pool).await.map_err(|error| { eprintln!("report balance: {error}"); WalletError::Unavailable })?;
        let points: i64 = sqlx::query_scalar("SELECT COALESCE(sum(points), 0)::bigint FROM users").fetch_one(&self.pool).await.map_err(|error| { eprintln!("report points: {error}"); WalletError::Unavailable })?;
        Ok((omzet, balance, points, success_count, failed_count))
    }

    pub async fn save_report_snapshot(&self, day: chrono::NaiveDate, values: (i64, i64, i64, i64, i64)) -> Result<(), WalletError> {
        sqlx::query("INSERT INTO report_snapshots (snapshot_date, omzet, balance, points, success_count, failed_count) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (snapshot_date) DO UPDATE SET omzet = EXCLUDED.omzet, balance = EXCLUDED.balance, points = EXCLUDED.points, success_count = EXCLUDED.success_count, failed_count = EXCLUDED.failed_count")
            .bind(day).bind(values.0).bind(values.1).bind(values.2).bind(values.3 as i32).bind(values.4 as i32).execute(&self.pool).await.map(|_| ()).map_err(|_| WalletError::Unavailable)
    }
    pub async fn rate_limit(&self, namespace: &str, key: &str, limit: i64, window_seconds: i64, block_seconds: i64) -> Result<(bool, i64), WalletError> {
        let url = std::env::var("REDIS_URL").map_err(|_| WalletError::Unavailable)?;
        let mut connection = redis::Client::open(url).map_err(|_| WalletError::Unavailable)?.get_multiplexed_async_connection().await.map_err(|_| WalletError::Unavailable)?;
        let redis_key = format!("{namespace}:rate:{key}");
        let block_key = format!("{redis_key}:block");
        let blocked: i64 = redis::cmd("TTL").arg(&block_key).query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        if blocked > 0 { return Ok((false, blocked)); }
        let count: i64 = redis::cmd("INCR").arg(&redis_key).query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        if count == 1 {
            redis::cmd("EXPIRE").arg(&redis_key).arg(window_seconds).query_async::<()>(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        }
        if count > limit {
            redis::cmd("SET").arg(&block_key).arg("1").arg("EX").arg(block_seconds).query_async::<()>(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
            return Ok((false, block_seconds));
        }
        let ttl: i64 = redis::cmd("TTL").arg(&redis_key).query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        Ok((true, ttl.max(1)))
    }
    pub async fn cache_catalog_product(&self, code: &str, name: &str, status: &str) -> Result<(), WalletError> {
        if status == "provider_error" { return Ok(()); }
        let url = std::env::var("REDIS_URL").map_err(|_| WalletError::Unavailable)?;
        let mut connection = redis::Client::open(url).map_err(|_| WalletError::Unavailable)?.get_multiplexed_async_connection().await.map_err(|_| WalletError::Unavailable)?;
        let _: bool = redis::cmd("SET").arg("webtopup:catalog:version").arg(1).arg("NX").query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        let version: i64 = redis::cmd("GET").arg("webtopup:catalog:version").query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        let ttl = if status == "failed" { 10 } else { 30 };
        let payload = serde_json::json!({"code": code, "name": name, "status": status, "version": version}).to_string();
        redis::cmd("SET").arg(format!("webtopup:catalog:v{version}:{code}")).arg(payload).arg("EX").arg(ttl).query_async::<()>(&mut connection).await.map_err(|_| WalletError::Unavailable)
    }

    pub async fn cached_catalog_product(&self, code: &str) -> Result<Option<serde_json::Value>, WalletError> {
        let url = std::env::var("REDIS_URL").map_err(|_| WalletError::Unavailable)?;
        let mut connection = redis::Client::open(url).map_err(|_| WalletError::Unavailable)?.get_multiplexed_async_connection().await.map_err(|_| WalletError::Unavailable)?;
        let _: bool = redis::cmd("SET").arg("webtopup:catalog:version").arg(1).arg("NX").query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        let version: i64 = redis::cmd("GET").arg("webtopup:catalog:version").query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        let value: Option<String> = redis::cmd("GET").arg(format!("webtopup:catalog:v{version}:{code}")).query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)?;
        Ok(value.and_then(|value| serde_json::from_str(&value).ok()))
    }

    pub async fn invalidate_catalog_cache(&self) -> Result<i64, WalletError> {
        let url = std::env::var("REDIS_URL").map_err(|_| WalletError::Unavailable)?;
        let mut connection = redis::Client::open(url).map_err(|_| WalletError::Unavailable)?.get_multiplexed_async_connection().await.map_err(|_| WalletError::Unavailable)?;
        redis::cmd("INCR").arg("webtopup:catalog:version").query_async(&mut connection).await.map_err(|_| WalletError::Unavailable)
    }











    pub async fn apply_financial_webhook(&self, provider: &str, ref_id: &str, status: &str, body: &[u8], signature: &str, secret: &str, user_id: Uuid, amount: i64) -> Result<&'static str, WalletError> {
        let expected = hmac_sha1_hex(secret.as_bytes(), body);
        if signature != format!("sha1={expected}") { return Err(WalletError::Conflict); }
        if !matches!(status, "success" | "failed") || amount <= 0 { return Err(WalletError::Conflict); }
        let mut tx = self.pool.begin().await.map_err(|_| WalletError::Unavailable)?;
        let current: Option<(String, bool)> = sqlx::query_as("SELECT status, refunded FROM webhook_events WHERE provider = $1 AND ref_id = $2 FOR UPDATE")
            .bind(provider).bind(ref_id).fetch_optional(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        let refunded = match current {
            Some((stored, _)) if stored == status => return Ok("replay"),
            Some((stored, true)) if stored == "failed" && status != "failed" => { self.debit_in_tx(&mut tx, user_id, &format!("webhook-correction:{provider}:{ref_id}"), amount).await?; false }
            Some(_) => return Err(WalletError::Conflict),
            None if status == "failed" => { self.credit_in_tx(&mut tx, user_id, &format!("webhook-refund:{provider}:{ref_id}"), amount).await?; true }
            None => false,
        };
        if status == "success" {
            let points = amount / 10_000 * 100;
            if points > 0 {
                let source = format!("webhook-points:{provider}:{ref_id}");
                let inserted = sqlx::query("INSERT INTO point_awards (source, user_id, points) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING")
                    .bind(&source).bind(user_id).bind(points).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
                if inserted.rows_affected() == 1 {
                    sqlx::query("UPDATE users SET points = points + $2 WHERE id = $1").bind(user_id).bind(points).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
                }
            }
        }
        sqlx::query("INSERT INTO webhook_events (provider, ref_id, status, payload_digest, refunded) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider, ref_id) DO UPDATE SET status = EXCLUDED.status, refunded = EXCLUDED.refunded")
            .bind(provider).bind(ref_id).bind(status).bind(&expected).bind(refunded).execute(&mut *tx).await.map_err(|_| WalletError::Unavailable)?;
        tx.commit().await.map_err(|_| WalletError::Unavailable)?;
        Ok("applied")
    }

    async fn credit_in_tx(&self, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, user_id: Uuid, source: &str, amount: i64) -> Result<i64, WalletError> {
        self.post_in_tx(tx, user_id, source, "credit", 1, amount).await
    }

    async fn debit_in_tx(&self, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, user_id: Uuid, source: &str, amount: i64) -> Result<i64, WalletError> {
        self.post_in_tx(tx, user_id, source, "debit", -1, amount).await
    }

    async fn post_in_tx(&self, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, user_id: Uuid, source: &str, kind: &str, direction: i16, amount: i64) -> Result<i64, WalletError> {
        if amount <= 0 || source.is_empty() { return Err(WalletError::Conflict); }
        let balance: Option<i64> = sqlx::query_scalar("SELECT balance FROM users WHERE id = $1 FOR UPDATE").bind(user_id).fetch_optional(&mut **tx).await.map_err(|_| WalletError::Unavailable)?;
        let Some(balance) = balance else { return Err(WalletError::Conflict); };
        let next = balance + i64::from(direction) * amount;
        if next < 0 { return Err(WalletError::Insufficient); }
        sqlx::query("INSERT INTO ledger_entries (user_id, source, kind, direction, amount, balance_after) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(user_id).bind(source).bind(kind).bind(direction).bind(amount).bind(next).execute(&mut **tx).await.map_err(|_| WalletError::Conflict)?;
        sqlx::query("UPDATE users SET balance = $2, updated_at = now() WHERE id = $1").bind(user_id).bind(next).execute(&mut **tx).await.map_err(|_| WalletError::Unavailable)?;
        Ok(next)
    }
}
pub(crate) fn redact_audit_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(map.into_iter().map(|(key, child)| {
            let normalized = key.to_ascii_lowercase();
            let sensitive = ["password", "token", "secret", "apikey", "credential"].iter().any(|needle| normalized.replace(['_', '-'], "").contains(needle));
            (key, if sensitive { serde_json::Value::String("[redacted]".to_string()) } else { redact_audit_value(child) })
        }).collect()),
        serde_json::Value::Array(items) => serde_json::Value::Array(items.into_iter().map(redact_audit_value).collect()),
        other => other,
    }
}

