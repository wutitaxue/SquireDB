// MCP HTTP server. Speaks JSON-RPC 2.0 over POST /mcp with Bearer auth.
//
// Lifecycle: launched at app startup if mcp_settings.enabled. Settings changes
// require app restart to take effect (v0.4.0.1 scope). The UI surfaces this.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::{MySqlPool, SqlitePool};
use tokio::sync::{Mutex, RwLock};

use crate::query;
use crate::sqlite_query;
use crate::storage;

mod protocol;
use protocol::*;

pub static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
pub static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

#[derive(Clone)]
struct ServerCtx {
    token: Arc<String>,
    sqlite: SqlitePool,
    pools: Arc<Mutex<HashMap<i64, MySqlPool>>>,
    // User SQLite connections (kind == "sqlite"). Distinct from `sqlite` above,
    // which is Squire's own metadata database.
    sqlite_pools: Arc<Mutex<HashMap<i64, SqlitePool>>>,
    // Shared with the Tauri side so set_mcp_allowed_conns takes effect live.
    allowed_conn_ids: Arc<RwLock<Vec<i64>>>, // empty = allow all
}

pub async fn serve(
    port: u16,
    token: String,
    sqlite: SqlitePool,
    pools: Arc<Mutex<HashMap<i64, MySqlPool>>>,
    sqlite_pools: Arc<Mutex<HashMap<i64, SqlitePool>>>,
    allowed_conn_ids: Arc<RwLock<Vec<i64>>>,
) -> Result<(), std::io::Error> {
    let ctx = ServerCtx {
        token: Arc::new(token),
        sqlite,
        pools,
        sqlite_pools,
        allowed_conn_ids,
    };

    let app = Router::new()
        .route("/mcp", post(handle_rpc))
        .layer(from_fn_with_state(ctx.clone(), auth_middleware))
        .with_state(ctx);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("[MCP] listening on http://127.0.0.1:{port}/mcp");
    SERVER_RUNNING.store(true, Ordering::SeqCst);
    SERVER_PORT.store(port, Ordering::SeqCst);

    let result = axum::serve(listener, app).await;

    SERVER_RUNNING.store(false, Ordering::SeqCst);
    SERVER_PORT.store(0, Ordering::SeqCst);
    result
}

