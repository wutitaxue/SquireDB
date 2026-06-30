use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::crypto;

use super::{DB_SCHEMA_VERSION, PROTOCOL_VERSION};

#[derive(Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub protocol_version: u32,
    pub db_schema_version: u32,
    pub exported_at: String,
    pub device_name: String,
    pub app_version: String,
    pub connections: Vec<ConnectionEntry>,
    pub projects: Vec<ProjectEntry>,
    pub project_tables: Vec<ProjectTableEntry>,
    pub project_relations: Vec<ProjectRelationEntry>,
    pub schema_relations: Vec<SchemaRelationEntry>,
    pub saved_queries: Vec<SavedQueryEntry>,
    pub ai_models: Vec<AiModelEntry>,
    pub embedding_models: Vec<EmbeddingModelEntry>,
    pub mcp_settings: Option<McpSettingsEntry>,
    pub settings: Vec<SettingEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionEntry {
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub database: Option<String>,
    pub kind: String,
    /// Plaintext password. Encrypted only at rest with machine-key on each side.
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectTableEntry {
    pub project_name: String,
    pub connection_name: String,
    pub database_name: String,
    pub table_name: String,
    pub alias: Option<String>,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRelationEntry {
    pub project_name: String,
    pub from_connection_name: String,
    pub from_db: String,
    pub from_table: String,
    pub from_column: String,
    pub to_connection_name: String,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    pub cardinality: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaRelationEntry {
    pub connection_name: String,
    pub from_db: String,
    pub from_table: String,
    pub from_column: String,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    pub confidence: f64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQueryEntry {
    pub connection_name: String,
    pub name: String,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelEntry {
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub enable_thinking: Option<i64>,
    /// Plaintext API key.
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingModelEntry {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub deployment: String,
    pub api_version: String,
    pub dimensions: Option<i64>,
    /// Plaintext API key.
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpSettingsEntry {
    pub enabled: bool,
    pub bind_port: i64,
    pub read_only: bool,
    /// Original FK was a JSON list of connection ids; re-encoded as connection names
    /// so the foreign references survive id reshuffling on the receiving side.
    pub allowed_conn_names: Vec<String>,
    /// Plaintext MCP token.
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingEntry {
    pub key: String,
    pub value: String,
}

/// Keys with this prefix are local-only (S3 endpoint, AK, SK, device name).
/// They must never travel in the bundle.
pub const SYNC_SETTINGS_PREFIX: &str = "sync.";

pub async fn dump(
    pool: &SqlitePool,
    device_name: &str,
    app_version: &str,
) -> Result<Snapshot, String> {
    let connections = dump_connections(pool).await?;
    let id_to_conn_name = build_id_name_map(
        pool,
        "SELECT id, name FROM connections",
    )
    .await?;
    let id_to_project_name = build_id_name_map(
        pool,
        "SELECT id, name FROM projects",
    )
    .await?;

    let projects = dump_projects(pool).await?;
    let project_tables = dump_project_tables(pool, &id_to_conn_name, &id_to_project_name).await?;
    let project_relations =
        dump_project_relations(pool, &id_to_conn_name, &id_to_project_name).await?;
    let schema_relations = dump_schema_relations(pool, &id_to_conn_name).await?;
    let saved_queries = dump_saved_queries(pool, &id_to_conn_name).await?;
    let ai_models = dump_ai_models(pool).await?;
    let embedding_models = dump_embedding_models(pool).await?;
    let mcp_settings = dump_mcp_settings(pool, &id_to_conn_name).await?;
    let settings = dump_settings(pool).await?;

    Ok(Snapshot {
        protocol_version: PROTOCOL_VERSION,
        db_schema_version: DB_SCHEMA_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        device_name: device_name.to_string(),
        app_version: app_version.to_string(),
        connections,
        projects,
        project_tables,
        project_relations,
        schema_relations,
        saved_queries,
        ai_models,
        embedding_models,
        mcp_settings,
        settings,
    })
}

async fn build_id_name_map(
    pool: &SqlitePool,
    query: &str,
) -> Result<HashMap<i64, String>, String> {
    let rows: Vec<(i64, String)> = sqlx::query_as(query)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("build id->name map: {e}"))?;
    Ok(rows.into_iter().collect())
}

async fn dump_connections(pool: &SqlitePool) -> Result<Vec<ConnectionEntry>, String> {
    let rows: Vec<(i64, String, String, i64, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, name, host, port, username, database, kind FROM connections ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("dump connections: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, name, host, port, username, database, kind) in rows {
        let password = crypto::get_password(pool, id).await.unwrap_or_default();
        out.push(ConnectionEntry {
            name,
            host,
            port,
            username,
            database,
            kind,
            password,
        });
    }
    Ok(out)
}

async fn dump_projects(pool: &SqlitePool) -> Result<Vec<ProjectEntry>, String> {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT name, description FROM projects ORDER BY name")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("dump projects: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(name, description)| ProjectEntry { name, description })
        .collect())
}

async fn dump_project_tables(
    pool: &SqlitePool,
    id_to_conn: &HashMap<i64, String>,
    id_to_project: &HashMap<i64, String>,
) -> Result<Vec<ProjectTableEntry>, String> {
    let rows: Vec<(i64, i64, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT project_id, connection_id, database_name, table_name, alias, is_primary \
         FROM project_tables",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("dump project_tables: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (project_id, connection_id, database_name, table_name, alias, is_primary) in rows {
        let (Some(project_name), Some(connection_name)) = (
            id_to_project.get(&project_id).cloned(),
            id_to_conn.get(&connection_id).cloned(),
        ) else {
            // Orphan row (dangling FK) — skip silently rather than poison the bundle.
            continue;
        };
        out.push(ProjectTableEntry {
            project_name,
            connection_name,
            database_name,
            table_name,
            alias,
            is_primary: is_primary != 0,
        });
    }
    Ok(out)
}

async fn dump_project_relations(
    pool: &SqlitePool,
    id_to_conn: &HashMap<i64, String>,
    id_to_project: &HashMap<i64, String>,
) -> Result<Vec<ProjectRelationEntry>, String> {
    let rows: Vec<(i64, i64, String, String, String, i64, String, String, String, String, String)> =
        sqlx::query_as(
            "SELECT project_id, from_connection_id, from_db, from_table, from_column, \
                    to_connection_id, to_db, to_table, to_column, cardinality, source \
             FROM project_relations",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| format!("dump project_relations: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (
        project_id,
        from_conn_id,
        from_db,
        from_table,
        from_column,
        to_conn_id,
        to_db,
        to_table,
        to_column,
        cardinality,
        source,
    ) in rows
    {
        let (Some(project_name), Some(from_conn), Some(to_conn)) = (
            id_to_project.get(&project_id).cloned(),
            id_to_conn.get(&from_conn_id).cloned(),
            id_to_conn.get(&to_conn_id).cloned(),
        ) else {
            continue;
        };
        out.push(ProjectRelationEntry {
            project_name,
            from_connection_name: from_conn,
            from_db,
            from_table,
            from_column,
            to_connection_name: to_conn,
            to_db,
            to_table,
            to_column,
            cardinality,
            source,
        });
    }
    Ok(out)
}

async fn dump_schema_relations(
    pool: &SqlitePool,
    id_to_conn: &HashMap<i64, String>,
) -> Result<Vec<SchemaRelationEntry>, String> {
    let rows: Vec<(i64, String, String, String, String, String, String, f64, String)> =
        sqlx::query_as(
            "SELECT connection_id, from_db, from_table, from_column, \
                    to_db, to_table, to_column, confidence, source \
             FROM schema_relations",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| format!("dump schema_relations: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (
        connection_id,
        from_db,
        from_table,
        from_column,
        to_db,
        to_table,
        to_column,
        confidence,
        source,
    ) in rows
    {
        let Some(connection_name) = id_to_conn.get(&connection_id).cloned() else {
            continue;
        };
        out.push(SchemaRelationEntry {
            connection_name,
            from_db,
            from_table,
            from_column,
            to_db,
            to_table,
            to_column,
            confidence,
            source,
        });
    }
    Ok(out)
}

async fn dump_saved_queries(
    pool: &SqlitePool,
    id_to_conn: &HashMap<i64, String>,
) -> Result<Vec<SavedQueryEntry>, String> {
    let rows: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT connection_id, name, sql FROM saved_queries")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("dump saved_queries: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (connection_id, name, sql) in rows {
        let Some(connection_name) = id_to_conn.get(&connection_id).cloned() else {
            continue;
        };
        out.push(SavedQueryEntry {
            connection_name,
            name,
            sql,
        });
    }
    Ok(out)
}

async fn dump_ai_models(pool: &SqlitePool) -> Result<Vec<AiModelEntry>, String> {
    let rows: Vec<(i64, String, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, name, base_url, model, enable_thinking FROM ai_models ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("dump ai_models: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, name, base_url, model, enable_thinking) in rows {
        let api_key = crypto::get_ai_model_key(pool, id).await.unwrap_or_default();
        out.push(AiModelEntry {
            name,
            base_url,
            model,
            enable_thinking,
            api_key,
        });
    }
    Ok(out)
}

async fn dump_embedding_models(pool: &SqlitePool) -> Result<Vec<EmbeddingModelEntry>, String> {
    let rows: Vec<(i64, String, String, String, String, String, String, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, name, provider, base_url, model, deployment, api_version, dimensions \
             FROM embedding_models ORDER BY name",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| format!("dump embedding_models: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, name, provider, base_url, model, deployment, api_version, dimensions) in rows {
        let api_key = crypto::get_embedding_model_key(pool, id)
            .await
            .unwrap_or_default();
        out.push(EmbeddingModelEntry {
            name,
            provider,
            base_url,
            model,
            deployment,
            api_version,
            dimensions,
            api_key,
        });
    }
    Ok(out)
}

async fn dump_mcp_settings(
    pool: &SqlitePool,
    id_to_conn: &HashMap<i64, String>,
) -> Result<Option<McpSettingsEntry>, String> {
    let row: Option<(i64, i64, i64, String)> = sqlx::query_as(
        "SELECT enabled, bind_port, read_only, allowed_conn_ids FROM mcp_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("dump mcp_settings: {e}"))?;

    let Some((enabled, bind_port, read_only, allowed_conn_ids_json)) = row else {
        return Ok(None);
    };

    let allowed_ids: Vec<i64> =
        serde_json::from_str(&allowed_conn_ids_json).unwrap_or_default();
    let allowed_conn_names: Vec<String> = allowed_ids
        .into_iter()
        .filter_map(|id| id_to_conn.get(&id).cloned())
        .collect();
    let token = crypto::get_mcp_token(pool).await.unwrap_or_default();

    Ok(Some(McpSettingsEntry {
        enabled: enabled != 0,
        bind_port,
        read_only: read_only != 0,
        allowed_conn_names,
        token,
    }))
}

async fn dump_settings(pool: &SqlitePool) -> Result<Vec<SettingEntry>, String> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM settings")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("dump settings: {e}"))?;
    Ok(rows
        .into_iter()
        .filter(|(k, _)| !k.starts_with(SYNC_SETTINGS_PREFIX))
        .map(|(key, value)| SettingEntry { key, value })
        .collect())
}

// ---- diff / conflict / resolution types ----

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Connection,
    Project,
    ProjectTable,
    ProjectRelation,
    SchemaRelation,
    SavedQuery,
    AiModel,
    EmbeddingModel,
    McpSettings,
    Setting,
}

impl EntryKind {
    fn as_str(&self) -> &'static str {
        match self {
            EntryKind::Connection => "connection",
            EntryKind::Project => "project",
            EntryKind::ProjectTable => "project_table",
            EntryKind::ProjectRelation => "project_relation",
            EntryKind::SchemaRelation => "schema_relation",
            EntryKind::SavedQuery => "saved_query",
            EntryKind::AiModel => "ai_model",
            EntryKind::EmbeddingModel => "embedding_model",
            EntryKind::McpSettings => "mcp_settings",
            EntryKind::Setting => "setting",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conflict {
    pub kind: EntryKind,
    /// Stable identifier (e.g. connection name). Used as part of the resolution lookup key.
    pub local_key: String,
    /// Human-readable diff (field-by-field) for the UI.
    pub diff_lines: Vec<String>,
    pub supports_rename: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AdditionCounts {
    pub connections: usize,
    pub projects: usize,
    pub project_tables: usize,
    pub project_relations: usize,
    pub schema_relations: usize,
    pub saved_queries: usize,
    pub ai_models: usize,
    pub embedding_models: usize,
    pub mcp_settings: usize,
    pub settings: usize,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ConflictReport {
    pub additions: AdditionCounts,
    pub conflicts: Vec<Conflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Resolution {
    Overwrite,
    KeepBothRename { new_name: String },
    Skip,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ResolutionMap {
    /// keyed by "{kind}:{local_key}" — same encoding diff() emits via Conflict.
    pub entries: HashMap<String, Resolution>,
}

impl ResolutionMap {
    fn key(kind: EntryKind, local_key: &str) -> String {
        format!("{}:{}", kind.as_str(), local_key)
    }

    pub fn get(&self, kind: EntryKind, local_key: &str) -> Resolution {
        self.entries
            .get(&Self::key(kind, local_key))
            .cloned()
            .unwrap_or(Resolution::Overwrite)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RestoreReport {
    pub inserted: HashMap<String, usize>,
    pub overwritten: HashMap<String, usize>,
    pub renamed: HashMap<String, usize>,
    pub skipped: HashMap<String, usize>,
    pub warnings: Vec<String>,
}

impl RestoreReport {
    fn bump(map: &mut HashMap<String, usize>, kind: EntryKind) {
        *map.entry(kind.as_str().to_string()).or_default() += 1;
    }
}

// ---- diff ----

pub async fn diff(pool: &SqlitePool, remote: &Snapshot) -> Result<ConflictReport, String> {
    let local = dump(pool, "", "").await?;
    Ok(diff_snapshots(&local, remote))
}

pub fn diff_snapshots(local: &Snapshot, remote: &Snapshot) -> ConflictReport {
    let mut report = ConflictReport::default();
    diff_connections(local, remote, &mut report);
    diff_projects(local, remote, &mut report);
    diff_project_tables(local, remote, &mut report);
    diff_project_relations(local, remote, &mut report);
    diff_schema_relations(local, remote, &mut report);
    diff_saved_queries(local, remote, &mut report);
    diff_ai_models(local, remote, &mut report);
    diff_embedding_models(local, remote, &mut report);
    diff_mcp(local, remote, &mut report);
    diff_settings(local, remote, &mut report);
    report
}

fn fmt_diff_line<T: std::fmt::Debug + PartialEq>(field: &str, l: &T, r: &T) -> Option<String> {
    if l == r {
        None
    } else {
        Some(format!("{field}: {l:?} → {r:?}"))
    }
}

fn diff_connections(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let local_by_name: HashMap<&str, &ConnectionEntry> =
        local.connections.iter().map(|c| (c.name.as_str(), c)).collect();
    for r in &remote.connections {
        match local_by_name.get(r.name.as_str()) {
            None => report.additions.connections += 1,
            Some(l) => {
                let mut diff_lines = Vec::new();
                if let Some(s) = fmt_diff_line("host", &l.host, &r.host) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("port", &l.port, &r.port) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("username", &l.username, &r.username) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("database", &l.database, &r.database) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("kind", &l.kind, &r.kind) {
                    diff_lines.push(s);
                }
                if l.password != r.password {
                    diff_lines.push("password: (changed)".to_string());
                }
                if !diff_lines.is_empty() {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::Connection,
                        local_key: r.name.clone(),
                        diff_lines,
                        supports_rename: true,
                    });
                }
            }
        }
    }
}

fn diff_projects(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let local_by_name: HashMap<&str, &ProjectEntry> =
        local.projects.iter().map(|p| (p.name.as_str(), p)).collect();
    for r in &remote.projects {
        match local_by_name.get(r.name.as_str()) {
            None => report.additions.projects += 1,
            Some(l) => {
                if let Some(line) = fmt_diff_line("description", &l.description, &r.description) {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::Project,
                        local_key: r.name.clone(),
                        diff_lines: vec![line],
                        supports_rename: true,
                    });
                }
            }
        }
    }
}

fn diff_project_tables(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let local_keys: HashSet<String> = local
        .project_tables
        .iter()
        .map(|t| format!("{}|{}|{}", t.project_name, t.database_name, t.table_name))
        .collect();
    let local_by_key: HashMap<String, &ProjectTableEntry> = local
        .project_tables
        .iter()
        .map(|t| {
            (
                format!("{}|{}|{}", t.project_name, t.database_name, t.table_name),
                t,
            )
        })
        .collect();
    for r in &remote.project_tables {
        let key = format!("{}|{}|{}", r.project_name, r.database_name, r.table_name);
        if !local_keys.contains(&key) {
            report.additions.project_tables += 1;
        } else if let Some(l) = local_by_key.get(&key) {
            let mut diff_lines = Vec::new();
            if let Some(s) = fmt_diff_line("connection", &l.connection_name, &r.connection_name) {
                diff_lines.push(s);
            }
            if let Some(s) = fmt_diff_line("alias", &l.alias, &r.alias) {
                diff_lines.push(s);
            }
            if let Some(s) = fmt_diff_line("is_primary", &l.is_primary, &r.is_primary) {
                diff_lines.push(s);
            }
            if !diff_lines.is_empty() {
                report.conflicts.push(Conflict {
                    kind: EntryKind::ProjectTable,
                    local_key: key,
                    diff_lines,
                    supports_rename: false,
                });
            }
        }
    }
}

fn diff_project_relations(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let rel_key = |r: &ProjectRelationEntry| {
        format!(
            "{}|{}.{}.{}|{}.{}.{}",
            r.project_name,
            r.from_db,
            r.from_table,
            r.from_column,
            r.to_db,
            r.to_table,
            r.to_column,
        )
    };
    let local_by_key: HashMap<String, &ProjectRelationEntry> =
        local.project_relations.iter().map(|r| (rel_key(r), r)).collect();
    for r in &remote.project_relations {
        let key = rel_key(r);
        match local_by_key.get(&key) {
            None => report.additions.project_relations += 1,
            Some(l) => {
                let mut diff_lines = Vec::new();
                if let Some(s) =
                    fmt_diff_line("from_conn", &l.from_connection_name, &r.from_connection_name)
                {
                    diff_lines.push(s);
                }
                if let Some(s) =
                    fmt_diff_line("to_conn", &l.to_connection_name, &r.to_connection_name)
                {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("cardinality", &l.cardinality, &r.cardinality) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("source", &l.source, &r.source) {
                    diff_lines.push(s);
                }
                if !diff_lines.is_empty() {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::ProjectRelation,
                        local_key: key,
                        diff_lines,
                        supports_rename: false,
                    });
                }
            }
        }
    }
}

fn diff_schema_relations(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let rel_key = |r: &SchemaRelationEntry| {
        format!(
            "{}|{}.{}.{}|{}.{}.{}",
            r.connection_name,
            r.from_db,
            r.from_table,
            r.from_column,
            r.to_db,
            r.to_table,
            r.to_column,
        )
    };
    let local_by_key: HashMap<String, &SchemaRelationEntry> =
        local.schema_relations.iter().map(|r| (rel_key(r), r)).collect();
    for r in &remote.schema_relations {
        let key = rel_key(r);
        match local_by_key.get(&key) {
            None => report.additions.schema_relations += 1,
            Some(l) => {
                let mut diff_lines = Vec::new();
                if let Some(s) = fmt_diff_line("confidence", &l.confidence, &r.confidence) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("source", &l.source, &r.source) {
                    diff_lines.push(s);
                }
                if !diff_lines.is_empty() {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::SchemaRelation,
                        local_key: key,
                        diff_lines,
                        supports_rename: false,
                    });
                }
            }
        }
    }
}

fn diff_saved_queries(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let key = |q: &SavedQueryEntry| format!("{}|{}", q.connection_name, q.name);
    let local_by_key: HashMap<String, &SavedQueryEntry> =
        local.saved_queries.iter().map(|q| (key(q), q)).collect();
    for r in &remote.saved_queries {
        let k = key(r);
        match local_by_key.get(&k) {
            None => report.additions.saved_queries += 1,
            Some(l) => {
                if let Some(line) = fmt_diff_line("sql", &l.sql, &r.sql) {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::SavedQuery,
                        local_key: k,
                        diff_lines: vec![line],
                        supports_rename: true,
                    });
                }
            }
        }
    }
}

fn diff_ai_models(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let local_by_name: HashMap<&str, &AiModelEntry> =
        local.ai_models.iter().map(|m| (m.name.as_str(), m)).collect();
    for r in &remote.ai_models {
        match local_by_name.get(r.name.as_str()) {
            None => report.additions.ai_models += 1,
            Some(l) => {
                let mut diff_lines = Vec::new();
                if let Some(s) = fmt_diff_line("base_url", &l.base_url, &r.base_url) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("model", &l.model, &r.model) {
                    diff_lines.push(s);
                }
                if let Some(s) =
                    fmt_diff_line("enable_thinking", &l.enable_thinking, &r.enable_thinking)
                {
                    diff_lines.push(s);
                }
                if l.api_key != r.api_key {
                    diff_lines.push("api_key: (changed)".to_string());
                }
                if !diff_lines.is_empty() {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::AiModel,
                        local_key: r.name.clone(),
                        diff_lines,
                        supports_rename: true,
                    });
                }
            }
        }
    }
}

fn diff_embedding_models(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let local_by_name: HashMap<&str, &EmbeddingModelEntry> =
        local.embedding_models.iter().map(|m| (m.name.as_str(), m)).collect();
    for r in &remote.embedding_models {
        match local_by_name.get(r.name.as_str()) {
            None => report.additions.embedding_models += 1,
            Some(l) => {
                let mut diff_lines = Vec::new();
                if let Some(s) = fmt_diff_line("provider", &l.provider, &r.provider) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("base_url", &l.base_url, &r.base_url) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("model", &l.model, &r.model) {
                    diff_lines.push(s);
                }
                if let Some(s) = fmt_diff_line("dimensions", &l.dimensions, &r.dimensions) {
                    diff_lines.push(s);
                }
                if l.api_key != r.api_key {
                    diff_lines.push("api_key: (changed)".to_string());
                }
                if !diff_lines.is_empty() {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::EmbeddingModel,
                        local_key: r.name.clone(),
                        diff_lines,
                        supports_rename: true,
                    });
                }
            }
        }
    }
}

fn diff_mcp(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    match (&local.mcp_settings, &remote.mcp_settings) {
        (None, Some(_)) => report.additions.mcp_settings += 1,
        (Some(l), Some(r)) => {
            let mut diff_lines = Vec::new();
            if let Some(s) = fmt_diff_line("enabled", &l.enabled, &r.enabled) {
                diff_lines.push(s);
            }
            if let Some(s) = fmt_diff_line("bind_port", &l.bind_port, &r.bind_port) {
                diff_lines.push(s);
            }
            if let Some(s) = fmt_diff_line("read_only", &l.read_only, &r.read_only) {
                diff_lines.push(s);
            }
            if let Some(s) =
                fmt_diff_line("allowed_conn_names", &l.allowed_conn_names, &r.allowed_conn_names)
            {
                diff_lines.push(s);
            }
            if l.token != r.token {
                diff_lines.push("token: (changed)".to_string());
            }
            if !diff_lines.is_empty() {
                report.conflicts.push(Conflict {
                    kind: EntryKind::McpSettings,
                    local_key: "default".to_string(),
                    diff_lines,
                    supports_rename: false,
                });
            }
        }
        _ => {}
    }
}

fn diff_settings(local: &Snapshot, remote: &Snapshot, report: &mut ConflictReport) {
    let local_by_key: HashMap<&str, &SettingEntry> =
        local.settings.iter().map(|s| (s.key.as_str(), s)).collect();
    for r in &remote.settings {
        match local_by_key.get(r.key.as_str()) {
            None => report.additions.settings += 1,
            Some(l) => {
                if l.value != r.value {
                    report.conflicts.push(Conflict {
                        kind: EntryKind::Setting,
                        local_key: r.key.clone(),
                        diff_lines: vec![format!("value: {:?} → {:?}", l.value, r.value)],
                        supports_rename: false,
                    });
                }
            }
        }
    }
}

// ---- restore ----

pub async fn restore(
    pool: &SqlitePool,
    snapshot: &Snapshot,
    resolutions: &ResolutionMap,
) -> Result<RestoreReport, String> {
    let mut report = RestoreReport::default();

    // 1. connections
    let mut remote_conn_to_local_id: HashMap<String, i64> = HashMap::new();
    let existing_conn_names: HashSet<String> = sqlx::query_scalar("SELECT name FROM connections")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("scan connections: {e}"))?
        .into_iter()
        .collect();

    for c in &snapshot.connections {
        let exists = existing_conn_names.contains(&c.name);
        if !exists {
            let id = insert_connection(pool, &c.name, c).await?;
            crypto::set_password(pool, id, &c.password).await?;
            remote_conn_to_local_id.insert(c.name.clone(), id);
            RestoreReport::bump(&mut report.inserted, EntryKind::Connection);
            continue;
        }
        match resolutions.get(EntryKind::Connection, &c.name) {
            Resolution::Overwrite => {
                let id = update_connection(pool, &c.name, c).await?;
                crypto::set_password(pool, id, &c.password).await?;
                remote_conn_to_local_id.insert(c.name.clone(), id);
                RestoreReport::bump(&mut report.overwritten, EntryKind::Connection);
            }
            Resolution::KeepBothRename { new_name } => {
                let id = insert_connection(pool, &new_name, c).await?;
                crypto::set_password(pool, id, &c.password).await?;
                remote_conn_to_local_id.insert(c.name.clone(), id);
                RestoreReport::bump(&mut report.renamed, EntryKind::Connection);
            }
            Resolution::Skip => {
                let local_id: Option<i64> =
                    sqlx::query_scalar("SELECT id FROM connections WHERE name = ?")
                        .bind(&c.name)
                        .fetch_optional(pool)
                        .await
                        .map_err(|e| format!("lookup conn id: {e}"))?;
                if let Some(id) = local_id {
                    remote_conn_to_local_id.insert(c.name.clone(), id);
                }
                RestoreReport::bump(&mut report.skipped, EntryKind::Connection);
            }
        }
    }

    // Build a global remote_conn_name -> local_id map including pre-existing local
    // connections that did not appear in the bundle. Needed so downstream FK lookups
    // can resolve names that overlap between sides.
    let all_local_conns: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, name FROM connections")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("scan connections post: {e}"))?;
    for (id, name) in all_local_conns {
        remote_conn_to_local_id.entry(name).or_insert(id);
    }

    // 2. projects
    let mut remote_project_to_local_id: HashMap<String, i64> = HashMap::new();
    let existing_project_names: HashSet<String> = sqlx::query_scalar("SELECT name FROM projects")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("scan projects: {e}"))?
        .into_iter()
        .collect();
    for p in &snapshot.projects {
        let exists = existing_project_names.contains(&p.name);
        if !exists {
            let id = insert_project(pool, &p.name, &p.description).await?;
            remote_project_to_local_id.insert(p.name.clone(), id);
            RestoreReport::bump(&mut report.inserted, EntryKind::Project);
            continue;
        }
        match resolutions.get(EntryKind::Project, &p.name) {
            Resolution::Overwrite => {
                sqlx::query("UPDATE projects SET description = ? WHERE name = ?")
                    .bind(&p.description)
                    .bind(&p.name)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update project: {e}"))?;
                let id: i64 = sqlx::query_scalar("SELECT id FROM projects WHERE name = ?")
                    .bind(&p.name)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| format!("lookup project id: {e}"))?;
                remote_project_to_local_id.insert(p.name.clone(), id);
                RestoreReport::bump(&mut report.overwritten, EntryKind::Project);
            }
            Resolution::KeepBothRename { new_name } => {
                let id = insert_project(pool, &new_name, &p.description).await?;
                remote_project_to_local_id.insert(p.name.clone(), id);
                RestoreReport::bump(&mut report.renamed, EntryKind::Project);
            }
            Resolution::Skip => {
                let id: Option<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE name = ?")
                    .bind(&p.name)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| format!("lookup project id: {e}"))?;
                if let Some(id) = id {
                    remote_project_to_local_id.insert(p.name.clone(), id);
                }
                RestoreReport::bump(&mut report.skipped, EntryKind::Project);
            }
        }
    }
    let all_local_projects: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, name FROM projects")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("scan projects post: {e}"))?;
    for (id, name) in all_local_projects {
        remote_project_to_local_id.entry(name).or_insert(id);
    }

    // 3. project_tables (composite unique key, no rename)
    for t in &snapshot.project_tables {
        let (Some(&project_id), Some(&connection_id)) = (
            remote_project_to_local_id.get(&t.project_name),
            remote_conn_to_local_id.get(&t.connection_name),
        ) else {
            report.warnings.push(format!(
                "project_table {}.{}.{} skipped (missing project or connection)",
                t.project_name, t.database_name, t.table_name
            ));
            continue;
        };

        let existing: Option<(i64, i64, Option<String>, i64)> = sqlx::query_as(
            "SELECT id, connection_id, alias, is_primary FROM project_tables \
             WHERE project_id = ? AND database_name = ? AND table_name = ?",
        )
        .bind(project_id)
        .bind(&t.database_name)
        .bind(&t.table_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("lookup project_table: {e}"))?;

        let local_key = format!("{}|{}|{}", t.project_name, t.database_name, t.table_name);
        match existing {
            None => {
                sqlx::query(
                    "INSERT INTO project_tables \
                     (project_id, connection_id, database_name, table_name, alias, is_primary) \
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(project_id)
                .bind(connection_id)
                .bind(&t.database_name)
                .bind(&t.table_name)
                .bind(&t.alias)
                .bind(if t.is_primary { 1 } else { 0 })
                .execute(pool)
                .await
                .map_err(|e| format!("insert project_table: {e}"))?;
                RestoreReport::bump(&mut report.inserted, EntryKind::ProjectTable);
            }
            Some(_) => match resolutions.get(EntryKind::ProjectTable, &local_key) {
                Resolution::Overwrite | Resolution::KeepBothRename { .. } => {
                    sqlx::query(
                        "UPDATE project_tables SET connection_id = ?, alias = ?, is_primary = ? \
                         WHERE project_id = ? AND database_name = ? AND table_name = ?",
                    )
                    .bind(connection_id)
                    .bind(&t.alias)
                    .bind(if t.is_primary { 1 } else { 0 })
                    .bind(project_id)
                    .bind(&t.database_name)
                    .bind(&t.table_name)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update project_table: {e}"))?;
                    RestoreReport::bump(&mut report.overwritten, EntryKind::ProjectTable);
                }
                Resolution::Skip => {
                    RestoreReport::bump(&mut report.skipped, EntryKind::ProjectTable);
                }
            },
        }
    }

    // 4. project_relations
    for r in &snapshot.project_relations {
        let (Some(&project_id), Some(&from_conn), Some(&to_conn)) = (
            remote_project_to_local_id.get(&r.project_name),
            remote_conn_to_local_id.get(&r.from_connection_name),
            remote_conn_to_local_id.get(&r.to_connection_name),
        ) else {
            report
                .warnings
                .push(format!("project_relation in {} skipped (missing FK)", r.project_name));
            continue;
        };

        let key = format!(
            "{}|{}.{}.{}|{}.{}.{}",
            r.project_name,
            r.from_db,
            r.from_table,
            r.from_column,
            r.to_db,
            r.to_table,
            r.to_column,
        );
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM project_relations WHERE \
             project_id = ? AND from_db = ? AND from_table = ? AND from_column = ? \
             AND to_db = ? AND to_table = ? AND to_column = ?",
        )
        .bind(project_id)
        .bind(&r.from_db)
        .bind(&r.from_table)
        .bind(&r.from_column)
        .bind(&r.to_db)
        .bind(&r.to_table)
        .bind(&r.to_column)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("lookup project_relation: {e}"))?;

        match exists {
            None => {
                sqlx::query(
                    "INSERT INTO project_relations \
                     (project_id, from_connection_id, from_db, from_table, from_column, \
                      to_connection_id, to_db, to_table, to_column, cardinality, source) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(project_id)
                .bind(from_conn)
                .bind(&r.from_db)
                .bind(&r.from_table)
                .bind(&r.from_column)
                .bind(to_conn)
                .bind(&r.to_db)
                .bind(&r.to_table)
                .bind(&r.to_column)
                .bind(&r.cardinality)
                .bind(&r.source)
                .execute(pool)
                .await
                .map_err(|e| format!("insert project_relation: {e}"))?;
                RestoreReport::bump(&mut report.inserted, EntryKind::ProjectRelation);
            }
            Some(_) => match resolutions.get(EntryKind::ProjectRelation, &key) {
                Resolution::Overwrite | Resolution::KeepBothRename { .. } => {
                    sqlx::query(
                        "UPDATE project_relations SET from_connection_id = ?, to_connection_id = ?, \
                                cardinality = ?, source = ? \
                         WHERE project_id = ? AND from_db = ? AND from_table = ? AND from_column = ? \
                         AND to_db = ? AND to_table = ? AND to_column = ?",
                    )
                    .bind(from_conn)
                    .bind(to_conn)
                    .bind(&r.cardinality)
                    .bind(&r.source)
                    .bind(project_id)
                    .bind(&r.from_db)
                    .bind(&r.from_table)
                    .bind(&r.from_column)
                    .bind(&r.to_db)
                    .bind(&r.to_table)
                    .bind(&r.to_column)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update project_relation: {e}"))?;
                    RestoreReport::bump(&mut report.overwritten, EntryKind::ProjectRelation);
                }
                Resolution::Skip => {
                    RestoreReport::bump(&mut report.skipped, EntryKind::ProjectRelation);
                }
            },
        }
    }

    // 5. schema_relations
    for r in &snapshot.schema_relations {
        let Some(&connection_id) = remote_conn_to_local_id.get(&r.connection_name) else {
            report
                .warnings
                .push(format!("schema_relation on {} skipped (missing conn)", r.connection_name));
            continue;
        };
        let key = format!(
            "{}|{}.{}.{}|{}.{}.{}",
            r.connection_name,
            r.from_db,
            r.from_table,
            r.from_column,
            r.to_db,
            r.to_table,
            r.to_column,
        );
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM schema_relations WHERE \
             connection_id = ? AND from_db = ? AND from_table = ? AND from_column = ? \
             AND to_db = ? AND to_table = ? AND to_column = ?",
        )
        .bind(connection_id)
        .bind(&r.from_db)
        .bind(&r.from_table)
        .bind(&r.from_column)
        .bind(&r.to_db)
        .bind(&r.to_table)
        .bind(&r.to_column)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("lookup schema_relation: {e}"))?;

        match exists {
            None => {
                sqlx::query(
                    "INSERT INTO schema_relations \
                     (connection_id, from_db, from_table, from_column, \
                      to_db, to_table, to_column, confidence, source) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(connection_id)
                .bind(&r.from_db)
                .bind(&r.from_table)
                .bind(&r.from_column)
                .bind(&r.to_db)
                .bind(&r.to_table)
                .bind(&r.to_column)
                .bind(r.confidence)
                .bind(&r.source)
                .execute(pool)
                .await
                .map_err(|e| format!("insert schema_relation: {e}"))?;
                RestoreReport::bump(&mut report.inserted, EntryKind::SchemaRelation);
            }
            Some(_) => match resolutions.get(EntryKind::SchemaRelation, &key) {
                Resolution::Overwrite | Resolution::KeepBothRename { .. } => {
                    sqlx::query(
                        "UPDATE schema_relations SET confidence = ?, source = ? \
                         WHERE connection_id = ? AND from_db = ? AND from_table = ? AND from_column = ? \
                         AND to_db = ? AND to_table = ? AND to_column = ?",
                    )
                    .bind(r.confidence)
                    .bind(&r.source)
                    .bind(connection_id)
                    .bind(&r.from_db)
                    .bind(&r.from_table)
                    .bind(&r.from_column)
                    .bind(&r.to_db)
                    .bind(&r.to_table)
                    .bind(&r.to_column)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update schema_relation: {e}"))?;
                    RestoreReport::bump(&mut report.overwritten, EntryKind::SchemaRelation);
                }
                Resolution::Skip => {
                    RestoreReport::bump(&mut report.skipped, EntryKind::SchemaRelation);
                }
            },
        }
    }

    // 6. saved_queries
    for q in &snapshot.saved_queries {
        let Some(&connection_id) = remote_conn_to_local_id.get(&q.connection_name) else {
            report
                .warnings
                .push(format!("saved_query {}/{} skipped (missing conn)", q.connection_name, q.name));
            continue;
        };
        let key = format!("{}|{}", q.connection_name, q.name);
        let existing_name: Option<String> = sqlx::query_scalar(
            "SELECT name FROM saved_queries WHERE connection_id = ? AND name = ?",
        )
        .bind(connection_id)
        .bind(&q.name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("lookup saved_query: {e}"))?;

        match existing_name {
            None => {
                sqlx::query(
                    "INSERT INTO saved_queries (connection_id, name, sql) VALUES (?, ?, ?)",
                )
                .bind(connection_id)
                .bind(&q.name)
                .bind(&q.sql)
                .execute(pool)
                .await
                .map_err(|e| format!("insert saved_query: {e}"))?;
                RestoreReport::bump(&mut report.inserted, EntryKind::SavedQuery);
            }
            Some(_) => match resolutions.get(EntryKind::SavedQuery, &key) {
                Resolution::Overwrite => {
                    sqlx::query(
                        "UPDATE saved_queries SET sql = ?, updated_at = CURRENT_TIMESTAMP \
                         WHERE connection_id = ? AND name = ?",
                    )
                    .bind(&q.sql)
                    .bind(connection_id)
                    .bind(&q.name)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update saved_query: {e}"))?;
                    RestoreReport::bump(&mut report.overwritten, EntryKind::SavedQuery);
                }
                Resolution::KeepBothRename { new_name } => {
                    sqlx::query(
                        "INSERT INTO saved_queries (connection_id, name, sql) VALUES (?, ?, ?)",
                    )
                    .bind(connection_id)
                    .bind(&new_name)
                    .bind(&q.sql)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("insert renamed saved_query: {e}"))?;
                    RestoreReport::bump(&mut report.renamed, EntryKind::SavedQuery);
                }
                Resolution::Skip => {
                    RestoreReport::bump(&mut report.skipped, EntryKind::SavedQuery);
                }
            },
        }
    }

    // 7. ai_models
    for m in &snapshot.ai_models {
        let existing_id: Option<i64> =
            sqlx::query_scalar("SELECT id FROM ai_models WHERE name = ?")
                .bind(&m.name)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("lookup ai_model: {e}"))?;
        match existing_id {
            None => {
                let id = insert_ai_model(pool, &m.name, m).await?;
                crypto::set_ai_model_key(pool, id, &m.api_key).await?;
                RestoreReport::bump(&mut report.inserted, EntryKind::AiModel);
            }
            Some(id) => match resolutions.get(EntryKind::AiModel, &m.name) {
                Resolution::Overwrite => {
                    sqlx::query(
                        "UPDATE ai_models SET base_url = ?, model = ?, enable_thinking = ? WHERE id = ?",
                    )
                    .bind(&m.base_url)
                    .bind(&m.model)
                    .bind(m.enable_thinking)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update ai_model: {e}"))?;
                    crypto::set_ai_model_key(pool, id, &m.api_key).await?;
                    RestoreReport::bump(&mut report.overwritten, EntryKind::AiModel);
                }
                Resolution::KeepBothRename { new_name } => {
                    let new_id = insert_ai_model(pool, &new_name, m).await?;
                    crypto::set_ai_model_key(pool, new_id, &m.api_key).await?;
                    RestoreReport::bump(&mut report.renamed, EntryKind::AiModel);
                }
                Resolution::Skip => {
                    RestoreReport::bump(&mut report.skipped, EntryKind::AiModel);
                }
            },
        }
    }

    // 8. embedding_models
    for m in &snapshot.embedding_models {
        let existing_id: Option<i64> =
            sqlx::query_scalar("SELECT id FROM embedding_models WHERE name = ?")
                .bind(&m.name)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("lookup embedding_model: {e}"))?;
        match existing_id {
            None => {
                let id = insert_embedding_model(pool, &m.name, m).await?;
                crypto::set_embedding_model_key(pool, id, &m.api_key).await?;
                RestoreReport::bump(&mut report.inserted, EntryKind::EmbeddingModel);
            }
            Some(id) => match resolutions.get(EntryKind::EmbeddingModel, &m.name) {
                Resolution::Overwrite => {
                    sqlx::query(
                        "UPDATE embedding_models SET provider = ?, base_url = ?, model = ?, \
                                deployment = ?, api_version = ?, dimensions = ? WHERE id = ?",
                    )
                    .bind(&m.provider)
                    .bind(&m.base_url)
                    .bind(&m.model)
                    .bind(&m.deployment)
                    .bind(&m.api_version)
                    .bind(m.dimensions)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update embedding_model: {e}"))?;
                    crypto::set_embedding_model_key(pool, id, &m.api_key).await?;
                    RestoreReport::bump(&mut report.overwritten, EntryKind::EmbeddingModel);
                }
                Resolution::KeepBothRename { new_name } => {
                    let new_id = insert_embedding_model(pool, &new_name, m).await?;
                    crypto::set_embedding_model_key(pool, new_id, &m.api_key).await?;
                    RestoreReport::bump(&mut report.renamed, EntryKind::EmbeddingModel);
                }
                Resolution::Skip => {
                    RestoreReport::bump(&mut report.skipped, EntryKind::EmbeddingModel);
                }
            },
        }
    }

    // 9. mcp_settings (singleton)
    if let Some(m) = &snapshot.mcp_settings {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT id FROM mcp_settings WHERE id = 1")
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("lookup mcp_settings: {e}"))?;
        let allowed_ids: Vec<i64> = m
            .allowed_conn_names
            .iter()
            .filter_map(|n| remote_conn_to_local_id.get(n).copied())
            .collect();
        let allowed_json = serde_json::to_string(&allowed_ids).unwrap_or_else(|_| "[]".to_string());

        let apply = match (exists, resolutions.get(EntryKind::McpSettings, "default")) {
            (None, _) => true,
            (Some(_), Resolution::Overwrite) => true,
            (Some(_), Resolution::KeepBothRename { .. }) => true,
            (Some(_), Resolution::Skip) => false,
        };
        if apply {
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
            .bind(if m.enabled { 1 } else { 0 })
            .bind(m.bind_port)
            .bind(if m.read_only { 1 } else { 0 })
            .bind(&allowed_json)
            .execute(pool)
            .await
            .map_err(|e| format!("upsert mcp_settings: {e}"))?;
            crypto::set_mcp_token(pool, &m.token).await?;
            if exists.is_some() {
                RestoreReport::bump(&mut report.overwritten, EntryKind::McpSettings);
            } else {
                RestoreReport::bump(&mut report.inserted, EntryKind::McpSettings);
            }
        } else {
            RestoreReport::bump(&mut report.skipped, EntryKind::McpSettings);
        }
    }

    // 10. settings (exclude sync.*)
    for s in &snapshot.settings {
        if s.key.starts_with(SYNC_SETTINGS_PREFIX) {
            continue;
        }
        let existing: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
                .bind(&s.key)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("lookup setting: {e}"))?;
        match existing {
            None => {
                sqlx::query(
                    "INSERT INTO settings (key, value, updated_at) \
                     VALUES (?, ?, CURRENT_TIMESTAMP)",
                )
                .bind(&s.key)
                .bind(&s.value)
                .execute(pool)
                .await
                .map_err(|e| format!("insert setting: {e}"))?;
                RestoreReport::bump(&mut report.inserted, EntryKind::Setting);
            }
            Some(local_v) if local_v == s.value => {
                // identical — nothing to do
            }
            Some(_) => match resolutions.get(EntryKind::Setting, &s.key) {
                Resolution::Overwrite | Resolution::KeepBothRename { .. } => {
                    sqlx::query(
                        "UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?",
                    )
                    .bind(&s.value)
                    .bind(&s.key)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("update setting: {e}"))?;
                    RestoreReport::bump(&mut report.overwritten, EntryKind::Setting);
                }
                Resolution::Skip => {
                    RestoreReport::bump(&mut report.skipped, EntryKind::Setting);
                }
            },
        }
    }

    Ok(report)
}

