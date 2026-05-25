use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Column, MySqlPool, Row, SqlitePool};
use std::collections::BTreeSet;

use crate::ai;
use crate::storage::repair as repair_storage;
use crate::storage::repair::RepairSession;

pub const STATE_INVESTIGATING: &str = "investigating";
pub const STATE_PROPOSING: &str = "proposing";
pub const STATE_AWAITING_APPROVAL: &str = "awaiting_approval";
pub const STATE_BACKING_UP: &str = "backing_up";
pub const STATE_AWAITING_FINAL: &str = "awaiting_final";
pub const STATE_EXECUTING: &str = "executing";
pub const STATE_DONE: &str = "done";
pub const STATE_FAILED: &str = "failed";
pub const STATE_CANCELLED: &str = "cancelled";

const INVESTIGATION_ROW_LIMIT: i64 = 100;
const INVESTIGATION_MAX_QUERIES: usize = 8;
const FORBIDDEN_KEYWORDS: &[&str] = &[
    "insert", "update", "delete", "drop", "alter", "truncate", "rename",
    "create", "grant", "revoke", "replace", "call", "lock", "unlock",
    "load", "set", "do",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvestigationQuery {
    pub purpose: String,
    pub sql: String,
    pub rows: Vec<serde_json::Value>,
    pub row_count: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Investigation {
    pub queries: Vec<InvestigationQuery>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Strategy {
    pub kind: String,                  // "delete" | "update"
    pub target_table: String,
    pub strategy_summary: String,
    pub final_sql: String,
    pub estimated_rows: i64,
    pub count_probe_sql: String,
    pub risks: Vec<String>,
    pub where_clause: String,          // extracted for backup
}

/// Stage 1+2 combined: insert session, ask AI for SELECTs, validate, run, store.
pub async fn start_session(
    sqlite: &SqlitePool,
    mysql: &MySqlPool,
    ai_cfg: &ai::AiConfig,
    api_key: &str,
    connection_id: i64,
    database: &str,
    scope_tables: Option<&[String]>,
    goal: &str,
) -> Result<RepairSession, String> {
    let goal_trimmed = goal.trim();
    if goal_trimmed.is_empty() {
        return Err("Goal is required.".into());
    }
    if goal_trimmed.chars().count() > 800 {
        return Err("Goal too long (≤ 800 chars).".into());
    }

    let scope_json = scope_tables
        .map(|s| serde_json::to_string(s).unwrap_or_default());

    let session_id = repair_storage::insert(
        sqlite,
        connection_id,
        database,
        scope_json.as_deref(),
        goal_trimmed,
        STATE_INVESTIGATING,
    )
    .await
    .map_err(|e| format!("create session failed: {e}"))?;

    // Build schema brief for AI from scope tables (or all tables if scope is empty).
    let schema_block = build_schema_block(mysql, database, scope_tables).await?;

    let ai_queries = match ai::repair_investigate(
        ai_cfg,
        api_key,
        goal_trimmed,
        database,
        &schema_block,
    )
    .await
    {
        Ok(q) => q,
        Err(e) => {
            let _ = repair_storage::set_error(sqlite, session_id, &e, STATE_FAILED).await;
            return Err(e);
        }
    };

    let mut investigation = Investigation {
        queries: Vec::new(),
    };

    for q in ai_queries.into_iter().take(INVESTIGATION_MAX_QUERIES) {
        let mut sanitized = match sanitize_select(&q.sql) {
            Ok(s) => s,
            Err(e) => {
                investigation.queries.push(InvestigationQuery {
                    purpose: q.purpose,
                    sql: q.sql,
                    rows: Vec::new(),
                    row_count: 0,
                    truncated: false,
                    elapsed_ms: 0,
                    error: Some(format!("rejected: {e}")),
                });
                continue;
            }
        };
        sanitized = enforce_limit(&sanitized, INVESTIGATION_ROW_LIMIT);

        let start = std::time::Instant::now();
        match run_select_capture(mysql, &sanitized).await {
            Ok((rows, row_count)) => {
                let truncated = row_count as i64 >= INVESTIGATION_ROW_LIMIT;
                investigation.queries.push(InvestigationQuery {
                    purpose: q.purpose,
                    sql: sanitized,
                    rows,
                    row_count,
                    truncated,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    error: None,
                });
            }
            Err(e) => {
                investigation.queries.push(InvestigationQuery {
                    purpose: q.purpose,
                    sql: sanitized,
                    rows: Vec::new(),
                    row_count: 0,
                    truncated: false,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    error: Some(e),
                });
            }
        }
    }

    let json = serde_json::to_string(&investigation)
        .map_err(|e| format!("serialize investigation failed: {e}"))?;
    repair_storage::set_investigation(sqlite, session_id, &json, STATE_PROPOSING)
        .await
        .map_err(|e| format!("save investigation failed: {e}"))?;

    repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("reload session failed: {e}"))
}

/// Stage 3: AI proposes strategy + COUNT(*) probe.
pub async fn propose_strategy(
    sqlite: &SqlitePool,
    mysql: &MySqlPool,
    ai_cfg: &ai::AiConfig,
    api_key: &str,
    session_id: i64,
) -> Result<RepairSession, String> {
    let session = repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    if session.state != STATE_PROPOSING {
        return Err(format!(
            "Cannot propose: session is in state '{}', expected '{}'.",
            session.state, STATE_PROPOSING
        ));
    }
    let investigation_json = session
        .investigation_json
        .clone()
        .ok_or_else(|| "Investigation results missing.".to_string())?;

    let scope_tables = parse_scope(&session);
    let schema_block = build_schema_block(
        mysql,
        &session.database_name,
        scope_tables.as_deref(),
    )
    .await?;

    let ai_strategy = match ai::repair_strategy(
        ai_cfg,
        api_key,
        &session.goal,
        &session.database_name,
        &schema_block,
        &investigation_json,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = repair_storage::set_error(sqlite, session_id, &e, STATE_FAILED).await;
            return Err(e);
        }
    };

    let strategy = validate_strategy(ai_strategy)?;

    // Run COUNT(*) probe with timeout (regular execution; safety guard already validates SELECT).
    let estimated_rows: i64 = sqlx::query_scalar(&strategy.count_probe_sql)
        .fetch_one(mysql)
        .await
        .map_err(|e| format!("count probe failed: {e}"))?;

    let mut strategy = strategy;
    strategy.estimated_rows = estimated_rows;

    let json = serde_json::to_string(&strategy)
        .map_err(|e| format!("serialize strategy failed: {e}"))?;
    repair_storage::set_strategy(sqlite, session_id, &json, STATE_AWAITING_APPROVAL)
        .await
        .map_err(|e| format!("save strategy failed: {e}"))?;

    repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("reload session failed: {e}"))
}

