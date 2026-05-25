use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, SqlitePool};
use std::collections::{BTreeSet, HashMap};
use std::time::Instant;

#[derive(Debug, Serialize)]
pub struct ExplainResult {
    pub raw_json: serde_json::Value,
    pub tree: ExplainNode,
    pub tables: Vec<TableAccess>,
    pub risks: Vec<String>,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct ExplainNode {
    pub kind: String,
    pub label: String,
    pub details: HashMap<String, String>,
    pub risks: Vec<String>,
    pub children: Vec<ExplainNode>,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct TableAccess {
    pub table_name: String,
    pub access_type: Option<String>,
    pub possible_keys: Vec<String>,
    pub key: Option<String>,
    pub key_length: Option<String>,
    pub used_columns: Vec<String>,
    pub rows_examined: Option<f64>,
    pub filtered: Option<f64>,
    pub cost: Option<f64>,
    pub attached_condition: Option<String>,
    pub using_index: bool,
    pub using_filesort: bool,
    pub using_temporary_table: bool,
}

pub async fn explain_sql(pool: &MySqlPool, sql: &str) -> Result<ExplainResult, String> {
    let trimmed = sql.trim().trim_end_matches(';');
    let lower_first = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    if !matches!(
        lower_first.as_str(),
        "select" | "with" | "update" | "delete" | "insert"
    ) {
        return Err("EXPLAIN only supports SELECT/UPDATE/DELETE/INSERT/WITH".into());
    }

    let prepared = substitute_placeholders(trimmed);
    let explain_sql = format!("EXPLAIN FORMAT=JSON {prepared}");
    let rows: Vec<(String,)> = sqlx::query_as(&explain_sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("EXPLAIN failed: {e}"))?;

    let raw_text = rows
        .into_iter()
        .next()
        .map(|(s,)| s)
        .ok_or_else(|| "EXPLAIN returned no rows".to_string())?;

    let raw_json: serde_json::Value =
        serde_json::from_str(&raw_text).map_err(|e| format!("parse EXPLAIN JSON failed: {e}"))?;

    let mut tables = Vec::new();
    let mut risks = Vec::new();
    let tree = parse_root(&raw_json, &mut tables, &mut risks);

    risks.sort();
    risks.dedup();

    Ok(ExplainResult {
        raw_json,
        tree,
        tables,
        risks,
    })
}

fn parse_root(
    v: &serde_json::Value,
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    if let Some(qb) = v.get("query_block") {
        return parse_query_block(qb, tables, risks);
    }
    ExplainNode {
        kind: "unknown".into(),
        label: "Unknown plan root".into(),
        ..Default::default()
    }
}

fn parse_query_block(
    v: &serde_json::Value,
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    let select_id = v.get("select_id").and_then(|x| x.as_i64());
    let label = match select_id {
        Some(id) => format!("Query block #{id}"),
        None => "Query block".to_string(),
    };
    let mut node = ExplainNode {
        kind: "query_block".into(),
        label,
        ..Default::default()
    };
    if let Some(ci) = v.get("cost_info") {
        if let Some(c) = ci.get("query_cost").and_then(|x| x.as_str()) {
            node.details.insert("query_cost".into(), c.to_string());
        }
    }

    if let Some(ord) = v.get("ordering_operation") {
        node.children.push(parse_ordering(ord, tables, risks));
    } else if let Some(grp) = v.get("grouping_operation") {
        node.children.push(parse_grouping(grp, tables, risks));
    } else if let Some(dup) = v.get("duplicates_removal") {
        node.children.push(parse_dup(dup, tables, risks));
    } else if let Some(nl) = v.get("nested_loop").and_then(|x| x.as_array()) {
        node.children.push(parse_nested_loop(nl, tables, risks));
    } else if let Some(tb) = v.get("table") {
        node.children.push(parse_table(tb, tables, risks));
    } else if let Some(u) = v.get("union_result") {
        node.children.push(parse_union(u, tables, risks));
    }
    node
}

fn parse_ordering(
    v: &serde_json::Value,
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    let using_filesort = v
        .get("using_filesort")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let mut node = ExplainNode {
        kind: "ordering".into(),
        label: if using_filesort {
            "Ordering (filesort)".into()
        } else {
            "Ordering".into()
        },
        ..Default::default()
    };
    if using_filesort {
        node.risks.push("filesort".into());
        risks.push("filesort".into());
    }
    if let Some(grp) = v.get("grouping_operation") {
        node.children.push(parse_grouping(grp, tables, risks));
    } else if let Some(nl) = v.get("nested_loop").and_then(|x| x.as_array()) {
        node.children.push(parse_nested_loop(nl, tables, risks));
    } else if let Some(tb) = v.get("table") {
        node.children.push(parse_table(tb, tables, risks));
    }
    node
}

fn parse_grouping(
    v: &serde_json::Value,
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    let using_temporary_table = v
        .get("using_temporary_table")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let using_filesort = v
        .get("using_filesort")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let mut node = ExplainNode {
        kind: "grouping".into(),
        label: "Grouping".into(),
        ..Default::default()
    };
    if using_temporary_table {
        node.risks.push("temporary_table".into());
        risks.push("temporary_table".into());
    }
    if using_filesort {
        node.risks.push("filesort".into());
        risks.push("filesort".into());
    }
    if let Some(nl) = v.get("nested_loop").and_then(|x| x.as_array()) {
        node.children.push(parse_nested_loop(nl, tables, risks));
    } else if let Some(tb) = v.get("table") {
        node.children.push(parse_table(tb, tables, risks));
    }
    node
}

fn parse_dup(
    v: &serde_json::Value,
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    let mut node = ExplainNode {
        kind: "duplicates_removal".into(),
        label: "Duplicates Removal".into(),
        ..Default::default()
    };
    if let Some(nl) = v.get("nested_loop").and_then(|x| x.as_array()) {
        node.children.push(parse_nested_loop(nl, tables, risks));
    } else if let Some(tb) = v.get("table") {
        node.children.push(parse_table(tb, tables, risks));
    }
    node
}

fn parse_nested_loop(
    arr: &[serde_json::Value],
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    let mut node = ExplainNode {
        kind: "nested_loop".into(),
        label: "Nested Loop Join".into(),
        ..Default::default()
    };
    for item in arr {
        if let Some(tb) = item.get("table") {
            node.children.push(parse_table(tb, tables, risks));
        }
    }
    node
}

fn parse_union(
    v: &serde_json::Value,
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    let mut node = ExplainNode {
        kind: "union_result".into(),
        label: "Union Result".into(),
        ..Default::default()
    };
    if let Some(specs) = v.get("query_specifications").and_then(|x| x.as_array()) {
        for spec in specs {
            if let Some(qb) = spec.get("query_block") {
                node.children.push(parse_query_block(qb, tables, risks));
            }
        }
    }
    node
}

fn parse_table(
    v: &serde_json::Value,
    tables: &mut Vec<TableAccess>,
    risks: &mut Vec<String>,
) -> ExplainNode {
    let table_name = v
        .get("table_name")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_string();
    let access_type = v
        .get("access_type")
        .and_then(|x| x.as_str())
        .map(String::from);

    let possible_keys: Vec<String> = v
        .get("possible_keys")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let key = v.get("key").and_then(|x| x.as_str()).map(String::from);
    let key_length = v
        .get("key_length")
        .and_then(|x| x.as_str())
        .map(String::from);
    let used_columns: Vec<String> = v
        .get("used_columns")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let rows_examined = v
        .get("rows_examined_per_scan")
        .and_then(|x| x.as_f64())
        .or_else(|| v.get("rows").and_then(|x| x.as_f64()));
    let filtered = v
        .get("filtered")
        .and_then(|x| match x {
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            serde_json::Value::Number(n) => n.as_f64(),
            _ => None,
        });
    let cost = v
        .get("cost_info")
        .and_then(|ci| ci.get("read_cost").or_else(|| ci.get("eval_cost")))
        .and_then(|x| match x {
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            serde_json::Value::Number(n) => n.as_f64(),
            _ => None,
        });
    let attached_condition = v
        .get("attached_condition")
        .and_then(|x| x.as_str())
        .map(String::from);
    let using_index = v
        .get("using_index")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);

    let access_lower = access_type.as_deref().unwrap_or("").to_lowercase();
    let mut node_risks: Vec<String> = Vec::new();
    if access_lower == "all" {
        node_risks.push("full_table_scan".into());
        risks.push("full_table_scan".into());
    }
    if access_lower == "index" {
        node_risks.push("full_index_scan".into());
        risks.push("full_index_scan".into());
    }
    if let Some(rs) = rows_examined {
        if rs >= 100_000.0 {
            node_risks.push("large_scan".into());
            risks.push("large_scan".into());
        }
    }

    let label = match &access_type {
        Some(a) => format!("Table: {table_name} ({a})"),
        None => format!("Table: {table_name}"),
    };

    let mut details = HashMap::new();
    if let Some(k) = &key {
        details.insert("key".into(), k.clone());
    } else if !possible_keys.is_empty() {
        details.insert("possible_keys".into(), possible_keys.join(", "));
    }
    if let Some(r) = rows_examined {
        details.insert("rows".into(), format!("{r:.0}"));
    }
    if let Some(f) = filtered {
        details.insert("filtered".into(), format!("{f:.1}%"));
    }
    if let Some(c) = cost {
        details.insert("cost".into(), format!("{c:.2}"));
    }
    if using_index {
        details.insert("using_index".into(), "true".into());
    }

    tables.push(TableAccess {
        table_name: table_name.clone(),
        access_type: access_type.clone(),
        possible_keys: possible_keys.clone(),
        key: key.clone(),
        key_length: key_length.clone(),
        used_columns,
        rows_examined,
        filtered,
        cost,
        attached_condition: attached_condition.clone(),
        using_index,
        using_filesort: false,
        using_temporary_table: false,
    });

    let mut node = ExplainNode {
        kind: "table".into(),
        label,
        details,
        risks: node_risks,
        children: Vec::new(),
    };

    if let Some(sub) = v
        .get("materialized_from_subquery")
        .and_then(|m| m.get("query_block"))
    {
        node.children.push(parse_query_block(sub, tables, risks));
    }
    if let Some(attached) = v.get("attached_subqueries").and_then(|x| x.as_array()) {
        for s in attached {
            if let Some(qb) = s.get("query_block") {
                node.children.push(parse_query_block(qb, tables, risks));
            }
        }
    }

    node
}

#[derive(Debug, Serialize, Clone)]
pub struct SlowQuery {
    pub digest: String,
    pub digest_text: String,
    pub schema_name: Option<String>,
    pub count_star: i64,
    pub avg_ms: f64,
    pub max_ms: f64,
    pub total_ms: f64,
    pub avg_rows_examined: f64,
    pub avg_rows_sent: f64,
    pub no_index_used: i64,
    pub no_good_index_used: i64,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
}

pub async fn list_slow_queries(
    pool: &MySqlPool,
    limit: i64,
    min_avg_ms: f64,
) -> Result<Vec<SlowQuery>, String> {
    let sql = "SELECT \
        IFNULL(CAST(DIGEST AS CHAR), '') as digest, \
        CAST(IFNULL(DIGEST_TEXT, '') AS CHAR) as digest_text, \
        CAST(SCHEMA_NAME AS CHAR) as schema_name, \
        CAST(COUNT_STAR AS SIGNED) as count_star, \
        (AVG_TIMER_WAIT / 1000000.0) * 1e0 as avg_ms, \
        (MAX_TIMER_WAIT / 1000000.0) * 1e0 as max_ms, \
        (SUM_TIMER_WAIT / 1000000.0) * 1e0 as total_ms, \
        (CASE WHEN COUNT_STAR > 0 THEN SUM_ROWS_EXAMINED / COUNT_STAR ELSE 0 END) * 1e0 as avg_rows_examined, \
        (CASE WHEN COUNT_STAR > 0 THEN SUM_ROWS_SENT / COUNT_STAR ELSE 0 END) * 1e0 as avg_rows_sent, \
        CAST(SUM_NO_INDEX_USED AS SIGNED) as no_index_used, \
        CAST(SUM_NO_GOOD_INDEX_USED AS SIGNED) as no_good_index_used, \
        CAST(FIRST_SEEN AS CHAR) as first_seen, \
        CAST(LAST_SEEN AS CHAR) as last_seen \
    FROM performance_schema.events_statements_summary_by_digest \
    WHERE DIGEST_TEXT IS NOT NULL \
      AND (AVG_TIMER_WAIT / 1000000.0) >= ? \
    ORDER BY SUM_TIMER_WAIT DESC \
    LIMIT ?";

    let rows: Vec<(
        String,
        String,
        Option<String>,
        i64,
        f64,
        f64,
        f64,
        f64,
        f64,
        i64,
        i64,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(sql)
        .bind(min_avg_ms)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list slow queries failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(
            |(
                digest,
                digest_text,
                schema_name,
                count_star,
                avg_ms,
                max_ms,
                total_ms,
                avg_rows_examined,
                avg_rows_sent,
                no_index_used,
                no_good_index_used,
                first_seen,
                last_seen,
            )| SlowQuery {
                digest,
                digest_text,
                schema_name,
                count_star,
                avg_ms,
                max_ms,
                total_ms,
                avg_rows_examined,
                avg_rows_sent,
                no_index_used,
                no_good_index_used,
                first_seen,
                last_seen,
            },
        )
        .collect())
}

#[derive(Debug, Serialize, Clone)]
pub struct PerfStatus {
    pub mysql_version: String,
    pub performance_schema: bool,
    pub slow_query_log: bool,
    pub long_query_time: f64,
    pub log_output: String,
    pub slow_query_log_file: Option<String>,
    pub digest_table_available: bool,
}

async fn show_variable(pool: &MySqlPool, name: &str) -> Option<String> {
    sqlx::query_as::<_, (String, String)>("SHOW VARIABLES LIKE ?")
        .bind(name)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(_, v)| v)
}