async fn auth_middleware(
    State(ctx): State<ServerCtx>,
    headers: HeaderMap,
    req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let provided = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if provided.is_empty() || provided != ctx.token.as_str() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

async fn handle_rpc(
    State(ctx): State<ServerCtx>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    // Try parse as a single JsonRpcRequest. (Batch not supported in v0.4.0.1.)
    let req: JsonRpcRequest = match serde_json::from_value(body) {
        Ok(r) => r,
        Err(e) => {
            return Json(serde_json::to_value(err(
                Value::Null,
                E_PARSE,
                format!("parse error: {e}"),
            ))
            .unwrap());
        }
    };

    if req.jsonrpc != "2.0" {
        return Json(
            serde_json::to_value(err(
                req.id.unwrap_or(Value::Null),
                E_INVALID_REQ,
                "jsonrpc must be \"2.0\"",
            ))
            .unwrap(),
        );
    }

    let id = req.id.clone().unwrap_or(Value::Null);

    // Notifications have no id and expect no response. We still must return a
    // JSON body to axum; clients ignore it.
    let is_notification = req.id.is_none();

    let resp = match req.method.as_str() {
        "initialize" => Json(serde_json::to_value(ok(
            id.clone(),
            serde_json::to_value(InitializeResult {
                protocol_version: PROTOCOL_VERSION,
                capabilities: json!({ "tools": {} }),
                server_info: ServerInfo {
                    name: "squiredb",
                    version: env!("CARGO_PKG_VERSION"),
                },
            })
            .unwrap(),
        ))
        .unwrap()),
        "notifications/initialized" | "initialized" => {
            // No-op; return empty result so notification-respecting clients are fine.
            Json(serde_json::to_value(ok(id.clone(), json!({}))).unwrap())
        }
        "tools/list" => Json(
            serde_json::to_value(ok(
                id.clone(),
                serde_json::to_value(ToolsListResult { tools: tool_list() }).unwrap(),
            ))
            .unwrap(),
        ),
        "tools/call" => {
            let params: ToolsCallParams = match serde_json::from_value(req.params) {
                Ok(p) => p,
                Err(e) => {
                    return Json(
                        serde_json::to_value(err(
                            id,
                            E_INVALID_PARAMS,
                            format!("invalid params: {e}"),
                        ))
                        .unwrap(),
                    );
                }
            };
            let result = dispatch_tool(&ctx, &params.name, params.arguments).await;
            Json(serde_json::to_value(ok(id.clone(), serde_json::to_value(result).unwrap())).unwrap())
        }
        "ping" => Json(serde_json::to_value(ok(id.clone(), json!({}))).unwrap()),
        other => Json(
            serde_json::to_value(err(
                id.clone(),
                E_METHOD_NOT_FOUND,
                format!("unknown method: {other}"),
            ))
            .unwrap(),
        ),
    };

    if is_notification {
        Json(json!({})) // returning {} for notifications is benign
    } else {
        resp
    }
}

// ------------------------------------------------------------------- //
// Tool catalogue
// ------------------------------------------------------------------- //

fn tool_list() -> Vec<Tool> {
    vec![
        Tool {
            name: "list_connections",
            description: "List MySQL and SQLite connections registered in Squire. Returns id, name, kind (mysql|sqlite), host, port, default database. Closed connections are also listed but cannot be queried until opened.",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        Tool {
            name: "list_databases",
            description: "List databases on a connection. Connection must be open (the user must have unlocked it in Squire). SQLite connections have a single schema and always return [\"main\"].",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "connection_id": { "type": "integer", "description": "id from list_connections" }
                },
                "required": ["connection_id"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: "describe_table",
            description: "Describe a table: columns (name, type, nullable, default, key), indexes, and PII / AI semantic annotations Squire has gathered. For SQLite connections, pass database \"main\" (columns/indexes come from PRAGMA).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "connection_id": { "type": "integer" },
                    "database": { "type": "string" },
                    "table": { "type": "string" }
                },
                "required": ["connection_id", "database", "table"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: "query",
            description: "Run a read-only SQL statement. Only SELECT / SHOW / DESC[RIBE] / EXPLAIN / WITH are allowed. Results are capped at 1000 rows; if no LIMIT clause is present on a top-level SELECT, ' LIMIT 1000' is appended.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "connection_id": { "type": "integer" },
                    "sql": { "type": "string" }
                },
                "required": ["connection_id", "sql"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: "execute",
            description: "Run a single write statement (INSERT / UPDATE / DELETE) that MODIFIES data. Disabled by default: the user must turn off global read-only AND grant the specific (connection, database, operation) in Squire → Settings → MCP. The `database` argument names the target database and must be granted for the statement's operation. Only one statement is allowed; the target table may not be qualified to a different database. For SQLite connections use database \"main\". Returns rows_affected.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "connection_id": { "type": "integer", "description": "id from list_connections" },
                    "database": { "type": "string", "description": "target database; the write runs with this as the session default schema and must be granted in settings" },
                    "sql": { "type": "string", "description": "a single INSERT / UPDATE / DELETE statement" }
                },
                "required": ["connection_id", "database", "sql"],
                "additionalProperties": false
            }),
        },
    ]
}

async fn dispatch_tool(ctx: &ServerCtx, name: &str, args: Value) -> ToolCallResult {
    match name {
        "list_connections" => tool_list_connections(ctx).await,
        "list_databases" => tool_list_databases(ctx, args).await,
        "describe_table" => tool_describe_table(ctx, args).await,
        "query" => tool_query(ctx, args).await,
        "execute" => tool_execute(ctx, args).await,
        other => ToolCallResult::error(format!("unknown tool: {other}")),
    }
}

// ------------------------------------------------------------------- //
// Helpers
// ------------------------------------------------------------------- //

async fn allowed_snapshot(ctx: &ServerCtx) -> Vec<i64> {
    ctx.allowed_conn_ids.read().await.clone()
}

fn allow_in(snapshot: &[i64], id: i64) -> bool {
    snapshot.is_empty() || snapshot.contains(&id)
}