/// Stage 4: user approves → state moves to backing_up. No DB writes here.
pub async fn approve_strategy(
    sqlite: &SqlitePool,
    session_id: i64,
) -> Result<RepairSession, String> {
    let session = repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    if session.state != STATE_AWAITING_APPROVAL {
        return Err(format!(
            "Cannot approve: session is in state '{}', expected '{}'.",
            session.state, STATE_AWAITING_APPROVAL
        ));
    }
    repair_storage::update_state(sqlite, session_id, STATE_BACKING_UP)
        .await
        .map_err(|e| format!("update state failed: {e}"))?;
    repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("reload failed: {e}"))
}

/// Stage 5: server creates backup table.
pub async fn create_backup(
    sqlite: &SqlitePool,
    mysql: &MySqlPool,
    session_id: i64,
) -> Result<RepairSession, String> {
    let session = repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    if session.state != STATE_BACKING_UP {
        return Err(format!(
            "Cannot back up: session is in state '{}', expected '{}'.",
            session.state, STATE_BACKING_UP
        ));
    }
    let strategy: Strategy = serde_json::from_str(
        session
            .strategy_json
            .as_deref()
            .ok_or_else(|| "Strategy missing.".to_string())?,
    )
    .map_err(|e| format!("parse strategy: {e}"))?;

    let stamp = Utc::now().format("%Y%m%d%H%M%S");
    let mut backup_name = format!("{}_repair_backup_{}", strategy.target_table, stamp);
    if backup_name.len() > 64 {
        backup_name = backup_name.chars().take(64).collect();
    }
    if !is_safe_ident(&backup_name) || !is_safe_ident(&strategy.target_table) {
        return Err("Unsafe identifier — refusing to create backup.".into());
    }
    if !is_safe_ident(&session.database_name) {
        return Err("Unsafe database name.".into());
    }

    let exists_sql = "SELECT COUNT(*) FROM information_schema.TABLES \
                      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";
    let exists_count: i64 = sqlx::query_scalar(exists_sql)
        .bind(&session.database_name)
        .bind(&backup_name)
        .fetch_one(mysql)
        .await
        .map_err(|e| format!("check backup table existence: {e}"))?;
    if exists_count > 0 {
        return Err(format!("Backup table `{backup_name}` already exists."));
    }

    let create_sql = format!(
        "CREATE TABLE `{}`.`{}` AS SELECT * FROM `{}`.`{}` WHERE {}",
        session.database_name,
        backup_name,
        session.database_name,
        strategy.target_table,
        strategy.where_clause,
    );

    sqlx::query(&create_sql)
        .execute(mysql)
        .await
        .map_err(|e| format!("backup CREATE TABLE failed: {e}"))?;

    repair_storage::set_backup(sqlite, session_id, &backup_name, STATE_AWAITING_FINAL)
        .await
        .map_err(|e| format!("save backup info failed: {e}"))?;
    repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("reload failed: {e}"))
}

