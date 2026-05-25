use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use sqlx::{MySqlPool, Row, SqlitePool};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

use crate::ai::{self, AiConfig};
use crate::storage::{annotation, project, relation};

const VALID_CARDINALITIES: &[&str] = &["1-1", "1-N", "N-1", "N-N"];

const SAMPLE_LIMIT: i64 = 50;
const PII_THRESHOLD: f64 = 0.6;
const SYSTEM_DBS: &[&str] = &["information_schema", "performance_schema", "mysql", "sys"];

static RE_PHONE_CN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^1[3-9]\d{9}$").unwrap());
static RE_EMAIL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$").unwrap());
static RE_ID_CARD_CN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{17}[\dXx]$").unwrap());
static RE_DIGITS_ONLY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{13,19}$").unwrap());

#[derive(Debug, Serialize)]
pub struct AnalyzeReport {
    pub tables_analyzed: usize,
    pub columns_analyzed: usize,
    pub annotations_written: usize,
    pub relations_written: usize,
    pub pii_columns: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone)]
struct ColumnMeta {
    db: String,
    table: String,
    name: String,
    data_type: String,
    column_key: String,
}

pub async fn analyze_connection(
    mysql: &MySqlPool,
    sqlite: &SqlitePool,
    connection_id: i64,
) -> Result<AnalyzeReport, String> {
    let start = Instant::now();

    let columns = fetch_columns(mysql).await?;
    let columns_analyzed = columns.len();

    let mut by_table: HashMap<(String, String), Vec<ColumnMeta>> = HashMap::new();
    for c in columns.iter().cloned() {
        by_table
            .entry((c.db.clone(), c.table.clone()))
            .or_default()
            .push(c);
    }
    let tables_analyzed = by_table.len();

    let mut annotations_written = 0usize;
    let mut pii_columns = 0usize;

    let mut pk_by_table: HashMap<(String, String), String> = HashMap::new();
    for c in &columns {
        if c.column_key == "PRI" {
            pk_by_table
                .entry((c.db.clone(), c.table.clone()))
                .or_insert_with(|| c.name.clone());
        }
    }

    let mut tables_in_db: HashMap<String, Vec<String>> = HashMap::new();
    for (db, table) in by_table.keys() {
        tables_in_db.entry(db.clone()).or_default().push(table.clone());
    }

    let mut relations_written = 0usize;
    let fk_rows = fetch_fk_constraints(mysql).await?;
    for fk in &fk_rows {
        relation::upsert(
            sqlite,
            connection_id,
            &fk.from_db,
            &fk.from_table,
            &fk.from_column,
            &fk.to_db,
            &fk.to_table,
            &fk.to_column,
            1.0,
            "fk_constraint",
        )
        .await
        .map_err(|e| format!("save fk relation failed: {e}"))?;
        relations_written += 1;
    }

    for ((db, table), cols) in &by_table {
        let pii_map = sample_for_pii(mysql, db, table, cols).await.unwrap_or_default();

        for c in cols {
            let role = infer_semantic_role(c);
            let pii = pii_map.get(&c.name).cloned();
            if pii.is_some() {
                pii_columns += 1;
            }

            if role.is_some() || pii.is_some() {
                annotation::upsert(
                    sqlite,
                    connection_id,
                    db,
                    table,
                    Some(&c.name),
                    role.as_deref(),
                    pii.as_deref(),
                    None,
                )
                .await
                .map_err(|e| format!("save annotation failed: {e}"))?;
                annotations_written += 1;
            }

            if let Some(target) = infer_relation_by_name(c, db, &tables_in_db, &pk_by_table) {
                relation::upsert(
                    sqlite,
                    connection_id,
                    db,
                    table,
                    &c.name,
                    &target.0,
                    &target.1,
                    &target.2,
                    0.7,
                    "name_match",
                )
                .await
                .map_err(|e| format!("save relation failed: {e}"))?;
                relations_written += 1;
            }
        }
    }

    Ok(AnalyzeReport {
        tables_analyzed,
        columns_analyzed,
        annotations_written,
        relations_written,
        pii_columns,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

async fn fetch_columns(pool: &MySqlPool) -> Result<Vec<ColumnMeta>, String> {
    let sys_list = SYSTEM_DBS
        .iter()
        .map(|s| format!("'{}'", s))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), \
                CAST(COLUMN_NAME AS CHAR), CAST(DATA_TYPE AS CHAR), CAST(COLUMN_KEY AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA NOT IN ({sys_list}) \
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
    );
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch columns failed: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(db, table, name, data_type, column_key)| ColumnMeta {
            db,
            table,
            name,
            data_type,
            column_key,
        })
        .collect())
}

