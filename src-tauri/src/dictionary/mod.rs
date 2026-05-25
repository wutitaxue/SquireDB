use serde::Serialize;
use sqlx::{MySqlPool, Row, SqlitePool};
use std::collections::{BTreeSet, HashMap};
use std::time::Instant;

#[derive(Debug, Serialize, Clone)]
pub struct DictColumn {
    pub name: String,
    pub data_type: String,
    pub column_type: String,
    pub column_key: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub comment: String,
    pub semantic_role: Option<String>,
    pub pii_type: Option<String>,
    pub ai_comment: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DictTable {
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
    pub columns: Vec<DictColumn>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DictRelation {
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
pub struct ProjectDictionarySnapshot {
    pub project_id: i64,
    pub project_name: String,
    pub project_description: Option<String>,
    pub generated_at: String,
    pub tables: Vec<DictTable>,
    pub relations: Vec<DictRelation>,
    pub total_tables: usize,
    pub total_relations: usize,
    pub missing_connection_ids: Vec<i64>,
    pub missing_connection_names: Vec<String>,
    pub pii_columns_count: usize,
    pub annotated_columns_count: usize,
    pub elapsed_ms: u64,
}

pub async fn collect_project_dictionary(
    sqlite: &SqlitePool,
    pools: &HashMap<i64, MySqlPool>,
    project_id: i64,
) -> Result<ProjectDictionarySnapshot, String> {
    let start = Instant::now();

    let connections = crate::storage::connection::list_all(sqlite)
        .await
        .map_err(|e| format!("load connections failed: {e}"))?;
    let conn_name: HashMap<i64, String> = connections
        .into_iter()
        .filter_map(|c| c.id.map(|id| (id, c.name)))
        .collect();

    let meta: (String, Option<String>) =
        sqlx::query_as("SELECT name, description FROM projects WHERE id = ?")
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

    let mut tables: Vec<DictTable> = table_rows
        .iter()
        .map(|t| DictTable {
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
                    CAST(DATA_TYPE AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
                    CAST(COLUMN_KEY AS CHAR), \
                    CAST(IS_NULLABLE AS CHAR), \
                    COLUMN_DEFAULT, \
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
        let mut cols_by_table: HashMap<String, Vec<DictColumn>> = HashMap::new();
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
            let default: Option<String> = r.try_get(6).ok();
            let comment: String = r.try_get(7).unwrap_or_default();
            cols_by_table.entry(tname).or_default().push(DictColumn {
                name,
                data_type,
                column_type,
                column_key,
                nullable: is_nullable.eq_ignore_ascii_case("YES"),
                default,
                comment,
                semantic_role: None,
                pii_type: None,
                ai_comment: None,
            });
        }

        // Pull annotations for this (conn, db) — single SQLite query
        let annos = crate::storage::annotation::list(sqlite, conn_id, Some(&db))
            .await
            .unwrap_or_default();
        let mut anno_map: HashMap<(String, String), &crate::storage::annotation::Annotation> =
            HashMap::new();
        for a in &annos {
            if let Some(col) = a.column_name.as_deref() {
                anno_map.insert((a.table_name.clone(), col.to_string()), a);
            }
        }

        for &i in &idxs {
            let tbl = &table_rows[i];
            if let Some((rows, len, cmt)) = stats.remove(&tbl.table_name) {
                tables[i].estimated_rows = rows;
                tables[i].data_mb = len as f64 / 1024.0 / 1024.0;
                tables[i].comment = cmt;
            }
            let mut cols = cols_by_table.remove(&tbl.table_name).unwrap_or_default();
            for c in cols.iter_mut() {
                if let Some(a) = anno_map.get(&(tbl.table_name.clone(), c.name.clone())) {
                    c.semantic_role = a.semantic_role.clone();
                    c.pii_type = a.pii_type.clone();
                    c.ai_comment = a.ai_comment.clone();
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

    let relations: Vec<DictRelation> = relation_rows
        .into_iter()
        .map(|r| {
            let cross_conn = r.from_connection_id != r.to_connection_id;
            let cross_db = !cross_conn && r.from_db != r.to_db;
            DictRelation {
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

    let mut pii_count = 0usize;
    let mut annotated_count = 0usize;
    for t in &tables {
        for c in &t.columns {
            if c.pii_type.as_deref().filter(|s| !s.is_empty()).is_some() {
                pii_count += 1;
            }
            if c.ai_comment.as_deref().filter(|s| !s.is_empty()).is_some()
                || c.semantic_role.as_deref().filter(|s| !s.is_empty()).is_some()
            {
                annotated_count += 1;
            }
        }
    }

    let missing_connection_ids: Vec<i64> = missing_set.into_iter().collect();
    let missing_connection_names: Vec<String> = missing_connection_ids
        .iter()
        .map(|id| conn_name.get(id).cloned().unwrap_or_else(|| format!("#{id}")))
        .collect();

    Ok(ProjectDictionarySnapshot {
        project_id,
        project_name: meta.0,
        project_description: meta.1,
        generated_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string(),
        tables,
        relations,
        total_tables,
        total_relations,
        missing_connection_ids,
        missing_connection_names,
        pii_columns_count: pii_count,
        annotated_columns_count: annotated_count,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

pub fn render_markdown(s: &ProjectDictionarySnapshot, ai_summary: Option<&str>) -> String {
    use std::fmt::Write;
    let mut out = String::new();

    let _ = writeln!(out, "# {} — Data Dictionary", s.project_name);
    let _ = writeln!(out);
    let _ = writeln!(out, "_Generated at {} · scan {}ms_", s.generated_at, s.elapsed_ms);
    let _ = writeln!(out);

    if let Some(desc) = &s.project_description {
        if !desc.is_empty() {
            let _ = writeln!(out, "> {}", desc.replace('\n', " "));
            let _ = writeln!(out);
        }
    }

    if let Some(sum) = ai_summary {
        if !sum.is_empty() {
            let _ = writeln!(out, "## Executive summary");
            let _ = writeln!(out);
            let _ = writeln!(out, "{sum}");
            let _ = writeln!(out);
        }
    }

    let _ = writeln!(out, "## Overview");
    let _ = writeln!(out);
    let _ = writeln!(out, "| Item | Count |");
    let _ = writeln!(out, "|---|---:|");
    let _ = writeln!(out, "| Curated tables | {} |", s.total_tables);
    let _ = writeln!(out, "| Curated relations | {} |", s.total_relations);
    let _ = writeln!(out, "| Annotated columns | {} |", s.annotated_columns_count);
    let _ = writeln!(out, "| PII columns | {} |", s.pii_columns_count);
    if !s.missing_connection_names.is_empty() {
        let _ = writeln!(
            out,
            "| Closed connections (partial data) | {} |",
            s.missing_connection_names.join(", ")
        );
    }
    let _ = writeln!(out);

    let _ = writeln!(out, "## Tables");
    let _ = writeln!(out);

    let mut last_group: Option<(i64, String)> = None;
    for t in &s.tables {
        let group = (t.connection_id, t.database.clone());
        if last_group.as_ref() != Some(&group) {
            let _ = writeln!(out, "### {} · `{}`", t.connection_name, t.database);
            let _ = writeln!(out);
            last_group = Some(group);
        }

        let mut header = format!("#### `{}`", t.table);
        if t.is_primary {
            header.push_str(" ⭐ PRIMARY");
        }
        if t.closed {
            header.push_str(" _(connection closed)_");
        }
        let _ = writeln!(out, "{header}");
        let _ = writeln!(out);

        if !t.comment.is_empty() {
            let _ = writeln!(out, "> {}", t.comment.replace('\n', " "));
            let _ = writeln!(out);
        }

        if !t.closed {
            let _ = writeln!(
                out,
                "_~{} rows · {:.2} MB_",
                t.estimated_rows, t.data_mb
            );
            let _ = writeln!(out);
        }

        if t.columns.is_empty() {
            let _ = writeln!(out, "_(no column metadata — connection may be closed)_");
            let _ = writeln!(out);
        } else {
            let _ = writeln!(
                out,
                "| Column | Type | Null | Key | Default | PII | Notes |"
            );
            let _ = writeln!(out, "|---|---|:-:|:-:|---|---|---|");
            for c in &t.columns {
                let nullable = if c.nullable { "Y" } else { "N" };
                let key = if c.column_key.is_empty() {
                    "—".to_string()
                } else {
                    c.column_key.clone()
                };
                let default = c
                    .default
                    .as_deref()
                    .map(|d| escape_md_cell(d))
                    .unwrap_or_else(|| "—".to_string());
                let pii = c.pii_type.as_deref().unwrap_or("—");
                let mut notes_parts: Vec<String> = Vec::new();
                if let Some(role) = c.semantic_role.as_deref().filter(|s| !s.is_empty()) {
                    notes_parts.push(format!("_{}_", escape_md_cell(role)));
                }
                if let Some(ai) = c.ai_comment.as_deref().filter(|s| !s.is_empty()) {
                    notes_parts.push(escape_md_cell(ai));
                }
                if let Some(orig) = Some(c.comment.as_str()).filter(|s| !s.is_empty()) {
                    notes_parts.push(escape_md_cell(orig));
                }
                let notes = if notes_parts.is_empty() {
                    "—".to_string()
                } else {
                    notes_parts.join(" · ")
                };
                let _ = writeln!(
                    out,
                    "| `{}` | `{}` | {} | {} | {} | {} | {} |",
                    escape_md_cell(&c.name),
                    escape_md_cell(&c.column_type),
                    nullable,
                    key,
                    default,
                    pii,
                    notes,
                );
            }
            let _ = writeln!(out);
        }
    }

    if !s.relations.is_empty() {
        let _ = writeln!(out, "## Relations");
        let _ = writeln!(out);
        let _ = writeln!(out, "| From | To | Cardinality | Source | Scope |");
        let _ = writeln!(out, "|---|---|:-:|---|:-:|");
        for r in &s.relations {
            let scope = if r.cross_conn {
                "X-CONN"
            } else if r.cross_db {
                "X-DB"
            } else {
                "local"
            };
            let from = format!(
                "{}·{}.{}.{}",
                r.from_connection_name, r.from_db, r.from_table, r.from_column
            );
            let to = format!(
                "{}·{}.{}.{}",
                r.to_connection_name, r.to_db, r.to_table, r.to_column
            );
            let _ = writeln!(
                out,
                "| `{}` | `{}` | {} | {} | {} |",
                escape_md_cell(&from),
                escape_md_cell(&to),
                r.cardinality,
                escape_md_cell(&r.source),
                scope,
            );
        }
        let _ = writeln!(out);
    }

    out
}

fn escape_md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

pub fn render_html(s: &ProjectDictionarySnapshot, ai_summary: Option<&str>) -> String {
    use std::fmt::Write;
    let mut out = String::new();

    let _ = write!(
        out,
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>{title} — Data Dictionary</title>
<style>
  :root {{ color-scheme: light; }}
  body {{ font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #1f2328; background: #fff; max-width: 980px; margin: 32px auto; padding: 0 24px; }}
  h1 {{ font-size: 22px; border-bottom: 2px solid #d0d7de; padding-bottom: 8px; }}
  h2 {{ font-size: 16px; margin-top: 28px; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; }}
  h3 {{ font-size: 14px; color: #57606a; margin-top: 22px; }}
  h4 {{ font-size: 13px; margin: 18px 0 6px; }}
  .meta {{ color: #57606a; font-size: 11px; }}
  .desc {{ background: #f6f8fa; border-left: 3px solid #d0d7de; padding: 8px 12px; margin: 8px 0; color: #57606a; }}
  table {{ width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 12px; }}
  th, td {{ border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; vertical-align: top; }}
  th {{ background: #f6f8fa; font-weight: 600; }}
  code {{ font: 12px/1.4 "SF Mono", Menlo, monospace; background: #f6f8fa; padding: 0 4px; border-radius: 3px; }}
  .badge {{ display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 10px; font-weight: 700; }}
  .b-primary {{ background: #fff3cd; color: #856404; }}
  .b-closed {{ background: #f8d7da; color: #842029; }}
  .b-pii {{ background: #f5d3e6; color: #6f256f; }}
  .b-xconn {{ background: #d1ecf1; color: #0c5460; }}
  .b-xdb {{ background: #fff3cd; color: #856404; }}
  .summary {{ background: #eef6ff; border-left: 3px solid #2f81f7; padding: 10px 14px; margin: 8px 0; }}
</style>
</head>
<body>
<h1>{title} — Data Dictionary</h1>
<div class="meta">Generated at {generated} · scan {elapsed}ms</div>
"#,
        title = escape_html(&s.project_name),
        generated = escape_html(&s.generated_at),
        elapsed = s.elapsed_ms,
    );

    if let Some(desc) = s.project_description.as_deref().filter(|d| !d.is_empty()) {
        let _ = write!(out, r#"<div class="desc">{}</div>"#, escape_html(desc));
    }

    if let Some(sum) = ai_summary.filter(|x| !x.is_empty()) {
        let _ = write!(
            out,
            "<h2>Executive summary</h2><div class=\"summary\">{}</div>",
            escape_html(sum).replace('\n', "<br/>")
        );
    }

    let _ = write!(out, "<h2>Overview</h2>");
    let _ = write!(
        out,
        "<table><tr><th>Item</th><th>Count</th></tr>\
         <tr><td>Curated tables</td><td>{}</td></tr>\
         <tr><td>Curated relations</td><td>{}</td></tr>\
         <tr><td>Annotated columns</td><td>{}</td></tr>\
         <tr><td>PII columns</td><td>{}</td></tr>",
        s.total_tables, s.total_relations, s.annotated_columns_count, s.pii_columns_count
    );
    if !s.missing_connection_names.is_empty() {
        let _ = write!(
            out,
            "<tr><td>Closed connections (partial data)</td><td>{}</td></tr>",
            escape_html(&s.missing_connection_names.join(", "))
        );
    }
    let _ = write!(out, "</table>");

    let _ = write!(out, "<h2>Tables</h2>");
    let mut last_group: Option<(i64, String)> = None;
    for t in &s.tables {
        let group = (t.connection_id, t.database.clone());
        if last_group.as_ref() != Some(&group) {
            let _ = write!(
                out,
                "<h3>{} · <code>{}</code></h3>",
                escape_html(&t.connection_name),
                escape_html(&t.database)
            );
            last_group = Some(group);
        }
        let _ = write!(out, "<h4><code>{}</code>", escape_html(&t.table));
        if t.is_primary {
            let _ = write!(out, r#" <span class="badge b-primary">PRIMARY</span>"#);
        }
        if t.closed {
            let _ = write!(out, r#" <span class="badge b-closed">closed</span>"#);
        }
        let _ = write!(out, "</h4>");

        if !t.comment.is_empty() {
            let _ = write!(out, r#"<div class="desc">{}</div>"#, escape_html(&t.comment));
        }
        if !t.closed {
            let _ = write!(
                out,
                r#"<div class="meta">~{} rows · {:.2} MB</div>"#,
                t.estimated_rows, t.data_mb
            );
        }

        if t.columns.is_empty() {
            let _ = write!(
                out,
                r#"<div class="meta">(no column metadata — connection may be closed)</div>"#
            );
        } else {
            let _ = write!(
                out,
                "<table><tr><th>Column</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th><th>PII</th><th>Notes</th></tr>"
            );
            for c in &t.columns {
                let nullable = if c.nullable { "Y" } else { "N" };
                let key = if c.column_key.is_empty() {
                    "—".to_string()
                } else {
                    escape_html(&c.column_key)
                };
                let default = c
                    .default
                    .as_deref()
                    .map(escape_html)
                    .unwrap_or_else(|| "—".to_string());
                let pii_html = match c.pii_type.as_deref().filter(|s| !s.is_empty()) {
                    Some(pii) => format!(r#"<span class="badge b-pii">{}</span>"#, escape_html(pii)),
                    None => "—".to_string(),
                };
                let mut notes: Vec<String> = Vec::new();
                if let Some(role) = c.semantic_role.as_deref().filter(|s| !s.is_empty()) {
                    notes.push(format!("<em>{}</em>", escape_html(role)));
                }
                if let Some(ai) = c.ai_comment.as_deref().filter(|s| !s.is_empty()) {
                    notes.push(escape_html(ai));
                }
                if !c.comment.is_empty() {
                    notes.push(escape_html(&c.comment));
                }
                let notes_html = if notes.is_empty() {
                    "—".to_string()
                } else {
                    notes.join(" · ")
                };
                let _ = write!(
                    out,
                    "<tr><td><code>{}</code></td><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                    escape_html(&c.name),
                    escape_html(&c.column_type),
                    nullable,
                    key,
                    default,
                    pii_html,
                    notes_html,
                );
            }
            let _ = write!(out, "</table>");
        }
    }

    if !s.relations.is_empty() {
        let _ = write!(out, "<h2>Relations</h2>");
        let _ = write!(
            out,
            "<table><tr><th>From</th><th>To</th><th>Cardinality</th><th>Source</th><th>Scope</th></tr>"
        );
        for r in &s.relations {
            let scope_html = if r.cross_conn {
                r#"<span class="badge b-xconn">X-CONN</span>"#.to_string()
            } else if r.cross_db {
                r#"<span class="badge b-xdb">X-DB</span>"#.to_string()
            } else {
                "local".to_string()
            };
            let _ = write!(
                out,
                "<tr><td><code>{}·{}.{}.{}</code></td><td><code>{}·{}.{}.{}</code></td><td>{}</td><td>{}</td><td>{}</td></tr>",
                escape_html(&r.from_connection_name),
                escape_html(&r.from_db),
                escape_html(&r.from_table),
                escape_html(&r.from_column),
                escape_html(&r.to_connection_name),
                escape_html(&r.to_db),
                escape_html(&r.to_table),
                escape_html(&r.to_column),
                escape_html(&r.cardinality),
                escape_html(&r.source),
                scope_html,
            );
        }
        let _ = write!(out, "</table>");
    }

    let _ = write!(out, "</body></html>");
    out
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}