pub async fn get_perf_status(pool: &MySqlPool) -> Result<PerfStatus, String> {
    let perf_schema = show_variable(pool, "performance_schema")
        .await
        .unwrap_or_default();
    let slow_log = show_variable(pool, "slow_query_log").await.unwrap_or_default();
    let long_query_time = show_variable(pool, "long_query_time")
        .await
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(10.0);
    let log_output = show_variable(pool, "log_output").await.unwrap_or_default();
    let slow_query_log_file = show_variable(pool, "slow_query_log_file").await;

    let version_row: Option<(String,)> = sqlx::query_as("SELECT @@version")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    let mysql_version = version_row.map(|(v,)| v).unwrap_or_default();

    let digest_table_available = sqlx::query("SELECT 1 FROM performance_schema.events_statements_summary_by_digest LIMIT 1")
        .fetch_optional(pool)
        .await
        .is_ok();

    Ok(PerfStatus {
        mysql_version,
        performance_schema: perf_schema.eq_ignore_ascii_case("ON"),
        slow_query_log: slow_log.eq_ignore_ascii_case("ON"),
        long_query_time,
        log_output,
        slow_query_log_file,
        digest_table_available,
    })
}

pub async fn show_create_table(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE `{}`.`{}`", database.replace('`', ""), table.replace('`', ""));
    let row: (String, String) = sqlx::query_as(&sql)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("SHOW CREATE TABLE failed: {e}"))?;
    Ok(row.1)
}

