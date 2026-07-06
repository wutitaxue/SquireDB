use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, Row};

/// A schema object that isn't a base table — surfaced in the schema tree under
/// per-type groups. Views are intentionally excluded: they already appear in
/// the table list (queryable like tables), so only the non-SELECTable object
/// types live here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbObject {
    pub name: String,
    /// Short descriptor shown after the name (e.g. trigger timing/event,
    /// routine return type, event status). Empty when there's nothing useful.
    pub detail: String,
}

/// Object types this module can list and show DDL for. Kept as a string on the
/// wire (matches the frontend group keys) and normalized here.
fn normalize_kind(kind: &str) -> Result<&'static str, String> {
    match kind.to_ascii_lowercase().as_str() {
        "procedure" => Ok("procedure"),
        "function" => Ok("function"),
        "trigger" => Ok("trigger"),
        "event" => Ok("event"),
        other => Err(format!("unknown object kind: {other}")),
    }
}

pub async fn list_objects(
    pool: &MySqlPool,
    database: &str,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let kind = normalize_kind(kind)?;
    let rows: Vec<(String, String)> = match kind {
        "procedure" | "function" => {
            let routine_type = if kind == "procedure" { "PROCEDURE" } else { "FUNCTION" };
            sqlx::query_as(
                "SELECT CAST(ROUTINE_NAME AS CHAR), \
                    CAST(COALESCE(DTD_IDENTIFIER, '') AS CHAR) \
                 FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? \
                 ORDER BY ROUTINE_NAME",
            )
            .bind(database)
            .bind(routine_type)
            .fetch_all(pool)
            .await
        }
        "trigger" => {
            sqlx::query_as(
                "SELECT CAST(TRIGGER_NAME AS CHAR), \
                    CAST(CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION, ' ON ', EVENT_OBJECT_TABLE) AS CHAR) \
                 FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = ? \
                 ORDER BY TRIGGER_NAME",
            )
            .bind(database)
            .fetch_all(pool)
            .await
        }
        "event" => {
            sqlx::query_as(
                "SELECT CAST(EVENT_NAME AS CHAR), \
                    CAST(CONCAT(STATUS, ' · ', EVENT_TYPE) AS CHAR) \
                 FROM information_schema.EVENTS \
                 WHERE EVENT_SCHEMA = ? \
                 ORDER BY EVENT_NAME",
            )
            .bind(database)
            .fetch_all(pool)
            .await
        }
        _ => unreachable!(),
    }
    .map_err(|e| format!("list {kind}s failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|(name, detail)| DbObject { name, detail })
        .collect())
}

/// Fetch the `CREATE …` statement for one object via `SHOW CREATE …`. The
/// column that carries the DDL differs per object type, so we read it by name.
pub async fn show_object_ddl(
    pool: &MySqlPool,
    database: &str,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let kind = normalize_kind(kind)?;
    let db = database.replace('`', "");
    let obj = name.replace('`', "");
    let (stmt, ddl_col) = match kind {
        "procedure" => (format!("SHOW CREATE PROCEDURE `{db}`.`{obj}`"), "Create Procedure"),
        "function" => (format!("SHOW CREATE FUNCTION `{db}`.`{obj}`"), "Create Function"),
        "trigger" => (format!("SHOW CREATE TRIGGER `{db}`.`{obj}`"), "SQL Original Statement"),
        "event" => (format!("SHOW CREATE EVENT `{db}`.`{obj}`"), "Create Event"),
        _ => unreachable!(),
    };
    let row = sqlx::query(&stmt)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("{stmt}: {e}"))?;
    row.try_get::<String, _>(ddl_col)
        .map_err(|e| format!("read DDL column '{ddl_col}': {e}"))
}