/// Stage 6: execute the final DELETE/UPDATE inside a transaction.
/// `confirm_text` MUST equal "CONFIRM" exactly.
pub async fn execute(
    sqlite: &SqlitePool,
    mysql: &MySqlPool,
    session_id: i64,
    confirm_text: &str,
) -> Result<RepairSession, String> {
    if confirm_text != "CONFIRM" {
        return Err("Confirmation text must be exactly: CONFIRM".into());
    }
    let session = repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    if session.state != STATE_AWAITING_FINAL {
        return Err(format!(
            "Cannot execute: session is in state '{}', expected '{}'.",
            session.state, STATE_AWAITING_FINAL
        ));
    }
    if session.backup_table_name.is_none() {
        return Err("Backup table missing — refusing to execute.".into());
    }
    let strategy: Strategy = serde_json::from_str(
        session
            .strategy_json
            .as_deref()
            .ok_or_else(|| "Strategy missing.".to_string())?,
    )
    .map_err(|e| format!("parse strategy: {e}"))?;

    // Re-validate before run.
    validate_final_sql(&strategy.final_sql)?;

    repair_storage::update_state(sqlite, session_id, STATE_EXECUTING)
        .await
        .ok();

    let mut tx = mysql
        .begin()
        .await
        .map_err(|e| format!("begin tx failed: {e}"))?;
    let exec = sqlx::query(&strategy.final_sql).execute(&mut *tx).await;

    match exec {
        Ok(r) => {
            tx.commit()
                .await
                .map_err(|e| format!("commit failed: {e}"))?;
            let rows = r.rows_affected() as i64;
            repair_storage::set_executed(
                sqlite,
                session_id,
                &strategy.final_sql,
                rows,
                STATE_DONE,
            )
            .await
            .ok();
        }
        Err(e) => {
            tx.rollback().await.ok();
            let msg = format!("execute failed (rolled back): {e}");
            let _ = repair_storage::set_error(sqlite, session_id, &msg, STATE_FAILED).await;
            return Err(msg);
        }
    }
    repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("reload failed: {e}"))
}