#[derive(Debug, Deserialize)]
pub struct InvolvedTableRef {
    pub database: String,
    pub table: String,
}

#[derive(Debug, Serialize)]
pub struct ProcessRow {
    pub id: i64,
    pub user: Option<String>,
    pub host: Option<String>,
    pub db: Option<String>,
    pub command: Option<String>,
    pub time: i64,
    pub state: Option<String>,
    pub info: Option<String>,
}

pub async fn list_processlist(pool: &MySqlPool) -> Result<Vec<ProcessRow>, String> {
    let sql = "SELECT CAST(ID AS SIGNED), \
        CAST(USER AS CHAR), \
        CAST(HOST AS CHAR), \
        CAST(DB AS CHAR), \
        CAST(COMMAND AS CHAR), \
        CAST(TIME AS SIGNED), \
        CAST(STATE AS CHAR), \
        CAST(INFO AS CHAR) \
    FROM information_schema.processlist \
    ORDER BY TIME DESC";
    let rows: Vec<(
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list processlist failed: {e}"))?;
    Ok(rows
        .into_iter()
        .map(
            |(id, user, host, db, command, time, state, info)| ProcessRow {
                id,
                user,
                host,
                db,
                command,
                time,
                state,
                info,
            },
        )
        .collect())
}

pub async fn kill_process(pool: &MySqlPool, id: i64) -> Result<(), String> {
    let sql = format!("KILL {id}");
    sqlx::query(&sql)
        .execute(pool)
        .await
        .map_err(|e| format!("KILL {id} failed: {e}"))?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ServerStatus {
    pub uptime: i64,
    pub threads_running: i64,
    pub threads_connected: i64,
    pub threads_cached: i64,
    pub queries: i64,
    pub slow_queries: i64,
    pub aborted_connects: i64,
    pub innodb_rows_read: i64,
    pub innodb_rows_inserted: i64,
    pub innodb_rows_updated: i64,
    pub innodb_rows_deleted: i64,
    pub bytes_sent: i64,
    pub bytes_received: i64,
}

pub async fn server_status(pool: &MySqlPool) -> Result<ServerStatus, String> {
    let rows: Vec<(String, String)> = sqlx::query_as("SHOW GLOBAL STATUS")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("SHOW GLOBAL STATUS failed: {e}"))?;
    let mut map: HashMap<String, String> = HashMap::new();
    for (k, v) in rows {
        map.insert(k, v);
    }
    let n = |key: &str| -> i64 {
        map.get(key).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0)
    };
    Ok(ServerStatus {
        uptime: n("Uptime"),
        threads_running: n("Threads_running"),
        threads_connected: n("Threads_connected"),
        threads_cached: n("Threads_cached"),
        queries: n("Queries"),
        slow_queries: n("Slow_queries"),
        aborted_connects: n("Aborted_connects"),
        innodb_rows_read: n("Innodb_rows_read"),
        innodb_rows_inserted: n("Innodb_rows_inserted"),
        innodb_rows_updated: n("Innodb_rows_updated"),
        innodb_rows_deleted: n("Innodb_rows_deleted"),
        bytes_sent: n("Bytes_sent"),
        bytes_received: n("Bytes_received"),
    })
}

