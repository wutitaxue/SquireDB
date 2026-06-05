use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub bind_port: u16,
    pub read_only: bool,
    pub allowed_conn_ids: Vec<i64>,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            bind_port: 7421,
            read_only: true,
            allowed_conn_ids: vec![],
        }
    }
}

pub async fn get(pool: &SqlitePool) -> Result<McpSettings, String> {
    let row: Option<(i64, i64, i64, String)> = sqlx::query_as(
        "SELECT enabled, bind_port, read_only, allowed_conn_ids \
         FROM mcp_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("mcp_settings fetch: {e}"))?;

    match row {
        Some((en, port, ro, ids)) => Ok(McpSettings {
            enabled: en != 0,
            bind_port: port.clamp(1, 65535) as u16,
            read_only: ro != 0,
            allowed_conn_ids: serde_json::from_str(&ids).unwrap_or_default(),
        }),
        None => {
            let s = McpSettings::default();
            save(pool, &s).await?;
            Ok(s)
        }
    }
}

pub async fn save(pool: &SqlitePool, s: &McpSettings) -> Result<(), String> {
    let allowed = serde_json::to_string(&s.allowed_conn_ids)
        .unwrap_or_else(|_| "[]".to_string());
    sqlx::query(
        "INSERT INTO mcp_settings (id, enabled, bind_port, read_only, allowed_conn_ids, updated_at) \
         VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT(id) DO UPDATE SET \
            enabled = excluded.enabled, \
            bind_port = excluded.bind_port, \
            read_only = excluded.read_only, \
            allowed_conn_ids = excluded.allowed_conn_ids, \
            updated_at = CURRENT_TIMESTAMP",
    )
    .bind(s.enabled as i64)
    .bind(s.bind_port as i64)
    .bind(s.read_only as i64)
    .bind(&allowed)
    .execute(pool)
    .await
    .map_err(|e| format!("mcp_settings save: {e}"))?;
    Ok(())
}