async fn pool_for(ctx: &ServerCtx, id: i64) -> Result<MySqlPool, String> {
    let snap = allowed_snapshot(ctx).await;
    if !allow_in(&snap, id) {
        return Err(format!(
            "connection {id} is not on the MCP allowlist (configure in Squire → Settings → MCP)"
        ));
    }
    let pools = ctx.pools.lock().await;
    pools
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("connection {id} is not open in Squire — ask the user to open it"))
}

/// Look up a user SQLite connection's pool, subject to the same allowlist.
async fn sqlite_pool_for(ctx: &ServerCtx, id: i64) -> Result<SqlitePool, String> {
    let snap = allowed_snapshot(ctx).await;
    if !allow_in(&snap, id) {
        return Err(format!(
            "connection {id} is not on the MCP allowlist (configure in Squire → Settings → MCP)"
        ));
    }
    let pools = ctx.sqlite_pools.lock().await;
    pools
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("connection {id} is not open in Squire — ask the user to open it"))
}

/// Read a connection's kind ("mysql" / "sqlite" / …) from the metadata DB.
/// Used to dispatch tools that behave differently per data source.
async fn conn_kind(ctx: &ServerCtx, id: i64) -> Result<String, String> {
    storage::connection::get_by_id(&ctx.sqlite, id)
        .await
        .map(|c| c.kind)
        .map_err(|e| format!("connection {id} lookup failed: {e}"))
}

fn json_payload(value: Value) -> ToolCallResult {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    ToolCallResult::text(text)
}

// ------------------------------------------------------------------- //
// Tool: list_connections
// ------------------------------------------------------------------- //

async fn tool_list_connections(ctx: &ServerCtx) -> ToolCallResult {
    let conns = match storage::connection::list_all(&ctx.sqlite).await {
        Ok(v) => v,
        Err(e) => return ToolCallResult::error(format!("list_connections failed: {e}")),
    };

    let open_ids: std::collections::HashSet<i64> = {
        let mysql = ctx.pools.lock().await;
        let sqlite = ctx.sqlite_pools.lock().await;
        mysql.keys().copied().chain(sqlite.keys().copied()).collect()
    };
    let snap = allowed_snapshot(ctx).await;

    let items: Vec<Value> = conns
        .into_iter()
        .filter(|c| c.kind == "mysql" || c.kind == "sqlite")
        .filter(|c| match c.id {
            Some(id) => allow_in(&snap, id),
            None => false,
        })
        .map(|c| {
            let id = c.id.unwrap_or_default();
            json!({
                "id": id,
                "name": c.name,
                "kind": c.kind,
                "host": c.host,
                "port": c.port,
                "default_database": c.database,
                "open": open_ids.contains(&id),
            })
        })
        .collect();

    json_payload(json!({ "connections": items }))
}

// ------------------------------------------------------------------- //
// Tool: list_databases
// ------------------------------------------------------------------- //

#[derive(serde::Deserialize)]
struct ListDbArgs {
    connection_id: i64,
}

async fn tool_list_databases(ctx: &ServerCtx, args: Value) -> ToolCallResult {
    let args: ListDbArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => return ToolCallResult::error(format!("bad arguments: {e}")),
    };

    // SQLite has no multi-database concept — one file is one schema ("main").
    match conn_kind(ctx, args.connection_id).await {
        Ok(k) if k == "sqlite" => {
            if let Err(e) = sqlite_pool_for(ctx, args.connection_id).await {
                return ToolCallResult::error(e);
            }
            return json_payload(json!({ "databases": ["main"] }));
        }
        Ok(_) => {}
        Err(e) => return ToolCallResult::error(e),
    }

    let pool = match pool_for(ctx, args.connection_id).await {
        Ok(p) => p,
        Err(e) => return ToolCallResult::error(e),
    };

    let result = match query::execute(&pool, "SHOW DATABASES").await {
        Ok(r) => r,
        Err(e) => return ToolCallResult::error(format!("SHOW DATABASES failed: {e}")),
    };

    let mut names: Vec<String> = result
        .rows
        .iter()
        .filter_map(|r| r.first().and_then(|v| v.as_str().map(str::to_string)))
        .collect();
    names.retain(|n| {
        !matches!(
            n.as_str(),
            "information_schema" | "performance_schema" | "mysql" | "sys"
        )
    });
    json_payload(json!({ "databases": names }))
}