pub async fn cancel(sqlite: &SqlitePool, session_id: i64) -> Result<RepairSession, String> {
    let session = repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    if matches!(
        session.state.as_str(),
        STATE_DONE | STATE_FAILED | STATE_CANCELLED
    ) {
        return Err(format!("Already in terminal state: {}", session.state));
    }
    repair_storage::update_state(sqlite, session_id, STATE_CANCELLED)
        .await
        .map_err(|e| format!("update state failed: {e}"))?;
    repair_storage::get(sqlite, session_id)
        .await
        .map_err(|e| format!("reload failed: {e}"))
}

// ===== validation helpers =====

fn sanitize_select(sql: &str) -> Result<String, String> {
    let trimmed = sql.trim().trim_end_matches(';').trim().to_string();
    if trimmed.is_empty() {
        return Err("empty SQL".into());
    }
    if trimmed.contains(';') {
        return Err("multiple statements not allowed".into());
    }
    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("select ") || lower.starts_with("select\n") || lower.starts_with("with ") || lower.starts_with("with\n")) {
        return Err("must start with SELECT or WITH".into());
    }
    for kw in FORBIDDEN_KEYWORDS {
        if contains_word(&lower, kw) {
            return Err(format!("forbidden keyword '{kw}'"));
        }
    }
    Ok(trimmed)
}

fn enforce_limit(sql: &str, limit: i64) -> String {
    let lower = sql.to_lowercase();
    if lower.contains(" limit ") || lower.ends_with("limit") {
        return sql.to_string();
    }
    format!("{sql} LIMIT {limit}")
}

fn validate_final_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim().trim_end_matches(';').trim().to_string();
    if trimmed.is_empty() {
        return Err("Final SQL is empty.".into());
    }
    if trimmed.contains(';') {
        return Err("Final SQL must be a single statement.".into());
    }
    let lower = trimmed.to_lowercase();
    let is_delete = lower.starts_with("delete from ") || lower.starts_with("delete\n");
    let is_update = lower.starts_with("update ");
    if !is_delete && !is_update {
        return Err("Final SQL must start with DELETE FROM or UPDATE.".into());
    }
    if !contains_word(&lower, "where") {
        return Err("Final SQL must contain a WHERE clause (refusing mass operation).".into());
    }
    Ok(())
}

fn validate_strategy(s: ai::RepairStrategy) -> Result<Strategy, String> {
    let kind = s.kind.to_lowercase();
    if kind != "delete" && kind != "update" {
        return Err(format!("Unsupported strategy kind: {kind}"));
    }
    let target_table = s.target_table.trim().to_string();
    if !is_safe_ident(&target_table) {
        return Err(format!("Unsafe target table identifier: {target_table}"));
    }
    let where_clause = s.where_clause.trim().to_string();
    if where_clause.is_empty() {
        return Err("Strategy WHERE clause is empty.".into());
    }
    if where_clause.contains(';') {
        return Err("WHERE clause must not contain semicolons.".into());
    }
    validate_final_sql(&s.final_sql)?;
    // Sanity: count_probe_sql must be SELECT
    sanitize_select(&s.count_probe_sql)
        .map_err(|e| format!("count probe rejected: {e}"))?;
    Ok(Strategy {
        kind,
        target_table,
        strategy_summary: s.strategy_summary,
        final_sql: s.final_sql,
        estimated_rows: 0,
        count_probe_sql: s.count_probe_sql,
        risks: s.risks,
        where_clause,
    })
}

