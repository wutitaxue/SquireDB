use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ProjectCacheMapping {
    pub id: i64,
    pub project_id: i64,
    pub mysql_connection_id: i64,
    pub mysql_database: String,
    pub mysql_table: String,
    pub redis_connection_id: i64,
    pub redis_db: i64,
    pub key_pattern: String,
    pub command: String,
    pub label: Option<String>,
    pub created_at: String,
}

pub async fn create(
    pool: &SqlitePool,
    project_id: i64,
    mysql_connection_id: i64,
    mysql_database: &str,
    mysql_table: &str,
    redis_connection_id: i64,
    redis_db: i64,
    key_pattern: &str,
    command: &str,
    label: Option<&str>,
) -> Result<ProjectCacheMapping, sqlx::Error> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO project_cache_mappings \
         (project_id, mysql_connection_id, mysql_database, mysql_table, \
          redis_connection_id, redis_db, key_pattern, command, label) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(project_id)
    .bind(mysql_connection_id)
    .bind(mysql_database)
    .bind(mysql_table)
    .bind(redis_connection_id)
    .bind(redis_db)
    .bind(key_pattern)
    .bind(command)
    .bind(label)
    .fetch_one(pool)
    .await?;
    get(pool, id).await
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<ProjectCacheMapping, sqlx::Error> {
    sqlx::query_as::<_, ProjectCacheMapping>(
        "SELECT id, project_id, mysql_connection_id, mysql_database, mysql_table, \
         redis_connection_id, redis_db, key_pattern, command, label, created_at \
         FROM project_cache_mappings WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

pub async fn list(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<ProjectCacheMapping>, sqlx::Error> {
    sqlx::query_as::<_, ProjectCacheMapping>(
        "SELECT id, project_id, mysql_connection_id, mysql_database, mysql_table, \
         redis_connection_id, redis_db, key_pattern, command, label, created_at \
         FROM project_cache_mappings WHERE project_id = ? \
         ORDER BY mysql_database, mysql_table, id",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
}

pub async fn list_for_table(
    pool: &SqlitePool,
    project_id: i64,
    mysql_connection_id: i64,
    mysql_database: &str,
    mysql_table: &str,
) -> Result<Vec<ProjectCacheMapping>, sqlx::Error> {
    sqlx::query_as::<_, ProjectCacheMapping>(
        "SELECT id, project_id, mysql_connection_id, mysql_database, mysql_table, \
         redis_connection_id, redis_db, key_pattern, command, label, created_at \
         FROM project_cache_mappings \
         WHERE project_id = ? AND mysql_connection_id = ? \
           AND mysql_database = ? AND mysql_table = ? \
         ORDER BY id",
    )
    .bind(project_id)
    .bind(mysql_connection_id)
    .bind(mysql_database)
    .bind(mysql_table)
    .fetch_all(pool)
    .await
}

pub async fn update(
    pool: &SqlitePool,
    id: i64,
    redis_db: i64,
    key_pattern: &str,
    command: &str,
    label: Option<&str>,
) -> Result<ProjectCacheMapping, sqlx::Error> {
    sqlx::query(
        "UPDATE project_cache_mappings \
         SET redis_db = ?, key_pattern = ?, command = ?, label = ? WHERE id = ?",
    )
    .bind(redis_db)
    .bind(key_pattern)
    .bind(command)
    .bind(label)
    .bind(id)
    .execute(pool)
    .await?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM project_cache_mappings WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