async fn insert_connection(
    pool: &SqlitePool,
    name: &str,
    c: &ConnectionEntry,
) -> Result<i64, String> {
    let result = sqlx::query(
        "INSERT INTO connections (name, host, port, username, database, kind) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(name)
    .bind(&c.host)
    .bind(c.port)
    .bind(&c.username)
    .bind(&c.database)
    .bind(&c.kind)
    .execute(pool)
    .await
    .map_err(|e| format!("insert connection: {e}"))?;
    Ok(result.last_insert_rowid())
}

async fn update_connection(
    pool: &SqlitePool,
    name: &str,
    c: &ConnectionEntry,
) -> Result<i64, String> {
    sqlx::query(
        "UPDATE connections SET host = ?, port = ?, username = ?, database = ?, kind = ? \
         WHERE name = ?",
    )
    .bind(&c.host)
    .bind(c.port)
    .bind(&c.username)
    .bind(&c.database)
    .bind(&c.kind)
    .bind(name)
    .execute(pool)
    .await
    .map_err(|e| format!("update connection: {e}"))?;
    let id: i64 = sqlx::query_scalar("SELECT id FROM connections WHERE name = ?")
        .bind(name)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("lookup connection id: {e}"))?;
    Ok(id)
}

async fn insert_project(
    pool: &SqlitePool,
    name: &str,
    description: &Option<String>,
) -> Result<i64, String> {
    let result =
        sqlx::query("INSERT INTO projects (name, description) VALUES (?, ?)")
            .bind(name)
            .bind(description)
            .execute(pool)
            .await
            .map_err(|e| format!("insert project: {e}"))?;
    Ok(result.last_insert_rowid())
}

async fn insert_ai_model(
    pool: &SqlitePool,
    name: &str,
    m: &AiModelEntry,
) -> Result<i64, String> {
    let result = sqlx::query(
        "INSERT INTO ai_models (name, base_url, model, enable_thinking) VALUES (?, ?, ?, ?)",
    )
    .bind(name)
    .bind(&m.base_url)
    .bind(&m.model)
    .bind(m.enable_thinking)
    .execute(pool)
    .await
    .map_err(|e| format!("insert ai_model: {e}"))?;
    Ok(result.last_insert_rowid())
}

async fn insert_embedding_model(
    pool: &SqlitePool,
    name: &str,
    m: &EmbeddingModelEntry,
) -> Result<i64, String> {
    let result = sqlx::query(
        "INSERT INTO embedding_models \
         (name, provider, base_url, model, deployment, api_version, dimensions) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(name)
    .bind(&m.provider)
    .bind(&m.base_url)
    .bind(&m.model)
    .bind(&m.deployment)
    .bind(&m.api_version)
    .bind(m.dimensions)
    .execute(pool)
    .await
    .map_err(|e| format!("insert embedding_model: {e}"))?;
    Ok(result.last_insert_rowid())
}
