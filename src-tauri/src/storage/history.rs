use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: i64,
    pub sql: String,
    pub elapsed_ms: Option<i64>,
    pub rows_affected: Option<i64>,
    pub rows_returned: Option<i64>,
    pub error: Option<String>,
    pub executed_at: String,
}

pub async fn insert(
    pool: &SqlitePool,
    connection_id: i64,
    sql: &str,
    elapsed_ms: Option<i64>,
    rows_affected: Option<i64>,
    rows_returned: Option<i64>,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO query_history \
         (connection_id, sql, elapsed_ms, rows_affected, rows_returned, error) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(connection_id)
    .bind(sql)
    .bind(elapsed_ms)
    .bind(rows_affected)
    .bind(rows_returned)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list(
    pool: &SqlitePool,
    connection_id: i64,
    limit: i64,
) -> Result<Vec<HistoryEntry>, sqlx::Error> {
    sqlx::query_as::<_, HistoryEntry>(
        "SELECT id, connection_id, sql, elapsed_ms, rows_affected, rows_returned, \
                error, executed_at \
         FROM query_history \
         WHERE connection_id = ? \
         ORDER BY id DESC \
         LIMIT ?",
    )
    .bind(connection_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

pub async fn delete_by_connection(
    pool: &SqlitePool,
    connection_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM query_history WHERE connection_id = ?")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}
