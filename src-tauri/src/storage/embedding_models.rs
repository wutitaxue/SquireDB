use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct EmbeddingModel {
    pub id: Option<i64>,
    pub name: String,
    /// "openai" or "azure"
    pub provider: String,
    pub base_url: String,
    /// OpenAI-only — model name in request body
    pub model: String,
    /// Azure-only — deployment name baked into URL
    pub deployment: String,
    /// Azure-only — `api-version` query string
    pub api_version: String,
    pub dimensions: Option<i64>,
    pub created_at: Option<String>,
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<EmbeddingModel>, sqlx::Error> {
    sqlx::query_as::<_, EmbeddingModel>(
        "SELECT id, name, provider, base_url, model, deployment, api_version, dimensions, created_at \
         FROM embedding_models ORDER BY id",
    )
    .fetch_all(pool)
    .await
}

pub async fn get_by_id(pool: &SqlitePool, id: i64) -> Result<EmbeddingModel, sqlx::Error> {
    sqlx::query_as::<_, EmbeddingModel>(
        "SELECT id, name, provider, base_url, model, deployment, api_version, dimensions, created_at \
         FROM embedding_models WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

pub async fn insert(pool: &SqlitePool, m: &EmbeddingModel) -> Result<i64, sqlx::Error> {
    let r = sqlx::query(
        "INSERT INTO embedding_models (name, provider, base_url, model, deployment, api_version, dimensions) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&m.name)
    .bind(&m.provider)
    .bind(&m.base_url)
    .bind(&m.model)
    .bind(&m.deployment)
    .bind(&m.api_version)
    .bind(m.dimensions)
    .execute(pool)
    .await?;
    Ok(r.last_insert_rowid())
}

pub async fn update(pool: &SqlitePool, m: &EmbeddingModel) -> Result<(), sqlx::Error> {
    let id = m.id.ok_or(sqlx::Error::RowNotFound)?;
    sqlx::query(
        "UPDATE embedding_models SET name = ?, provider = ?, base_url = ?, model = ?, \
         deployment = ?, api_version = ?, dimensions = ? WHERE id = ?",
    )
    .bind(&m.name)
    .bind(&m.provider)
    .bind(&m.base_url)
    .bind(&m.model)
    .bind(&m.deployment)
    .bind(&m.api_version)
    .bind(m.dimensions)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_by_id(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM embedding_models WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM embedding_models")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
