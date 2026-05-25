use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct RepairSession {
    pub id: i64,
    pub connection_id: i64,
    pub database_name: String,
    pub scope_tables_json: Option<String>,
    pub goal: String,
    pub state: String,
    pub investigation_json: Option<String>,
    pub strategy_json: Option<String>,
    pub backup_table_name: Option<String>,
    pub final_sql: Option<String>,
    pub executed_rows: Option<i64>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn insert(
    pool: &SqlitePool,
    connection_id: i64,
    database_name: &str,
    scope_tables_json: Option<&str>,
    goal: &str,
    state: &str,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO repair_sessions \
         (connection_id, database_name, scope_tables_json, goal, state) \
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(connection_id)
    .bind(database_name)
    .bind(scope_tables_json)
    .bind(goal)
    .bind(state)
    .fetch_one(pool)
    .await?;
    Ok(row.get::<i64, _>(0))
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<RepairSession, sqlx::Error> {
    sqlx::query_as::<_, RepairSession>(
        "SELECT id, connection_id, database_name, scope_tables_json, goal, state, \
                investigation_json, strategy_json, backup_table_name, final_sql, \
                executed_rows, error, created_at, updated_at \
         FROM repair_sessions WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

pub async fn list_by_connection(
    pool: &SqlitePool,
    connection_id: i64,
    limit: i64,
) -> Result<Vec<RepairSession>, sqlx::Error> {
    sqlx::query_as::<_, RepairSession>(
        "SELECT id, connection_id, database_name, scope_tables_json, goal, state, \
                investigation_json, strategy_json, backup_table_name, final_sql, \
                executed_rows, error, created_at, updated_at \
         FROM repair_sessions WHERE connection_id = ? \
         ORDER BY id DESC LIMIT ?",
    )
    .bind(connection_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

pub async fn update_state(
    pool: &SqlitePool,
    id: i64,
    state: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE repair_sessions SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(state)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_investigation(
    pool: &SqlitePool,
    id: i64,
    investigation_json: &str,
    state: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE repair_sessions SET investigation_json = ?, state = ?, \
                updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(investigation_json)
    .bind(state)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_strategy(
    pool: &SqlitePool,
    id: i64,
    strategy_json: &str,
    state: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE repair_sessions SET strategy_json = ?, state = ?, \
                updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(strategy_json)
    .bind(state)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_backup(
    pool: &SqlitePool,
    id: i64,
    backup_table_name: &str,
    state: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE repair_sessions SET backup_table_name = ?, state = ?, \
                updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(backup_table_name)
    .bind(state)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_executed(
    pool: &SqlitePool,
    id: i64,
    final_sql: &str,
    executed_rows: i64,
    state: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE repair_sessions SET final_sql = ?, executed_rows = ?, state = ?, \
                updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(final_sql)
    .bind(executed_rows)
    .bind(state)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_error(
    pool: &SqlitePool,
    id: i64,
    error: &str,
    state: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE repair_sessions SET error = ?, state = ?, \
                updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(error)
    .bind(state)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}
