pub mod repair;

use serde::Serialize;
use sqlx::{MySqlPool, Row, SqlitePool};
use std::collections::HashMap;
use std::time::Instant;

const SYSTEM_DBS: &[&str] = &["information_schema", "performance_schema", "mysql", "sys"];

#[derive(Debug, Serialize, Clone)]
pub struct OnboardingColumn {
    pub name: String,
    pub data_type: String,
    pub is_primary: bool,
    pub is_indexed: bool,
    pub comment: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct OnboardingTable {
    pub name: String,
    pub estimated_rows: i64,
    pub data_mb: f64,
    pub comment: String,
    pub columns: Vec<OnboardingColumn>,
}

#[derive(Debug, Serialize, Clone)]
pub struct OnboardingFk {
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct OnboardingSnapshot {
    pub database: String,
    pub server_version: String,
    pub tables: Vec<OnboardingTable>,
    pub fks: Vec<OnboardingFk>,
    pub total_tables: usize,
    pub elapsed_ms: u64,
}

pub async fn collect_snapshot(
    pool: &MySqlPool,
    database: &str,
    max_tables: usize,
) -> Result<OnboardingSnapshot, String> {
    let start = Instant::now();

    if SYSTEM_DBS.contains(&database) {
        return Err("Cannot onboard a MySQL system database".to_string());
    }

    let server_version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("fetch version failed: {e}"))?;

    let table_rows: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT CAST(TABLE_NAME AS CHAR), \
                CAST(IFNULL(TABLE_ROWS, 0) AS SIGNED), \
                CAST(IFNULL(DATA_LENGTH, 0) AS SIGNED), \
                CAST(IFNULL(TABLE_COMMENT, '') AS CHAR) \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
         ORDER BY IFNULL(DATA_LENGTH, 0) DESC, IFNULL(TABLE_ROWS, 0) DESC",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("fetch tables failed: {e}"))?;

    let total_tables = table_rows.len();
    let selected: Vec<(String, i64, i64, String)> =
        table_rows.into_iter().take(max_tables).collect();