// ------------------------------------------------------------------- //
// Tool: describe_table
// ------------------------------------------------------------------- //

#[derive(serde::Deserialize)]
struct DescribeArgs {
    connection_id: i64,
    database: String,
    table: String,
}

async fn tool_describe_table(ctx: &ServerCtx, args: Value) -> ToolCallResult {
    let args: DescribeArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => return ToolCallResult::error(format!("bad arguments: {e}")),
    };

    if !is_safe_ident(&args.database) || !is_safe_ident(&args.table) {
        return ToolCallResult::error("database / table must be a simple identifier");
    }

    // SQLite: describe via PRAGMA. Uses its own pool; no db qualifier.
    match conn_kind(ctx, args.connection_id).await {
        Ok(k) if k == "sqlite" => {
            let pool = match sqlite_pool_for(ctx, args.connection_id).await {
                Ok(p) => p,
                Err(e) => return ToolCallResult::error(e),
            };
            let cols = sqlite_query::execute(
                &pool,
                &format!("PRAGMA table_info(`{}`)", args.table.replace('`', "``")),
            )
            .await;
            let idx = sqlite_query::execute(
                &pool,
                &format!("PRAGMA index_list(`{}`)", args.table.replace('`', "``")),
            )
            .await;
            let columns_json = match cols {
                Ok(r) => rows_to_records(&r),
                Err(e) => return ToolCallResult::error(format!("PRAGMA table_info failed: {e}")),
            };
            let indexes_json = match idx {
                Ok(r) => rows_to_records(&r),
                Err(e) => return ToolCallResult::error(format!("PRAGMA index_list failed: {e}")),
            };
            return json_payload(json!({
                "database": "main",
                "table": args.table,
                "columns": columns_json,
                "indexes": indexes_json,
                "annotations": [],
            }));
        }
        Ok(_) => {}
        Err(e) => return ToolCallResult::error(e),
    }

    let pool = match pool_for(ctx, args.connection_id).await {
        Ok(p) => p,
        Err(e) => return ToolCallResult::error(e),
    };

    let qref = format!("`{}`.`{}`", args.database, args.table);

    let columns_res = query::execute(&pool, &format!("SHOW FULL COLUMNS FROM {qref}")).await;
    let indexes_res = query::execute(&pool, &format!("SHOW INDEX FROM {qref}")).await;

    let columns_json = match columns_res {
        Ok(r) => rows_to_records(&r),
        Err(e) => return ToolCallResult::error(format!("SHOW COLUMNS failed: {e}")),
    };
    let indexes_json = match indexes_res {
        Ok(r) => rows_to_records(&r),
        Err(e) => return ToolCallResult::error(format!("SHOW INDEX failed: {e}")),
    };

    // Annotations (PII / AI comments) are best-effort; missing is fine.
    let annotations = storage::annotation::list(&ctx.sqlite, args.connection_id, Some(&args.database))
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.table_name == args.table)
        .map(|a| {
            json!({
                "column": a.column_name,
                "semantic_role": a.semantic_role,
                "pii_type": a.pii_type,
                "ai_comment": a.ai_comment,
            })
        })
        .collect::<Vec<_>>();

    json_payload(json!({
        "database": args.database,
        "table": args.table,
        "columns": columns_json,
        "indexes": indexes_json,
        "annotations": annotations,
    }))
}

fn rows_to_records(result: &query::QueryResult) -> Vec<Value> {
    let names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
    result
        .rows
        .iter()
        .map(|row| {
            let mut obj = serde_json::Map::new();
            for (i, n) in names.iter().enumerate() {
                obj.insert((*n).to_string(), row.get(i).cloned().unwrap_or(Value::Null));
            }
            Value::Object(obj)
        })
        .collect()
}

fn is_safe_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 100
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

// ------------------------------------------------------------------- //
// Tool: query
// ------------------------------------------------------------------- //

const HARD_ROW_CAP: usize = 1000;

#[derive(serde::Deserialize)]
struct QueryArgs {
    connection_id: i64,
    sql: String,
}