struct FkRow {
    from_db: String,
    from_table: String,
    from_column: String,
    to_db: String,
    to_table: String,
    to_column: String,
}

async fn fetch_fk_constraints(pool: &MySqlPool) -> Result<Vec<FkRow>, String> {
    let sys_list = SYSTEM_DBS
        .iter()
        .map(|s| format!("'{}'", s))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
                CAST(REFERENCED_TABLE_SCHEMA AS CHAR), CAST(REFERENCED_TABLE_NAME AS CHAR), \
                CAST(REFERENCED_COLUMN_NAME AS CHAR) \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE REFERENCED_TABLE_NAME IS NOT NULL \
           AND TABLE_SCHEMA NOT IN ({sys_list})"
    );
    let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("fetch fk failed: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(fd, ft, fc, td, tt, tc)| FkRow {
            from_db: fd,
            from_table: ft,
            from_column: fc,
            to_db: td,
            to_table: tt,
            to_column: tc,
        })
        .collect())
}

fn infer_semantic_role(c: &ColumnMeta) -> Option<String> {
    let n = c.name.to_lowercase();
    let dt = c.data_type.to_lowercase();

    if c.column_key == "PRI" || n == "id" {
        return Some("pk".into());
    }
    if n.ends_with("_id") && n != "id" {
        return Some("fk".into());
    }
    if matches!(dt.as_str(), "datetime" | "timestamp" | "date")
        || n.ends_with("_at")
        || n.ends_with("_time")
        || matches!(n.as_str(), "created" | "updated" | "deleted")
    {
        return Some("timestamp".into());
    }
    if matches!(n.as_str(), "status" | "state" | "type" | "kind") {
        return Some("status".into());
    }
    if matches!(n.as_str(), "name" | "title" | "label" | "display_name") {
        return Some("name".into());
    }
    if matches!(
        n.as_str(),
        "content" | "description" | "body" | "text" | "comment" | "note" | "remark"
    ) {
        return Some("content".into());
    }
    None
}

fn infer_relation_by_name(
    c: &ColumnMeta,
    same_db: &str,
    tables_in_db: &HashMap<String, Vec<String>>,
    pk_by_table: &HashMap<(String, String), String>,
) -> Option<(String, String, String)> {
    let n = c.name.to_lowercase();
    if !n.ends_with("_id") || n == "id" {
        return None;
    }
    let stem = &n[..n.len() - 3];
    if stem.is_empty() {
        return None;
    }

    let tables = tables_in_db.get(same_db)?;
    let candidates = [stem.to_string(), format!("{stem}s"), format!("{stem}es")];

    for cand in &candidates {
        if let Some(real) = tables.iter().find(|t| t.to_lowercase() == *cand) {
            if let Some(pk) = pk_by_table.get(&(same_db.to_string(), real.clone())) {
                return Some((same_db.to_string(), real.clone(), pk.clone()));
            }
            return Some((same_db.to_string(), real.clone(), "id".to_string()));
        }
    }
    None
}

async fn sample_for_pii(
    pool: &MySqlPool,
    db: &str,
    table: &str,
    cols: &[ColumnMeta],
) -> Result<HashMap<String, String>, String> {
    let text_cols: Vec<&ColumnMeta> = cols
        .iter()
        .filter(|c| is_text_type(&c.data_type))
        .collect();
    if text_cols.is_empty() {
        return Ok(HashMap::new());
    }

    let col_list = text_cols
        .iter()
        .map(|c| format!("`{}`", c.name.replace('`', "``")))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT {col_list} FROM `{}`.`{}` LIMIT {}",
        db.replace('`', "``"),
        table.replace('`', "``"),
        SAMPLE_LIMIT
    );

    let rows = sqlx::query(&sql).fetch_all(pool).await.map_err(|e| {
        format!("sample {db}.{table} failed: {e}")
    })?;

    let mut samples: HashMap<String, Vec<String>> = HashMap::new();
    for row in &rows {
        for (i, c) in text_cols.iter().enumerate() {
            let v: Option<String> = row.try_get(i).ok().flatten();
            if let Some(s) = v {
                if !s.is_empty() {
                    samples.entry(c.name.clone()).or_default().push(s);
                }
            }
        }
    }

    let mut result = HashMap::new();
    for (col, values) in &samples {
        if values.len() < 3 {
            continue;
        }
        if let Some(pii) = classify_pii(values) {
            result.insert(col.clone(), pii);
        }
    }
    Ok(result)
}