fn is_safe_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn contains_word(haystack: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let wb = word.as_bytes();
    let n = bytes.len();
    let m = wb.len();
    if m > n {
        return false;
    }
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut i = 0;
    while i + m <= n {
        if &bytes[i..i + m] == wb {
            let left_ok = i == 0 || !is_ident(bytes[i - 1]);
            let right_ok = i + m == n || !is_ident(bytes[i + m]);
            if left_ok && right_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn parse_scope(session: &RepairSession) -> Option<Vec<String>> {
    session
        .scope_tables_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .filter(|v| !v.is_empty())
}

async fn build_schema_block(
    mysql: &MySqlPool,
    database: &str,
    scope_tables: Option<&[String]>,
) -> Result<String, String> {
    let scope_set: Option<BTreeSet<String>> = scope_tables.map(|s| s.iter().cloned().collect());

    let (tables_sql, args_count): (String, usize) = if let Some(set) = &scope_set {
        let placeholders = vec!["?"; set.len()].join(",");
        (
            format!(
                "SELECT CAST(TABLE_NAME AS CHAR), CAST(IFNULL(TABLE_COMMENT,'') AS CHAR) \
                 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) \
                 ORDER BY TABLE_NAME"
            ),
            set.len(),
        )
    } else {
        (
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(IFNULL(TABLE_COMMENT,'') AS CHAR) \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
             ORDER BY TABLE_NAME LIMIT 30"
                .to_string(),
            0,
        )
    };
    let mut tq = sqlx::query_as::<_, (String, String)>(&tables_sql).bind(database);
    if let Some(set) = &scope_set {
        for n in set {
            tq = tq.bind(n);
        }
    }
    let table_rows = tq
        .fetch_all(mysql)
        .await
        .map_err(|e| format!("fetch tables: {e}"))?;
    let _ = args_count;

    if table_rows.is_empty() {
        return Err("No tables found in scope.".into());
    }

    let placeholders = vec!["?"; table_rows.len()].join(",");
    let col_sql = format!(
        "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                CAST(COLUMN_TYPE AS CHAR), CAST(COLUMN_KEY AS CHAR), \
                CAST(IFNULL(COLUMN_COMMENT,'') AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) \
         ORDER BY TABLE_NAME, ORDINAL_POSITION"
    );
    let mut cq = sqlx::query_as::<_, (String, String, String, String, String)>(&col_sql)
        .bind(database);
    for (t, _) in &table_rows {
        cq = cq.bind(t);
    }
    let col_rows = cq.fetch_all(mysql).await.unwrap_or_default();

    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "Database: `{database}`");
    for (t, cmt) in &table_rows {
        let _ = writeln!(
            out,
            "\nTable `{t}`{}",
            if cmt.is_empty() {
                String::new()
            } else {
                format!(" — {cmt}")
            }
        );
        for (tname, col, ty, key, comment) in &col_rows {
            if tname != t {
                continue;
            }
            let mut tags = Vec::new();
            if key == "PRI" {
                tags.push("PK");
            } else if !key.is_empty() {
                tags.push(key.as_str());
            }
            let tag_str = if tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", tags.join(","))
            };
            let cmt = if comment.is_empty() {
                String::new()
            } else {
                format!(" -- {comment}")
            };
            let _ = writeln!(out, "  {col} {ty}{tag_str}{cmt}");
        }
    }
    Ok(out)
}

async fn run_select_capture(
    pool: &MySqlPool,
    sql: &str,
) -> Result<(Vec<serde_json::Value>, usize), String> {
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("query failed: {e}"))?;
    let count = rows.len();
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(count);
    for r in rows {
        let mut obj = serde_json::Map::new();
        for (i, col) in r.columns().iter().enumerate() {
            let name = col.name().to_string();
            let val: serde_json::Value = if let Ok(v) = r.try_get::<Option<String>, _>(i) {
                v.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
            } else if let Ok(v) = r.try_get::<Option<i64>, _>(i) {
                v.map(|x| serde_json::Value::Number(x.into()))
                    .unwrap_or(serde_json::Value::Null)
            } else if let Ok(v) = r.try_get::<Option<f64>, _>(i) {
                v.map(|x| {
                    serde_json::Number::from_f64(x)
                        .map(serde_json::Value::Number)
                        .unwrap_or(serde_json::Value::Null)
                })
                .unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::Value::Null
            };
            obj.insert(name, val);
        }
        out.push(serde_json::Value::Object(obj));
    }
    Ok((out, count))
}