async fn tool_query(ctx: &ServerCtx, args: Value) -> ToolCallResult {
    let args: QueryArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => return ToolCallResult::error(format!("bad arguments: {e}")),
    };

    let sql = args.sql.trim().trim_end_matches(';').to_string();
    if sql.is_empty() {
        return ToolCallResult::error("sql is empty");
    }

    let first = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    let allowed = matches!(
        first.as_str(),
        "select" | "show" | "desc" | "describe" | "explain" | "with"
    );
    if !allowed {
        return ToolCallResult::error(format!(
            "only SELECT / SHOW / DESC[RIBE] / EXPLAIN / WITH are allowed in MCP query (got: {first})"
        ));
    }

    let augmented = inject_limit(&sql, HARD_ROW_CAP, &first);

    // SQLite reads run on the user SQLite pool.
    match conn_kind(ctx, args.connection_id).await {
        Ok(k) if k == "sqlite" => {
            let pool = match sqlite_pool_for(ctx, args.connection_id).await {
                Ok(p) => p,
                Err(e) => return ToolCallResult::error(e),
            };
            let result = match sqlite_query::execute(&pool, &augmented).await {
                Ok(r) => r,
                Err(e) => return ToolCallResult::error(format!("query failed: {e}")),
            };
            let truncated = result.rows.len() >= HARD_ROW_CAP;
            let records = rows_to_records(&result);
            return json_payload(json!({
                "columns": result.columns.iter().map(|c| json!({"name": c.name, "type": c.type_name})).collect::<Vec<_>>(),
                "rows": records,
                "row_count": result.rows.len(),
                "elapsed_ms": result.elapsed_ms,
                "truncated": truncated,
                "effective_sql": augmented,
            }));
        }
        Ok(_) => {}
        Err(e) => return ToolCallResult::error(e),
    }

    let pool = match pool_for(ctx, args.connection_id).await {
        Ok(p) => p,
        Err(e) => return ToolCallResult::error(e),
    };

    let result = match query::execute(&pool, &augmented).await {
        Ok(r) => r,
        Err(e) => return ToolCallResult::error(format!("query failed: {e}")),
    };

    let truncated = result.rows.len() >= HARD_ROW_CAP;
    let records = rows_to_records(&result);

    json_payload(json!({
        "columns": result.columns.iter().map(|c| json!({"name": c.name, "type": c.type_name})).collect::<Vec<_>>(),
        "rows": records,
        "row_count": result.rows.len(),
        "elapsed_ms": result.elapsed_ms,
        "truncated": truncated,
        "effective_sql": augmented,
    }))
}

// ------------------------------------------------------------------- //
// Tool: execute (writes — INSERT / UPDATE / DELETE, gated per database)
// ------------------------------------------------------------------- //

#[derive(serde::Deserialize)]
struct ExecuteArgs {
    connection_id: i64,
    database: String,
    sql: String,
}

