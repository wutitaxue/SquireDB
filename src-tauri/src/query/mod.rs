use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, MySqlPool, Row, TypeInfo, ValueRef};
use std::time::{Duration, Instant};

#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct EditTarget {
    pub schema: String,
    pub table: String,
    pub pk_columns: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub elapsed_ms: u64,
    pub rows_affected: Option<u64>,
    pub editable: Option<EditTarget>,
}

pub async fn build_pool(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: Option<&str>,
) -> Result<MySqlPool, sqlx::Error> {
    let mut options = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(username)
        .password(password);

    if let Some(db) = database.filter(|s| !s.is_empty()) {
        options = options.database(db);
    }

    MySqlPoolOptions::new()
        .max_connections(15)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(15))
        .idle_timeout(Duration::from_secs(60))
        .max_lifetime(Duration::from_secs(30 * 60))
        .connect_with(options)
        .await
}

/// Acquire a single connection, return its CONNECTION_ID() and the connection
/// itself, so the caller can register the thread_id for cancellation and then
/// run the query on the *same* connection.
pub async fn acquire_with_thread_id(
    pool: &MySqlPool,
) -> Result<(sqlx::pool::PoolConnection<sqlx::MySql>, u64), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&mut *conn)
        .await?;
    Ok((conn, thread_id))
}

/// Switch the current schema for an open connection via `USE`. Uses the
/// text protocol (`raw_sql`) — `USE` isn't supported by MySQL's prepared
/// statement protocol that sqlx defaults to.
///
/// The caller should make sure the conn is single-use (e.g. `.detach()`-ed
/// from the pool) so the per-conn schema change doesn't leak to the next
/// borrower.
/// Open a throw-away single-connection pool pointed at `db`, run `sql` on
/// it, return the result. Used by the per-tab database picker: we avoid
/// touching the long-lived pool's session state (no `USE` needed — the
/// database is supplied in the MySQL handshake, which accepts it without
/// the prepared-statement limitations that affect server-side `USE`).
///
/// `thread_id_tx` receives the MySQL `CONNECTION_ID()` of the throwaway
/// conn so the caller can register it for cancellation.
pub async fn execute_with_database(
    host: String,
    port: u16,
    username: String,
    password: String,
    db: String,
    sql: String,
    thread_id_tx: tokio::sync::oneshot::Sender<u64>,
) -> Result<QueryResult, sqlx::Error> {
    let scoped = build_pool(&host, port, &username, &password, Some(&db)).await?;
    let (mut conn, thread_id) = acquire_with_thread_id(&scoped).await?;
    let _ = thread_id_tx.send(thread_id);
    let r = execute_on_conn(&mut conn, &sql).await;
    // Pool is dropped here; the single conn is closed with it.
    drop(conn);
    scoped.close().await;
    r
}

/// Run a SQL statement on an already-acquired connection. Used by
/// cancellable execute path; the caller must hold the connection so that
/// `KILL QUERY <thread_id>` from another connection targets it.
pub async fn execute_on_conn(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
) -> Result<QueryResult, sqlx::Error> {
    let start = Instant::now();
    let first_word = sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();

    let is_query = matches!(
        first_word.as_str(),
        "select" | "show" | "describe" | "desc" | "explain" | "with"
    );

    if is_query {
        let rows = sqlx::query(sql).fetch_all(&mut *conn).await?;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        let columns: Vec<ColumnMeta> = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            // Empty result set — fetch the column list via PREPARE so the
            // UI still knows the projection (needed for editability/Insert).
            columns_via_describe_conn(conn, sql).await
        };

        let json_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                (0..row.columns().len())
                    .map(|i| value_to_json(row, i))
                    .collect()
            })
            .collect();

        Ok(QueryResult {
            columns,
            rows: json_rows,
            elapsed_ms,
            rows_affected: None,
            editable: None,
        })
    } else {
        let result = sqlx::query(sql).execute(&mut *conn).await?;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            elapsed_ms,
            rows_affected: Some(result.rows_affected()),
            editable: None,
        })
    }
}

