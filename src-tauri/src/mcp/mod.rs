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
    // Shared with the Tauri side so set_mcp_allowed_conns takes effect live.
    allowed_conn_ids: Arc<RwLock<Vec<i64>>>, // empty = allow all
}

pub async fn serve(
    port: u16,
    token: String,
    sqlite: SqlitePool,
    pools: Arc<Mutex<HashMap<i64, MySqlPool>>>,
    allowed_conn_ids: Arc<RwLock<Vec<i64>>>,
) -> Result<(), std::io::Error> {
    let ctx = ServerCtx {
        token: Arc::new(token),
        sqlite,
        pools,
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
            description: "List MySQL connections registered in Squire. Returns id, name, host, port, default database. Closed connections are also listed but cannot be queried until opened.",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        Tool {
            name: "list_databases",
            description: "List databases on a connection. Connection must be open (the user must have unlocked it in Squire).",
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
            description: "Describe a table: columns (name, type, nullable, default, key), indexes, and PII / AI semantic annotations Squire has gathered.",
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
    ]
}

async fn dispatch_tool(ctx: &ServerCtx, name: &str, args: Value) -> ToolCallResult {
    match name {
        "list_connections" => tool_list_connections(ctx).await,
        "list_databases" => tool_list_databases(ctx, args).await,
        "describe_table" => tool_describe_table(ctx, args).await,
        "query" => tool_query(ctx, args).await,
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
        let pools = ctx.pools.lock().await;
        pools.keys().copied().collect()
    };
    let snap = allowed_snapshot(ctx).await;

    let items: Vec<Value> = conns
        .into_iter()
        .filter(|c| c.kind == "mysql")
        .filter(|c| match c.id {
            Some(id) => allow_in(&snap, id),
            None => false,
        })
        .map(|c| {
            let id = c.id.unwrap_or_default();
            json!({
                "id": id,
                "name": c.name,
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
