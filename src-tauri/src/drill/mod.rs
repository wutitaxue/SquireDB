use std::collections::HashMap;
use std::time::Instant;

use redis::aio::ConnectionManager;
use serde::Serialize;
use sqlx::{MySqlPool, SqlitePool};

use crate::cache::{self, CacheValue};
use crate::query;
use crate::storage::{project, project_cache};

const DRILL_LIMIT: i64 = 100;

#[derive(Debug, Serialize)]
pub struct DrillNode {
    pub direction: String,
    pub relation_id: i64,
    pub from_table: String,
    pub from_column: String,
    pub to_connection_id: i64,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    pub cardinality: String,
    pub label: String,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    /// True when the target connection_id is not currently open in the pool
    /// map. The UI uses this to render an "Open connection N" CTA instead
    /// of a generic error.
    pub missing_connection: bool,
}

#[derive(Debug, Serialize)]
pub struct DrillResult {
    pub connection_id: i64,
    pub db: String,
    pub table: String,
    pub column: String,
    pub value: serde_json::Value,
    pub primary: Option<serde_json::Map<String, serde_json::Value>>,
    pub primary_elapsed_ms: u64,
    pub related: Vec<DrillNode>,
    /// Redis cache lookups for the primary row only. Empty when no mapping
    /// targets this table or when no Redis pool is currently open for the
    /// configured `redis_connection_id`.
    pub cache_results: Vec<CacheValue>,
    pub total_elapsed_ms: u64,
}

pub async fn drill(
    pools: &HashMap<i64, MySqlPool>,
    redis_mgrs: &HashMap<i64, ConnectionManager>,
    sqlite: &SqlitePool,
    project_id: i64,
    lookup_connection_id: i64,
    db: &str,
    table: &str,
    column: &str,
    value: &serde_json::Value,
) -> Result<DrillResult, String> {
    let total_start = Instant::now();

    let mysql = pools
        .get(&lookup_connection_id)
        .ok_or_else(|| format!("Connection {} is not open", lookup_connection_id))?;

    let primary_start = Instant::now();
    let primary_sql = format!(
        "SELECT * FROM `{}`.`{}` WHERE `{}` = ? LIMIT 1",
        escape_ident(db),
        escape_ident(table),
        escape_ident(column),
    );
    let bound = bind_value(sqlx::query(&primary_sql), value);
    let primary_rows = bound
        .fetch_all(mysql)
        .await
        .map_err(|e| format!("fetch primary failed: {e}"))?;
    let primary = primary_rows.first().map(query::row_to_object);
    let primary_elapsed_ms = primary_start.elapsed().as_millis() as u64;

    let mut related = Vec::new();
    let mut cache_results: Vec<CacheValue> = Vec::new();
    if let Some(primary_obj) = primary.as_ref() {
        // Cache mappings — only fired against the primary row (by design,
        // to keep Redis QPS bounded regardless of drill graph width).
        let mappings =
            project_cache::list_for_table(sqlite, project_id, lookup_connection_id, db, table)
                .await
                .map_err(|e| format!("list project cache mappings failed: {e}"))?;
        for m in mappings {
            match redis_mgrs.get(&m.redis_connection_id) {
                Some(mgr) => {
                    cache_results.push(cache::fetch_one(mgr, &m, primary_obj).await);
                }
                None => {
                    // Surface so the UI can hint "open redis conn N" without
                    // failing the whole drill.
                    cache_results.push(CacheValue {
                        mapping_id: m.id,
                        label: m.label.clone(),
                        command: m.command.clone(),
                        key: m.key_pattern.clone(),
                        ttl_seconds: None,
                        exists: false,
                        truncated: false,
                        string_value: None,
                        hash_value: None,
                        list_value: None,
                        set_value: None,
                        zset_value: None,
                        error: Some(format!(
                            "Redis connection {} is not open",
                            m.redis_connection_id
                        )),
                    });
                }
            }
        }

        let relations = project::list_relations(sqlite, project_id)
            .await
            .map_err(|e| format!("list project relations failed: {e}"))?;

        let mut jobs: Vec<DrillJob> = Vec::new();
        for r in relations {
            let outgoing_match = r.from_connection_id == lookup_connection_id
                && r.from_db == db
                && r.from_table == table;
            let incoming_match = r.to_connection_id == lookup_connection_id
                && r.to_db == db
                && r.to_table == table;

            if outgoing_match {
                if let Some(v) = primary_obj.get(&r.from_column) {
                    if !v.is_null() {
                        jobs.push(DrillJob {
                            direction: "outgoing".to_string(),
                            relation_id: r.id,
                            from_table: format!("{}.{}", r.from_db, r.from_table),
                            from_column: r.from_column.clone(),
                            target_connection_id: r.to_connection_id,
                            target_db: r.to_db.clone(),
                            target_table: r.to_table.clone(),
                            target_column: r.to_column.clone(),
                            cardinality: r.cardinality.clone(),
                            value: v.clone(),
                        });
                    }
                }
            } else if incoming_match {
                if let Some(v) = primary_obj.get(&r.to_column) {
                    if !v.is_null() {
                        jobs.push(DrillJob {
                            direction: "incoming".to_string(),
                            relation_id: r.id,
                            from_table: format!("{}.{}", r.to_db, r.to_table),
                            from_column: r.to_column.clone(),
                            target_connection_id: r.from_connection_id,
                            target_db: r.from_db.clone(),
                            target_table: r.from_table.clone(),
                            target_column: r.from_column.clone(),
                            cardinality: invert_cardinality(&r.cardinality),
                            value: v.clone(),
                        });
                    }
                }
            }
        }

        for j in jobs {
            let pool_for_target = pools.get(&j.target_connection_id).cloned();
            related.push(execute_job(pool_for_target.as_ref(), j).await);
        }
    }

    Ok(DrillResult {
        connection_id: lookup_connection_id,
        db: db.to_string(),
        table: table.to_string(),
        column: column.to_string(),
        value: value.clone(),
        primary,
        primary_elapsed_ms,
        related,
        cache_results,
        total_elapsed_ms: total_start.elapsed().as_millis() as u64,
    })
}

