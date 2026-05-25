use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct DrillHistoryEntry {
    pub id: i64,
    pub project_id: i64,
    pub connection_id: i64,
    pub database_name: String,
    pub table_name: String,
    pub column_name: String,
    pub value_json: String,
    pub executed_at: String,
}

pub async fn record(
    pool: &SqlitePool,
    project_id: i64,
    connection_id: i64,
    database_name: &str,
    table_name: &str,
    column_name: &str,
    value_json: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO drill_history \
         (project_id, connection_id, database_name, table_name, column_name, value_json) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(connection_id)
    .bind(database_name)
    .bind(table_name)
    .bind(column_name)
    .bind(value_json)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list(
    pool: &SqlitePool,
    project_id: i64,
    limit: i64,
) -> Result<Vec<DrillHistoryEntry>, sqlx::Error> {
    sqlx::query_as::<_, DrillHistoryEntry>(
        "SELECT id, project_id, connection_id, database_name, table_name, \
                column_name, value_json, executed_at \
         FROM drill_history \
         WHERE project_id = ? \
         ORDER BY id DESC \
         LIMIT ?",
    )
    .bind(project_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

