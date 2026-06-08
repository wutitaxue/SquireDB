use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, SqlitePool, TypeInfo, ValueRef};
use std::time::{Duration, Instant};

use crate::query::{ColumnMeta, QueryResult};

pub async fn build_pool(path: &str) -> Result<SqlitePool, sqlx::Error> {
    // Use .filename() instead of FromStr — the latter parses input as a URI
    // and chokes on plain absolute paths containing spaces (e.g. macOS
    // "Application Support").
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(false);

    SqlitePoolOptions::new()
        .max_connections(5)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(60))
        .max_lifetime(Duration::from_secs(30 * 60))
        .connect_with(opts)
        .await
}

pub async fn execute(pool: &SqlitePool, sql: &str) -> Result<QueryResult, sqlx::Error> {
    let start = Instant::now();
    let first_word = sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();

    let is_query = matches!(
        first_word.as_str(),
        "select" | "with" | "pragma" | "explain"
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
            columns_via_describe(pool, sql).await
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

async fn columns_via_describe(pool: &SqlitePool, sql: &str) -> Vec<ColumnMeta> {
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

pub fn value_to_json(row: &SqliteRow, idx: usize) -> serde_json::Value {
    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return serde_json::Value::Null;
        }
    } else {
        return serde_json::Value::Null;
    }

    // SQLite reports type via the column's declared affinity or, when the
    // column is the result of an expression, the runtime storage class. The
    // sqlx-sqlite TypeInfo::name() returns one of: INTEGER, REAL, TEXT, BLOB,
    // NULL, NUMERIC, BOOLEAN, DATE, TIME, DATETIME.
    let type_name = row.column(idx).type_info().name().to_uppercase();

    match type_name.as_str() {
        "INTEGER" | "BOOLEAN" => row
            .try_get::<i64, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "REAL" | "NUMERIC" => row
            .try_get::<f64, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "TEXT" | "DATE" | "TIME" | "DATETIME" => row
            .try_get::<String, _>(idx)
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| serde_json::Value::from(format!("<binary {} bytes>", v.len())))
            .unwrap_or(serde_json::Value::Null),
        "NULL" => serde_json::Value::Null,
        // Unknown / undeclared affinity: try string, then i64, then f64, then
        // blob. SQLite expression columns commonly land here.
        _ => row
            .try_get::<String, _>(idx)
            .map(serde_json::Value::from)
            .or_else(|_| row.try_get::<i64, _>(idx).map(serde_json::Value::from))
            .or_else(|_| row.try_get::<f64, _>(idx).map(serde_json::Value::from))
            .or_else(|_| {
                row.try_get::<Vec<u8>, _>(idx)
                    .map(|v| serde_json::Value::from(format!("<binary {} bytes>", v.len())))
            })
            .unwrap_or(serde_json::Value::Null),
    }
}
