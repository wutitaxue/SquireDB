use serde::Serialize;
use sqlx::{MySqlPool, Row, SqlitePool};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Instant;

#[derive(Debug, Serialize, Clone)]
pub struct ErColumn {
    pub name: String,
    pub data_type: String,
    pub column_type: String,
    pub column_key: String,
    pub nullable: bool,
    pub pii_type: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ErTable {
    pub connection_id: i64,
    pub connection_name: String,
    pub database: String,
    pub table: String,
    pub alias: Option<String>,
    pub is_primary: bool,
    pub closed: bool,
    pub columns: Vec<ErColumn>,
}

impl ErTable {
    pub fn mermaid_id(&self) -> String {
        sanitize_id(&format!(
            "c{}_{}_{}",
            self.connection_id, self.database, self.table
        ))
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct ErRelation {
    pub from_connection_id: i64,
    pub from_connection_name: String,
    pub from_db: String,
    pub from_table: String,
    pub from_column: String,
    pub to_connection_id: i64,
    pub to_connection_name: String,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    pub cardinality: String,
    pub source: String,
    pub cross_db: bool,
    pub cross_conn: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct ErSnapshot {
    pub scope: String,
    pub scope_label: String,
    pub connection_id: Option<i64>,
    pub project_id: Option<i64>,
    pub database: Option<String>,
    pub generated_at: String,
    pub tables: Vec<ErTable>,
    pub relations: Vec<ErRelation>,
    pub total_tables: usize,
    pub total_relations: usize,
    pub missing_connection_ids: Vec<i64>,
    pub missing_connection_names: Vec<String>,
    pub truncated: bool,
    pub truncated_limit: Option<usize>,
    pub elapsed_ms: u64,
}

pub async fn collect_connection_er(
    sqlite: &SqlitePool,
    pool: &MySqlPool,
    connection_id: i64,
    connection_name: &str,
    database: &str,
    table_filter: Option<&BTreeSet<String>>,
    max_tables: usize,
) -> Result<ErSnapshot, String> {
    let start = Instant::now();

    let all_tables: Vec<(String, String)> = sqlx::query_as(
        "SELECT CAST(TABLE_NAME AS CHAR), CAST(IFNULL(TABLE_COMMENT,'') AS CHAR) \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
         ORDER BY TABLE_NAME",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;

    let mut names: Vec<String> = match table_filter {
        Some(filter) => all_tables
            .into_iter()
            .filter_map(|(n, _)| if filter.contains(&n) { Some(n) } else { None })
            .collect(),
        None => all_tables.into_iter().map(|(n, _)| n).collect(),
    };

    let truncated = names.len() > max_tables;
    if truncated {
        names.truncate(max_tables);
    }
    let included: BTreeSet<String> = names.iter().cloned().collect();

    let mut tables: Vec<ErTable> = Vec::with_capacity(names.len());
    if !names.is_empty() {
        let placeholders = vec!["?"; names.len()].join(",");
        let col_sql = format!(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                    CAST(DATA_TYPE AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
                    CAST(COLUMN_KEY AS CHAR), CAST(IS_NULLABLE AS CHAR) \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) \
             ORDER BY TABLE_NAME, ORDINAL_POSITION"
        );
        let mut col_q = sqlx::query(&col_sql).bind(database);
        for n in &names {
            col_q = col_q.bind(n);
        }
        let col_rows = col_q
            .fetch_all(pool)
            .await
            .map_err(|e| format!("fetch columns failed: {e}"))?;

        let mut cols_by_table: HashMap<String, Vec<ErColumn>> = HashMap::new();
        for r in col_rows {
            let tname: String = match r.try_get(0) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let name: String = match r.try_get(1) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let data_type: String = r.try_get(2).unwrap_or_default();
            let column_type: String = r.try_get(3).unwrap_or_default();
            let column_key: String = r.try_get(4).unwrap_or_default();
            let is_nullable: String = r.try_get(5).unwrap_or_default();
            cols_by_table.entry(tname).or_default().push(ErColumn {
                name,
                data_type,
                column_type,
                column_key,
                nullable: is_nullable.eq_ignore_ascii_case("YES"),
                pii_type: None,
            });
        }

        let annos = crate::storage::annotation::list(sqlite, connection_id, Some(database))
            .await
            .unwrap_or_default();
        let mut pii_map: HashMap<(String, String), String> = HashMap::new();
        for a in annos {
            if let Some(col) = a.column_name {
                if let Some(pii) = a.pii_type.filter(|s| !s.is_empty()) {
                    pii_map.insert((a.table_name, col), pii);
                }
            }
        }

        for n in &names {
            let mut cols = cols_by_table.remove(n).unwrap_or_default();
            for c in cols.iter_mut() {
                if let Some(p) = pii_map.get(&(n.clone(), c.name.clone())) {
                    c.pii_type = Some(p.clone());
                }
            }
            tables.push(ErTable {
                connection_id,
                connection_name: connection_name.to_string(),
                database: database.to_string(),
                table: n.clone(),
                alias: None,
                is_primary: false,
                closed: false,
                columns: cols,
            });
        }
    }

    let relations = if names.is_empty() {
        Vec::new()
    } else {
        fetch_connection_fks(pool, database, &included, connection_id, connection_name).await?
    };

    let total_tables = tables.len();
    let total_relations = relations.len();

    Ok(ErSnapshot {
        scope: "connection".into(),
        scope_label: format!("{} · {}", connection_name, database),
        connection_id: Some(connection_id),
        project_id: None,
        database: Some(database.to_string()),
        generated_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string(),
        tables,
        relations,
        total_tables,
        total_relations,
        missing_connection_ids: Vec::new(),
        missing_connection_names: Vec::new(),
        truncated,
        truncated_limit: if truncated { Some(max_tables) } else { None },
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

async fn fetch_connection_fks(
    pool: &MySqlPool,
    database: &str,
    included: &BTreeSet<String>,
    connection_id: i64,
    connection_name: &str,
) -> Result<Vec<ErRelation>, String> {
    let sql = "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                      CAST(REFERENCED_TABLE_SCHEMA AS CHAR), CAST(REFERENCED_TABLE_NAME AS CHAR), \
                      CAST(REFERENCED_COLUMN_NAME AS CHAR) \
               FROM information_schema.KEY_COLUMN_USAGE \
               WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL";
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(sql)
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch fks failed: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (ft, fc, td, tt, tc) in rows {
        if !included.contains(&ft) {
            continue;
        }
        let same_db = td == database;
        if same_db && !included.contains(&tt) {
            continue;
        }
        out.push(ErRelation {
            from_connection_id: connection_id,
            from_connection_name: connection_name.to_string(),
            from_db: database.to_string(),
            from_table: ft,
            from_column: fc,
            to_connection_id: connection_id,
            to_connection_name: connection_name.to_string(),
            to_db: td.clone(),
            to_table: tt,
            to_column: tc,
            cardinality: "N:1".into(),
            source: "FK".into(),
            cross_db: !same_db,
            cross_conn: false,
        });
    }
    Ok(out)
}

pub async fn collect_project_er(
    sqlite: &SqlitePool,
    pools: &HashMap<i64, MySqlPool>,
    project_id: i64,
) -> Result<ErSnapshot, String> {
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
    let relation_rows = crate::storage::project::list_relations(sqlite, project_id)
        .await
        .map_err(|e| format!("list project relations failed: {e}"))?;

    let mut tables: Vec<ErTable> = table_rows
        .iter()
        .map(|t| ErTable {
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
            columns: Vec::new(),
        })
        .collect();

    let mut by_pool: HashMap<(i64, String), Vec<usize>> = HashMap::new();
    for (i, t) in table_rows.iter().enumerate() {
        by_pool
            .entry((t.connection_id, t.database_name.clone()))
            .or_default()
            .push(i);
    }

    let mut missing_set: BTreeSet<i64> = BTreeSet::new();

    for ((conn_id, db), idxs) in by_pool {
        let pool = match pools.get(&conn_id) {
            Some(p) => p,
            None => {
                missing_set.insert(conn_id);
                continue;
            }
        };
        let names: Vec<String> = idxs.iter().map(|&i| table_rows[i].table_name.clone()).collect();
        let placeholders = vec!["?"; names.len()].join(",");

        let col_sql = format!(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                    CAST(DATA_TYPE AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
                    CAST(COLUMN_KEY AS CHAR), CAST(IS_NULLABLE AS CHAR) \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) \
             ORDER BY TABLE_NAME, ORDINAL_POSITION"
        );
        let mut col_q = sqlx::query(&col_sql).bind(&db);
        for n in &names {
            col_q = col_q.bind(n);
        }
        let col_rows = col_q.fetch_all(pool).await.unwrap_or_default();
        let mut cols_by_table: HashMap<String, Vec<ErColumn>> = HashMap::new();
        for r in col_rows {
            let tname: String = match r.try_get(0) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let name: String = match r.try_get(1) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let data_type: String = r.try_get(2).unwrap_or_default();
            let column_type: String = r.try_get(3).unwrap_or_default();
            let column_key: String = r.try_get(4).unwrap_or_default();
            let is_nullable: String = r.try_get(5).unwrap_or_default();
            cols_by_table.entry(tname).or_default().push(ErColumn {
                name,
                data_type,
                column_type,
                column_key,
                nullable: is_nullable.eq_ignore_ascii_case("YES"),
                pii_type: None,
            });
        }

        let annos = crate::storage::annotation::list(sqlite, conn_id, Some(&db))
            .await
            .unwrap_or_default();
        let mut pii_map: HashMap<(String, String), String> = HashMap::new();
        for a in annos {
            if let Some(col) = a.column_name {
                if let Some(pii) = a.pii_type.filter(|s| !s.is_empty()) {
                    pii_map.insert((a.table_name, col), pii);
                }
            }
        }

        for &i in &idxs {
            let tbl_name = &table_rows[i].table_name;
            let mut cols = cols_by_table.remove(tbl_name).unwrap_or_default();
            for c in cols.iter_mut() {
                if let Some(p) = pii_map.get(&(tbl_name.clone(), c.name.clone())) {
                    c.pii_type = Some(p.clone());
                }
            }
            tables[i].columns = cols;
        }
    }

    tables.sort_by(|a, b| {
        b.is_primary
            .cmp(&a.is_primary)
            .then(a.connection_id.cmp(&b.connection_id))
            .then(a.database.cmp(&b.database))
            .then(a.table.cmp(&b.table))
    });

    let relations: Vec<ErRelation> = relation_rows
        .into_iter()
        .map(|r| {
            let cross_conn = r.from_connection_id != r.to_connection_id;
            let cross_db = !cross_conn && r.from_db != r.to_db;
            ErRelation {
                from_connection_id: r.from_connection_id,
                from_connection_name: conn_name
                    .get(&r.from_connection_id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{}", r.from_connection_id)),
                from_db: r.from_db,
                from_table: r.from_table,
                from_column: r.from_column,
                to_connection_id: r.to_connection_id,
                to_connection_name: conn_name
                    .get(&r.to_connection_id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{}", r.to_connection_id)),
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
    let total_relations = relations.len();
    let missing_connection_ids: Vec<i64> = missing_set.into_iter().collect();
    let missing_connection_names: Vec<String> = missing_connection_ids
        .iter()
        .map(|id| conn_name.get(id).cloned().unwrap_or_else(|| format!("#{id}")))
        .collect();

    Ok(ErSnapshot {
        scope: "project".into(),
        scope_label: meta.0.clone(),
        connection_id: None,
        project_id: Some(project_id),
        database: None,
        generated_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string(),
        tables,
        relations,
        total_tables,
        total_relations,
        missing_connection_ids,
        missing_connection_names,
        truncated: false,
        truncated_limit: None,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

pub fn render_mermaid(s: &ErSnapshot) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "erDiagram");

    let mut by_id: BTreeMap<String, &ErTable> = BTreeMap::new();
    for t in &s.tables {
        by_id.insert(t.mermaid_id(), t);
    }

    for (id, t) in &by_id {
        let scope_tag = if s.scope == "project" {
            let conn_short = short(&t.connection_name, 8);
            format!("{}_{}_{}", conn_short, short(&t.database, 8), t.table)
        } else {
            t.table.clone()
        };
        let _ = writeln!(out, "  {} {{", id);
        let _ = writeln!(out, "    %% {}", scope_tag);
        if t.columns.is_empty() && t.closed {
            let _ = writeln!(out, "    string CLOSED_CONNECTION");
        }
        for c in &t.columns {
            let ty = mermaid_type(&c.data_type);
            let name = sanitize_field(&c.name);
            let mut tags: Vec<&str> = Vec::new();
            if c.column_key == "PRI" {
                tags.push("PK");
            } else if c.column_key == "UNI" {
                tags.push("UK");
            }
            let mut note = String::new();
            if let Some(pii) = &c.pii_type {
                if !pii.is_empty() {
                    note.push_str(&format!("PII:{}", pii));
                }
            }
            let mut line = format!("    {} {}", ty, name);
            if !tags.is_empty() {
                line.push(' ');
                line.push_str(&tags.join(","));
            }
            if !note.is_empty() {
                line.push_str(&format!(" \"{}\"", note));
            }
            let _ = writeln!(out, "{}", line);
        }
        let _ = writeln!(out, "  }}");
    }

    let mut emitted: BTreeSet<(String, String, String)> = BTreeSet::new();
    for r in &s.relations {
        let from_id = sanitize_id(&format!(
            "c{}_{}_{}",
            r.from_connection_id, r.from_db, r.from_table
        ));
        let to_id = sanitize_id(&format!(
            "c{}_{}_{}",
            r.to_connection_id, r.to_db, r.to_table
        ));
        if !by_id.contains_key(&from_id) || !by_id.contains_key(&to_id) {
            continue;
        }
        let conn = mermaid_cardinality(&r.cardinality);
        let label = relation_label(r);
        let key = (from_id.clone(), to_id.clone(), label.clone());
        if emitted.contains(&key) {
            continue;
        }
        emitted.insert(key);
        let _ = writeln!(out, "  {} {} {} : \"{}\"", from_id, conn, to_id, label);
    }

    out
}

fn relation_label(r: &ErRelation) -> String {
    let mut tags: Vec<String> = Vec::new();
    if r.cross_conn {
        tags.push("X-CONN".into());
    } else if r.cross_db {
        tags.push("X-DB".into());
    }
    if !r.source.is_empty() && r.source != "FK" {
        tags.push(r.source.to_uppercase());
    }
    let core = format!("{}->{}", r.from_column, r.to_column);
    if tags.is_empty() {
        core
    } else {
        format!("{} [{}]", core, tags.join(","))
    }
}

fn mermaid_cardinality(c: &str) -> &'static str {
    match c {
        "1:1" => "||--||",
        "1:N" | "1:n" => "||--o{",
        "N:1" | "n:1" => "}o--||",
        "N:N" | "n:n" | "M:N" | "m:n" => "}o--o{",
        _ => "}o--||",
    }
}

fn mermaid_type(data_type: &str) -> String {
    let t = data_type.to_lowercase();
    if t.contains("int") {
        "int".into()
    } else if t == "tinyint" {
        "tinyint".into()
    } else if t.contains("char") || t.contains("text") || t.contains("enum") || t.contains("set") {
        "string".into()
    } else if t.contains("decimal") || t.contains("numeric") || t.contains("float") || t.contains("double") {
        "decimal".into()
    } else if t.contains("date") || t.contains("time") {
        "datetime".into()
    } else if t.contains("json") {
        "json".into()
    } else if t.contains("blob") || t.contains("binary") {
        "blob".into()
    } else if t.is_empty() {
        "string".into()
    } else {
        t
    }
}

fn sanitize_id(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    if out.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        out.insert(0, '_');
    }
    out
}

fn sanitize_field(s: &str) -> String {
    sanitize_id(s)
}

fn short(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

pub fn build_ai_block(s: &ErSnapshot) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "Scope: {}", s.scope_label);
    let _ = writeln!(
        out,
        "Tables: {} · Relations: {}",
        s.total_tables, s.total_relations
    );
    if s.truncated {
        if let Some(lim) = s.truncated_limit {
            let _ = writeln!(out, "WARNING: truncated to first {lim} tables (alphabetical).");
        }
    }
    if !s.missing_connection_names.is_empty() {
        let _ = writeln!(
            out,
            "WARNING: closed connections (partial data): {}",
            s.missing_connection_names.join(", ")
        );
    }
    let _ = writeln!(out, "\nTables and key columns:");
    for t in &s.tables {
        let primary = if t.is_primary { " ★" } else { "" };
        let _ = writeln!(out, "- {}.{}{}", t.database, t.table, primary);
        for c in &t.columns {
            if c.column_key == "PRI" || c.column_key == "UNI" || c.pii_type.is_some() {
                let pii = c
                    .pii_type
                    .as_deref()
                    .map(|p| format!(" PII:{p}"))
                    .unwrap_or_default();
                let _ = writeln!(
                    out,
                    "    {} {} [{}]{}",
                    c.name, c.column_type, c.column_key, pii
                );
            }
        }
    }
    let _ = writeln!(out, "\nRelations:");
    for r in &s.relations {
        let scope = if r.cross_conn {
            " [X-CONN]"
        } else if r.cross_db {
            " [X-DB]"
        } else {
            ""
        };
        let _ = writeln!(
            out,
            "  {}.{}.{} -> {}.{}.{}  ({}, src={}){}",
            r.from_db,
            r.from_table,
            r.from_column,
            r.to_db,
            r.to_table,
            r.to_column,
            r.cardinality,
            r.source,
            scope
        );
    }
    out
}