async fn columns_via_describe_conn(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
) -> Vec<ColumnMeta> {
    use sqlx::Executor;
    match (&mut *conn).describe(sql).await {
        Ok(d) => d
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

async fn columns_via_describe_pool(pool: &MySqlPool, sql: &str) -> Vec<ColumnMeta> {
    use sqlx::Executor;
    match pool.describe(sql).await {
        Ok(d) => d
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub async fn execute(pool: &MySqlPool, sql: &str) -> Result<QueryResult, sqlx::Error> {
    let start = Instant::now();
    let first_word = sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();

    let is_query = matches!(
        first_word.as_str(),
        "select" | "show" | "describe" | "desc" | "explain" | "with"
    );

    if is_query {
        let rows = sqlx::query(sql).fetch_all(pool).await?;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        let columns: Vec<ColumnMeta> = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            columns_via_describe_pool(pool, sql).await
        };

        let json_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                (0..row.columns().len())
                    .map(|i| value_to_json(row, i))
                    .collect()
            })
            .collect();

        Ok(QueryResult {
            columns,
            rows: json_rows,
            elapsed_ms,
            rows_affected: None,
            editable: None,
        })
    } else {
        let result = sqlx::query(sql).execute(pool).await?;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            elapsed_ms,
            rows_affected: Some(result.rows_affected()),
            editable: None,
        })
    }
}

/// Parse a SQL string to determine whether the result-set is a simple
/// single-table SELECT that can be safely mutated row-by-row.
///
/// Returns `Some((schema_opt, table))` if editable, `None` otherwise.
/// Rejects: JOIN, GROUP BY, HAVING, DISTINCT, UNION, subqueries in select
/// list, aggregate functions, multiple tables in FROM.
pub fn analyze_editable_from_sql(sql: &str) -> Option<(Option<String>, String)> {
    let stripped = strip_sql_comments(sql);
    let normalized = stripped.trim().trim_end_matches(';').trim();
    if normalized.is_empty() {
        return None;
    }
    let lower = normalized.to_lowercase();

    if !lower.starts_with("select") && !lower.starts_with("select\n") && !lower.starts_with("select\t") {
        return None;
    }
    // Reject if it looks like the SELECT keyword isn't word-bounded
    if !matches!(lower.as_bytes().get(6), Some(b) if b.is_ascii_whitespace()) {
        return None;
    }

    // Forbidden keywords (substring check on normalized lowercase, ok for
    // simple cases — comments already stripped, identifiers can still
    // contain them but that's rare enough to live with).
    let forbidden = [
        " join ", " group by ", " group  by ", " having ", " union ",
        " distinct ", " into outfile", " for update", " lock in ",
    ];
    for kw in forbidden {
        if lower.contains(kw) {
            return None;
        }
    }
    // SELECT DISTINCT right after select keyword
    if lower.starts_with("select distinct") {
        return None;
    }
    // Aggregate functions / subquery markers in select list or where clause
    let agg = ["count(", "sum(", "avg(", "min(", "max(", "group_concat(", "(select "];
    for kw in agg {
        if lower.contains(kw) {
            return None;
        }
    }

    // Find FROM keyword position (case-insensitive, word-bounded).
    let from_pos = find_keyword(&lower, "from")?;
    let after_from = &normalized[from_pos + 4..];
    let after_from_lower = lower.get(from_pos + 4..)?;

    // Find the end of the FROM clause: next clause keyword or end-of-statement.
    let stop_keywords = [" where ", " order by ", " limit ", " for ", " into ", " on ", " using "];
    let mut end = after_from.len();
    for kw in stop_keywords {
        if let Some(pos) = after_from_lower.find(kw) {
            if pos < end {
                end = pos;
            }
        }
    }
    let table_part = after_from[..end].trim();

    // FROM clause may be:  schema.table  |  `schema`.`table`  |  table AS alias  |  table alias
    // Multiple tables = comma list → reject.
    if table_part.contains(',') {
        return None;
    }
    let first = table_part.split_whitespace().next()?;
    let cleaned: String = first.chars().filter(|c| *c != '`' && *c != '"').collect();

    let parts: Vec<&str> = cleaned.split('.').collect();
    let (schema, table) = match parts.as_slice() {
        [t] => (None, (*t).to_string()),
        [s, t] => (Some((*s).to_string()), (*t).to_string()),
        _ => return None,
    };

    if !is_safe_identifier(&table) {
        return None;
    }
    if let Some(s) = &schema {
        if !is_safe_identifier(s) {
            return None;
        }
    }

    Some((schema, table))
}

