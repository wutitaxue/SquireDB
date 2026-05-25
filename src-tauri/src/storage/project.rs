use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Project {
    pub id: Option<i64>,
    pub name: String,
    pub description: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ProjectTable {
    pub id: i64,
    pub project_id: i64,
    pub connection_id: i64,
    pub database_name: String,
    pub table_name: String,
    pub alias: Option<String>,
    pub is_primary: i64,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ProjectRelation {
    pub id: i64,
    pub project_id: i64,
    pub from_connection_id: i64,
    pub from_db: String,
    pub from_table: String,
    pub from_column: String,
    pub to_connection_id: i64,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    pub cardinality: String,
    pub source: String,
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Project>, sqlx::Error> {
    sqlx::query_as::<_, Project>(
        "SELECT id, name, description, created_at FROM projects ORDER BY name",
    )
    .fetch_all(pool)
    .await
}

pub async fn insert(pool: &SqlitePool, project: &Project) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO projects (name, description) VALUES (?, ?) RETURNING id",
    )
    .bind(&project.name)
    .bind(&project.description)
    .fetch_one(pool)
    .await?;
    use sqlx::Row;
    Ok(row.get::<i64, _>(0))
}

pub async fn update(pool: &SqlitePool, project: &Project) -> Result<(), sqlx::Error> {
    let id = project.id.ok_or_else(|| sqlx::Error::RowNotFound)?;
    sqlx::query("UPDATE projects SET name = ?, description = ? WHERE id = ?")
        .bind(&project.name)
        .bind(&project.description)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_by_id(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM project_relations WHERE project_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM project_tables WHERE project_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM drill_history WHERE project_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Called when a connection is removed. Strips that connection's tables and
/// relations from every project but leaves the projects themselves intact —
/// projects are independent of any single connection.
pub async fn unbind_connection(
    pool: &SqlitePool,
    connection_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM project_relations \
         WHERE from_connection_id = ? OR to_connection_id = ?",
    )
    .bind(connection_id)
    .bind(connection_id)
    .execute(pool)
    .await?;
    sqlx::query("DELETE FROM project_tables WHERE connection_id = ?")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_tables(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<ProjectTable>, sqlx::Error> {
    sqlx::query_as::<_, ProjectTable>(
        "SELECT id, project_id, connection_id, database_name, table_name, alias, is_primary \
         FROM project_tables WHERE project_id = ? \
         ORDER BY is_primary DESC, connection_id, database_name, table_name",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn add_table(
    pool: &SqlitePool,
    project_id: i64,
    connection_id: i64,
    database_name: &str,
    table_name: &str,
    alias: Option<&str>,
    is_primary: bool,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO project_tables (project_id, connection_id, database_name, table_name, alias, is_primary) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(project_id, database_name, table_name) DO UPDATE SET \
           connection_id = excluded.connection_id, \
           alias = excluded.alias, \
           is_primary = excluded.is_primary \
         RETURNING id",
    )
    .bind(project_id)
    .bind(connection_id)
    .bind(database_name)
    .bind(table_name)
    .bind(alias)
    .bind(is_primary as i64)
    .fetch_one(pool)
    .await?;
    use sqlx::Row;
    Ok(row.get::<i64, _>(0))
}

pub async fn remove_table(pool: &SqlitePool, project_table_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM project_tables WHERE id = ?")
        .bind(project_table_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_primary_table(
    pool: &SqlitePool,
    project_id: i64,
    project_table_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE project_tables SET is_primary = 0 WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;
    sqlx::query("UPDATE project_tables SET is_primary = 1 WHERE id = ?")
        .bind(project_table_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_relations(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<ProjectRelation>, sqlx::Error> {
    sqlx::query_as::<_, ProjectRelation>(
        "SELECT id, project_id, \
                from_connection_id, from_db, from_table, from_column, \
                to_connection_id, to_db, to_table, to_column, \
                cardinality, source \
         FROM project_relations WHERE project_id = ? \
         ORDER BY from_connection_id, from_db, from_table, from_column",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn add_relation(
    pool: &SqlitePool,
    project_id: i64,
    from_connection_id: i64,
    from_db: &str,
    from_table: &str,
    from_column: &str,
    to_connection_id: i64,
    to_db: &str,
    to_table: &str,
    to_column: &str,
    cardinality: &str,
    source: &str,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "INSERT INTO project_relations \
         (project_id, from_connection_id, from_db, from_table, from_column, \
          to_connection_id, to_db, to_table, to_column, cardinality, source) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(project_id, from_db, from_table, from_column, to_db, to_table, to_column) \
         DO UPDATE SET \
           from_connection_id = excluded.from_connection_id, \
           to_connection_id = excluded.to_connection_id, \
           cardinality = excluded.cardinality, \
           source = excluded.source \
         RETURNING id",
    )
    .bind(project_id)
    .bind(from_connection_id)
    .bind(from_db)
    .bind(from_table)
    .bind(from_column)
    .bind(to_connection_id)
    .bind(to_db)
    .bind(to_table)
    .bind(to_column)
    .bind(cardinality)
    .bind(source)
    .fetch_one(pool)
    .await?;
    use sqlx::Row;
    Ok(row.get::<i64, _>(0))
}

pub async fn remove_relation(pool: &SqlitePool, relation_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM project_relations WHERE id = ?")
        .bind(relation_id)
        .execute(pool)
        .await?;
    Ok(())
}