#[derive(Debug, Serialize)]
pub struct VariableEntry {
    pub name: String,
    pub value: String,
}

pub async fn list_variables(
    pool: &MySqlPool,
    filter: Option<&str>,
) -> Result<Vec<VariableEntry>, String> {
    let rows: Vec<(String, String)> = sqlx::query_as("SHOW GLOBAL VARIABLES")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("SHOW GLOBAL VARIABLES failed: {e}"))?;
    let f = filter.unwrap_or("").to_lowercase();
    let mut out: Vec<VariableEntry> = rows
        .into_iter()
        .filter(|(k, _)| f.is_empty() || k.to_lowercase().contains(&f))
        .map(|(name, value)| VariableEntry { name, value })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn substitute_placeholders(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' if in_single || in_double => {
                out.push(c);
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            }
            '\'' if !in_double && !in_backtick => {
                in_single = !in_single;
                out.push(c);
            }
            '"' if !in_single && !in_backtick => {
                in_double = !in_double;
                out.push(c);
            }
            '`' if !in_single && !in_double => {
                in_backtick = !in_backtick;
                out.push(c);
            }
            '?' if !in_single && !in_double && !in_backtick => {
                out.push('1');
            }
            _ => out.push(c),
        }
    }
    out
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectSlowQuery {
    pub connection_id: i64,
    pub connection_name: String,
    #[serde(flatten)]
    pub slow: SlowQuery,
    pub matched_tables: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConnPerfStatus {
    pub connection_id: i64,
    pub connection_name: String,
    pub status: Option<PerfStatus>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConnScanError {
    pub connection_id: i64,
    pub connection_name: String,
    pub error: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectSlowQueryReport {
    pub elapsed_ms: u64,
    pub project_id: i64,
    pub project_name: String,
    pub queries: Vec<ProjectSlowQuery>,
    pub perf_by_connection: Vec<ConnPerfStatus>,
    pub total_scanned: usize,
    pub total_matched: usize,
    pub scanned_connection_ids: Vec<i64>,
    pub missing_connection_ids: Vec<i64>,
    pub missing_connection_names: Vec<String>,
    pub scan_errors: Vec<ConnScanError>,
}

pub async fn collect_project_slow_queries(
    sqlite: &SqlitePool,
    pools: &HashMap<i64, MySqlPool>,
    project_id: i64,
    per_conn_limit: i64,
    min_avg_ms: f64,
) -> Result<ProjectSlowQueryReport, String> {
    let start = Instant::now();

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

    let table_rows = crate::storage::project::list_tables(sqlite, project_id)
        .await
        .map_err(|e| format!("list project tables failed: {e}"))?;

    // Per-connection map: conn_id -> Vec<(db_lower, table_lower, db_orig, table_orig)>
    let mut per_conn: HashMap<i64, Vec<(String, String, String, String)>> = HashMap::new();
    let mut required: BTreeSet<i64> = BTreeSet::new();
    for t in &table_rows {
        required.insert(t.connection_id);
        per_conn.entry(t.connection_id).or_default().push((
            t.database_name.to_lowercase(),
            t.table_name.to_lowercase(),
            t.database_name.clone(),
            t.table_name.clone(),
        ));
    }

    let mut queries: Vec<ProjectSlowQuery> = Vec::new();
    let mut perf_by_connection: Vec<ConnPerfStatus> = Vec::new();
    let mut scan_errors: Vec<ConnScanError> = Vec::new();
    let mut total_scanned: usize = 0;
    let mut scanned_ids: Vec<i64> = Vec::new();
    let mut missing_set: BTreeSet<i64> = BTreeSet::new();

    for conn_id in required.iter().copied() {
        let name = conn_name
            .get(&conn_id)
            .cloned()
            .unwrap_or_else(|| format!("#{conn_id}"));
        let pool = match pools.get(&conn_id) {
            Some(p) => p,
            None => {
                missing_set.insert(conn_id);
                continue;
            }
        };
        scanned_ids.push(conn_id);

        let status = match get_perf_status(pool).await {
            Ok(s) => {
                perf_by_connection.push(ConnPerfStatus {
                    connection_id: conn_id,
                    connection_name: name.clone(),
                    status: Some(s.clone()),
                    error: None,
                });
                Some(s)
            }
            Err(e) => {
                perf_by_connection.push(ConnPerfStatus {
                    connection_id: conn_id,
                    connection_name: name.clone(),
                    status: None,
                    error: Some(e),
                });
                None
            }
        };

        if status
            .as_ref()
            .map(|s| !s.digest_table_available)
            .unwrap_or(false)
        {
            scan_errors.push(ConnScanError {
                connection_id: conn_id,
                connection_name: name.clone(),
                error: "performance_schema digest table unavailable".into(),
            });
            continue;
        }

        let rows = match list_slow_queries(pool, per_conn_limit, min_avg_ms).await {
            Ok(r) => r,
            Err(e) => {
                scan_errors.push(ConnScanError {
                    connection_id: conn_id,
                    connection_name: name.clone(),
                    error: e,
                });
                continue;
            }
        };
        total_scanned += rows.len();

        let project_tables_for_conn = per_conn.get(&conn_id).cloned().unwrap_or_default();

        for sq in rows {
            let dt_lower = sq.digest_text.to_lowercase();
            let schema_lower = sq
                .schema_name
                .as_deref()
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            let mut matched: Vec<String> = Vec::new();
            for (db_l, tbl_l, db_o, tbl_o) in &project_tables_for_conn {
                let mut hit = false;
                let pat_a = format!("`{db_l}`.`{tbl_l}`");
                let pat_b = format!("{db_l}.{tbl_l}");
                let pat_c_bt = format!("`{tbl_l}`");
                if dt_lower.contains(&pat_a) || dt_lower.contains(&pat_b) {
                    hit = true;
                } else if schema_lower == *db_l
                    && (dt_lower.contains(&pat_c_bt) || contains_word(&dt_lower, tbl_l))
                {
                    hit = true;
                }
                if hit {
                    matched.push(format!("{db_o}.{tbl_o}"));
                }
            }
            if !matched.is_empty() {
                queries.push(ProjectSlowQuery {
                    connection_id: conn_id,
                    connection_name: name.clone(),
                    slow: sq,
                    matched_tables: matched,
                });
            }
        }
    }

    queries.sort_by(|a, b| {
        b.slow
            .total_ms
            .partial_cmp(&a.slow.total_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total_matched = queries.len();
    let missing_connection_ids: Vec<i64> = missing_set.into_iter().collect();
    let missing_connection_names: Vec<String> = missing_connection_ids
        .iter()
        .map(|id| {
            conn_name
                .get(id)
                .cloned()
                .unwrap_or_else(|| format!("#{id}"))
        })
        .collect();

    Ok(ProjectSlowQueryReport {
        elapsed_ms: start.elapsed().as_millis() as u64,
        project_id,
        project_name: meta.0,
        queries,
        perf_by_connection,
        total_scanned,
        total_matched,
        scanned_connection_ids: scanned_ids,
        missing_connection_ids,
        missing_connection_names,
        scan_errors,
    })
}

fn contains_word(haystack: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let wb = word.as_bytes();
    let n = bytes.len();
    let m = wb.len();
    if m > n {
        return false;
    }
    let is_ident = |b: u8| -> bool { b.is_ascii_alphanumeric() || b == b'_' };
    let mut i = 0;
    while i + m <= n {
        if &bytes[i..i + m] == wb {
            let left_ok = i == 0 || !is_ident(bytes[i - 1]);
            let right_ok = i + m == n || !is_ident(bytes[i + m]);
            if left_ok && right_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}