fn strip_sql_comments(sql: &str) -> String {
    // Strip /* ... */ block comments and -- line comments.
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            out.push(' ');
        } else if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            out.push(' ');
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn find_keyword(lower: &str, kw: &str) -> Option<usize> {
    // Find the first occurrence of kw where it is word-bounded.
    let bytes = lower.as_bytes();
    let kw_bytes = kw.as_bytes();
    let mut i = 0;
    while i + kw_bytes.len() <= bytes.len() {
        if &bytes[i..i + kw_bytes.len()] == kw_bytes {
            let prev_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let next_ok = i + kw_bytes.len() == bytes.len()
                || !is_ident_byte(bytes[i + kw_bytes.len()]);
            if prev_ok && next_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_safe_identifier(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// After a successful SELECT, look up primary key columns for the source
/// table; if every PK column is present in the result-set columns, return
/// an EditTarget describing where mutations should be routed.
pub async fn resolve_editable(
    pool: &MySqlPool,
    sql: &str,
    result_columns: &[ColumnMeta],
) -> Option<EditTarget> {
    let (schema_opt, table) = analyze_editable_from_sql(sql)?;
    let schema = match schema_opt {
        Some(s) => s,
        None => {
            let row: (Option<String>,) = sqlx::query_as("SELECT DATABASE()")
                .fetch_one(pool)
                .await
                .ok()?;
            row.0?
        }
    };

    let pk_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT CAST(COLUMN_NAME AS CHAR) \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(pool)
    .await
    .ok()?;

    let pks: Vec<String> = pk_rows.into_iter().map(|(c,)| c).collect();
    if pks.is_empty() {
        return None;
    }
    let col_names: std::collections::HashSet<&str> =
        result_columns.iter().map(|c| c.name.as_str()).collect();
    if !pks.iter().all(|pk| col_names.contains(pk.as_str())) {
        return None;
    }

    Some(EditTarget {
        schema,
        table,
        pk_columns: pks,
    })
}

pub fn row_to_object(row: &MySqlRow) -> serde_json::Map<String, serde_json::Value> {
    let mut obj = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        obj.insert(col.name().to_string(), value_to_json(row, i));
    }
    obj
}

pub fn value_to_json(row: &MySqlRow, idx: usize) -> serde_json::Value {
    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return serde_json::Value::Null;
        }
    } else {
        return serde_json::Value::Null;
    }

    let type_name = row.column(idx).type_info().name().to_uppercase();

    match type_name.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => row
            .try_get::<i64, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" => row
            .try_get::<u32, _>(idx)
            .map(|v| serde_json::Value::from(v as u64))
            .unwrap_or(serde_json::Value::Null),
        "BIGINT UNSIGNED" => row
            .try_get::<u64, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "FLOAT" => row
            .try_get::<f32, _>(idx)
            .map(|v| serde_json::Value::from(v as f64))
            .unwrap_or(serde_json::Value::Null),
        "DOUBLE" => row
            .try_get::<f64, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "DECIMAL" | "NUMERIC" => row
            .try_get::<String, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "BOOLEAN" => row
            .try_get::<bool, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "JSON" => row
            .try_get::<serde_json::Value, _>(idx)
            .unwrap_or(serde_json::Value::Null),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|d| serde_json::Value::from(d.to_string()))
            .unwrap_or(serde_json::Value::Null),
        "TIME" => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|t| serde_json::Value::from(t.to_string()))
            .unwrap_or(serde_json::Value::Null),
        "DATETIME" | "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|t| serde_json::Value::from(t.to_string()))
            .unwrap_or(serde_json::Value::Null),
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            row.try_get::<String, _>(idx)
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null)
        }
        _ => row
            .try_get::<String, _>(idx)
            .map(serde_json::Value::from)
            .or_else(|_| {
                row.try_get::<Vec<u8>, _>(idx).map(|v| match std::str::from_utf8(&v) {
                    Ok(s) => serde_json::Value::from(s.to_string()),
                    Err(_) => serde_json::Value::from(format!("<binary {} bytes>", v.len())),
                })
            })
            .unwrap_or(serde_json::Value::Null),
    }
}
