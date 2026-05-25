use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Connection {
    pub id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub database: Option<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub created_at: Option<String>,
    pub last_used_at: Option<String>,
}

fn default_kind() -> String {
    "mysql".to_string()
}

pub async fn get_by_id(pool: &SqlitePool, id: i64) -> Result<Connection, sqlx::Error> {
    sqlx::query_as::<_, Connection>(
        "SELECT id, name, host, port, username, database, kind, created_at, last_used_at \
         FROM connections WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Connection>, sqlx::Error> {
    sqlx::query_as::<_, Connection>(
        "SELECT id, name, host, port, username, database, kind, created_at, last_used_at \
         FROM connections ORDER BY name",
    )
    .fetch_all(pool)
    .await
}

pub async fn insert(pool: &SqlitePool, conn: &Connection) -> Result<i64, sqlx::Error> {
    let result = sqlx::query(
        "INSERT INTO connections (name, host, port, username, database, kind) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&conn.name)
    .bind(&conn.host)
    .bind(conn.port)
    .bind(&conn.username)
    .bind(&conn.database)
    .bind(&conn.kind)
    .execute(pool)
    .await?;
    Ok(result.last_insert_rowid())
}

pub async fn update(pool: &SqlitePool, conn: &Connection) -> Result<(), sqlx::Error> {
    let id = conn.id.ok_or(sqlx::Error::RowNotFound)?;
    sqlx::query(
        "UPDATE connections \
         SET name = ?, host = ?, port = ?, username = ?, database = ?, kind = ? \
         WHERE id = ?",
    )
    .bind(&conn.name)
    .bind(&conn.host)
    .bind(conn.port)
    .bind(&conn.username)
    .bind(&conn.database)
    .bind(&conn.kind)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_by_id(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM connections WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn touch_last_used(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE connections SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
