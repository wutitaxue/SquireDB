use serde::Serialize;
use sqlx::{MySqlPool, SqlitePool};
use std::collections::{BTreeMap, HashMap};

use crate::perf;

#[derive(Debug, Serialize)]
pub struct HealthReport {
    pub elapsed_ms: u64,
    pub server_version: String,
    pub databases_scanned: Vec<String>,
    pub indexes: IndexHealth,
    pub tables: TableHealth,
    pub slow_queries: Vec<perf::SlowQuery>,
    pub security: SecurityCheck,
}

#[derive(Debug, Serialize, Default)]
pub struct IndexHealth {
    pub redundant: Vec<RedundantIndex>,
    pub unused: Vec<UnusedIndex>,
    pub total_indexes: i64,
    pub unused_unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RedundantIndex {
    pub database: String,
    pub table: String,
    pub index_a: String,
    pub index_a_cols: String,
    pub index_b: String,
    pub index_b_cols: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UnusedIndex {
    pub database: String,
    pub table: String,
    pub index: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct TableHealth {
    pub no_primary_key: Vec<TableRef>,
    pub fragmented: Vec<FragmentedTable>,
    pub largest: Vec<TableSize>,
}

#[derive(Debug, Serialize)]
pub struct TableRef {
    pub database: String,
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FragmentedTable {
    pub database: String,
    pub table: String,
    pub data_free_mb: f64,
    pub data_length_mb: f64,
    pub fragmentation_ratio: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TableSize {
    pub database: String,
    pub table: String,
    pub rows: i64,
    pub data_mb: f64,
    pub index_mb: f64,
    pub total_mb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct SecurityCheck {
    pub ssl_enabled: bool,
    pub require_secure_transport: bool,
    pub remote_root: Vec<RemoteRootUser>,
    pub mysql_user_unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteRootUser {
    pub user: String,
    pub host: String,
}

const EXCLUDED_SCHEMAS: &str =
    "'mysql', 'information_schema', 'performance_schema', 'sys'";

pub async fn run_health_check(pool: &MySqlPool) -> Result<HealthReport, String> {
    let started = std::time::Instant::now();

    let server_version = sqlx::query_as::<_, (String,)>("SELECT @@version")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(v,)| v)
        .unwrap_or_default();

    let databases: Vec<(String,)> = sqlx::query_as(&format!(
        "SELECT CAST(SCHEMA_NAME AS CHAR) \
         FROM information_schema.SCHEMATA \
         WHERE SCHEMA_NAME NOT IN ({EXCLUDED_SCHEMAS}) \
         ORDER BY SCHEMA_NAME"
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list databases failed: {e}"))?;
    let databases_scanned: Vec<String> = databases.into_iter().map(|(s,)| s).collect();

    let indexes = collect_index_health(pool).await?;
    let tables = collect_table_health(pool).await?;
    let slow_queries = perf::list_slow_queries(pool, 10, 0.0)
        .await
        .unwrap_or_default();
    let security = collect_security(pool).await?;

    Ok(HealthReport {
        elapsed_ms: started.elapsed().as_millis() as u64,
        server_version,
        databases_scanned,
        indexes,
        tables,
        slow_queries,
        security,
    })
}

async fn collect_index_health(pool: &MySqlPool) -> Result<IndexHealth, String> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(&format!(
        "SELECT \
            CAST(TABLE_SCHEMA AS CHAR), \
            CAST(TABLE_NAME AS CHAR), \
            CAST(INDEX_NAME AS CHAR), \
            CAST(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS CHAR) \
        FROM information_schema.STATISTICS \
        WHERE TABLE_SCHEMA NOT IN ({EXCLUDED_SCHEMAS}) \
        GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME"
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| format!("fetch indexes failed: {e}"))?;

    let total_indexes = rows.len() as i64;

    let mut by_table: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();
    for (db, table, idx, cols) in rows {
        by_table.entry((db, table)).or_default().push((idx, cols));
    }

    let mut redundant: Vec<RedundantIndex> = Vec::new();
    for ((db, table), idxs) in &by_table {
        for i in 0..idxs.len() {
            for j in 0..idxs.len() {
                if i == j {
                    continue;
                }
                let (a_name, a_cols) = &idxs[i];
                let (b_name, b_cols) = &idxs[j];
                if a_name == "PRIMARY" || b_name == "PRIMARY" {
                    continue;
                }
                if a_cols.is_empty() || b_cols.is_empty() {
                    continue;
                }
                if a_cols == b_cols {
                    if a_name < b_name {
                        redundant.push(RedundantIndex {
                            database: db.clone(),
                            table: table.clone(),
                            index_a: a_name.clone(),
                            index_a_cols: a_cols.clone(),
                            index_b: b_name.clone(),
                            index_b_cols: b_cols.clone(),
                            connection_id: None,
                            connection_name: None,
                        });
                    }
                    continue;
                }
                if b_cols.starts_with(&format!("{a_cols},")) {
                    redundant.push(RedundantIndex {
                        database: db.clone(),
                        table: table.clone(),
                        index_a: a_name.clone(),
                        index_a_cols: a_cols.clone(),
                        index_b: b_name.clone(),
                        index_b_cols: b_cols.clone(),
                        connection_id: None,
                        connection_name: None,
                    });
                }
            }
        }
    }

    let mut unused: Vec<UnusedIndex> = Vec::new();
    let mut unused_unavailable_reason: Option<String> = None;
    let unused_sql = format!(
        "SELECT \
            CAST(OBJECT_SCHEMA AS CHAR), \
            CAST(OBJECT_NAME AS CHAR), \
            CAST(INDEX_NAME AS CHAR) \
        FROM performance_schema.table_io_waits_summary_by_index_usage \
        WHERE INDEX_NAME IS NOT NULL \
          AND INDEX_NAME != 'PRIMARY' \
          AND OBJECT_SCHEMA IS NOT NULL \
          AND OBJECT_SCHEMA NOT IN ({EXCLUDED_SCHEMAS}) \
          AND COUNT_FETCH = 0 \
          AND COUNT_INSERT = 0 \
          AND COUNT_UPDATE = 0 \
          AND COUNT_DELETE = 0 \
        ORDER BY OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME \
        LIMIT 200"
    );
    match sqlx::query_as::<_, (String, String, String)>(&unused_sql)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => {
            for (db, table, idx) in rows {
                unused.push(UnusedIndex {
                    database: db,
                    table,
                    index: idx,
                    connection_id: None,
                    connection_name: None,
                });
            }
        }
        Err(e) => {
            unused_unavailable_reason = Some(format!("{e}"));
        }
    }

    Ok(IndexHealth {
        redundant,
        unused,
        total_indexes,
        unused_unavailable_reason,
    })
}

async fn collect_table_health(pool: &MySqlPool) -> Result<TableHealth, String> {
    let no_pk_rows: Vec<(String, String)> = sqlx::query_as(&format!(
        "SELECT CAST(t.TABLE_SCHEMA AS CHAR), CAST(t.TABLE_NAME AS CHAR) \
         FROM information_schema.TABLES t \
         LEFT JOIN information_schema.STATISTICS s \
           ON t.TABLE_SCHEMA = s.TABLE_SCHEMA \
          AND t.TABLE_NAME = s.TABLE_NAME \
          AND s.INDEX_NAME = 'PRIMARY' \
         WHERE t.TABLE_TYPE = 'BASE TABLE' \
           AND t.TABLE_SCHEMA NOT IN ({EXCLUDED_SCHEMAS}) \
           AND s.INDEX_NAME IS NULL \
         ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME"
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| format!("fetch no-pk failed: {e}"))?;

    let no_primary_key: Vec<TableRef> = no_pk_rows
        .into_iter()
        .map(|(database, table)| TableRef {
            database,
            table,
            connection_id: None,
            connection_name: None,
        })
        .collect();

    let frag_rows: Vec<(String, String, i64, i64)> = sqlx::query_as(&format!(
        "SELECT \
            CAST(TABLE_SCHEMA AS CHAR), \
            CAST(TABLE_NAME AS CHAR), \
            CAST(IFNULL(DATA_FREE, 0) AS SIGNED), \
            CAST(IFNULL(DATA_LENGTH, 0) AS SIGNED) \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' \
           AND TABLE_SCHEMA NOT IN ({EXCLUDED_SCHEMAS}) \
           AND DATA_LENGTH > 10485760 \
           AND DATA_FREE > 0 \
           AND DATA_FREE / DATA_LENGTH > 0.2 \
         ORDER BY DATA_FREE DESC \
         LIMIT 50"
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| format!("fetch fragmented failed: {e}"))?;

    let fragmented: Vec<FragmentedTable> = frag_rows
        .into_iter()
        .map(|(database, table, data_free, data_length)| {
            let df = data_free as f64;
            let dl = data_length as f64;
            FragmentedTable {
                database,
                table,
                data_free_mb: df / 1024.0 / 1024.0,
                data_length_mb: dl / 1024.0 / 1024.0,
                fragmentation_ratio: if dl > 0.0 { df / dl } else { 0.0 },
                connection_id: None,
                connection_name: None,
            }
        })
        .collect();

    let size_rows: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(&format!(
        "SELECT \
            CAST(TABLE_SCHEMA AS CHAR), \
            CAST(TABLE_NAME AS CHAR), \
            CAST(IFNULL(TABLE_ROWS, 0) AS SIGNED), \
            CAST(IFNULL(DATA_LENGTH, 0) AS SIGNED), \
            CAST(IFNULL(INDEX_LENGTH, 0) AS SIGNED) \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' \
           AND TABLE_SCHEMA NOT IN ({EXCLUDED_SCHEMAS}) \
         ORDER BY (IFNULL(DATA_LENGTH, 0) + IFNULL(INDEX_LENGTH, 0)) DESC \
         LIMIT 10"
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| format!("fetch top tables failed: {e}"))?;

    let largest: Vec<TableSize> = size_rows
        .into_iter()
        .map(|(database, table, rows, data, index)| TableSize {
            database,
            table,
            rows,
            data_mb: data as f64 / 1024.0 / 1024.0,
            index_mb: index as f64 / 1024.0 / 1024.0,
            total_mb: (data + index) as f64 / 1024.0 / 1024.0,
            connection_id: None,
            connection_name: None,
        })
        .collect();

    Ok(TableHealth {
        no_primary_key,
        fragmented,
        largest,
    })
}

async fn collect_security(pool: &MySqlPool) -> Result<SecurityCheck, String> {
    let have_ssl = read_variable(pool, "have_ssl").await;
    let req_ssl = read_variable(pool, "require_secure_transport").await;

    let mut remote_root: Vec<RemoteRootUser> = Vec::new();
    let mut mysql_user_unavailable_reason: Option<String> = None;
    let root_sql =
        "SELECT CAST(User AS CHAR), CAST(Host AS CHAR) \
         FROM mysql.user \
         WHERE User = 'root' AND Host NOT IN ('localhost', '127.0.0.1', '::1')";
    match sqlx::query_as::<_, (String, String)>(root_sql)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => {
            for (user, host) in rows {
                remote_root.push(RemoteRootUser { user, host });
            }
        }
        Err(e) => {
            mysql_user_unavailable_reason = Some(format!("{e}"));
        }
    }

    Ok(SecurityCheck {
        ssl_enabled: have_ssl
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("YES"))
            .unwrap_or(false),
        require_secure_transport: req_ssl
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("ON"))
            .unwrap_or(false),
        remote_root,
        mysql_user_unavailable_reason,
    })
}

async fn read_variable(pool: &MySqlPool, name: &str) -> Option<String> {
    sqlx::query_as::<_, (String, String)>("SHOW VARIABLES LIKE ?")
        .bind(name)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(_, v)| v)
}

#[derive(Debug, Serialize)]
pub struct ConnSecurity {
    pub connection_id: i64,
    pub connection_name: String,
    pub check: SecurityCheck,
}

#[derive(Debug, Serialize)]
pub struct ProjectHealthReport {
    pub elapsed_ms: u64,
    pub project_id: i64,
    pub project_name: String,
    pub indexes: IndexHealth,
    pub tables: TableHealth,
    pub security_by_connection: Vec<ConnSecurity>,
    pub project_tables_count: usize,
    pub scanned_databases: Vec<String>,
    pub missing_connection_ids: Vec<i64>,
    pub missing_connection_names: Vec<String>,
}

pub async fn run_project_health_check(
    sqlite: &SqlitePool,
    pools: &HashMap<i64, MySqlPool>,
    project_id: i64,
) -> Result<ProjectHealthReport, String> {
    let started = std::time::Instant::now();

    let project_meta: (String,) = sqlx::query_as("SELECT name FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_one(sqlite)
        .await
        .map_err(|e| format!("project not found: {e}"))?;

    let connections = crate::storage::connection::list_all(sqlite)
        .await
        .map_err(|e| format!("load connections failed: {e}"))?;
    let conn_name: HashMap<i64, String> = connections
        .into_iter()
        .filter_map(|c| c.id.map(|id| (id, c.name)))
        .collect();

    let tables = crate::storage::project::list_tables(sqlite, project_id)
        .await
        .map_err(|e| format!("list project tables failed: {e}"))?;
    let total_tables = tables.len();

    let mut by_pool: BTreeMap<(i64, String), Vec<String>> = BTreeMap::new();
    for t in &tables {
        by_pool
            .entry((t.connection_id, t.database_name.clone()))
            .or_default()
            .push(t.table_name.clone());
    }

    let mut redundant: Vec<RedundantIndex> = Vec::new();
    let mut unused: Vec<UnusedIndex> = Vec::new();
    let mut total_indexes: i64 = 0;
    let mut unused_unavailable_reason: Option<String> = None;
    let mut no_primary_key: Vec<TableRef> = Vec::new();
    let mut fragmented: Vec<FragmentedTable> = Vec::new();
    let mut largest: Vec<TableSize> = Vec::new();
    let mut security_by_connection: Vec<ConnSecurity> = Vec::new();
    let mut missing_ids: Vec<i64> = Vec::new();
    let mut missing_names: Vec<String> = Vec::new();
    let mut scanned_databases: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    let mut sec_done: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();

    for ((conn_id, db), tables_in_scope) in by_pool {
        let pool = match pools.get(&conn_id) {
            Some(p) => p,
            None => {
                if !missing_ids.contains(&conn_id) {
                    missing_ids.push(conn_id);
                    missing_names.push(
                        conn_name
                            .get(&conn_id)
                            .cloned()
                            .unwrap_or_else(|| format!("#{conn_id}")),
                    );
                }
                continue;
            }
        };
        let cname = conn_name
            .get(&conn_id)
            .cloned()
            .unwrap_or_else(|| format!("#{conn_id}"));
        scanned_databases.insert(db.clone());

        let scoped =
            collect_index_health_scoped(pool, &db, &tables_in_scope, conn_id, &cname).await?;
        redundant.extend(scoped.redundant);
        unused.extend(scoped.unused);
        total_indexes += scoped.total_indexes;
        if unused_unavailable_reason.is_none() {
            unused_unavailable_reason = scoped.unused_unavailable_reason;
        }

        let tscoped =
            collect_table_health_scoped(pool, &db, &tables_in_scope, conn_id, &cname).await?;
        no_primary_key.extend(tscoped.no_primary_key);
        fragmented.extend(tscoped.fragmented);
        largest.extend(tscoped.largest);

        if sec_done.insert(conn_id) {
            let check = collect_security(pool).await?;
            security_by_connection.push(ConnSecurity {
                connection_id: conn_id,
                connection_name: cname,
                check,
            });
        }
    }

    largest.sort_by(|a, b| b.total_mb.partial_cmp(&a.total_mb).unwrap_or(std::cmp::Ordering::Equal));
    largest.truncate(10);

    Ok(ProjectHealthReport {
        elapsed_ms: started.elapsed().as_millis() as u64,
        project_id,
        project_name: project_meta.0,
        indexes: IndexHealth {
            redundant,
            unused,
            total_indexes,
            unused_unavailable_reason,
        },
        tables: TableHealth {
            no_primary_key,
            fragmented,
            largest,
        },
        security_by_connection,
        project_tables_count: total_tables,
        scanned_databases: scanned_databases.into_iter().collect(),
        missing_connection_ids: missing_ids,
        missing_connection_names: missing_names,
    })
}

async fn collect_index_health_scoped(
    pool: &MySqlPool,
    database: &str,
    tables_in_scope: &[String],
    conn_id: i64,
    conn_name: &str,
) -> Result<IndexHealth, String> {
    if tables_in_scope.is_empty() {
        return Ok(IndexHealth::default());
    }
    let placeholders = vec!["?"; tables_in_scope.len()].join(",");

    let stat_sql = format!(
        "SELECT \
            CAST(TABLE_NAME AS CHAR), \
            CAST(INDEX_NAME AS CHAR), \
            CAST(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS CHAR) \
        FROM information_schema.STATISTICS \
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) \
        GROUP BY TABLE_NAME, INDEX_NAME"
    );
    let mut stat_q = sqlx::query_as::<_, (String, String, String)>(&stat_sql).bind(database);
    for t in tables_in_scope {
        stat_q = stat_q.bind(t);
    }
    let rows = stat_q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch indexes failed: {e}"))?;
    let total_indexes = rows.len() as i64;

    let mut by_table: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for (table, idx, cols) in rows {
        by_table.entry(table).or_default().push((idx, cols));
    }

    let mut redundant: Vec<RedundantIndex> = Vec::new();
    for (table, idxs) in &by_table {
        for i in 0..idxs.len() {
            for j in 0..idxs.len() {
                if i == j {
                    continue;
                }
                let (a_name, a_cols) = &idxs[i];
                let (b_name, b_cols) = &idxs[j];
                if a_name == "PRIMARY" || b_name == "PRIMARY" {
                    continue;
                }
                if a_cols.is_empty() || b_cols.is_empty() {
                    continue;
                }
                if a_cols == b_cols {
                    if a_name < b_name {
                        redundant.push(RedundantIndex {
                            database: database.to_string(),
                            table: table.clone(),
                            index_a: a_name.clone(),
                            index_a_cols: a_cols.clone(),
                            index_b: b_name.clone(),
                            index_b_cols: b_cols.clone(),
                            connection_id: Some(conn_id),
                            connection_name: Some(conn_name.to_string()),
                        });
                    }
                    continue;
                }
                if b_cols.starts_with(&format!("{a_cols},")) {
                    redundant.push(RedundantIndex {
                        database: database.to_string(),
                        table: table.clone(),
                        index_a: a_name.clone(),
                        index_a_cols: a_cols.clone(),
                        index_b: b_name.clone(),
                        index_b_cols: b_cols.clone(),
                        connection_id: Some(conn_id),
                        connection_name: Some(conn_name.to_string()),
                    });
                }
            }
        }
    }

    let mut unused: Vec<UnusedIndex> = Vec::new();
    let mut unused_unavailable_reason: Option<String> = None;
    let unused_sql = format!(
        "SELECT \
            CAST(OBJECT_NAME AS CHAR), \
            CAST(INDEX_NAME AS CHAR) \
        FROM performance_schema.table_io_waits_summary_by_index_usage \
        WHERE INDEX_NAME IS NOT NULL \
          AND INDEX_NAME != 'PRIMARY' \
          AND OBJECT_SCHEMA = ? \
          AND OBJECT_NAME IN ({placeholders}) \
          AND COUNT_FETCH = 0 \
          AND COUNT_INSERT = 0 \
          AND COUNT_UPDATE = 0 \
          AND COUNT_DELETE = 0 \
        ORDER BY OBJECT_NAME, INDEX_NAME"
    );
    let mut u_q = sqlx::query_as::<_, (String, String)>(&unused_sql).bind(database);
    for t in tables_in_scope {
        u_q = u_q.bind(t);
    }
    match u_q.fetch_all(pool).await {
        Ok(rows) => {
            for (table, idx) in rows {
                unused.push(UnusedIndex {
                    database: database.to_string(),
                    table,
                    index: idx,
                    connection_id: Some(conn_id),
                    connection_name: Some(conn_name.to_string()),
                });
            }
        }
        Err(e) => {
            unused_unavailable_reason = Some(format!("{e}"));
        }
    }

    Ok(IndexHealth {
        redundant,
        unused,
        total_indexes,
        unused_unavailable_reason,
    })
}

async fn collect_table_health_scoped(
    pool: &MySqlPool,
    database: &str,
    tables_in_scope: &[String],
    conn_id: i64,
    conn_name: &str,
) -> Result<TableHealth, String> {
    if tables_in_scope.is_empty() {
        return Ok(TableHealth::default());
    }
    let placeholders = vec!["?"; tables_in_scope.len()].join(",");

    let no_pk_sql = format!(
        "SELECT CAST(t.TABLE_NAME AS CHAR) \
         FROM information_schema.TABLES t \
         LEFT JOIN information_schema.STATISTICS s \
           ON t.TABLE_SCHEMA = s.TABLE_SCHEMA \
          AND t.TABLE_NAME = s.TABLE_NAME \
          AND s.INDEX_NAME = 'PRIMARY' \
         WHERE t.TABLE_TYPE = 'BASE TABLE' \
           AND t.TABLE_SCHEMA = ? \
           AND t.TABLE_NAME IN ({placeholders}) \
           AND s.INDEX_NAME IS NULL"
    );
    let mut q = sqlx::query_as::<_, (String,)>(&no_pk_sql).bind(database);
    for t in tables_in_scope {
        q = q.bind(t);
    }
    let no_pk_rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch no-pk failed: {e}"))?;
    let no_primary_key: Vec<TableRef> = no_pk_rows
        .into_iter()
        .map(|(table,)| TableRef {
            database: database.to_string(),
            table,
            connection_id: Some(conn_id),
            connection_name: Some(conn_name.to_string()),
        })
        .collect();

    let frag_sql = format!(
        "SELECT \
            CAST(TABLE_NAME AS CHAR), \
            CAST(IFNULL(DATA_FREE, 0) AS SIGNED), \
            CAST(IFNULL(DATA_LENGTH, 0) AS SIGNED) \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' \
           AND TABLE_SCHEMA = ? \
           AND TABLE_NAME IN ({placeholders}) \
           AND DATA_LENGTH > 10485760 \
           AND DATA_FREE > 0 \
           AND DATA_FREE / DATA_LENGTH > 0.2"
    );
    let mut q = sqlx::query_as::<_, (String, i64, i64)>(&frag_sql).bind(database);
    for t in tables_in_scope {
        q = q.bind(t);
    }
    let frag_rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch fragmented failed: {e}"))?;
    let fragmented: Vec<FragmentedTable> = frag_rows
        .into_iter()
        .map(|(table, data_free, data_length)| {
            let df = data_free as f64;
            let dl = data_length as f64;
            FragmentedTable {
                database: database.to_string(),
                table,
                data_free_mb: df / 1024.0 / 1024.0,
                data_length_mb: dl / 1024.0 / 1024.0,
                fragmentation_ratio: if dl > 0.0 { df / dl } else { 0.0 },
                connection_id: Some(conn_id),
                connection_name: Some(conn_name.to_string()),
            }
        })
        .collect();

    let size_sql = format!(
        "SELECT \
            CAST(TABLE_NAME AS CHAR), \
            CAST(IFNULL(TABLE_ROWS, 0) AS SIGNED), \
            CAST(IFNULL(DATA_LENGTH, 0) AS SIGNED), \
            CAST(IFNULL(INDEX_LENGTH, 0) AS SIGNED) \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' \
           AND TABLE_SCHEMA = ? \
           AND TABLE_NAME IN ({placeholders})"
    );
    let mut q = sqlx::query_as::<_, (String, i64, i64, i64)>(&size_sql).bind(database);
    for t in tables_in_scope {
        q = q.bind(t);
    }
    let size_rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch sizes failed: {e}"))?;
    let largest: Vec<TableSize> = size_rows
        .into_iter()
        .map(|(table, rows, data, index)| TableSize {
            database: database.to_string(),
            table,
            rows,
            data_mb: data as f64 / 1024.0 / 1024.0,
            index_mb: index as f64 / 1024.0 / 1024.0,
            total_mb: (data + index) as f64 / 1024.0 / 1024.0,
            connection_id: Some(conn_id),
            connection_name: Some(conn_name.to_string()),
        })
        .collect();

    Ok(TableHealth {
        no_primary_key,
        fragmented,
        largest,
    })
}