    if selected.is_empty() {
        return Ok(OnboardingSnapshot {
            database: database.to_string(),
            server_version,
            tables: vec![],
            fks: vec![],
            total_tables,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    let names: Vec<String> = selected.iter().map(|t| t.0.clone()).collect();
    let placeholders = vec!["?"; names.len()].join(",");

    let col_sql = format!(
        "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                CAST(COLUMN_TYPE AS CHAR), CAST(COLUMN_KEY AS CHAR), \
                CAST(IFNULL(COLUMN_COMMENT, '') AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) \
         ORDER BY TABLE_NAME, ORDINAL_POSITION"
    );
    let mut col_query = sqlx::query(&col_sql).bind(database);
    for n in &names {
        col_query = col_query.bind(n);
    }
    let col_rows = col_query
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch columns failed: {e}"))?;

    let mut cols_by_table: HashMap<String, Vec<OnboardingColumn>> = HashMap::new();
    for r in col_rows {
        let table: String = r
            .try_get(0)
            .map_err(|e| format!("decode column row failed: {e}"))?;
        let name: String = r
            .try_get(1)
            .map_err(|e| format!("decode column row failed: {e}"))?;
        let column_type: String = r
            .try_get(2)
            .map_err(|e| format!("decode column row failed: {e}"))?;
        let column_key: String = r
            .try_get(3)
            .map_err(|e| format!("decode column row failed: {e}"))?;
        let comment: String = r
            .try_get(4)
            .map_err(|e| format!("decode column row failed: {e}"))?;
        cols_by_table
            .entry(table)
            .or_default()
            .push(OnboardingColumn {
                name,
                data_type: column_type,
                is_primary: column_key == "PRI",
                is_indexed: matches!(column_key.as_str(), "PRI" | "UNI" | "MUL"),
                comment,
            });
    }

    let tables: Vec<OnboardingTable> = selected
        .into_iter()
        .map(|(name, rows, data_len, comment)| {
            let columns = cols_by_table.remove(&name).unwrap_or_default();
            OnboardingTable {
                name,
                estimated_rows: rows,
                data_mb: data_len as f64 / 1024.0 / 1024.0,
                comment,
                columns,
            }
        })
        .collect();

    let fk_sql = format!(
        "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                CAST(REFERENCED_TABLE_NAME AS CHAR), CAST(REFERENCED_COLUMN_NAME AS CHAR) \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
           AND TABLE_NAME IN ({placeholders})"
    );
    let mut fk_query = sqlx::query_as(&fk_sql).bind(database);
    for n in &names {
        fk_query = fk_query.bind(n);
    }
    let fk_rows: Vec<(String, String, String, String)> = fk_query
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch fk failed: {e}"))?;

    let fks: Vec<OnboardingFk> = fk_rows
        .into_iter()
        .map(|(ft, fc, tt, tc)| OnboardingFk {
            from_table: ft,
            from_column: fc,
            to_table: tt,
            to_column: tc,
        })
        .collect();

    Ok(OnboardingSnapshot {
        database: database.to_string(),
        server_version,
        tables,
        fks,
        total_tables,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct ImpactColumnMeta {
    pub database: String,
    pub table: String,
    pub column: String,
    pub data_type: String,
    pub column_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub column_key: String,
    pub comment: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ViewReference {
    pub database: String,
    pub view: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RoutineReference {
    pub database: String,
    pub name: String,
    pub routine_type: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TriggerReference {
    pub database: String,
    pub trigger: String,
    pub event_table: String,
    pub event: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct FkReference {
    pub from_db: String,
    pub from_table: String,
    pub from_column: String,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    pub direction: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct HistoryReference {
    pub count: i64,
    pub recent_sql: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImpactReport {
    pub column: ImpactColumnMeta,
    pub views: Vec<ViewReference>,
    pub routines: Vec<RoutineReference>,
    pub triggers: Vec<TriggerReference>,
    pub fks: Vec<FkReference>,
    pub history: HistoryReference,
    pub views_scan_error: Option<String>,
    pub routines_scan_error: Option<String>,
    pub triggers_scan_error: Option<String>,
    pub elapsed_ms: u64,
}

pub async fn analyze_impact(
    mysql: &MySqlPool,
    sqlite: &SqlitePool,
    connection_id: i64,
    database: &str,
    table: &str,
    column: &str,
) -> Result<ImpactReport, String> {
    let start = Instant::now();

    let col_row: Option<(String, String, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT CAST(DATA_TYPE AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
                CAST(IS_NULLABLE AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), \
                CAST(COLUMN_KEY AS CHAR), CAST(IFNULL(COLUMN_COMMENT,'') AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    )
    .bind(database)
    .bind(table)
    .bind(column)
    .fetch_optional(mysql)
    .await
    .map_err(|e| format!("fetch column meta failed: {e}"))?;

    let (data_type, column_type, is_nullable, default, column_key, comment) = col_row
        .ok_or_else(|| format!("Column `{database}`.`{table}`.`{column}` not found"))?;

    let column_meta = ImpactColumnMeta {
        database: database.to_string(),
        table: table.to_string(),
        column: column.to_string(),
        data_type,
        column_type,
        nullable: is_nullable.eq_ignore_ascii_case("YES"),
        default,
        column_key,
        comment,
    };

    let pattern_qualified = format!("%`{table}`%`{column}`%");
    let pattern_unqualified_back = format!("%`{column}`%");
    let pattern_naked = format!("%{column}%");

    let (views, views_err) = scan_views(mysql, &pattern_qualified, &pattern_unqualified_back).await;
    let (routines, routines_err) =
        scan_routines(mysql, &pattern_qualified, &pattern_unqualified_back).await;
    let (triggers, triggers_err) =
        scan_triggers(mysql, &pattern_qualified, &pattern_unqualified_back).await;
    let fks = scan_fks(mysql, database, table, column).await.unwrap_or_default();
    let history = scan_history(sqlite, connection_id, &pattern_naked).await;

    Ok(ImpactReport {
        column: column_meta,
        views,
        routines,
        triggers,
        fks,
        history,
        views_scan_error: views_err,
        routines_scan_error: routines_err,
        triggers_scan_error: triggers_err,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

async fn scan_views(
    pool: &MySqlPool,
    pat_a: &str,
    pat_b: &str,
) -> (Vec<ViewReference>, Option<String>) {
    let sql = "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), \
                      CAST(VIEW_DEFINITION AS CHAR) \
               FROM information_schema.VIEWS \
               WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                 AND (VIEW_DEFINITION LIKE ? OR VIEW_DEFINITION LIKE ?)";
    match sqlx::query_as::<_, (String, String, String)>(sql)
        .bind(pat_a)
        .bind(pat_b)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => {
            let refs = rows
                .into_iter()
                .map(|(db, view, def)| ViewReference {
                    database: db,
                    view,
                    snippet: snippet_around(&def, pat_b, 80),
                })
                .collect();
            (refs, None)
        }
        Err(e) => (Vec::new(), Some(format!("views scan failed: {e}"))),
    }
}

async fn scan_routines(
    pool: &MySqlPool,
    pat_a: &str,
    pat_b: &str,
) -> (Vec<RoutineReference>, Option<String>) {
    let sql = "SELECT CAST(ROUTINE_SCHEMA AS CHAR), CAST(ROUTINE_NAME AS CHAR), \
                      CAST(ROUTINE_TYPE AS CHAR), CAST(ROUTINE_DEFINITION AS CHAR) \
               FROM information_schema.ROUTINES \
               WHERE ROUTINE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                 AND ROUTINE_DEFINITION IS NOT NULL \
                 AND (ROUTINE_DEFINITION LIKE ? OR ROUTINE_DEFINITION LIKE ?)";
    match sqlx::query_as::<_, (String, String, String, String)>(sql)
        .bind(pat_a)
        .bind(pat_b)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => {
            let refs = rows
                .into_iter()
                .map(|(db, name, rtype, def)| RoutineReference {
                    database: db,
                    name,
                    routine_type: rtype,
                    snippet: snippet_around(&def, pat_b, 80),
                })
                .collect();
            (refs, None)
        }
        Err(e) => (Vec::new(), Some(format!("routines scan failed: {e}"))),
    }
}

async fn scan_triggers(
    pool: &MySqlPool,
    pat_a: &str,
    pat_b: &str,
) -> (Vec<TriggerReference>, Option<String>) {
    let sql = "SELECT CAST(TRIGGER_SCHEMA AS CHAR), CAST(TRIGGER_NAME AS CHAR), \
                      CAST(EVENT_OBJECT_TABLE AS CHAR), CAST(EVENT_MANIPULATION AS CHAR), \
                      CAST(ACTION_STATEMENT AS CHAR) \
               FROM information_schema.TRIGGERS \
               WHERE TRIGGER_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                 AND (ACTION_STATEMENT LIKE ? OR ACTION_STATEMENT LIKE ?)";
    match sqlx::query_as::<_, (String, String, String, String, String)>(sql)
        .bind(pat_a)
        .bind(pat_b)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => {
            let refs = rows
                .into_iter()
                .map(|(db, trig, evt_tbl, evt, def)| TriggerReference {
                    database: db,
                    trigger: trig,
                    event_table: evt_tbl,
                    event: evt,
                    snippet: snippet_around(&def, pat_b, 80),
                })
                .collect();
            (refs, None)
        }
        Err(e) => (Vec::new(), Some(format!("triggers scan failed: {e}"))),
    }
}

async fn scan_fks(
    pool: &MySqlPool,
    database: &str,
    table: &str,
    column: &str,
) -> Result<Vec<FkReference>, String> {
    let mut out = Vec::new();
    let inbound: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                CAST(REFERENCED_TABLE_SCHEMA AS CHAR), CAST(REFERENCED_TABLE_NAME AS CHAR), \
                CAST(REFERENCED_COLUMN_NAME AS CHAR) \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? AND REFERENCED_COLUMN_NAME = ?",
    )
    .bind(database)
    .bind(table)
    .bind(column)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("scan inbound FKs failed: {e}"))?;

    for (fdb, ft, fc, tdb, tt, tc) in inbound {
        out.push(FkReference {
            from_db: fdb,
            from_table: ft,
            from_column: fc,
            to_db: tdb,
            to_table: tt,
            to_column: tc,
            direction: "inbound".to_string(),
        });
    }

    let outbound: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                CAST(REFERENCED_TABLE_SCHEMA AS CHAR), CAST(REFERENCED_TABLE_NAME AS CHAR), \
                CAST(REFERENCED_COLUMN_NAME AS CHAR) \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? \
           AND REFERENCED_TABLE_NAME IS NOT NULL",
    )
    .bind(database)
    .bind(table)
    .bind(column)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("scan outbound FKs failed: {e}"))?;

    for (fdb, ft, fc, tdb, tt, tc) in outbound {
        out.push(FkReference {
            from_db: fdb,
            from_table: ft,
            from_column: fc,
            to_db: tdb,
            to_table: tt,
            to_column: tc,
            direction: "outbound".to_string(),
        });
    }

    Ok(out)
}

async fn scan_history(
    sqlite: &SqlitePool,
    connection_id: i64,
    pattern: &str,
) -> HistoryReference {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM query_history WHERE connection_id = ? AND sql LIKE ?",
    )
    .bind(connection_id)
    .bind(pattern)
    .fetch_one(sqlite)
    .await
    .unwrap_or(0);

    let recent: Vec<String> = sqlx::query_scalar(
        "SELECT sql FROM query_history WHERE connection_id = ? AND sql LIKE ? \
         ORDER BY id DESC LIMIT 5",
    )
    .bind(connection_id)
    .bind(pattern)
    .fetch_all(sqlite)
    .await
    .unwrap_or_default();

    HistoryReference {
        count,
        recent_sql: recent
            .into_iter()
            .map(|s| s.chars().take(240).collect::<String>())
            .collect(),
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct BriefingColumn {
    pub name: String,
    pub data_type: String,
    pub is_primary: bool,
    pub is_indexed: bool,
    pub comment: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct BriefingTableRef {
    pub connection_id: i64,
    pub connection_name: String,
    pub database: String,
    pub table: String,
    pub alias: Option<String>,
    pub is_primary: bool,
    pub closed: bool,
    pub estimated_rows: i64,
    pub data_mb: f64,
    pub comment: String,
    pub columns: Vec<BriefingColumn>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BriefingRelation {
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
    pub cross_db: bool,
    pub cross_conn: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectBriefingSnapshot {
    pub project_id: i64,
    pub project_name: String,
    pub project_description: Option<String>,
    pub tables: Vec<BriefingTableRef>,
    pub relations: Vec<BriefingRelation>,
    pub total_tables: usize,
    pub total_relations: usize,
    pub missing_connection_ids: Vec<i64>,
    pub elapsed_ms: u64,
}

pub async fn collect_project_briefing(
    sqlite: &SqlitePool,
    pools: &HashMap<i64, MySqlPool>,
    project_id: i64,
) -> Result<ProjectBriefingSnapshot, String> {
    let start = Instant::now();

    let project = crate::storage::connection::list_all(sqlite)
        .await
        .map_err(|e| format!("load connections failed: {e}"))?;
    let conn_name: HashMap<i64, String> = project
        .into_iter()
        .filter_map(|c| c.id.map(|id| (id, c.name)))
        .collect();

    let meta: (String, Option<String>) = sqlx::query_as(
        "SELECT name, description FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_one(sqlite)
    .await
    .map_err(|e| format!("project not found: {e}"))?;

    let table_rows = crate::storage::project::list_tables(sqlite, project_id)
        .await
        .map_err(|e| format!("list project tables failed: {e}"))?;
    let relation_rows = crate::storage::project::list_relations(sqlite, project_id)
        .await
        .map_err(|e| format!("list project relations failed: {e}"))?;

    let mut by_pool: HashMap<(i64, String), Vec<usize>> = HashMap::new();
    for (i, t) in table_rows.iter().enumerate() {
        by_pool
            .entry((t.connection_id, t.database_name.clone()))
            .or_default()
            .push(i);
    }

    let mut tables: Vec<BriefingTableRef> = table_rows
        .iter()
        .map(|t| BriefingTableRef {
            connection_id: t.connection_id,
            connection_name: conn_name
                .get(&t.connection_id)
                .cloned()
                .unwrap_or_else(|| format!("#{}", t.connection_id)),
            database: t.database_name.clone(),
            table: t.table_name.clone(),
            alias: t.alias.clone(),
            is_primary: t.is_primary == 1,
            closed: !pools.contains_key(&t.connection_id),
            estimated_rows: 0,
            data_mb: 0.0,
            comment: String::new(),
            columns: Vec::new(),
        })
        .collect();

    let mut missing_set: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();

    for ((conn_id, db), idxs) in by_pool {
        let pool = match pools.get(&conn_id) {
            Some(p) => p,
            None => {
                missing_set.insert(conn_id);
                continue;
            }
        };
        let names: Vec<String> = idxs
            .iter()
            .map(|&i| table_rows[i].table_name.clone())
            .collect();
        let placeholders = vec!["?"; names.len()].join(",");

        let tbl_sql = format!(
            "SELECT CAST(TABLE_NAME AS CHAR), \
                    CAST(IFNULL(TABLE_ROWS, 0) AS SIGNED), \
                    CAST(IFNULL(DATA_LENGTH, 0) AS SIGNED), \
                    CAST(IFNULL(TABLE_COMMENT, '') AS CHAR) \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders})"
        );
        let mut tbl_q = sqlx::query_as::<_, (String, i64, i64, String)>(&tbl_sql).bind(&db);
        for n in &names {
            tbl_q = tbl_q.bind(n);
        }
        let tbl_rows = tbl_q.fetch_all(pool).await.unwrap_or_default();
        let mut stats: HashMap<String, (i64, i64, String)> = HashMap::new();
        for (n, rows, len, cmt) in tbl_rows {
            stats.insert(n, (rows, len, cmt));
        }

        let col_sql = format!(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                    CAST(COLUMN_TYPE AS CHAR), CAST(COLUMN_KEY AS CHAR), \
                    CAST(IFNULL(COLUMN_COMMENT, '') AS CHAR) \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) \
             ORDER BY TABLE_NAME, ORDINAL_POSITION"
        );
        let mut col_q = sqlx::query(&col_sql).bind(&db);
        for n in &names {
            col_q = col_q.bind(n);
        }
        let col_rows = col_q.fetch_all(pool).await.unwrap_or_default();
        let mut cols_by_table: HashMap<String, Vec<BriefingColumn>> = HashMap::new();
        for r in col_rows {
            let tname: String = match r.try_get(0) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let name: String = match r.try_get(1) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let column_type: String = r.try_get(2).unwrap_or_default();
            let column_key: String = r.try_get(3).unwrap_or_default();
            let comment: String = r.try_get(4).unwrap_or_default();
            cols_by_table
                .entry(tname)
                .or_default()
                .push(BriefingColumn {
                    name,
                    data_type: column_type,
                    is_primary: column_key == "PRI",
                    is_indexed: matches!(column_key.as_str(), "PRI" | "UNI" | "MUL"),
                    comment,
                });
        }

        for &i in &idxs {
            let tbl = &table_rows[i];
            if let Some((rows, len, cmt)) = stats.remove(&tbl.table_name) {
                tables[i].estimated_rows = rows;
                tables[i].data_mb = len as f64 / 1024.0 / 1024.0;
                tables[i].comment = cmt;
            }
            tables[i].columns = cols_by_table.remove(&tbl.table_name).unwrap_or_default();
        }
    }

    tables.sort_by(|a, b| {
        b.is_primary
            .cmp(&a.is_primary)
            .then(a.connection_id.cmp(&b.connection_id))
            .then(a.database.cmp(&b.database))
            .then(a.table.cmp(&b.table))
    });

    let total_relations = relation_rows.len();
    let relations: Vec<BriefingRelation> = relation_rows
        .into_iter()
        .map(|r| {
            let cross_conn = r.from_connection_id != r.to_connection_id;
            let cross_db = !cross_conn && r.from_db != r.to_db;
            BriefingRelation {
                from_connection_id: r.from_connection_id,
                from_db: r.from_db,
                from_table: r.from_table,
                from_column: r.from_column,
                to_connection_id: r.to_connection_id,
                to_db: r.to_db,
                to_table: r.to_table,
                to_column: r.to_column,
                cardinality: r.cardinality,
                source: r.source,
                cross_db,
                cross_conn,
            }
        })
        .collect();

    let total_tables = tables.len();

    Ok(ProjectBriefingSnapshot {
        project_id,
        project_name: meta.0,
        project_description: meta.1,
        tables,
        relations,
        total_tables,
        total_relations,
        missing_connection_ids: missing_set.into_iter().collect(),
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct PropagationEdge {
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
    pub cross_db: bool,
    pub cross_conn: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PropagationPath {
    pub depth: usize,
    pub edges: Vec<PropagationEdge>,
}

#[derive(Debug, Serialize)]
pub struct ProjectImpactReport {
    pub project_id: i64,
    pub project_name: String,
    pub column: ImpactColumnMeta,
    pub connection_id: i64,
    pub connection_name: String,
    /// All propagation paths via user-curated project_relations, BFS up to `max_depth`.
    pub propagation_paths: Vec<PropagationPath>,
    pub views: Vec<ViewReference>,
    pub routines: Vec<RoutineReference>,
    pub triggers: Vec<TriggerReference>,
    pub fks: Vec<FkReference>,
    pub history: HistoryReference,
    pub views_scan_error: Option<String>,
    pub routines_scan_error: Option<String>,
    pub triggers_scan_error: Option<String>,
    pub elapsed_ms: u64,
}

const PROPAGATION_MAX_DEPTH: usize = 3;

pub async fn analyze_project_impact(
    sqlite: &SqlitePool,
    pools: &HashMap<i64, MySqlPool>,
    project_id: i64,
    connection_id: i64,
    database: &str,
    table: &str,
    column: &str,
) -> Result<ProjectImpactReport, String> {
    let start = Instant::now();

    let project_meta: (String,) = sqlx::query_as("SELECT name FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(sqlite)
        .await
        .map_err(|e| format!("project not found: {e}"))?;

    let conns = crate::storage::connection::list_all(sqlite)
        .await
        .map_err(|e| format!("load connections failed: {e}"))?;
    let conn_name_for: HashMap<i64, String> = conns
        .into_iter()
        .filter_map(|c| c.id.map(|id| (id, c.name)))
        .collect();
    let conn_name = conn_name_for
        .get(&connection_id)
        .cloned()
        .unwrap_or_else(|| format!("#{connection_id}"));

    let pool = pools
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Source connection is not open".to_string())?;

    let col_row: Option<(String, String, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT CAST(DATA_TYPE AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
                CAST(IS_NULLABLE AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), \
                CAST(COLUMN_KEY AS CHAR), CAST(IFNULL(COLUMN_COMMENT,'') AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    )
    .bind(database)
    .bind(table)
    .bind(column)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("fetch column meta failed: {e}"))?;

    let (data_type, column_type, is_nullable, default, column_key, comment) = col_row
        .ok_or_else(|| format!("Column `{database}`.`{table}`.`{column}` not found"))?;

    let column_meta = ImpactColumnMeta {
        database: database.to_string(),
        table: table.to_string(),
        column: column.to_string(),
        data_type,
        column_type,
        nullable: is_nullable.eq_ignore_ascii_case("YES"),
        default,
        column_key,
        comment,
    };

    let pattern_qualified = format!("%`{table}`%`{column}`%");
    let pattern_unqualified_back = format!("%`{column}`%");
    let pattern_naked = format!("%{column}%");

    let (views, views_err) = scan_views(&pool, &pattern_qualified, &pattern_unqualified_back).await;
    let (routines, routines_err) =
        scan_routines(&pool, &pattern_qualified, &pattern_unqualified_back).await;
    let (triggers, triggers_err) =
        scan_triggers(&pool, &pattern_qualified, &pattern_unqualified_back).await;
    let fks = scan_fks(&pool, database, table, column)
        .await
        .unwrap_or_default();

    let project_relations = crate::storage::project::list_relations(sqlite, project_id)
        .await
        .map_err(|e| format!("list project relations failed: {e}"))?;

    let propagation_paths = bfs_propagation(
        &project_relations,
        connection_id,
        database,
        table,
        column,
        PROPAGATION_MAX_DEPTH,
    );

    let history_pool_ids: std::collections::BTreeSet<i64> = {
        let mut s = std::collections::BTreeSet::new();
        s.insert(connection_id);
        for r in &project_relations {
            s.insert(r.from_connection_id);
            s.insert(r.to_connection_id);
        }
        s
    };
    let history = scan_history_multi(sqlite, &history_pool_ids, &pattern_naked).await;

    Ok(ProjectImpactReport {
        project_id,
        project_name: project_meta.0,
        column: column_meta,
        connection_id,
        connection_name: conn_name,
        propagation_paths,
        views,
        routines,
        triggers,
        fks,
        history,
        views_scan_error: views_err,
        routines_scan_error: routines_err,
        triggers_scan_error: triggers_err,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn bfs_propagation(
    relations: &[crate::storage::project::ProjectRelation],
    start_conn: i64,
    start_db: &str,
    start_table: &str,
    start_column: &str,
    max_depth: usize,
) -> Vec<PropagationPath> {
    type NodeKey = (i64, String, String, String);
    let start_key: NodeKey = (
        start_conn,
        start_db.to_string(),
        start_table.to_string(),
        start_column.to_string(),
    );

    let mut paths: Vec<PropagationPath> = Vec::new();
    let mut frontier: Vec<(NodeKey, Vec<PropagationEdge>)> = vec![(start_key.clone(), Vec::new())];
    let mut seen: std::collections::HashSet<NodeKey> = std::collections::HashSet::new();
    seen.insert(start_key);

    for depth in 1..=max_depth {
        let mut next_frontier: Vec<(NodeKey, Vec<PropagationEdge>)> = Vec::new();
        for (node, prefix) in &frontier {
            for r in relations {
                let mut edge_opt: Option<(NodeKey, PropagationEdge)> = None;
                if r.from_connection_id == node.0
                    && r.from_db == node.1
                    && r.from_table == node.2
                    && r.from_column == node.3
                {
                    let to_key = (
                        r.to_connection_id,
                        r.to_db.clone(),
                        r.to_table.clone(),
                        r.to_column.clone(),
                    );
                    let cross_conn = r.from_connection_id != r.to_connection_id;
                    let cross_db = !cross_conn && r.from_db != r.to_db;
                    edge_opt = Some((
                        to_key,
                        PropagationEdge {
                            from_connection_id: r.from_connection_id,
                            from_db: r.from_db.clone(),
                            from_table: r.from_table.clone(),
                            from_column: r.from_column.clone(),
                            to_connection_id: r.to_connection_id,
                            to_db: r.to_db.clone(),
                            to_table: r.to_table.clone(),
                            to_column: r.to_column.clone(),
                            cardinality: r.cardinality.clone(),
                            source: r.source.clone(),
                            cross_db,
                            cross_conn,
                        },
                    ));
                } else if r.to_connection_id == node.0
                    && r.to_db == node.1
                    && r.to_table == node.2
                    && r.to_column == node.3
                {
                    let to_key = (
                        r.from_connection_id,
                        r.from_db.clone(),
                        r.from_table.clone(),
                        r.from_column.clone(),
                    );
                    let cross_conn = r.from_connection_id != r.to_connection_id;
                    let cross_db = !cross_conn && r.from_db != r.to_db;
                    edge_opt = Some((
                        to_key,
                        PropagationEdge {
                            from_connection_id: r.to_connection_id,
                            from_db: r.to_db.clone(),
                            from_table: r.to_table.clone(),
                            from_column: r.to_column.clone(),
                            to_connection_id: r.from_connection_id,
                            to_db: r.from_db.clone(),
                            to_table: r.from_table.clone(),
                            to_column: r.from_column.clone(),
                            cardinality: r.cardinality.clone(),
                            source: format!("{} (reverse)", r.source),
                            cross_db,
                            cross_conn,
                        },
                    ));
                }
                if let Some((to_key, edge)) = edge_opt {
                    if !seen.contains(&to_key) {
                        let mut new_edges = prefix.clone();
                        new_edges.push(edge);
                        paths.push(PropagationPath {
                            depth,
                            edges: new_edges.clone(),
                        });
                        seen.insert(to_key.clone());
                        next_frontier.push((to_key, new_edges));
                    }
                }
            }
        }
        if next_frontier.is_empty() {
            break;
        }
        frontier = next_frontier;
    }
    paths
}

async fn scan_history_multi(
    sqlite: &SqlitePool,
    connection_ids: &std::collections::BTreeSet<i64>,
    pattern: &str,
) -> HistoryReference {
    if connection_ids.is_empty() {
        return HistoryReference {
            count: 0,
            recent_sql: Vec::new(),
        };
    }
    let placeholders = vec!["?"; connection_ids.len()].join(",");
    let count_sql = format!(
        "SELECT COUNT(*) FROM query_history \
         WHERE connection_id IN ({placeholders}) AND sql LIKE ?"
    );
    let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
    for cid in connection_ids {
        q = q.bind(cid);
    }
    let count: i64 = q.bind(pattern).fetch_one(sqlite).await.unwrap_or(0);

    let recent_sql = format!(
        "SELECT sql FROM query_history \
         WHERE connection_id IN ({placeholders}) AND sql LIKE ? \
         ORDER BY id DESC LIMIT 5"
    );
    let mut q = sqlx::query_scalar::<_, String>(&recent_sql);
    for cid in connection_ids {
        q = q.bind(cid);
    }
    let recent = q
        .bind(pattern)
        .fetch_all(sqlite)
        .await
        .unwrap_or_default();

    HistoryReference {
        count,
        recent_sql: recent
            .into_iter()
            .map(|s| s.chars().take(240).collect::<String>())
            .collect(),
    }
}

fn snippet_around(haystack: &str, needle_like: &str, radius: usize) -> String {
    let needle = needle_like.trim_matches('%');
    let lower_hs = haystack.to_lowercase();
    let lower_n = needle.to_lowercase();
    let pos = match lower_hs.find(&lower_n) {
        Some(p) => p,
        None => return haystack.chars().take(radius * 2).collect::<String>(),
    };
    let start = pos.saturating_sub(radius);
    let end = (pos + needle.len() + radius).min(haystack.len());
    let mut s = String::new();
    if start > 0 {
        s.push_str("…");
    }
    s.push_str(&haystack[start..end]);
    if end < haystack.len() {
        s.push_str("…");
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