async fn tool_execute(ctx: &ServerCtx, args: Value) -> ToolCallResult {
    let args: ExecuteArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => return ToolCallResult::error(format!("bad arguments: {e}")),
    };

    let sql = args.sql.trim().trim_end_matches(';').trim().to_string();
    if sql.is_empty() {
        return ToolCallResult::error("sql is empty");
    }
    let database = args.database.trim().to_string();
    if database.is_empty() {
        return ToolCallResult::error("database is required for execute");
    }

    // Reject multiple statements: after stripping the trailing ';', no ';'
    // that is not inside a string/identifier literal may remain.
    if contains_statement_separator(&sql) {
        return ToolCallResult::error(
            "only a single statement is allowed in execute (found ';' separating statements)",
        );
    }

    // Operation gate: first keyword must be a DML write.
    let first = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    let op = match first.as_str() {
        "insert" | "update" | "delete" => first.as_str(),
        _ => {
            return ToolCallResult::error(format!(
                "execute only accepts INSERT / UPDATE / DELETE (got: {first}); use the query tool for reads"
            ))
        }
    };

    // Permission gate: read the live settings from SQLite.
    let settings = match storage::mcp_settings::get(&ctx.sqlite).await {
        Ok(s) => s,
        Err(e) => return ToolCallResult::error(format!("read mcp settings: {e}")),
    };
    if settings.read_only {
        return ToolCallResult::error(
            "MCP is in read-only mode; writes are disabled. The user can turn this off in Squire → Settings → MCP.",
        );
    }
    let granted = settings.write_databases.iter().any(|p| {
        p.connection_id == args.connection_id
            && p.database.eq_ignore_ascii_case(&database)
            && p.ops.iter().any(|o| o.eq_ignore_ascii_case(op))
    });
    if !granted {
        return ToolCallResult::error(format!(
            "{op} on {database} (connection {}) is not granted for MCP; the user must grant it in Squire → Settings → MCP",
            args.connection_id
        ));
    }

    // SQLite writes: run directly on the user SQLite pool. SQLite has no
    // database qualifier / USE, so the cross-database guard doesn't apply; the
    // grant is expected to name the database "main".
    match conn_kind(ctx, args.connection_id).await {
        Ok(k) if k == "sqlite" => {
            let pool = match sqlite_pool_for(ctx, args.connection_id).await {
                Ok(p) => p,
                Err(e) => return ToolCallResult::error(e),
            };
            let result = match sqlite_query::execute(&pool, &sql).await {
                Ok(r) => r,
                Err(e) => return ToolCallResult::error(format!("execute failed: {e}")),
            };
            return json_payload(json!({
                "operation": op,
                "database": database,
                "rows_affected": result.rows_affected.unwrap_or(0),
                "elapsed_ms": result.elapsed_ms,
                "executed_sql": sql,
            }));
        }
        Ok(_) => {}
        Err(e) => return ToolCallResult::error(e),
    }

    // Cross-database guard: the primary write target may not be qualified to a
    // database other than the granted one.
    if let Some(target_db) = write_target_database(&sql, op) {
        if !target_db.eq_ignore_ascii_case(&database) {
            return ToolCallResult::error(format!(
                "statement targets database `{target_db}` but only `{database}` is granted; qualify the table with the granted database or omit the qualifier"
            ));
        }
    }

    let pool = match pool_for(ctx, args.connection_id).await {
        Ok(p) => p,
        Err(e) => return ToolCallResult::error(e),
    };

    // Scope the write to the granted database: acquire one connection, set its
    // default schema, then run the statement on that same connection.
    let mut conn = match pool.acquire().await {
        Ok(c) => c,
        Err(e) => return ToolCallResult::error(format!("acquire connection: {e}")),
    };
    // `USE` is rejected by the MySQL prepared-statement protocol (error 1295),
    // which some RDS builds enforce strictly. Run it via the text protocol by
    // handing the raw &str to the executor (this is COM_QUERY, not a prepare).
    let use_stmt = format!("USE `{}`", database.replace('`', "``"));
    if let Err(e) = sqlx::Executor::execute(&mut *conn, use_stmt.as_str()).await {
        return ToolCallResult::error(format!("USE {database} failed: {e}"));
    }
    let result = match query::execute_on_conn(&mut conn, &sql).await {
        Ok(r) => r,
        Err(e) => return ToolCallResult::error(format!("execute failed: {e}")),
    };

    json_payload(json!({
        "operation": op,
        "database": database,
        "rows_affected": result.rows_affected.unwrap_or(0),
        "elapsed_ms": result.elapsed_ms,
        "executed_sql": sql,
    }))
}

/// True if the SQL text contains a `;` that separates statements (i.e. a `;`
/// outside of string / backtick-identifier literals). The caller has already
/// stripped a single trailing `;`.
fn contains_statement_separator(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut in_str: Option<u8> = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = in_str {
            if c == q && bytes.get(i.saturating_sub(1)).copied() != Some(b'\\') {
                in_str = None;
            }
        } else if c == b'\'' || c == b'"' || c == b'`' {
            in_str = Some(c);
        } else if c == b';' {
            return true;
        }
        i += 1;
    }
    false
}

