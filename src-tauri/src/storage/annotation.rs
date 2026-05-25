use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
pub struct Annotation {
    pub id: i64,
    pub connection_id: i64,
    pub database_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub semantic_role: Option<String>,
    pub pii_type: Option<String>,
    pub ai_comment: Option<String>,
    pub analyzed_at: String,
}

pub async fn upsert(
    pool: &SqlitePool,
    connection_id: i64,
    database_name: &str,
    table_name: &str,
    column_name: Option<&str>,
    semantic_role: Option<&str>,
    pii_type: Option<&str>,
    ai_comment: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO schema_annotations \
         (connection_id, database_name, table_name, column_name, \
          semantic_role, pii_type, ai_comment, analyzed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT(connection_id, database_name, table_name, column_name) DO UPDATE SET \
           semantic_role = COALESCE(excluded.semantic_role, schema_annotations.semantic_role), \
           pii_type = COALESCE(excluded.pii_type, schema_annotations.pii_type), \
           ai_comment = COALESCE(excluded.ai_comment, schema_annotations.ai_comment), \
           analyzed_at = excluded.analyzed_at",
    )
    .bind(connection_id)
    .bind(database_name)
    .bind(table_name)
    .bind(column_name)
    .bind(semantic_role)
    .bind(pii_type)
    .bind(ai_comment)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list(
    pool: &SqlitePool,
    connection_id: i64,
    database_name: Option<&str>,
) -> Result<Vec<Annotation>, sqlx::Error> {
    let rows = match database_name {
        Some(db) => {
            sqlx::query_as::<_, Annotation>(
                "SELECT id, connection_id, database_name, table_name, column_name, \
                        semantic_role, pii_type, ai_comment, analyzed_at \
                 FROM schema_annotations \
                 WHERE connection_id = ? AND database_name = ? \
                 ORDER BY table_name, column_name",
            )
            .bind(connection_id)
            .bind(db)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, Annotation>(
                "SELECT id, connection_id, database_name, table_name, column_name, \
                        semantic_role, pii_type, ai_comment, analyzed_at \
                 FROM schema_annotations \
                 WHERE connection_id = ? \
                 ORDER BY database_name, table_name, column_name",
            )
            .bind(connection_id)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows)
}

pub async fn delete_by_connection(
    pool: &SqlitePool,
    connection_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM schema_annotations WHERE connection_id = ?")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}
