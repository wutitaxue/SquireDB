use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub bind_port: u16,
    pub read_only: bool,
    pub allowed_conn_ids: Vec<i64>,
    /// Per-database write grants. A write is allowed only when `read_only` is
    /// false AND the target (connection_id, database) has the matching op here.
    #[serde(default)]
    pub write_databases: Vec<WriteDbPerm>,
}

/// A single per-database write grant. `ops` is a subset of
/// {"insert", "update", "delete"}; an empty set means the database is not
/// writable (equivalent to not being listed at all).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDbPerm {
    pub connection_id: i64,
    pub database: String,
    pub ops: Vec<String>,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            bind_port: 7421,
            read_only: true,
            allowed_conn_ids: vec![],
            write_databases: vec![],
        }
    }
}

pub async fn get(pool: &SqlitePool) -> Result<McpSettings, String> {
    let row: Option<(i64, i64, i64, String, String)> = sqlx::query_as(
        "SELECT enabled, bind_port, read_only, allowed_conn_ids, write_databases \
         FROM mcp_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("mcp_settings fetch: {e}"))?;

    match row {
        Some((en, port, ro, ids, wdbs)) => Ok(McpSettings {
            enabled: en != 0,
            bind_port: port.clamp(1, 65535) as u16,
            read_only: ro != 0,
            allowed_conn_ids: serde_json::from_str(&ids).unwrap_or_default(),
            write_databases: serde_json::from_str(&wdbs).unwrap_or_default(),
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
    let write_dbs = serde_json::to_string(&s.write_databases)
        .unwrap_or_else(|_| "[]".to_string());
    sqlx::query(
        "INSERT INTO mcp_settings (id, enabled, bind_port, read_only, allowed_conn_ids, write_databases, updated_at) \
         VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT(id) DO UPDATE SET \
            enabled = excluded.enabled, \
            bind_port = excluded.bind_port, \
            read_only = excluded.read_only, \
            allowed_conn_ids = excluded.allowed_conn_ids, \
            write_databases = excluded.write_databases, \
            updated_at = CURRENT_TIMESTAMP",
    )
    .bind(s.enabled as i64)
    .bind(s.bind_port as i64)
    .bind(s.read_only as i64)
    .bind(&allowed)
    .bind(&write_dbs)
    .execute(pool)
    .await
    .map_err(|e| format!("mcp_settings save: {e}"))?;
    Ok(())
}
