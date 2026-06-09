use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AiModel {
    pub id: Option<i64>,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub enable_thinking: Option<i64>,
    pub created_at: Option<String>,
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<AiModel>, sqlx::Error> {
    sqlx::query_as::<_, AiModel>(
        "SELECT id, name, base_url, model, enable_thinking, created_at \
         FROM ai_models ORDER BY id",
    )
    .fetch_all(pool)
    .await
}

pub async fn get_by_id(pool: &SqlitePool, id: i64) -> Result<AiModel, sqlx::Error> {
    sqlx::query_as::<_, AiModel>(
        "SELECT id, name, base_url, model, enable_thinking, created_at \
         FROM ai_models WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

pub async fn insert(pool: &SqlitePool, m: &AiModel) -> Result<i64, sqlx::Error> {
    let r = sqlx::query(
        "INSERT INTO ai_models (name, base_url, model, enable_thinking) VALUES (?, ?, ?, ?)",
    )
    .bind(&m.name)
    .bind(&m.base_url)
    .bind(&m.model)
    .bind(m.enable_thinking)
    .execute(pool)
    .await?;
    Ok(r.last_insert_rowid())
}

pub async fn update(pool: &SqlitePool, m: &AiModel) -> Result<(), sqlx::Error> {
    let id = m.id.ok_or(sqlx::Error::RowNotFound)?;
    sqlx::query(
        "UPDATE ai_models SET name = ?, base_url = ?, model = ?, enable_thinking = ? WHERE id = ?",
    )
    .bind(&m.name)
    .bind(&m.base_url)
    .bind(&m.model)
    .bind(m.enable_thinking)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_by_id(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_models WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM ai_models")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