struct DrillJob {
    direction: String,
    relation_id: i64,
    from_table: String,
    from_column: String,
    target_connection_id: i64,
    target_db: String,
    target_table: String,
    target_column: String,
    cardinality: String,
    value: serde_json::Value,
}

async fn execute_job(pool: Option<&MySqlPool>, job: DrillJob) -> DrillNode {
    let start = Instant::now();
    let label = format!(
        "{}.{} → {}.{}.{}",
        job.from_table, job.from_column, job.target_db, job.target_table, job.target_column,
    );

    // Cross-connection target with no open pool — surface this distinctly
    // so the UI can render an "Open connection N" prompt rather than a
    // generic error.
    let pool = match pool {
        Some(p) => p,
        None => {
            return DrillNode {
                direction: job.direction,
                relation_id: job.relation_id,
                from_table: job.from_table,
                from_column: job.from_column,
                to_connection_id: job.target_connection_id,
                to_db: job.target_db,
                to_table: job.target_table,
                to_column: job.target_column,
                cardinality: job.cardinality,
                label,
                rows: Vec::new(),
                truncated: false,
                elapsed_ms: 0,
                error: Some(format!(
                    "Connection {} is not open — open it to load this section",
                    job.target_connection_id
                )),
                missing_connection: true,
            };
        }
    };

    let sql = format!(
        "SELECT * FROM `{}`.`{}` WHERE `{}` = ? LIMIT {}",
        escape_ident(&job.target_db),
        escape_ident(&job.target_table),
        escape_ident(&job.target_column),
        DRILL_LIMIT + 1
    );
    let bound = bind_value(sqlx::query(&sql), &job.value);
    let result = bound.fetch_all(pool).await;

    match result {
        Ok(rows) => {
            let truncated = rows.len() as i64 > DRILL_LIMIT;
            let take: Vec<_> = rows
                .iter()
                .take(DRILL_LIMIT as usize)
                .map(query::row_to_object)
                .collect();
            DrillNode {
                direction: job.direction,
                relation_id: job.relation_id,
                from_table: job.from_table,
                from_column: job.from_column,
                to_connection_id: job.target_connection_id,
                to_db: job.target_db,
                to_table: job.target_table,
                to_column: job.target_column,
                cardinality: job.cardinality,
                label,
                rows: take,
                truncated,
                elapsed_ms: start.elapsed().as_millis() as u64,
                error: None,
                missing_connection: false,
            }
        }
        Err(e) => DrillNode {
            direction: job.direction,
            relation_id: job.relation_id,
            from_table: job.from_table,
            from_column: job.from_column,
            to_connection_id: job.target_connection_id,
            to_db: job.target_db,
            to_table: job.target_table,
            to_column: job.target_column,
            cardinality: job.cardinality,
            label,
            rows: Vec::new(),
            truncated: false,
            elapsed_ms: start.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
            missing_connection: false,
        },
    }
}

fn escape_ident(s: &str) -> String {
    s.replace('`', "``")
}

fn invert_cardinality(c: &str) -> String {
    match c {
        "1-N" => "N-1".to_string(),
        "N-1" => "1-N".to_string(),
        other => other.to_string(),
    }
}

fn bind_value<'a>(
    q: sqlx::query::Query<'a, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    v: &'a serde_json::Value,
) -> sqlx::query::Query<'a, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    match v {
        serde_json::Value::Number(n) if n.is_i64() => q.bind(n.as_i64().unwrap()),
        serde_json::Value::Number(n) if n.is_u64() => q.bind(n.as_u64().unwrap() as i64),
        serde_json::Value::Number(n) => q.bind(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::Bool(b) => q.bind(*b),
        serde_json::Value::String(s) => q.bind(s.clone()),
        _ => q.bind::<Option<String>>(None),
    }
}
