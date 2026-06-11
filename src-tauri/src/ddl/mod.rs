use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColumnSpec {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub default_is_expression: bool,
    pub auto_increment: bool,
    pub on_update: Option<String>,
    pub comment: Option<String>,
    pub charset: Option<String>,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IndexKind {
    Primary,
    Unique,
    Index,
    Fulltext,
    Spatial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexColumn {
    pub name: String,
    pub length: Option<u32>,
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexSpec {
    pub name: String,
    pub kind: IndexKind,
    pub columns: Vec<IndexColumn>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FkAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

impl FkAction {
    fn parse(s: &str) -> Self {
        match s.to_uppercase().as_str() {
            "CASCADE" => Self::Cascade,
            "SET NULL" => Self::SetNull,
            "SET DEFAULT" => Self::SetDefault,
            "RESTRICT" => Self::Restrict,
            _ => Self::NoAction,
        }
    }
    fn to_sql(self) -> &'static str {
        match self {
            Self::NoAction => "NO ACTION",
            Self::Restrict => "RESTRICT",
            Self::Cascade => "CASCADE",
            Self::SetNull => "SET NULL",
            Self::SetDefault => "SET DEFAULT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForeignKeySpec {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_database: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: FkAction,
    pub on_update: FkAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TableStructure {
    pub database: String,
    pub table: String,
    pub engine: String,
    pub charset: String,
    pub collation: String,
    pub comment: Option<String>,
    pub columns: Vec<ColumnSpec>,
    pub indexes: Vec<IndexSpec>,
    pub foreign_keys: Vec<ForeignKeySpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableEdit {
    pub original: TableStructure,
    pub modified: TableStructure,
    pub rename_to: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AlterPlan {
    pub statements: Vec<String>,
    pub sql: String,
    pub risks: Vec<Risk>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Risk {
    pub level: RiskLevel,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Info,
    Warn,
    Critical,
}

pub fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

fn quote_string(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub async fn get_table_structure(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<TableStructure, String> {
    let tbl: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT \
            CAST(COALESCE(ENGINE, 'InnoDB') AS CHAR), \
            CAST(COALESCE(TABLE_COLLATION, '') AS CHAR), \
            CAST(CCSA.CHARACTER_SET_NAME AS CHAR), \
            CAST(TABLE_COMMENT AS CHAR) \
         FROM information_schema.TABLES T \
         LEFT JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY CCSA \
           ON CCSA.COLLATION_NAME = T.TABLE_COLLATION \
         WHERE T.TABLE_SCHEMA = ? AND T.TABLE_NAME = ?",
    )
    .bind(database)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("read table meta failed: {e}"))?;

    let (engine, collation, charset, comment_raw) = tbl
        .ok_or_else(|| format!("table `{}`.`{}` not found", database, table))?;
    let comment = match comment_raw.as_deref() {
        Some("") | None => None,
        Some(s) => Some(s.to_string()),
    };

    let columns = read_columns(pool, database, table).await?;
    let indexes = read_indexes(pool, database, table).await?;
    let foreign_keys = read_foreign_keys(pool, database, table).await?;

    Ok(TableStructure {
        database: database.to_string(),
        table: table.to_string(),
        engine,
        charset: charset.unwrap_or_default(),
        collation,
        comment,
        columns,
        indexes,
        foreign_keys,
    })
}

async fn read_columns(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnSpec>, String> {
    let rows: Vec<(
        String,         // column_name
        String,         // column_type
        String,         // is_nullable (YES/NO)
        Option<String>, // column_default
        String,         // extra
        Option<String>, // column_comment
        Option<String>, // character_set_name
        Option<String>, // collation_name
    )> = sqlx::query_as(
        "SELECT \
            CAST(COLUMN_NAME AS CHAR), \
            CAST(COLUMN_TYPE AS CHAR), \
            CAST(IS_NULLABLE AS CHAR), \
            CAST(COLUMN_DEFAULT AS CHAR), \
            CAST(COALESCE(EXTRA, '') AS CHAR), \
            CAST(COLUMN_COMMENT AS CHAR), \
            CAST(CHARACTER_SET_NAME AS CHAR), \
            CAST(COLLATION_NAME AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("read columns failed: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (name, ctype, nullable, default, extra, comment, charset, collation) in rows {
        let extra_lower = extra.to_lowercase();
        let auto_increment = extra_lower.contains("auto_increment");
        let on_update = if let Some(rest) = extra_lower.strip_prefix("on update ") {
            Some(rest.trim().to_uppercase())
        } else if let Some(idx) = extra_lower.find(" on update ") {
            let rest = &extra[idx + 11..];
            Some(rest.trim().to_uppercase())
        } else {
            None
        };
        let (default_value, default_is_expression) = match default {
            None => (None, false),
            Some(d) => {
                let trimmed = d.trim();
                let looks_expr = trimmed.eq_ignore_ascii_case("CURRENT_TIMESTAMP")
                    || trimmed.eq_ignore_ascii_case("NULL")
                    || trimmed.starts_with("CURRENT_TIMESTAMP")
                    || extra_lower.contains("default_generated");
                (Some(trimmed.to_string()), looks_expr)
            }
        };
        out.push(ColumnSpec {
            name,
            data_type: ctype,
            nullable: nullable == "YES",
            default_value,
            default_is_expression,
            auto_increment,
            on_update,
            comment: comment.filter(|s| !s.is_empty()),
            charset,
            collation,
        });
    }
    Ok(out)
}

async fn read_indexes(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<IndexSpec>, String> {
    let rows: Vec<(
        String,         // index_name
        i64,            // non_unique
        i64,            // seq_in_index
        String,         // column_name
        Option<i64>,    // sub_part
        Option<String>, // collation
        String,         // index_type
        Option<String>, // index_comment
    )> = sqlx::query_as(
        "SELECT \
            CAST(INDEX_NAME AS CHAR), \
            CAST(NON_UNIQUE AS SIGNED), \
            CAST(SEQ_IN_INDEX AS SIGNED), \
            CAST(COLUMN_NAME AS CHAR), \
            CAST(SUB_PART AS SIGNED), \
            CAST(COLLATION AS CHAR), \
            CAST(COALESCE(INDEX_TYPE, '') AS CHAR), \
            CAST(INDEX_COMMENT AS CHAR) \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("read indexes failed: {e}"))?;

    let mut indexes: Vec<IndexSpec> = Vec::new();
    for (name, non_unique, _seq, col, sub_part, coll, itype, icomment) in rows {
        let kind = if name == "PRIMARY" {
            IndexKind::Primary
        } else if itype.eq_ignore_ascii_case("FULLTEXT") {
            IndexKind::Fulltext
        } else if itype.eq_ignore_ascii_case("SPATIAL") {
            IndexKind::Spatial
        } else if non_unique == 0 {
            IndexKind::Unique
        } else {
            IndexKind::Index
        };
        let icol = IndexColumn {
            name: col,
            length: sub_part.map(|v| v as u32),
            desc: coll.as_deref() == Some("D"),
        };
        if let Some(existing) = indexes.iter_mut().find(|i| i.name == name) {
            existing.columns.push(icol);
        } else {
            indexes.push(IndexSpec {
                name,
                kind,
                columns: vec![icol],
                comment: icomment.filter(|s| !s.is_empty()),
            });
        }
    }
    Ok(indexes)
}

async fn read_foreign_keys(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<ForeignKeySpec>, String> {
    let rows: Vec<(
        String,         // constraint_name
        String,         // column_name
        String,         // referenced_table_name
        String,         // referenced_column_name
        Option<String>, // referenced_table_schema
        Option<String>, // update_rule
        Option<String>, // delete_rule
        i64,            // ordinal_position
    )> = sqlx::query_as(
        "SELECT \
            CAST(KCU.CONSTRAINT_NAME AS CHAR), \
            CAST(KCU.COLUMN_NAME AS CHAR), \
            CAST(KCU.REFERENCED_TABLE_NAME AS CHAR), \
            CAST(KCU.REFERENCED_COLUMN_NAME AS CHAR), \
            CAST(KCU.REFERENCED_TABLE_SCHEMA AS CHAR), \
            CAST(RC.UPDATE_RULE AS CHAR), \
            CAST(RC.DELETE_RULE AS CHAR), \
            CAST(KCU.ORDINAL_POSITION AS SIGNED) \
         FROM information_schema.KEY_COLUMN_USAGE KCU \
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS RC \
           ON RC.CONSTRAINT_NAME = KCU.CONSTRAINT_NAME \
          AND RC.CONSTRAINT_SCHEMA = KCU.CONSTRAINT_SCHEMA \
         WHERE KCU.TABLE_SCHEMA = ? AND KCU.TABLE_NAME = ? \
           AND KCU.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY KCU.CONSTRAINT_NAME, KCU.ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("read fks failed: {e}"))?;

    let mut fks: Vec<ForeignKeySpec> = Vec::new();
    for (name, col, ref_tbl, ref_col, ref_db, upd, del, _seq) in rows {
        if let Some(existing) = fks.iter_mut().find(|f| f.name == name) {
            existing.columns.push(col);
            existing.ref_columns.push(ref_col);
        } else {
            let ref_database = match ref_db.as_deref() {
                Some(s) if s == database => None,
                Some(s) if !s.is_empty() => Some(s.to_string()),
                _ => None,
            };
            fks.push(ForeignKeySpec {
                name,
                columns: vec![col],
                ref_database,
                ref_table: ref_tbl,
                ref_columns: vec![ref_col],
                on_update: upd.as_deref().map(FkAction::parse).unwrap_or(FkAction::NoAction),
                on_delete: del.as_deref().map(FkAction::parse).unwrap_or(FkAction::NoAction),
            });
        }
    }
    Ok(fks)
}

fn column_clause(c: &ColumnSpec) -> String {
    let mut s = format!("{} {}", quote_ident(&c.name), c.data_type);
    if let (Some(cs), Some(co)) = (&c.charset, &c.collation) {
        if !cs.is_empty() && !co.is_empty() && is_text_type(&c.data_type) {
            s.push_str(&format!(" CHARACTER SET {} COLLATE {}", cs, co));
        }
    }
    if !c.nullable {
        s.push_str(" NOT NULL");
    } else {
        s.push_str(" NULL");
    }
    if c.auto_increment {
        s.push_str(" AUTO_INCREMENT");
    }
    match &c.default_value {
        Some(v) if c.default_is_expression => s.push_str(&format!(" DEFAULT {}", v)),
        Some(v) => s.push_str(&format!(" DEFAULT {}", quote_string(v))),
        None => {}
    }
    if let Some(ou) = &c.on_update {
        s.push_str(&format!(" ON UPDATE {}", ou));
    }
    if let Some(cm) = &c.comment {
        s.push_str(&format!(" COMMENT {}", quote_string(cm)));
    }
    s
}

fn is_text_type(t: &str) -> bool {
    let lower = t.to_lowercase();
    lower.starts_with("char")
        || lower.starts_with("varchar")
        || lower.starts_with("text")
        || lower.starts_with("tinytext")
        || lower.starts_with("mediumtext")
        || lower.starts_with("longtext")
        || lower.starts_with("enum")
        || lower.starts_with("set")
}

fn index_columns_clause(cols: &[IndexColumn]) -> String {
    cols.iter()
        .map(|c| {
            let mut s = quote_ident(&c.name);
            if let Some(n) = c.length {
                s.push_str(&format!("({})", n));
            }
            if c.desc {
                s.push_str(" DESC");
            }
            s
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn index_clause(idx: &IndexSpec) -> String {
    match idx.kind {
        IndexKind::Primary => format!("PRIMARY KEY ({})", index_columns_clause(&idx.columns)),
        IndexKind::Unique => format!(
            "UNIQUE KEY {} ({})",
            quote_ident(&idx.name),
            index_columns_clause(&idx.columns)
        ),
        IndexKind::Fulltext => format!(
            "FULLTEXT KEY {} ({})",
            quote_ident(&idx.name),
            index_columns_clause(&idx.columns)
        ),
        IndexKind::Spatial => format!(
            "SPATIAL KEY {} ({})",
            quote_ident(&idx.name),
            index_columns_clause(&idx.columns)
        ),
        IndexKind::Index => format!(
            "KEY {} ({})",
            quote_ident(&idx.name),
            index_columns_clause(&idx.columns)
        ),
    }
}

fn fk_clause(fk: &ForeignKeySpec) -> String {
    let cols = fk
        .columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_cols = fk
        .ref_columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_target = match &fk.ref_database {
        Some(db) => format!("{}.{}", quote_ident(db), quote_ident(&fk.ref_table)),
        None => quote_ident(&fk.ref_table),
    };
    format!(
        "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
        quote_ident(&fk.name),
        cols,
        ref_target,
        ref_cols,
        fk.on_delete.to_sql(),
        fk.on_update.to_sql()
    )
}

pub fn generate_create_sql(spec: &TableStructure) -> Result<String, String> {
    if spec.table.is_empty() {
        return Err("table name is empty".into());
    }
    if spec.columns.is_empty() {
        return Err("table must have at least one column".into());
    }
    let mut parts: Vec<String> = Vec::new();
    for c in &spec.columns {
        parts.push(column_clause(c));
    }
    for idx in &spec.indexes {
        parts.push(index_clause(idx));
    }
    for fk in &spec.foreign_keys {
        parts.push(fk_clause(fk));
    }
    let target = if spec.database.is_empty() {
        quote_ident(&spec.table)
    } else {
        format!("{}.{}", quote_ident(&spec.database), quote_ident(&spec.table))
    };
    let mut sql = format!(
        "CREATE TABLE {} (\n  {}\n)",
        target,
        parts.join(",\n  ")
    );
    if !spec.engine.is_empty() {
        sql.push_str(&format!(" ENGINE={}", spec.engine));
    }
    if !spec.charset.is_empty() {
        sql.push_str(&format!(" DEFAULT CHARSET={}", spec.charset));
    }
    if !spec.collation.is_empty() {
        sql.push_str(&format!(" COLLATE={}", spec.collation));
    }
    if let Some(c) = &spec.comment {
        if !c.is_empty() {
            sql.push_str(&format!(" COMMENT={}", quote_string(c)));
        }
    }
    sql.push(';');
    Ok(sql)
}

pub fn generate_alter_sql(edit: &TableEdit) -> Result<AlterPlan, String> {
    let mut statements: Vec<String> = Vec::new();
    let mut risks: Vec<Risk> = Vec::new();

    let original = &edit.original;
    let modified = &edit.modified;

    let target = if original.database.is_empty() {
        quote_ident(&original.table)
    } else {
        format!(
            "{}.{}",
            quote_ident(&original.database),
            quote_ident(&original.table)
        )
    };

    let mut clauses: Vec<String> = Vec::new();

    let orig_by_name: std::collections::HashMap<&str, &ColumnSpec> = original
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();
    let mod_by_name: std::collections::HashMap<&str, &ColumnSpec> = modified
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();

    for c in &original.columns {
        if !mod_by_name.contains_key(c.name.as_str()) {
            clauses.push(format!("DROP COLUMN {}", quote_ident(&c.name)));
            risks.push(Risk {
                level: RiskLevel::Critical,
                kind: "data_loss".into(),
                message: format!("DROP COLUMN `{}` is irreversible", c.name),
            });
        }
    }

    // Index of each column in original, restricted to those still present in modified.
    // Use that to detect a relative-position change (a pure reorder must still emit MODIFY ...
    // AFTER, otherwise MySQL keeps the old layout).
    let mod_names: std::collections::HashSet<&str> = modified
        .columns
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    let surviving_pos: std::collections::HashMap<&str, usize> = original
        .columns
        .iter()
        .filter(|c| mod_names.contains(c.name.as_str()))
        .enumerate()
        .map(|(i, c)| (c.name.as_str(), i))
        .collect();

    let mut existing_idx_in_modified: usize = 0;
    for (i, c) in modified.columns.iter().enumerate() {
        let position_clause = if i == 0 {
            " FIRST".to_string()
        } else {
            format!(" AFTER {}", quote_ident(&modified.columns[i - 1].name))
        };
        match orig_by_name.get(c.name.as_str()) {
            None => {
                clauses.push(format!("ADD COLUMN {}{}", column_clause(c), position_clause));
                if !c.nullable && c.default_value.is_none() && !c.auto_increment {
                    risks.push(Risk {
                        level: RiskLevel::Warn,
                        kind: "not_null_no_default".into(),
                        message: format!(
                            "ADD COLUMN `{}` NOT NULL without DEFAULT will fail on non-empty table",
                            c.name
                        ),
                    });
                }
            }
            Some(orig) => {
                let pos_changed = surviving_pos.get(c.name.as_str()).copied()
                    != Some(existing_idx_in_modified);
                existing_idx_in_modified += 1;
                let spec_changed = *orig != c;
                if pos_changed || spec_changed {
                    let pos_suffix = if pos_changed {
                        position_clause.clone()
                    } else {
                        String::new()
                    };
                    clauses.push(format!(
                        "MODIFY COLUMN {}{}",
                        column_clause(c),
                        pos_suffix
                    ));
                    if spec_changed {
                        if types_narrowing(&orig.data_type, &c.data_type) {
                            risks.push(Risk {
                                level: RiskLevel::Critical,
                                kind: "narrowing".into(),
                                message: format!(
                                    "Column `{}` type narrowed ({} → {}): risk of data truncation",
                                    c.name, orig.data_type, c.data_type
                                ),
                            });
                        }
                        if orig.nullable && !c.nullable {
                            risks.push(Risk {
                                level: RiskLevel::Warn,
                                kind: "to_not_null".into(),
                                message: format!(
                                    "Column `{}` NULL → NOT NULL: existing NULL rows will fail",
                                    c.name
                                ),
                            });
                        }
                    }
                }
            }
        }
    }

    let orig_idx_names: std::collections::HashSet<&str> = original
        .indexes
        .iter()
        .map(|i| i.name.as_str())
        .collect();
    let mod_idx_names: std::collections::HashSet<&str> =
        modified.indexes.iter().map(|i| i.name.as_str()).collect();

    for idx in &original.indexes {
        if !mod_idx_names.contains(idx.name.as_str()) {
            if matches!(idx.kind, IndexKind::Primary) {
                clauses.push("DROP PRIMARY KEY".into());
            } else {
                clauses.push(format!("DROP INDEX {}", quote_ident(&idx.name)));
            }
        }
    }
    for idx in &modified.indexes {
        match original.indexes.iter().find(|o| o.name == idx.name) {
            None => {
                clauses.push(format!("ADD {}", index_clause(idx)));
            }
            Some(orig) if orig != idx => {
                if matches!(idx.kind, IndexKind::Primary) {
                    clauses.push("DROP PRIMARY KEY".into());
                } else {
                    clauses.push(format!("DROP INDEX {}", quote_ident(&idx.name)));
                }
                clauses.push(format!("ADD {}", index_clause(idx)));
            }
            _ => {}
        }
    }
    let _ = orig_idx_names;

    let mod_fk_names: std::collections::HashSet<&str> = modified
        .foreign_keys
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    for fk in &original.foreign_keys {
        if !mod_fk_names.contains(fk.name.as_str()) {
            clauses.push(format!("DROP FOREIGN KEY {}", quote_ident(&fk.name)));
        }
    }
    for fk in &modified.foreign_keys {
        match original.foreign_keys.iter().find(|o| o.name == fk.name) {
            None => clauses.push(format!("ADD {}", fk_clause(fk))),
            Some(orig) if orig != fk => {
                clauses.push(format!("DROP FOREIGN KEY {}", quote_ident(&fk.name)));
                clauses.push(format!("ADD {}", fk_clause(fk)));
            }
            _ => {}
        }
    }

    if original.engine != modified.engine && !modified.engine.is_empty() {
        clauses.push(format!("ENGINE={}", modified.engine));
        risks.push(Risk {
            level: RiskLevel::Critical,
            kind: "rebuild".into(),
            message: format!(
                "ENGINE change ({} → {}) rebuilds the entire table",
                original.engine, modified.engine
            ),
        });
    }
    if original.charset != modified.charset && !modified.charset.is_empty() {
        clauses.push(format!("DEFAULT CHARSET={}", modified.charset));
    }
    if original.collation != modified.collation && !modified.collation.is_empty() {
        clauses.push(format!("COLLATE={}", modified.collation));
    }
    if original.comment != modified.comment {
        let c = modified.comment.clone().unwrap_or_default();
        clauses.push(format!("COMMENT={}", quote_string(&c)));
    }

    if !clauses.is_empty() {
        statements.push(format!("ALTER TABLE {}\n  {};", target, clauses.join(",\n  ")));
    }

    if let Some(new_name) = &edit.rename_to {
        if new_name != &original.table {
            let new_target = if original.database.is_empty() {
                quote_ident(new_name)
            } else {
                format!("{}.{}", quote_ident(&original.database), quote_ident(new_name))
            };
            statements.push(format!("RENAME TABLE {} TO {};", target, new_target));
        }
    }

    if statements.is_empty() {
        return Err("No changes to apply".into());
    }

    if !risks.iter().any(|r| matches!(r.level, RiskLevel::Critical)) {
        risks.push(Risk {
            level: RiskLevel::Info,
            kind: "implicit_commit".into(),
            message: "DDL statements in MySQL implicitly commit and cannot be rolled back".into(),
        });
    }

    let sql = statements.join("\n\n");
    Ok(AlterPlan {
        statements,
        sql,
        risks,
    })
}

fn extract_size(t: &str) -> Option<u64> {
    let lower = t.to_lowercase();
    let open = lower.find('(')?;
    let close = lower[open..].find(')')? + open;
    let inside = &lower[open + 1..close];
    inside
        .split(',')
        .next()
        .and_then(|s| s.trim().parse::<u64>().ok())
}

fn types_narrowing(old: &str, new: &str) -> bool {
    let o = old.to_lowercase();
    let n = new.to_lowercase();
    if o == n {
        return false;
    }
    let old_head = o.split('(').next().unwrap_or("").trim();
    let new_head = n.split('(').next().unwrap_or("").trim();
    if old_head == new_head {
        if let (Some(a), Some(b)) = (extract_size(&o), extract_size(&n)) {
            return b < a;
        }
        return false;
    }
    let rank = |head: &str| match head {
        "tinyint" => 1,
        "smallint" => 2,
        "mediumint" => 3,
        "int" | "integer" => 4,
        "bigint" => 5,
        _ => 0,
    };
    if rank(old_head) > 0 && rank(new_head) > 0 && rank(new_head) < rank(old_head) {
        return true;
    }
    let txt_rank = |head: &str| match head {
        "char" | "varchar" => 1,
        "tinytext" => 2,
        "text" => 3,
        "mediumtext" => 4,
        "longtext" => 5,
        _ => 0,
    };
    if txt_rank(old_head) > 0
        && txt_rank(new_head) > 0
        && txt_rank(new_head) < txt_rank(old_head)
    {
        return true;
    }
    false
}

#[derive(Debug, Serialize)]
pub struct ExecResult {
    pub statements_executed: usize,
    pub elapsed_ms: u64,
}

pub async fn execute_ddl(pool: &MySqlPool, sql: &str) -> Result<ExecResult, String> {
    let started = std::time::Instant::now();
    let statements: Vec<&str> = sql
        .split(';')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let count = statements.len();
    for stmt in statements {
        sqlx::query(stmt)
            .execute(pool)
            .await
            .map_err(|e| format!("DDL failed at: {}\n{}", stmt, e))?;
    }
    Ok(ExecResult {
        statements_executed: count,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

pub async fn drop_table(
    pool: &MySqlPool,
    database: &str,
    table: &str,
    confirm_token: &str,
) -> Result<ExecResult, String> {
    if confirm_token != table {
        return Err(format!(
            "Confirmation does not match table name. Type `{}` exactly to confirm.",
            table
        ));
    }
    let started = std::time::Instant::now();
    let target = if database.is_empty() {
        quote_ident(table)
    } else {
        format!("{}.{}", quote_ident(database), quote_ident(table))
    };
    let sql = format!("DROP TABLE {}", target);
    sqlx::query(&sql)
        .execute(pool)
        .await
        .map_err(|e| format!("DROP TABLE failed: {e}"))?;
    Ok(ExecResult {
        statements_executed: 1,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