fn is_text_type(dt: &str) -> bool {
    matches!(
        dt.to_lowercase().as_str(),
        "char" | "varchar" | "text" | "tinytext" | "mediumtext" | "longtext"
    )
}

fn classify_pii(values: &[String]) -> Option<String> {
    let total = values.len() as f64;
    let mut counts = HashMap::new();
    for v in values {
        let t = v.trim();
        let kind = if RE_PHONE_CN.is_match(t) {
            Some("phone")
        } else if RE_EMAIL.is_match(t) {
            Some("email")
        } else if RE_ID_CARD_CN.is_match(t) {
            Some("id_card")
        } else if RE_DIGITS_ONLY.is_match(t) && luhn_check(t) {
            Some("bank_card")
        } else {
            None
        };
        if let Some(k) = kind {
            *counts.entry(k).or_insert(0usize) += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .filter(|(_, n)| (*n as f64) / total >= PII_THRESHOLD)
        .map(|(k, _)| k.to_string())
}

#[derive(Debug, Serialize)]
pub struct TableCommentReport {
    pub columns_documented: usize,
    pub elapsed_ms: u64,
}

pub async fn list_tables_in_db(
    mysql: &MySqlPool,
    database_name: &str,
) -> Result<Vec<String>, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT CAST(TABLE_NAME AS CHAR) \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
         ORDER BY TABLE_NAME",
    )
    .bind(database_name)
    .fetch_all(mysql)
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;
    Ok(rows.into_iter().map(|(t,)| t).collect())
}

