use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, SqlitePool};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Instant;

#[derive(Debug, Serialize, Clone)]
pub struct ColumnInfo {
    pub name: String,
    pub column_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub extra: String,
    pub comment: String,
    pub ordinal: i64,
}

#[derive(Debug, Serialize)]
pub struct ColumnChange {
    pub name: String,
    pub source: ColumnInfo,
    pub target: ColumnInfo,
    pub differences: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Serialize)]
pub struct TableDiff {
    pub name: String,
    pub columns_added: Vec<ColumnInfo>,
    pub columns_removed: Vec<ColumnInfo>,
    pub columns_changed: Vec<ColumnChange>,
    pub indexes_added: Vec<IndexInfo>,
    pub indexes_removed: Vec<IndexInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationStatement {
    pub kind: String,
    pub table: String,
    pub sql: String,
    pub destructive: bool,
}

#[derive(Debug, Serialize)]
pub struct DiffReport {
    pub source_db: String,
    pub target_db: String,
    pub tables_added: Vec<String>,
    pub tables_removed: Vec<String>,
    pub tables_changed: Vec<TableDiff>,
    pub migrations: Vec<MigrationStatement>,
    pub source_creates: BTreeMap<String, String>,
}

async fn fetch_columns(
    pool: &MySqlPool,
    db: &str,
) -> Result<BTreeMap<String, BTreeMap<String, ColumnInfo>>, String> {
    let rows: Vec<(String, String, String, String, Option<String>, String, String, i64)> =
        sqlx::query_as(
            "SELECT \
                CAST(TABLE_NAME AS CHAR), \
                CAST(COLUMN_NAME AS CHAR), \
                CAST(COLUMN_TYPE AS CHAR), \
                CAST(IS_NULLABLE AS CHAR), \
                CAST(COLUMN_DEFAULT AS CHAR), \
                CAST(IFNULL(EXTRA, '') AS CHAR), \
                CAST(IFNULL(COLUMN_COMMENT, '') AS CHAR), \
                CAST(ORDINAL_POSITION AS SIGNED) \
            FROM information_schema.COLUMNS \
            WHERE TABLE_SCHEMA = ? \
            ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(db)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch columns {db}: {e}"))?;

    let mut out: BTreeMap<String, BTreeMap<String, ColumnInfo>> = BTreeMap::new();
    for (table, col, ty, is_null, default, extra, comment, ordinal) in rows {
        let info = ColumnInfo {
            name: col.clone(),
            column_type: ty,
            nullable: is_null.eq_ignore_ascii_case("YES"),
            default,
            extra,
            comment,
            ordinal,
        };
        out.entry(table).or_default().insert(col, info);
    }
    Ok(out)
}

async fn fetch_indexes(
    pool: &MySqlPool,
    db: &str,
) -> Result<BTreeMap<String, BTreeMap<String, IndexInfo>>, String> {
    let rows: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT \
            CAST(TABLE_NAME AS CHAR), \
            CAST(INDEX_NAME AS CHAR), \
            CAST(COLUMN_NAME AS CHAR), \
            CAST(NON_UNIQUE AS SIGNED), \
            CAST(SEQ_IN_INDEX AS SIGNED) \
        FROM information_schema.STATISTICS \
        WHERE TABLE_SCHEMA = ? \
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(db)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("fetch indexes {db}: {e}"))?;

    let mut out: BTreeMap<String, BTreeMap<String, IndexInfo>> = BTreeMap::new();
    for (table, idx, col, non_unique, _seq) in rows {
        let entry = out
            .entry(table)
            .or_default()
            .entry(idx.clone())
            .or_insert_with(|| IndexInfo {
                name: idx,
                columns: Vec::new(),
                unique: non_unique == 0,
            });
        entry.columns.push(col);
    }
    Ok(out)
}

async fn show_create_table(pool: &MySqlPool, db: &str, table: &str) -> Result<String, String> {
    let db_clean = db.replace('`', "");
    let table_clean = table.replace('`', "");
    let sql = format!("SHOW CREATE TABLE `{db_clean}`.`{table_clean}`");
    let row: (String, String) = sqlx::query_as(&sql)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("SHOW CREATE TABLE `{db}`.`{table}`: {e}"))?;
    Ok(row.1)
}

pub async fn compare_schemas(
    pool: &MySqlPool,
    source_db: &str,
    target_db: &str,
) -> Result<DiffReport, String> {
    compare_schemas_inner(pool, source_db, pool, target_db, None).await
}

