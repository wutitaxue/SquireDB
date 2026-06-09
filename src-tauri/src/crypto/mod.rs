// Machine-bound encrypted secret storage.
//
// Not a true cryptographic boundary against a local attacker: any process able to
// read the SQLite file *and* run the SquireDB binary on the same machine can derive
// the same key. Equivalent in spirit to OS keychain "user is logged in = secrets
// readable". Copying the SQLite file to a different machine will fail to decrypt.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use once_cell::sync::OnceCell;
use rand::RngCore;
use sha2::Sha256;
use sqlx::SqlitePool;

const AI_KEY: &str = "ai:apikey";
const EMBEDDING_KEY: &str = "embedding:apikey";
const MCP_TOKEN: &str = "mcp:token";
const HKDF_INFO: &[u8] = b"squiredb-v1-secret-store";
const HKDF_SALT: &[u8] = b"squiredb-static-salt";

static CIPHER: OnceCell<Aes256Gcm> = OnceCell::new();

fn cipher() -> Result<&'static Aes256Gcm, String> {
    CIPHER.get_or_try_init(|| {
        let uid = machine_uid::get()
            .map_err(|e| format!("machine-uid failed: {e}"))?;
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), uid.as_bytes());
        let mut key_bytes = [0u8; 32];
        hk.expand(HKDF_INFO, &mut key_bytes)
            .map_err(|e| format!("hkdf expand failed: {e}"))?;
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        Ok(Aes256Gcm::new(key))
    })
}

fn encrypt(plaintext: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let c = cipher()?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = c
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("encrypt failed: {e}"))?;
    Ok((nonce_bytes.to_vec(), ct))
}

fn decrypt(nonce_bytes: &[u8], ciphertext: &[u8]) -> Result<String, String> {
    if nonce_bytes.len() != 12 {
        return Err(format!("invalid nonce length: {}", nonce_bytes.len()));
    }
    let c = cipher()?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let pt = c
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt failed: {e}"))?;
    String::from_utf8(pt).map_err(|e| format!("decrypt utf8 failed: {e}"))
}

async fn put(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    let (nonce, ct) = encrypt(value)?;
    sqlx::query(
        "INSERT INTO secrets (key, nonce, ciphertext, updated_at) \
         VALUES (?, ?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT(key) DO UPDATE SET \
           nonce = excluded.nonce, \
           ciphertext = excluded.ciphertext, \
           updated_at = CURRENT_TIMESTAMP",
    )
    .bind(key)
    .bind(&nonce)
    .bind(&ct)
    .execute(pool)
    .await
    .map_err(|e| format!("put secret failed: {e}"))?;
    Ok(())
}

async fn fetch(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    let row: Option<(Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT nonce, ciphertext FROM secrets WHERE key = ?",
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("fetch secret failed: {e}"))?;
    match row {
        Some((nonce, ct)) => Ok(Some(decrypt(&nonce, &ct)?)),
        None => Ok(None),
    }
}

async fn drop_key(pool: &SqlitePool, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM secrets WHERE key = ?")
        .bind(key)
        .execute(pool)
        .await
        .map_err(|e| format!("delete secret failed: {e}"))?;
    Ok(())
}

pub async fn set_password(pool: &SqlitePool, id: i64, password: &str) -> Result<(), String> {
    put(pool, &format!("conn:{id}"), password).await
}

pub async fn get_password(pool: &SqlitePool, id: i64) -> Result<String, String> {
    Ok(fetch(pool, &format!("conn:{id}")).await?.unwrap_or_default())
}

pub async fn delete_password(pool: &SqlitePool, id: i64) -> Result<(), String> {
    drop_key(pool, &format!("conn:{id}")).await
}

/// Legacy single-slot AI key. Retained only so `migrate_legacy_ai_models` can read
/// it on first launch after upgrade. Everywhere else uses `*_ai_model_key(id, …)`.
pub async fn get_ai_key(pool: &SqlitePool) -> Result<String, String> {
    Ok(fetch(pool, AI_KEY).await?.unwrap_or_default())
}

/// Same story for the legacy embedding key.
pub async fn get_embedding_key(pool: &SqlitePool) -> Result<String, String> {
    Ok(fetch(pool, EMBEDDING_KEY).await?.unwrap_or_default())
}

pub async fn set_ai_model_key(pool: &SqlitePool, id: i64, key: &str) -> Result<(), String> {
    put(pool, &format!("ai:apikey:{id}"), key).await
}

pub async fn get_ai_model_key(pool: &SqlitePool, id: i64) -> Result<String, String> {
    Ok(fetch(pool, &format!("ai:apikey:{id}"))
        .await?
        .unwrap_or_default())
}

pub async fn has_ai_model_key(pool: &SqlitePool, id: i64) -> bool {
    matches!(get_ai_model_key(pool, id).await, Ok(ref s) if !s.is_empty())
}

pub async fn delete_ai_model_key(pool: &SqlitePool, id: i64) -> Result<(), String> {
    drop_key(pool, &format!("ai:apikey:{id}")).await
}

pub async fn set_embedding_model_key(
    pool: &SqlitePool,
    id: i64,
    key: &str,
) -> Result<(), String> {
    put(pool, &format!("embedding:apikey:{id}"), key).await
}

pub async fn get_embedding_model_key(pool: &SqlitePool, id: i64) -> Result<String, String> {
    Ok(fetch(pool, &format!("embedding:apikey:{id}"))
        .await?
        .unwrap_or_default())
}

pub async fn has_embedding_model_key(pool: &SqlitePool, id: i64) -> bool {
    matches!(get_embedding_model_key(pool, id).await, Ok(ref s) if !s.is_empty())
}

pub async fn delete_embedding_model_key(pool: &SqlitePool, id: i64) -> Result<(), String> {
    drop_key(pool, &format!("embedding:apikey:{id}")).await
}

pub fn generate_mcp_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub async fn get_mcp_token(pool: &SqlitePool) -> Result<String, String> {
    Ok(fetch(pool, MCP_TOKEN).await?.unwrap_or_default())
}

pub async fn set_mcp_token(pool: &SqlitePool, token: &str) -> Result<(), String> {
    put(pool, MCP_TOKEN, token).await
}

pub async fn ensure_mcp_token(pool: &SqlitePool) -> Result<String, String> {
    let existing = get_mcp_token(pool).await?;
    if !existing.is_empty() {
        return Ok(existing);
    }
    let token = generate_mcp_token();
    set_mcp_token(pool, &token).await?;
    Ok(token)
}
