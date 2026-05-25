use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
pub struct Relation {
    pub id: i64,
    pub connection_id: i64,
    pub from_db: String,
    pub from_table: String,
    pub from_column: String,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    pub confidence: f64,
    pub source: String,
    pub analyzed_at: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert(
    pool: &SqlitePool,
    connection_id: i64,
    from_db: &str,
    from_table: &str,
    from_column: &str,
    to_db: &str,
    to_table: &str,
    to_column: &str,
    confidence: f64,
    source: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO schema_relations \
         (connection_id, from_db, from_table, from_column, \
          to_db, to_table, to_column, confidence, source, analyzed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT(connection_id, from_db, from_table, from_column, to_db, to_table, to_column) \
         DO UPDATE SET \
           confidence = MAX(excluded.confidence, schema_relations.confidence), \
           source = CASE \
             WHEN excluded.confidence > schema_relations.confidence THEN excluded.source \
             ELSE schema_relations.source \
           END, \
           analyzed_at = excluded.analyzed_at",
    )
    .bind(connection_id)
    .bind(from_db)
    .bind(from_table)
    .bind(from_column)
    .bind(to_db)
    .bind(to_table)
    .bind(to_column)
    .bind(confidence)
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list(
    pool: &SqlitePool,
    connection_id: i64,
    database_name: Option<&str>,
) -> Result<Vec<Relation>, sqlx::Error> {
    let rows = match database_name {
        Some(db) => {
            sqlx::query_as::<_, Relation>(
                "SELECT id, connection_id, from_db, from_table, from_column, \
                        to_db, to_table, to_column, confidence, source, analyzed_at \
                 FROM schema_relations \
                 WHERE connection_id = ? AND from_db = ? \
                 ORDER BY from_table, from_column",
            )
            .bind(connection_id)
            .bind(db)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, Relation>(
                "SELECT id, connection_id, from_db, from_table, from_column, \
                        to_db, to_table, to_column, confidence, source, analyzed_at \
                 FROM schema_relations \
                 WHERE connection_id = ? \
                 ORDER BY from_db, from_table, from_column",
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
    sqlx::query("DELETE FROM schema_relations WHERE connection_id = ?")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}