pub async fn compare_schemas_cross(
    source_pool: &MySqlPool,
    source_db: &str,
    target_pool: &MySqlPool,
    target_db: &str,
    scope_tables: Option<&BTreeSet<String>>,
) -> Result<DiffReport, String> {
    compare_schemas_inner(source_pool, source_db, target_pool, target_db, scope_tables).await
}

async fn compare_schemas_inner(
    source_pool: &MySqlPool,
    source_db: &str,
    target_pool: &MySqlPool,
    target_db: &str,
    scope_tables: Option<&BTreeSet<String>>,
) -> Result<DiffReport, String> {
    let mut source_cols = fetch_columns(source_pool, source_db).await?;
    let mut target_cols = fetch_columns(target_pool, target_db).await?;
    let mut source_idx = fetch_indexes(source_pool, source_db).await?;
    let mut target_idx = fetch_indexes(target_pool, target_db).await?;

    if let Some(scope) = scope_tables {
        source_cols.retain(|k, _| scope.contains(k));
        target_cols.retain(|k, _| scope.contains(k));
        source_idx.retain(|k, _| scope.contains(k));
        target_idx.retain(|k, _| scope.contains(k));
    }

    let source_tables: BTreeSet<String> = source_cols.keys().cloned().collect();
    let target_tables: BTreeSet<String> = target_cols.keys().cloned().collect();

    let tables_added: Vec<String> = source_tables.difference(&target_tables).cloned().collect();
    let tables_removed: Vec<String> = target_tables.difference(&source_tables).cloned().collect();

    let mut migrations: Vec<MigrationStatement> = Vec::new();
    let mut source_creates: BTreeMap<String, String> = BTreeMap::new();

    for t in &tables_added {
        let create_sql = show_create_table(source_pool, source_db, t).await.unwrap_or_else(
            |e| format!("-- failed to fetch CREATE TABLE for {t}: {e}"),
        );
        source_creates.insert(t.clone(), create_sql.clone());
        let rewritten = create_sql.replacen(
            &format!("CREATE TABLE `{t}`"),
            &format!("CREATE TABLE `{target_db}`.`{t}`"),
            1,
        );
        migrations.push(MigrationStatement {
            kind: "create_table".into(),
            table: t.clone(),
            sql: format!("{rewritten};"),
            destructive: false,
        });
    }

    for t in &tables_removed {
        migrations.push(MigrationStatement {
            kind: "drop_table".into(),
            table: t.clone(),
            sql: format!("DROP TABLE `{target_db}`.`{t}`;"),
            destructive: true,
        });
    }

    let mut tables_changed: Vec<TableDiff> = Vec::new();
    let both: Vec<String> = source_tables.intersection(&target_tables).cloned().collect();
    for t in &both {
        let s_cols = source_cols.get(t).cloned().unwrap_or_default();
        let g_cols = target_cols.get(t).cloned().unwrap_or_default();
        let s_idx = source_idx.get(t).cloned().unwrap_or_default();
        let g_idx = target_idx.get(t).cloned().unwrap_or_default();

        let mut columns_added: Vec<ColumnInfo> = Vec::new();
        let mut columns_removed: Vec<ColumnInfo> = Vec::new();
        let mut columns_changed: Vec<ColumnChange> = Vec::new();

        let s_col_names: BTreeSet<&String> = s_cols.keys().collect();
        let g_col_names: BTreeSet<&String> = g_cols.keys().collect();

        for c in s_col_names.difference(&g_col_names) {
            if let Some(info) = s_cols.get(*c) {
                columns_added.push(info.clone());
            }
        }
        for c in g_col_names.difference(&s_col_names) {
            if let Some(info) = g_cols.get(*c) {
                columns_removed.push(info.clone());
            }
        }
        for c in s_col_names.intersection(&g_col_names) {
            let s_info = s_cols.get(*c).cloned().unwrap();
            let g_info = g_cols.get(*c).cloned().unwrap();
            let mut diffs: Vec<String> = Vec::new();
            if s_info.column_type != g_info.column_type {
                diffs.push("type".into());
            }
            if s_info.nullable != g_info.nullable {
                diffs.push("nullable".into());
            }
            if s_info.default != g_info.default {
                diffs.push("default".into());
            }
            if s_info.extra != g_info.extra {
                diffs.push("extra".into());
            }
            if s_info.comment != g_info.comment {
                diffs.push("comment".into());
            }
            if !diffs.is_empty() {
                columns_changed.push(ColumnChange {
                    name: (*c).clone(),
                    source: s_info,
                    target: g_info,
                    differences: diffs,
                });
            }
        }

        let mut indexes_added: Vec<IndexInfo> = Vec::new();
        let mut indexes_removed: Vec<IndexInfo> = Vec::new();
        let s_idx_names: BTreeSet<&String> = s_idx.keys().collect();
        let g_idx_names: BTreeSet<&String> = g_idx.keys().collect();
        for i in s_idx_names.difference(&g_idx_names) {
            if let Some(info) = s_idx.get(*i) {
                indexes_added.push(info.clone());
            }
        }
        for i in g_idx_names.difference(&s_idx_names) {
            if let Some(info) = g_idx.get(*i) {
                indexes_removed.push(info.clone());
            }
        }
        for i in s_idx_names.intersection(&g_idx_names) {
            let s_info = s_idx.get(*i).cloned().unwrap();
            let g_info = g_idx.get(*i).cloned().unwrap();
            if s_info.columns != g_info.columns || s_info.unique != g_info.unique {
                indexes_removed.push(g_info);
                indexes_added.push(s_info);
            }
        }

        if columns_added.is_empty()
            && columns_removed.is_empty()
            && columns_changed.is_empty()
            && indexes_added.is_empty()
            && indexes_removed.is_empty()
        {
            continue;
        }

        for col in &columns_added {
            let parts = build_column_clause(col);
            migrations.push(MigrationStatement {
                kind: "add_column".into(),
                table: t.clone(),
                sql: format!(
                    "ALTER TABLE `{target_db}`.`{t}` ADD COLUMN {parts};"
                ),
                destructive: false,
            });
        }
        for col in &columns_removed {
            migrations.push(MigrationStatement {
                kind: "drop_column".into(),
                table: t.clone(),
                sql: format!(
                    "ALTER TABLE `{target_db}`.`{t}` DROP COLUMN `{}`;",
                    col.name
                ),
                destructive: true,
            });
        }
        for change in &columns_changed {
            let parts = build_column_clause(&change.source);
            migrations.push(MigrationStatement {
                kind: "modify_column".into(),
                table: t.clone(),
                sql: format!(
                    "ALTER TABLE `{target_db}`.`{t}` MODIFY COLUMN {parts};"
                ),
                destructive: change.differences.iter().any(|d| d == "type"),
            });
        }
        for idx in &indexes_removed {
            migrations.push(MigrationStatement {
                kind: "drop_index".into(),
                table: t.clone(),
                sql: format!(
                    "ALTER TABLE `{target_db}`.`{t}` DROP INDEX `{}`;",
                    idx.name
                ),
                destructive: false,
            });
        }
        for idx in &indexes_added {
            let unique = if idx.unique { " UNIQUE" } else { "" };
            let cols = idx
                .columns
                .iter()
                .map(|c| format!("`{c}`"))
                .collect::<Vec<_>>()
                .join(", ");
            if idx.name == "PRIMARY" {
                migrations.push(MigrationStatement {
                    kind: "add_index".into(),
                    table: t.clone(),
                    sql: format!(
                        "ALTER TABLE `{target_db}`.`{t}` ADD PRIMARY KEY ({cols});"
                    ),
                    destructive: false,
                });
            } else {
                migrations.push(MigrationStatement {
                    kind: "add_index".into(),
                    table: t.clone(),
                    sql: format!(
                        "ALTER TABLE `{target_db}`.`{t}` ADD{unique} INDEX `{}` ({cols});",
                        idx.name
                    ),
                    destructive: false,
                });
            }
        }

        tables_changed.push(TableDiff {
            name: t.clone(),
            columns_added,
            columns_removed,
            columns_changed,
            indexes_added,
            indexes_removed,
        });
    }

    Ok(DiffReport {
        source_db: source_db.to_string(),
        target_db: target_db.to_string(),
        tables_added,
        tables_removed,
        tables_changed,
        migrations,
        source_creates,
    })
}

