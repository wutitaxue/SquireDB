use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::crypto;
use crate::storage::settings;

use super::s3::S3Config;

const KEY_PROVIDER: &str = "sync.provider";
const KEY_ENDPOINT: &str = "sync.endpoint";
const KEY_REGION: &str = "sync.region";
const KEY_BUCKET: &str = "sync.bucket";
const KEY_ACCESS: &str = "sync.access_key";
const KEY_PATH_STYLE: &str = "sync.path_style";
const KEY_PREFIX: &str = "sync.prefix";
const KEY_DEVICE: &str = "sync.device_name";
const KEY_LAST_PUSHED_AT: &str = "sync.last_pushed_at";
const KEY_LAST_PULLED_AT: &str = "sync.last_pulled_at";
const KEY_LAST_PULLED_FROM: &str = "sync.last_pulled_from";

#[derive(Debug, Clone, Deserialize)]
pub struct SyncConfigInput {
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    /// Empty string / None means "keep the existing stored key".
    #[serde(default)]
    pub secret_key: Option<String>,
    pub path_style: bool,
    pub prefix: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncConfigDisplay {
    pub configured: bool,
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub has_secret_key: bool,
    pub path_style: bool,
    pub prefix: String,
    pub device_name: String,
    pub last_pushed_at: Option<String>,
    pub last_pulled_at: Option<String>,
    pub last_pulled_from: Option<String>,
}

async fn get_opt(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    settings::get(pool, key).await.map_err(|e| e.to_string())
}

async fn set_val(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    settings::set(pool, key, value).await.map_err(|e| e.to_string())
}

pub async fn save(pool: &SqlitePool, input: &SyncConfigInput) -> Result<(), String> {
    set_val(pool, KEY_PROVIDER, &input.provider).await?;
    set_val(pool, KEY_ENDPOINT, &input.endpoint).await?;
    set_val(pool, KEY_REGION, &input.region).await?;
    set_val(pool, KEY_BUCKET, &input.bucket).await?;
    set_val(pool, KEY_ACCESS, &input.access_key).await?;
    set_val(
        pool,
        KEY_PATH_STYLE,
        if input.path_style { "true" } else { "false" },
    )
    .await?;
    set_val(pool, KEY_PREFIX, &input.prefix).await?;
    set_val(pool, KEY_DEVICE, &input.device_name).await?;

    if let Some(sk) = input.secret_key.as_deref() {
        if !sk.is_empty() {
            crypto::set_sync_secret_key(pool, sk).await?;
        }
    }
    Ok(())
}

pub async fn clear(pool: &SqlitePool) -> Result<(), String> {
    for key in [
        KEY_PROVIDER,
        KEY_ENDPOINT,
        KEY_REGION,
        KEY_BUCKET,
        KEY_ACCESS,
        KEY_PATH_STYLE,
        KEY_PREFIX,
        KEY_DEVICE,
        KEY_LAST_PUSHED_AT,
        KEY_LAST_PULLED_AT,
        KEY_LAST_PULLED_FROM,
    ] {
        sqlx::query("DELETE FROM settings WHERE key = ?")
            .bind(key)
            .execute(pool)
            .await
            .map_err(|e| format!("clear {key}: {e}"))?;
    }
    crypto::delete_sync_secret_key(pool).await?;
    Ok(())
}

pub async fn load_display(pool: &SqlitePool) -> Result<SyncConfigDisplay, String> {
    let provider = get_opt(pool, KEY_PROVIDER).await?.unwrap_or_default();
    let endpoint = get_opt(pool, KEY_ENDPOINT).await?.unwrap_or_default();
    let region = get_opt(pool, KEY_REGION).await?.unwrap_or_default();
    let bucket = get_opt(pool, KEY_BUCKET).await?.unwrap_or_default();
    let access_key = get_opt(pool, KEY_ACCESS).await?.unwrap_or_default();
    let path_style = get_opt(pool, KEY_PATH_STYLE)
        .await?
        .map(|v| v == "true")
        .unwrap_or(true);
    let prefix = get_opt(pool, KEY_PREFIX)
        .await?
        .unwrap_or_else(|| "squiredb-sync".to_string());
    let device_name = get_opt(pool, KEY_DEVICE)
        .await?
        .unwrap_or_else(|| default_device_name());
    let last_pushed_at = get_opt(pool, KEY_LAST_PUSHED_AT).await?;
    let last_pulled_at = get_opt(pool, KEY_LAST_PULLED_AT).await?;
    let last_pulled_from = get_opt(pool, KEY_LAST_PULLED_FROM).await?;
    let has_secret_key = crypto::get_sync_secret_key(pool)
        .await?
        .as_deref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    let configured =
        !bucket.is_empty() && !access_key.is_empty() && has_secret_key;

    Ok(SyncConfigDisplay {
        configured,
        provider,
        endpoint,
        region,
        bucket,
        access_key,
        has_secret_key,
        path_style,
        prefix,
        device_name,
        last_pushed_at,
        last_pulled_at,
        last_pulled_from,
    })
}

pub async fn load_full(pool: &SqlitePool) -> Result<S3Config, String> {
    let disp = load_display(pool).await?;
    if !disp.configured {
        return Err("sync is not configured".to_string());
    }
    let secret_key = crypto::get_sync_secret_key(pool)
        .await?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "sync secret key missing".to_string())?;
    Ok(S3Config {
        provider: disp.provider,
        endpoint: disp.endpoint,
        region: disp.region,
        bucket: disp.bucket,
        access_key: disp.access_key,
        secret_key,
        path_style: disp.path_style,
        prefix: disp.prefix,
    })
}

pub async fn mark_pushed(pool: &SqlitePool, ts: &str) -> Result<(), String> {
    set_val(pool, KEY_LAST_PUSHED_AT, ts).await
}

pub async fn mark_pulled(pool: &SqlitePool, ts: &str, from_device: &str) -> Result<(), String> {
    set_val(pool, KEY_LAST_PULLED_AT, ts).await?;
    set_val(pool, KEY_LAST_PULLED_FROM, from_device).await
}

/// Empty placeholder — Tauri frontend uses `@tauri-apps/plugin-os` to populate
/// the actual hostname into the Settings input. Backend doesn't shell out.
fn default_device_name() -> String {
    "SquireDB".to_string()
}