pub async fn generate_table_comments(
    mysql: &MySqlPool,
    sqlite: &SqlitePool,
    connection_id: i64,
    database_name: &str,
    table_name: &str,
    ai_config: &AiConfig,
    api_key: &str,
) -> Result<TableCommentReport, String> {
    let start = Instant::now();

    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
                CAST(COALESCE(COLUMN_COMMENT, '') AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(database_name)
    .bind(table_name)
    .fetch_all(mysql)
    .await
    .map_err(|e| format!("fetch columns failed: {e}"))?;

    if rows.is_empty() {
        return Ok(TableCommentReport {
            columns_documented: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    let existing = annotation::list(sqlite, connection_id, Some(database_name))
        .await
        .map_err(|e| format!("list annotations failed: {e}"))?;
    let mut hint_map: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for a in existing {
        if a.table_name == table_name {
            if let Some(col) = a.column_name {
                hint_map.insert(col, (a.semantic_role, a.pii_type));
            }
        }
    }

    let mut block = String::new();
    for (col, ty, existing_comment) in &rows {
        let hint = hint_map.get(col);
        let role = hint.and_then(|(r, _)| r.clone()).unwrap_or_default();
        let pii = hint.and_then(|(_, p)| p.clone()).unwrap_or_default();
        block.push_str(&format!(
            "- `{col}` {ty}{}{}{}\n",
            if existing_comment.is_empty() {
                String::new()
            } else {
                format!(" -- existing: {existing_comment}")
            },
            if role.is_empty() {
                String::new()
            } else {
                format!(" [role: {role}]")
            },
            if pii.is_empty() {
                String::new()
            } else {
                format!(" [pii: {pii}]")
            },
        ));
    }

    let comments =
        ai::generate_table_comments(ai_config, api_key, database_name, table_name, &block).await?;

    if let Some(tc) = comments.table_comment.as_deref() {
        let _ = annotation::upsert(
            sqlite,
            connection_id,
            database_name,
            table_name,
            None,
            None,
            None,
            Some(tc),
        )
        .await;
    }
    let mut columns_documented = 0usize;
    for (col, comment) in &comments.columns {
        if comment.trim().is_empty() {
            continue;
        }
        let _ = annotation::upsert(
            sqlite,
            connection_id,
            database_name,
            table_name,
            Some(col),
            None,
            None,
            Some(comment),
        )
        .await;
        columns_documented += 1;
    }

    Ok(TableCommentReport {
        columns_documented,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Serialize)]
pub struct AiRelationsReport {
    pub proposed: usize,
    pub accepted: usize,
    pub rejected_unknown_endpoint: usize,
    pub elapsed_ms: u64,
    pub rejections: Vec<String>,
}

pub async fn generate_ai_relations(
    mysql: &MySqlPool,
    sqlite: &SqlitePool,
    connection_id: i64,
    ai_config: &AiConfig,
    api_key: &str,
) -> Result<AiRelationsReport, String> {
    let start = Instant::now();

    let columns = fetch_columns(mysql).await?;
    if columns.is_empty() {
        return Ok(AiRelationsReport {
            proposed: 0,
            accepted: 0,
            rejected_unknown_endpoint: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
            rejections: Vec::new(),
        });
    }

    let mut valid_columns: HashSet<(String, String, String)> = HashSet::new();
    let mut by_table: BTreeMap<(String, String), Vec<&ColumnMeta>> = BTreeMap::new();
    for c in &columns {
        valid_columns.insert((c.db.clone(), c.table.clone(), c.name.clone()));
        by_table
            .entry((c.db.clone(), c.table.clone()))
            .or_default()
            .push(c);
    }

    let existing_annotations = annotation::list(sqlite, connection_id, None)
        .await
        .map_err(|e| format!("list annotations failed: {e}"))?;
    let mut role_hint: HashMap<(String, String, String), String> = HashMap::new();
    for a in existing_annotations {
        if let Some(col) = a.column_name {
            if let Some(r) = a.semantic_role {
                role_hint.insert((a.database_name, a.table_name, col), r);
            }
        }
    }

    let mut ctx = String::new();
    for ((db, table), cols) in &by_table {
        ctx.push_str(&format!("Database `{db}` table `{table}`:\n"));
        for c in cols {
            let pk_tag = if c.column_key == "PRI" { " [PK]" } else { "" };
            let role_tag = role_hint
                .get(&(db.clone(), table.clone(), c.name.clone()))
                .map(|r| format!(" [role: {r}]"))
                .unwrap_or_default();
            ctx.push_str(&format!(
                "  - {} {}{}{}\n",
                c.name, c.data_type, pk_tag, role_tag
            ));
        }
    }

    let inferred = ai::generate_relations(ai_config, api_key, &ctx).await?;
    let proposed = inferred.relations.len();

    let mut accepted = 0usize;
    let mut rejected_unknown_endpoint = 0usize;
    let mut rejections: Vec<String> = Vec::new();

    for r in inferred.relations {
        if r.confidence < 0.5 {
            continue;
        }
        let from_key = (r.from_db.clone(), r.from_table.clone(), r.from_column.clone());
        let to_key = (r.to_db.clone(), r.to_table.clone(), r.to_column.clone());
        if !valid_columns.contains(&from_key) || !valid_columns.contains(&to_key) {
            rejected_unknown_endpoint += 1;
            if rejections.len() < 5 {
                rejections.push(format!(
                    "{}.{}.{} → {}.{}.{}",
                    r.from_db, r.from_table, r.from_column,
                    r.to_db, r.to_table, r.to_column
                ));
            }
            continue;
        }
        if from_key == to_key {
            continue;
        }
        relation::upsert(
            sqlite,
            connection_id,
            &r.from_db,
            &r.from_table,
            &r.from_column,
            &r.to_db,
            &r.to_table,
            &r.to_column,
            r.confidence.clamp(0.0, 1.0),
            "ai_inferred",
        )
        .await
        .map_err(|e| format!("save ai relation failed: {e}"))?;
        accepted += 1;
    }

    Ok(AiRelationsReport {
        proposed,
        accepted,
        rejected_unknown_endpoint,
        elapsed_ms: start.elapsed().as_millis() as u64,
        rejections,
    })
}

pub async fn generate_ai_relations_for_project(
    mysql: &MySqlPool,
    sqlite: &SqlitePool,
    project_id: i64,
    connection_id: i64,
    ai_config: &AiConfig,
    api_key: &str,
) -> Result<AiRelationsReport, String> {
    let start = Instant::now();

    let project_tables = project::list_tables(sqlite, project_id)
        .await
        .map_err(|e| format!("list project tables failed: {e}"))?;
    if project_tables.is_empty() {
        return Err("Project has no tables.".into());
    }
    let in_project: HashSet<(String, String)> = project_tables
        .iter()
        .map(|t| (t.database_name.clone(), t.table_name.clone()))
        .collect();

    let all_columns = fetch_columns(mysql).await?;
    let columns: Vec<ColumnMeta> = all_columns
        .into_iter()
        .filter(|c| in_project.contains(&(c.db.clone(), c.table.clone())))
        .collect();
    if columns.is_empty() {
        return Err("No columns found for project tables.".into());
    }

    let mut valid_columns: HashSet<(String, String, String)> = HashSet::new();
    let mut by_table: BTreeMap<(String, String), Vec<&ColumnMeta>> = BTreeMap::new();
    for c in &columns {
        valid_columns.insert((c.db.clone(), c.table.clone(), c.name.clone()));
        by_table
            .entry((c.db.clone(), c.table.clone()))
            .or_default()
            .push(c);
    }

    let existing_annotations = annotation::list(sqlite, connection_id, None)
        .await
        .map_err(|e| format!("list annotations failed: {e}"))?;
    let mut role_hint: HashMap<(String, String, String), String> = HashMap::new();
    for a in existing_annotations {
        if let Some(col) = a.column_name {
            if let Some(r) = a.semantic_role {
                role_hint.insert((a.database_name, a.table_name, col), r);
            }
        }
    }

    let mut ctx = String::new();
    for ((db, table), cols) in &by_table {
        ctx.push_str(&format!("Database `{db}` table `{table}`:\n"));
        for c in cols {
            let pk_tag = if c.column_key == "PRI" { " [PK]" } else { "" };
            let role_tag = role_hint
                .get(&(db.clone(), table.clone(), c.name.clone()))
                .map(|r| format!(" [role: {r}]"))
                .unwrap_or_default();
            ctx.push_str(&format!(
                "  - {} {}{}{}\n",
                c.name, c.data_type, pk_tag, role_tag
            ));
        }
    }

    let inferred = ai::generate_relations(ai_config, api_key, &ctx).await?;
    let proposed = inferred.relations.len();

    let mut accepted = 0usize;
    let mut rejected_unknown_endpoint = 0usize;
    let mut rejections: Vec<String> = Vec::new();

    for r in inferred.relations {
        if r.confidence < 0.5 {
            continue;
        }
        let from_key = (r.from_db.clone(), r.from_table.clone(), r.from_column.clone());
        let to_key = (r.to_db.clone(), r.to_table.clone(), r.to_column.clone());
        if !valid_columns.contains(&from_key) || !valid_columns.contains(&to_key) {
            rejected_unknown_endpoint += 1;
            if rejections.len() < 5 {
                rejections.push(format!(
                    "{}.{}.{} → {}.{}.{}",
                    r.from_db, r.from_table, r.from_column,
                    r.to_db, r.to_table, r.to_column
                ));
            }
            continue;
        }
        if from_key == to_key {
            continue;
        }
        let cardinality = r
            .cardinality
            .as_deref()
            .filter(|c| VALID_CARDINALITIES.contains(c))
            .unwrap_or("N-1");
        project::add_relation(
            sqlite,
            project_id,
            connection_id,
            &r.from_db,
            &r.from_table,
            &r.from_column,
            connection_id,
            &r.to_db,
            &r.to_table,
            &r.to_column,
            cardinality,
            "ai_inferred",
        )
        .await
        .map_err(|e| format!("save project relation failed: {e}"))?;
        accepted += 1;
    }

    Ok(AiRelationsReport {
        proposed,
        accepted,
        rejected_unknown_endpoint,
        elapsed_ms: start.elapsed().as_millis() as u64,
        rejections,
    })
}

fn luhn_check(s: &str) -> bool {
    let digits: Vec<u32> = s.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            if i % 2 == 1 {
                let m = d * 2;
                if m > 9 {
                    m - 9
                } else {
                    m
                }
            } else {
                d
            }
        })
        .sum();
    sum % 10 == 0
}
