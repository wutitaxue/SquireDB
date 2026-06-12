use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct SavedQuery {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub sql: String,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn create(
    pool: &SqlitePool,
    connection_id: i64,
    name: &str,
    sql: &str,
) -> Result<SavedQuery, sqlx::Error> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO saved_queries (connection_id, name, sql) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(connection_id)
    .bind(name)
    .bind(sql)
    .fetch_one(pool)
    .await?;
    get(pool, id).await
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<SavedQuery, sqlx::Error> {
    sqlx::query_as::<_, SavedQuery>(
        "SELECT id, connection_id, name, sql, created_at, updated_at \
         FROM saved_queries WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

pub async fn list(
    pool: &SqlitePool,
    connection_id: i64,
) -> Result<Vec<SavedQuery>, sqlx::Error> {
    sqlx::query_as::<_, SavedQuery>(
        "SELECT id, connection_id, name, sql, created_at, updated_at \
         FROM saved_queries WHERE connection_id = ? \
         ORDER BY name COLLATE NOCASE",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
}

pub async fn list_for_connections(
    pool: &SqlitePool,
    ids: &[i64],
) -> Result<Vec<SavedQuery>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, connection_id, name, sql, created_at, updated_at \
         FROM saved_queries WHERE connection_id IN ({placeholders}) \
         ORDER BY connection_id, name COLLATE NOCASE"
    );
    let mut q = sqlx::query_as::<_, SavedQuery>(&sql);
    for id in ids {
        q = q.bind(*id);
    }
    q.fetch_all(pool).await
}

pub async fn update(
    pool: &SqlitePool,
    id: i64,
    name: &str,
    sql: &str,
) -> Result<SavedQuery, sqlx::Error> {
    sqlx::query(
        "UPDATE saved_queries SET name = ?, sql = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(name)
    .bind(sql)
    .bind(id)
    .execute(pool)
    .await?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM saved_queries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