#[derive(Debug, Serialize)]
pub struct ProjectSchemaDiffReport {
    pub elapsed_ms: u64,
    pub project_id: i64,
    pub project_name: String,
    pub source_connection_id: i64,
    pub source_connection_name: String,
    pub source_db: String,
    pub target_connection_id: i64,
    pub target_connection_name: String,
    pub target_db: String,
    pub scope_tables: Vec<String>,
    pub scope_tables_missing_source: Vec<String>,
    pub scope_tables_missing_target: Vec<String>,
    pub diff: DiffReport,
}

pub async fn collect_project_schema_diff(
    sqlite: &SqlitePool,
    pools: &HashMap<i64, MySqlPool>,
    project_id: i64,
    source_connection_id: i64,
    source_db: &str,
    target_connection_id: i64,
    target_db: &str,
) -> Result<ProjectSchemaDiffReport, String> {
    let start = Instant::now();

    if source_connection_id == target_connection_id && source_db == target_db {
        return Err("Source and target are identical. Pick a different connection or database.".into());
    }

    let connections = crate::storage::connection::list_all(sqlite)
        .await
        .map_err(|e| format!("load connections failed: {e}"))?;
    let conn_name: HashMap<i64, String> = connections
        .into_iter()
        .filter_map(|c| c.id.map(|id| (id, c.name)))
        .collect();

    let meta: (String,) = sqlx::query_as("SELECT name FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(sqlite)
        .await
        .map_err(|e| format!("project not found: {e}"))?;

    let source_pool = pools.get(&source_connection_id).ok_or_else(|| {
        format!(
            "source connection #{source_connection_id} is not open. Open it in the workspace sidebar first."
        )
    })?;
    let target_pool = pools.get(&target_connection_id).ok_or_else(|| {
        format!(
            "target connection #{target_connection_id} is not open. Open it in the workspace sidebar first."
        )
    })?;

    let table_rows = crate::storage::project::list_tables(sqlite, project_id)
        .await
        .map_err(|e| format!("list project tables failed: {e}"))?;
    let scope: BTreeSet<String> = table_rows
        .iter()
        .map(|t| t.table_name.clone())
        .collect();
    if scope.is_empty() {
        return Err("Project has no tables yet. Add tables in Edit project.".into());
    }

    let source_cols = fetch_columns(source_pool, source_db).await?;
    let target_cols = fetch_columns(target_pool, target_db).await?;
    let source_present: BTreeSet<&String> = source_cols.keys().collect();
    let target_present: BTreeSet<&String> = target_cols.keys().collect();
    let scope_tables_missing_source: Vec<String> = scope
        .iter()
        .filter(|t| !source_present.contains(*t))
        .cloned()
        .collect();
    let scope_tables_missing_target: Vec<String> = scope
        .iter()
        .filter(|t| !target_present.contains(*t))
        .cloned()
        .collect();

    let diff = compare_schemas_cross(
        source_pool,
        source_db,
        target_pool,
        target_db,
        Some(&scope),
    )
    .await?;

    Ok(ProjectSchemaDiffReport {
        elapsed_ms: start.elapsed().as_millis() as u64,
        project_id,
        project_name: meta.0,
        source_connection_id,
        source_connection_name: conn_name
            .get(&source_connection_id)
            .cloned()
            .unwrap_or_else(|| format!("#{source_connection_id}")),
        source_db: source_db.to_string(),
        target_connection_id,
        target_connection_name: conn_name
            .get(&target_connection_id)
            .cloned()
            .unwrap_or_else(|| format!("#{target_connection_id}")),
        target_db: target_db.to_string(),
        scope_tables: scope.into_iter().collect(),
        scope_tables_missing_source,
        scope_tables_missing_target,
        diff,
    })
}

fn build_column_clause(col: &ColumnInfo) -> String {
    let mut out = format!("`{}` {}", col.name, col.column_type);
    if !col.nullable {
        out.push_str(" NOT NULL");
    }
    if let Some(d) = &col.default {
        // MySQL stores CURRENT_TIMESTAMP as literal, not quoted
        if d.eq_ignore_ascii_case("CURRENT_TIMESTAMP")
            || d.starts_with("(")
            || d.parse::<f64>().is_ok()
        {
            out.push_str(&format!(" DEFAULT {d}"));
        } else {
            let escaped = d.replace('\'', "''");
            out.push_str(&format!(" DEFAULT '{escaped}'"));
        }
    } else if col.nullable {
        out.push_str(" DEFAULT NULL");
    }
    if !col.extra.is_empty() {
        out.push_str(&format!(" {}", col.extra));
    }
    if !col.comment.is_empty() {
        let escaped = col.comment.replace('\'', "''");
        out.push_str(&format!(" COMMENT '{escaped}'"));
    }
    out
}