/// Extract the database qualifier of the primary write target, if the target
/// table is written as `db.table` / `` `db`.`table` ``. Returns None when the
/// target is unqualified (which is the common, safe case). Only inspects the
/// token that names the target table (after INSERT [INTO] / UPDATE / DELETE
/// FROM); column qualifiers elsewhere are intentionally ignored.
fn write_target_database(sql: &str, op: &str) -> Option<String> {
    let toks: Vec<&str> = sql.split_whitespace().collect();
    let target_tok = match op {
        "insert" => {
            // INSERT [LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE]* [INTO] <target>
            let skip = ["insert", "into", "ignore", "low_priority", "delayed", "high_priority"];
            toks.iter()
                .find(|t| !skip.contains(&t.to_lowercase().as_str()))
                .copied()
        }
        "update" => {
            let skip = ["update", "low_priority", "ignore"];
            toks.iter()
                .find(|t| !skip.contains(&t.to_lowercase().as_str()))
                .copied()
        }
        "delete" => {
            // DELETE ... FROM <target>
            let idx = toks.iter().position(|t| t.eq_ignore_ascii_case("from"))?;
            toks.get(idx + 1).copied()
        }
        _ => None,
    }?;

    // Take the part before any '(' (e.g. `db.t(col)`), then split the db
    // qualifier off `db.table`.
    let cleaned = target_tok.split('(').next().unwrap_or(target_tok).trim();
    if !cleaned.contains('.') {
        return None;
    }
    let db_part = cleaned.split('.').next()?.trim().trim_matches('`');
    if db_part.is_empty() {
        None
    } else {
        Some(db_part.to_string())
    }
}

// Append ` LIMIT N` only for top-level SELECT/WITH that don't already have one.
// SHOW / DESC / EXPLAIN return naturally bounded result sets — leave alone.
fn inject_limit(sql: &str, cap: usize, first_word: &str) -> String {
    if !matches!(first_word, "select" | "with") {
        return sql.to_string();
    }
    if has_top_level_limit(sql) {
        return sql.to_string();
    }
    format!("{} LIMIT {}", sql, cap)
}

fn has_top_level_limit(sql: &str) -> bool {
    // Conservative: only skips injection when the lowercased text contains
    // the word "limit" preceded by whitespace, not inside a string literal.
    // Good enough for the read-only path — a false positive only means we
    // skip the cap on an already-bounded query.
    let lower = sql.to_lowercase();
    let bytes = lower.as_bytes();
    let mut in_str: Option<u8> = None;
    let mut i = 0;
    while i + 5 <= bytes.len() {
        let c = bytes[i];
        if let Some(q) = in_str {
            if c == q && bytes.get(i.saturating_sub(1)).copied() != Some(b'\\') {
                in_str = None;
            }
            i += 1;
            continue;
        }
        if c == b'\'' || c == b'"' || c == b'`' {
            in_str = Some(c);
            i += 1;
            continue;
        }
        if (c == b' ' || c == b'\n' || c == b'\t' || c == b'\r')
            && bytes.get(i + 1..i + 6) == Some(b"limit")
        {
            let after = bytes.get(i + 6).copied();
            if matches!(after, Some(b' ') | Some(b'\n') | Some(b'\t') | Some(b'\r')) || after.is_none() {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statement_separator_detection() {
        assert!(!contains_statement_separator("DELETE FROM t WHERE id = 1"));
        assert!(contains_statement_separator("DELETE FROM t; DROP TABLE t"));
        // Semicolon inside a string literal is not a separator.
        assert!(!contains_statement_separator("UPDATE t SET name = 'a;b' WHERE id = 1"));
    }

    #[test]
    fn write_target_db_unqualified_is_none() {
        assert_eq!(write_target_database("INSERT INTO users (a) VALUES (1)", "insert"), None);
        assert_eq!(write_target_database("UPDATE users SET a = 1 WHERE id = 2", "update"), None);
        assert_eq!(write_target_database("DELETE FROM users WHERE id = 3", "delete"), None);
        // Column qualifier in WHERE must not be mistaken for a target db.
        assert_eq!(write_target_database("DELETE FROM users WHERE users.id = 3", "delete"), None);
    }

    #[test]
    fn write_target_db_qualified_is_detected() {
        assert_eq!(
            write_target_database("INSERT INTO shop.users (a) VALUES (1)", "insert"),
            Some("shop".to_string())
        );
        assert_eq!(
            write_target_database("UPDATE `shop`.`users` SET a = 1 WHERE id = 2", "update"),
            Some("shop".to_string())
        );
        assert_eq!(
            write_target_database("DELETE FROM shop.users WHERE id = 3", "delete"),
            Some("shop".to_string())
        );
        // No space before the column list.
        assert_eq!(
            write_target_database("INSERT INTO shop.users(a) VALUES (1)", "insert"),
            Some("shop".to_string())
        );
    }
}
