mod agent;
mod ai;
mod analyze;
mod cache;
mod crypto;
mod ddl;
mod deadlock;
mod dictionary;
mod diff;
mod er;
mod drill;
mod embed;
mod health;
mod llm_log;
mod mcp;
mod milvus;
mod perf;
mod query;
mod redis_kind;
mod sqlite_query;
mod storage;
mod sync;

use serde::Serialize;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::{MySqlPool, SqlitePool};
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, State};
use tokio::sync::{Mutex, RwLock};

use query::QueryResult;
use storage::connection::Connection;
use storage::mcp_settings::McpSettings;

const DEFAULT_AI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_AI_MODEL: &str = "gpt-4o-mini";
const DEFAULT_EMBEDDING_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";

struct AppState {
    sqlite: SqlitePool,
    active_pools: Arc<Mutex<HashMap<i64, MySqlPool>>>,
    active_milvus: Mutex<HashMap<i64, milvus::MilvusClient>>,
    active_sqlite: Mutex<HashMap<i64, SqlitePool>>,
    active_redis: Mutex<HashMap<i64, redis::aio::ConnectionManager>>,
    // query_token -> (connection_id, mysql_thread_id) for in-flight queries
    running_queries: Arc<Mutex<HashMap<String, (i64, u64)>>>,
    // Shared with the MCP server task so allowlist edits take effect live
    // without restarting Squire. Empty Vec means "allow all".
    mcp_allowed_conns: Arc<RwLock<Vec<i64>>>,
}

#[tauri::command]
async fn mysql_ping(
    host: String,
    port: u16,
    user: String,
    password: String,
    database: Option<String>,
) -> Result<String, String> {
    let mut options = MySqlConnectOptions::new()
        .host(&host)
        .port(port)
        .username(&user)
        .password(&password);

    if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
        options = options.database(db);
    }

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let (one,): (i64,) = sqlx::query_as("SELECT 1")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    Ok(format!("Connected. SELECT 1 → {one}"))
}

#[tauri::command]
async fn redis_ping(
    host: String,
    port: u16,
    user: String,
    password: String,
    db: u8,
) -> Result<String, String> {
    let mgr = redis_kind::build_manager(&host, port, &user, &password)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let resp = redis_kind::ping(&mgr, db).await?;
    Ok(format!("Connected. PING → {resp}"))
}

#[tauri::command]
async fn redis_scan(
    state: State<'_, AppState>,
    connection_id: i64,
    db: u8,
    pattern: String,
    cursor: u64,
    count: u32,
) -> Result<serde_json::Value, String> {
    let mgr = get_redis_manager(&state, connection_id).await?;
    let pat = if pattern.is_empty() { "*".to_string() } else { pattern };
    let (next, keys) = redis_kind::scan(&mgr, db, &pat, cursor, count).await?;
    Ok(serde_json::json!({ "cursor": next, "keys": keys }))
}

#[tauri::command]
async fn redis_get_value(
    state: State<'_, AppState>,
    connection_id: i64,
    db: u8,
    key: String,
) -> Result<redis_kind::KeyValue, String> {
    let mgr = get_redis_manager(&state, connection_id).await?;
    redis_kind::get_value(&mgr, db, &key).await
}

#[tauri::command]
async fn redis_exec(
    state: State<'_, AppState>,
    connection_id: i64,
    db: u8,
    command: String,
) -> Result<serde_json::Value, String> {
    let mgr = get_redis_manager(&state, connection_id).await?;
    redis_kind::exec_command(&mgr, db, &command).await
}

#[tauri::command]
async fn sqlite_ping(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("file path is empty".into());
    }
    if !std::path::Path::new(trimmed).exists() {
        return Err(format!("file does not exist: {trimmed}"));
    }
    let pool = sqlite_query::build_pool(trimmed)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let (one,): (i64,) = sqlx::query_as("SELECT 1")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("query failed: {e}"))?;
    pool.close().await;
    Ok(format!("Connected. SELECT 1 → {one}"))
}

#[tauri::command]
async fn list_connections(state: State<'_, AppState>) -> Result<Vec<Connection>, String> {
    storage::connection::list_all(&state.sqlite)
        .await
        .map_err(|e| format!("list_connections failed: {e}"))
}

#[tauri::command]
async fn save_connection(
    state: State<'_, AppState>,
    conn: Connection,
    password: String,
) -> Result<Connection, String> {
    let mut saved = conn.clone();
    let id = if let Some(existing_id) = conn.id {
        storage::connection::update(&state.sqlite, &conn)
            .await
            .map_err(|e| format!("update failed: {e}"))?;
        existing_id
    } else {
        let new_id = storage::connection::insert(&state.sqlite, &conn)
            .await
            .map_err(|e| format!("insert failed: {e}"))?;
        saved.id = Some(new_id);
        new_id
    };

    if !password.is_empty() {
        crypto::set_password(&state.sqlite, id, &password).await?;
    }

    Ok(saved)
}

#[tauri::command]
async fn delete_connection(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    // Close active pools first (MySQL, SQLite, Milvus, Redis)
    if let Some(pool) = state.active_pools.lock().await.remove(&id) {
        pool.close().await;
    }
    if let Some(pool) = state.active_sqlite.lock().await.remove(&id) {
        pool.close().await;
    }
    state.active_milvus.lock().await.remove(&id);
    state.active_redis.lock().await.remove(&id);
    storage::history::delete_by_connection(&state.sqlite, id)
        .await
        .map_err(|e| format!("delete history failed: {e}"))?;
    storage::annotation::delete_by_connection(&state.sqlite, id)
        .await
        .map_err(|e| format!("delete annotations failed: {e}"))?;
    storage::relation::delete_by_connection(&state.sqlite, id)
        .await
        .map_err(|e| format!("delete relations failed: {e}"))?;
    storage::project::unbind_connection(&state.sqlite, id)
        .await
        .map_err(|e| format!("unbind projects failed: {e}"))?;
    storage::connection::delete_by_id(&state.sqlite, id)
        .await
        .map_err(|e| format!("delete failed: {e}"))?;
    crypto::delete_password(&state.sqlite, id).await?;
    Ok(())
}

#[tauri::command]
async fn get_connection_password(state: State<'_, AppState>, id: i64) -> Result<String, String> {
    crypto::get_password(&state.sqlite, id).await
}

#[tauri::command]
async fn list_open_connection_ids(state: State<'_, AppState>) -> Result<Vec<i64>, String> {
    let mut ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for k in state.active_pools.lock().await.keys() {
        ids.insert(*k);
    }
    for k in state.active_milvus.lock().await.keys() {
        ids.insert(*k);
    }
    for k in state.active_sqlite.lock().await.keys() {
        ids.insert(*k);
    }
    for k in state.active_redis.lock().await.keys() {
        ids.insert(*k);
    }
    Ok(ids.into_iter().collect())
}

#[tauri::command]
async fn open_connection(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = storage::connection::get_by_id(&state.sqlite, id)
        .await
        .map_err(|e| format!("connection not found: {e}"))?;

    if conn.kind == "milvus" {
        if state.active_milvus.lock().await.contains_key(&id) {
            return Ok(());
        }
        let password = crypto::get_password(&state.sqlite, id).await?;
        let client = milvus::MilvusClient::new(
            &conn.host,
            conn.port as u16,
            &conn.username,
            &password,
            conn.database.as_deref(),
        )?;
        client
            .ping()
            .await
            .map_err(|e| format!("milvus connect failed: {e}"))?;
        state.active_milvus.lock().await.insert(id, client);
    } else if conn.kind == "sqlite" {
        if state.active_sqlite.lock().await.contains_key(&id) {
            return Ok(());
        }
        let path = conn.database.as_deref().unwrap_or("").trim().to_string();
        if path.is_empty() {
            return Err("sqlite connection has empty file path".into());
        }
        let pool = sqlite_query::build_pool(&path)
            .await
            .map_err(|e| format!("sqlite open failed: {e}"))?;
        state.active_sqlite.lock().await.insert(id, pool);
    } else if conn.kind == "redis" {
        if state.active_redis.lock().await.contains_key(&id) {
            return Ok(());
        }
        let password = crypto::get_password(&state.sqlite, id).await.unwrap_or_default();
        let mgr = redis_kind::build_manager(
            &conn.host,
            conn.port as u16,
            &conn.username,
            &password,
        )
        .await
        .map_err(|e| format!("redis connect failed: {e}"))?;
        state.active_redis.lock().await.insert(id, mgr);
    } else {
        if state.active_pools.lock().await.contains_key(&id) {
            return Ok(());
        }
        let password = crypto::get_password(&state.sqlite, id).await?;
        let pool = query::build_pool(
            &conn.host,
            conn.port as u16,
            &conn.username,
            &password,
            conn.database.as_deref(),
        )
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
        state.active_pools.lock().await.insert(id, pool);
    }

    storage::connection::touch_last_used(&state.sqlite, id)
        .await
        .ok();
    Ok(())
}

#[tauri::command]
async fn close_connection(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    if let Some(pool) = state.active_pools.lock().await.remove(&id) {
        pool.close().await;
    }
    if let Some(pool) = state.active_sqlite.lock().await.remove(&id) {
        pool.close().await;
    }
    state.active_milvus.lock().await.remove(&id);
    state.active_redis.lock().await.remove(&id);
    Ok(())
}

// ============================================================================
// Milvus commands
// ============================================================================

#[tauri::command]
async fn milvus_ping(
    host: String,
    port: u16,
    user: String,
    password: String,
    database: Option<String>,
) -> Result<String, String> {
    let client = milvus::MilvusClient::new(
        &host,
        port,
        &user,
        &password,
        database.as_deref(),
    )?;
    client.ping().await
}

async fn get_milvus_client(
    state: &State<'_, AppState>,
    id: i64,
) -> Result<milvus::MilvusClient, String> {
    state
        .active_milvus
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "Milvus connection not open. Click 'Open' first.".to_string())
}

#[tauri::command]
async fn milvus_list_collections(
    state: State<'_, AppState>,
    id: i64,
    db: Option<String>,
) -> Result<Vec<milvus::CollectionInfo>, String> {
    let client = get_milvus_client(&state, id).await?;
    let db_ref = db.as_deref().filter(|s| !s.is_empty());
    if db_ref.is_some() {
        client.list_collections_in(db_ref).await
    } else {
        client.list_collections().await
    }
}

#[tauri::command]
async fn milvus_list_databases(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Vec<String>, String> {
    let client = get_milvus_client(&state, id).await?;
    client.list_databases().await
}

#[tauri::command]
async fn milvus_describe_collection(
    state: State<'_, AppState>,
    id: i64,
    collection: String,
    db: Option<String>,
) -> Result<milvus::CollectionDescription, String> {
    let client = get_milvus_client(&state, id).await?;
    client
        .describe_collection_in(&collection, db.as_deref().filter(|s| !s.is_empty()))
        .await
}

#[tauri::command]
async fn milvus_search(
    state: State<'_, AppState>,
    id: i64,
    collection: String,
    vector: Vec<f64>,
    anns_field: Option<String>,
    limit: u32,
    filter: Option<String>,
    output_fields: Option<Vec<String>>,
    db: Option<String>,
) -> Result<milvus::SearchResponse, String> {
    let client = get_milvus_client(&state, id).await?;
    client
        .search(
            &collection,
            vector,
            anns_field.as_deref(),
            limit,
            filter.as_deref(),
            output_fields,
            db.as_deref().filter(|s| !s.is_empty()),
        )
        .await
}

#[tauri::command]
async fn milvus_query(
    state: State<'_, AppState>,
    id: i64,
    collection: String,
    filter: String,
    output_fields: Option<Vec<String>>,
    limit: u32,
    db: Option<String>,
) -> Result<milvus::QueryResponse, String> {
    let client = get_milvus_client(&state, id).await?;
    client
        .query(
            &collection,
            &filter,
            output_fields,
            limit,
            db.as_deref().filter(|s| !s.is_empty()),
        )
        .await
}

/// Wraps `query::execute_with_database` with cancel-token bookkeeping.
async fn run_with_database(
    host: String,
    port: u16,
    username: String,
    password: String,
    db: String,
    sql: String,
    conn_id: i64,
    query_token: Option<String>,
    running_queries: std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, (i64, u64)>>,
    >,
) -> Result<query::QueryResult, sqlx::Error> {
    let (tid_tx, tid_rx) = tokio::sync::oneshot::channel::<u64>();
    let register_token = query_token.clone();
    let register_running = running_queries.clone();
    // Register the thread_id for cancellation as soon as we learn it.
    tokio::spawn(async move {
        if let Ok(thread_id) = tid_rx.await {
            if let Some(token) = register_token {
                register_running
                    .lock()
                    .await
                    .insert(token, (conn_id, thread_id));
            }
        }
    });
    let r = query::execute_with_database(host, port, username, password, db, sql, tid_tx).await;
    if let Some(token) = query_token.as_ref() {
        running_queries.lock().await.remove(token);
    }
    r
}

#[tauri::command]
async fn execute_query(
    state: State<'_, AppState>,
    id: i64,
    sql: String,
    query_token: Option<String>,
    database: Option<String>,
) -> Result<QueryResult, String> {
    if is_sqlite(&state, id).await {
        let pool = get_sqlite_pool(&state, id).await?;
        let result = sqlite_query::execute(&pool, &sql).await;
        match &result {
            Ok(qr) => {
                let _ = storage::history::insert(
                    &state.sqlite,
                    id,
                    &sql,
                    Some(qr.elapsed_ms as i64),
                    qr.rows_affected.map(|n| n as i64),
                    Some(qr.rows.len() as i64),
                    None,
                )
                .await;
            }
            Err(e) => {
                let _ = storage::history::insert(
                    &state.sqlite,
                    id,
                    &sql,
                    None,
                    None,
                    None,
                    Some(&e.to_string()),
                )
                .await;
            }
        }
        return result.map_err(|e| format!("query failed: {e}"));
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "Connection not open. Click 'Open' first.".to_string())?;

    // When the caller picks a database for this query, we acquire a conn,
    // run `USE` on it via the text protocol (raw_sql), then run the user SQL.
    // The conn is then **detached** from the pool so the per-conn `USE`
    // side-effect doesn't leak to a future borrower. Without a database the
    // existing pool path is unchanged.
    let db_choice = database
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let result = if let Some(db) = db_choice.clone() {
        // Per-tab database picker: open a single-use connection scoped to
        // `db`. Cheap relative to the query itself but adds a handshake
        // round-trip per query; that's the price of not having to manage
        // `USE` session-state leakage in the shared pool.
        let creds = storage::connection::get_by_id(&state.sqlite, id)
            .await
            .map_err(|e| format!("connection lookup failed: {e}"))?;
        let password = crypto::get_password(&state.sqlite, id).await?;
        run_with_database(
            creds.host,
            creds.port as u16,
            creds.username,
            password,
            db,
            sql.clone(),
            id,
            query_token.clone(),
            state.running_queries.clone(),
        )
        .await
    } else if let Some(token) = query_token.as_ref() {
        let acquired = query::acquire_with_thread_id(&pool).await;
        match acquired {
            Ok((mut conn, thread_id)) => {
                state
                    .running_queries
                    .lock()
                    .await
                    .insert(token.clone(), (id, thread_id));
                let r = query::execute_on_conn(&mut conn, &sql).await;
                state.running_queries.lock().await.remove(token);
                r
            }
            Err(e) => Err(e),
        }
    } else {
        query::execute(&pool, &sql).await
    };

    match &result {
        Ok(qr) => {
            let _ = storage::history::insert(
                &state.sqlite,
                id,
                &sql,
                Some(qr.elapsed_ms as i64),
                qr.rows_affected.map(|n| n as i64),
                Some(qr.rows.len() as i64),
                None,
            )
            .await;
        }
        Err(e) => {
            let _ = storage::history::insert(
                &state.sqlite,
                id,
                &sql,
                None,
                None,
                None,
                Some(&e.to_string()),
            )
            .await;
        }
    }

    let mut qr = result.map_err(|e| format!("query failed: {e}"))?;
    // Only SELECT-style results carry columns; for them, decide if the
    // result-set is mutable (single-table, PK present in projection).
    if !qr.columns.is_empty() {
        qr.editable = query::resolve_editable(&pool, &sql, &qr.columns).await;
    }
    Ok(qr)
}

#[tauri::command]
async fn cancel_query(
    state: State<'_, AppState>,
    query_token: String,
) -> Result<(), String> {
    let mapping = state
        .running_queries
        .lock()
        .await
        .get(&query_token)
        .cloned();
    let (conn_id, thread_id) = match mapping {
        Some(v) => v,
        None => return Err("Query is not running (already finished or never started)".to_string()),
    };
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    sqlx::query(&format!("KILL QUERY {}", thread_id))
        .execute(&pool)
        .await
        .map_err(|e| format!("KILL QUERY failed: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
struct MutationResult {
    rows_affected: u64,
    sql: String,
    last_insert_id: Option<u64>,
}

#[derive(serde::Deserialize)]
struct ColumnValue {
    column: String,
    value: serde_json::Value,
}

fn quote_ident(name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('`') || name.contains('\0') {
        return Err(format!("invalid identifier: {name}"));
    }
    Ok(format!("`{name}`"))
}

fn bind_value<'q>(
    q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    v: &'q serde_json::Value,
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    match v {
        serde_json::Value::Null => q.bind(Option::<String>::None),
        serde_json::Value::Bool(b) => q.bind(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else if let Some(u) = n.as_u64() {
                q.bind(u as i64)
            } else if let Some(f) = n.as_f64() {
                q.bind(f)
            } else {
                q.bind(n.to_string())
            }
        }
        serde_json::Value::String(s) => q.bind(s.as_str()),
        // arrays / objects — fall back to JSON string, MySQL JSON columns
        // accept this and string columns store the literal.
        _ => q.bind(v.to_string()),
    }
}

fn render_value_preview(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        _ => format!("'{}'", v.to_string().replace('\'', "''")),
    }
}

#[tauri::command]
async fn update_cell(
    state: State<'_, AppState>,
    connection_id: i64,
    schema: String,
    table: String,
    pk: Vec<ColumnValue>,
    column: String,
    value: serde_json::Value,
) -> Result<MutationResult, String> {
    if pk.is_empty() {
        return Err("primary key payload is empty".to_string());
    }
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let q_schema = quote_ident(&schema)?;
    let q_table = quote_ident(&table)?;
    let q_col = quote_ident(&column)?;
    let mut where_parts = Vec::with_capacity(pk.len());
    for p in &pk {
        where_parts.push(format!("{} = ?", quote_ident(&p.column)?));
    }
    let sql = format!(
        "UPDATE {}.{} SET {} = ? WHERE {}",
        q_schema,
        q_table,
        q_col,
        where_parts.join(" AND ")
    );

    let preview_sql = format!(
        "UPDATE {}.{} SET {} = {} WHERE {}",
        q_schema,
        q_table,
        q_col,
        render_value_preview(&value),
        pk.iter()
            .map(|p| format!(
                "{} = {}",
                quote_ident(&p.column).unwrap_or_default(),
                render_value_preview(&p.value)
            ))
            .collect::<Vec<_>>()
            .join(" AND ")
    );

    let mut q = sqlx::query(&sql);
    q = bind_value(q, &value);
    for p in &pk {
        q = bind_value(q, &p.value);
    }
    let res = q
        .execute(&pool)
        .await
        .map_err(|e| format!("update_cell failed: {e}"))?;

    Ok(MutationResult {
        rows_affected: res.rows_affected(),
        sql: preview_sql,
        last_insert_id: None,
    })
}

#[tauri::command]
async fn insert_row(
    state: State<'_, AppState>,
    connection_id: i64,
    schema: String,
    table: String,
    values: Vec<ColumnValue>,
) -> Result<MutationResult, String> {
    if values.is_empty() {
        return Err("at least one column value is required".to_string());
    }
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let q_schema = quote_ident(&schema)?;
    let q_table = quote_ident(&table)?;
    let cols_quoted: Vec<String> = values
        .iter()
        .map(|c| quote_ident(&c.column))
        .collect::<Result<_, _>>()?;
    let placeholders: Vec<&str> = values.iter().map(|_| "?").collect();
    let sql = format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        q_schema,
        q_table,
        cols_quoted.join(", "),
        placeholders.join(", ")
    );
    let preview_sql = format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        q_schema,
        q_table,
        cols_quoted.join(", "),
        values
            .iter()
            .map(|c| render_value_preview(&c.value))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let mut q = sqlx::query(&sql);
    for c in &values {
        q = bind_value(q, &c.value);
    }
    let res = q
        .execute(&pool)
        .await
        .map_err(|e| format!("insert_row failed: {e}"))?;

    let last_insert_id = if res.last_insert_id() == 0 {
        None
    } else {
        Some(res.last_insert_id())
    };
    Ok(MutationResult {
        rows_affected: res.rows_affected(),
        sql: preview_sql,
        last_insert_id,
    })
}

#[tauri::command]
async fn delete_rows(
    state: State<'_, AppState>,
    connection_id: i64,
    schema: String,
    table: String,
    pks: Vec<Vec<ColumnValue>>,
) -> Result<MutationResult, String> {
    if pks.is_empty() {
        return Err("no rows to delete".to_string());
    }
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let q_schema = quote_ident(&schema)?;
    let q_table = quote_ident(&table)?;

    // Build (col1 = ? AND col2 = ?) OR (col1 = ? AND col2 = ?) ...
    let mut row_clauses = Vec::with_capacity(pks.len());
    let mut preview_row_clauses = Vec::with_capacity(pks.len());
    for row_pk in &pks {
        if row_pk.is_empty() {
            return Err("empty PK in delete payload".to_string());
        }
        let parts: Vec<String> = row_pk
            .iter()
            .map(|p| quote_ident(&p.column).map(|q| format!("{} = ?", q)))
            .collect::<Result<_, _>>()?;
        row_clauses.push(format!("({})", parts.join(" AND ")));
        let preview_parts: Vec<String> = row_pk
            .iter()
            .map(|p| {
                format!(
                    "{} = {}",
                    quote_ident(&p.column).unwrap_or_default(),
                    render_value_preview(&p.value)
                )
            })
            .collect();
        preview_row_clauses.push(format!("({})", preview_parts.join(" AND ")));
    }

    let sql = format!(
        "DELETE FROM {}.{} WHERE {}",
        q_schema,
        q_table,
        row_clauses.join(" OR ")
    );
    let preview_sql = format!(
        "DELETE FROM {}.{} WHERE {}",
        q_schema,
        q_table,
        preview_row_clauses.join(" OR ")
    );

    let mut q = sqlx::query(&sql);
    for row_pk in &pks {
        for p in row_pk {
            q = bind_value(q, &p.value);
        }
    }
    let res = q
        .execute(&pool)
        .await
        .map_err(|e| format!("delete_rows failed: {e}"))?;

    Ok(MutationResult {
        rows_affected: res.rows_affected(),
        sql: preview_sql,
        last_insert_id: None,
    })
}

#[tauri::command]
async fn list_history(
    state: State<'_, AppState>,
    connection_id: i64,
    limit: i64,
) -> Result<Vec<storage::history::HistoryEntry>, String> {
    storage::history::list(&state.sqlite, connection_id, limit)
        .await
        .map_err(|e| format!("list_history failed: {e}"))
}

/// Tiny dispatcher: is this connection a Milvus client?
async fn is_milvus(state: &State<'_, AppState>, id: i64) -> bool {
    state.active_milvus.lock().await.contains_key(&id)
}

async fn is_sqlite(state: &State<'_, AppState>, id: i64) -> bool {
    state.active_sqlite.lock().await.contains_key(&id)
}

async fn get_sqlite_pool(state: &State<'_, AppState>, id: i64) -> Result<SqlitePool, String> {
    state
        .active_sqlite
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "SQLite connection not open. Click 'Open' first.".to_string())
}

#[allow(dead_code)]
async fn is_redis(state: &State<'_, AppState>, id: i64) -> bool {
    state.active_redis.lock().await.contains_key(&id)
}

async fn get_redis_manager(
    state: &State<'_, AppState>,
    id: i64,
) -> Result<redis::aio::ConnectionManager, String> {
    state
        .active_redis
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "Redis connection not open. Click 'Open' first.".to_string())
}

#[tauri::command]
async fn list_databases(state: State<'_, AppState>, id: i64) -> Result<Vec<String>, String> {
    if is_milvus(&state, id).await {
        let client = get_milvus_client(&state, id).await?;
        return client.list_databases().await;
    }

    if is_sqlite(&state, id).await {
        // SQLite has a single schema per file; expose it as "main" to fit the
        // existing two-level (database → table) tree shape.
        return Ok(vec!["main".to_string()]);
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("list_databases failed: {e}"))?;

    Ok(rows.into_iter().map(|(s,)| s).collect())
}

#[tauri::command]
async fn list_tables(
    state: State<'_, AppState>,
    id: i64,
    database: String,
) -> Result<Vec<String>, String> {
    if is_milvus(&state, id).await {
        let client = get_milvus_client(&state, id).await?;
        let cols = client
            .list_collections_in(Some(database.as_str()).filter(|s| !s.is_empty()))
            .await?;
        return Ok(cols.into_iter().map(|c| c.name).collect());
    }

    if is_sqlite(&state, id).await {
        let pool = get_sqlite_pool(&state, id).await?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master \
             WHERE type IN ('table', 'view') \
             AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("list_tables failed: {e}"))?;
        return Ok(rows.into_iter().map(|(s,)| s).collect());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT CAST(TABLE_NAME AS CHAR) FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
    )
    .bind(&database)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("list_tables failed: {e}"))?;

    Ok(rows.into_iter().map(|(s,)| s).collect())
}

const DEFAULT_EMBEDDING_PROVIDER: &str = "openai";

#[derive(Serialize)]
struct AiModelView {
    id: i64,
    name: String,
    base_url: String,
    model: String,
    enable_thinking: Option<bool>,
    has_api_key: bool,
    is_active: bool,
}

#[tauri::command]
async fn list_ai_models(state: State<'_, AppState>) -> Result<Vec<AiModelView>, String> {
    let active = active_ai_model_id(&state.sqlite).await?;
    let rows = storage::ai_models::list_all(&state.sqlite)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for m in rows {
        let id = m.id.unwrap_or(0);
        let has_api_key = crypto::has_ai_model_key(&state.sqlite, id).await;
        out.push(AiModelView {
            id,
            name: m.name,
            base_url: m.base_url,
            model: m.model,
            enable_thinking: m.enable_thinking.map(|v| v != 0),
            has_api_key,
            is_active: active == Some(id),
        });
    }
    Ok(out)
}

#[tauri::command]
async fn create_ai_model(
    state: State<'_, AppState>,
    name: String,
    base_url: String,
    model: String,
    api_key: String,
    enable_thinking: Option<bool>,
) -> Result<i64, String> {
    let m = storage::ai_models::AiModel {
        id: None,
        name,
        base_url,
        model,
        enable_thinking: enable_thinking.map(|b| if b { 1 } else { 0 }),
        created_at: None,
    };
    let id = storage::ai_models::insert(&state.sqlite, &m)
        .await
        .map_err(|e| e.to_string())?;
    if !api_key.is_empty() {
        crypto::set_ai_model_key(&state.sqlite, id, &api_key).await?;
    }
    // If this is the first model, auto-activate it.
    if active_ai_model_id(&state.sqlite).await?.is_none() {
        storage::settings::set(&state.sqlite, "ai.active_model_id", &id.to_string())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
async fn update_ai_model(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    base_url: String,
    model: String,
    api_key: String,
    enable_thinking: Option<bool>,
) -> Result<(), String> {
    let m = storage::ai_models::AiModel {
        id: Some(id),
        name,
        base_url,
        model,
        enable_thinking: enable_thinking.map(|b| if b { 1 } else { 0 }),
        created_at: None,
    };
    storage::ai_models::update(&state.sqlite, &m)
        .await
        .map_err(|e| e.to_string())?;
    if !api_key.is_empty() {
        crypto::set_ai_model_key(&state.sqlite, id, &api_key).await?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_ai_model(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    storage::ai_models::delete_by_id(&state.sqlite, id)
        .await
        .map_err(|e| e.to_string())?;
    crypto::delete_ai_model_key(&state.sqlite, id).await?;
    // If the deleted row was active, clear the active pointer so the next
    // AI call surfaces a clear "no model" error instead of pointing at a ghost.
    if active_ai_model_id(&state.sqlite).await? == Some(id) {
        sqlx::query("DELETE FROM settings WHERE key = ?")
            .bind("ai.active_model_id")
            .execute(&state.sqlite)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn set_active_ai_model(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    storage::ai_models::get_by_id(&state.sqlite, id)
        .await
        .map_err(|_| "model not found".to_string())?;
    storage::settings::set(&state.sqlite, "ai.active_model_id", &id.to_string())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct ActiveAiSummary {
    id: Option<i64>,
    name: Option<String>,
    model: Option<String>,
}

#[tauri::command]
async fn get_active_ai_model(state: State<'_, AppState>) -> Result<ActiveAiSummary, String> {
    match active_ai_model_id(&state.sqlite).await? {
        Some(id) => match storage::ai_models::get_by_id(&state.sqlite, id).await {
            Ok(m) => Ok(ActiveAiSummary {
                id: Some(id),
                name: Some(m.name),
                model: Some(m.model),
            }),
            Err(_) => Ok(ActiveAiSummary {
                id: None,
                name: None,
                model: None,
            }),
        },
        None => Ok(ActiveAiSummary {
            id: None,
            name: None,
            model: None,
        }),
    }
}

#[derive(Serialize)]
struct EmbeddingModelView {
    id: i64,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    deployment: String,
    api_version: String,
    dimensions: Option<u32>,
    has_api_key: bool,
    is_active: bool,
}

#[tauri::command]
async fn list_embedding_models(
    state: State<'_, AppState>,
) -> Result<Vec<EmbeddingModelView>, String> {
    let active = active_embedding_model_id(&state.sqlite).await?;
    let rows = storage::embedding_models::list_all(&state.sqlite)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for m in rows {
        let id = m.id.unwrap_or(0);
        let has_api_key = crypto::has_embedding_model_key(&state.sqlite, id).await;
        out.push(EmbeddingModelView {
            id,
            name: m.name,
            provider: m.provider,
            base_url: m.base_url,
            model: m.model,
            deployment: m.deployment,
            api_version: m.api_version,
            dimensions: m.dimensions.and_then(|d| u32::try_from(d).ok()),
            has_api_key,
            is_active: active == Some(id),
        });
    }
    Ok(out)
}

#[tauri::command]
async fn create_embedding_model(
    state: State<'_, AppState>,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    deployment: String,
    api_version: String,
    dimensions: Option<u32>,
    api_key: String,
) -> Result<i64, String> {
    let m = storage::embedding_models::EmbeddingModel {
        id: None,
        name,
        provider,
        base_url,
        model,
        deployment,
        api_version,
        dimensions: dimensions.map(|d| d as i64),
        created_at: None,
    };
    let id = storage::embedding_models::insert(&state.sqlite, &m)
        .await
        .map_err(|e| e.to_string())?;
    if !api_key.is_empty() {
        crypto::set_embedding_model_key(&state.sqlite, id, &api_key).await?;
    }
    if active_embedding_model_id(&state.sqlite).await?.is_none() {
        storage::settings::set(&state.sqlite, "embedding.active_model_id", &id.to_string())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
async fn update_embedding_model(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    deployment: String,
    api_version: String,
    dimensions: Option<u32>,
    api_key: String,
) -> Result<(), String> {
    let m = storage::embedding_models::EmbeddingModel {
        id: Some(id),
        name,
        provider,
        base_url,
        model,
        deployment,
        api_version,
        dimensions: dimensions.map(|d| d as i64),
        created_at: None,
    };
    storage::embedding_models::update(&state.sqlite, &m)
        .await
        .map_err(|e| e.to_string())?;
    if !api_key.is_empty() {
        crypto::set_embedding_model_key(&state.sqlite, id, &api_key).await?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_embedding_model(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    storage::embedding_models::delete_by_id(&state.sqlite, id)
        .await
        .map_err(|e| e.to_string())?;
    crypto::delete_embedding_model_key(&state.sqlite, id).await?;
    if active_embedding_model_id(&state.sqlite).await? == Some(id) {
        sqlx::query("DELETE FROM settings WHERE key = ?")
            .bind("embedding.active_model_id")
            .execute(&state.sqlite)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn set_active_embedding_model(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    storage::embedding_models::get_by_id(&state.sqlite, id)
        .await
        .map_err(|_| "model not found".to_string())?;
    storage::settings::set(&state.sqlite, "embedding.active_model_id", &id.to_string())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct ActiveEmbeddingSummary {
    id: Option<i64>,
    name: Option<String>,
    model: Option<String>,
}

#[tauri::command]
async fn get_active_embedding_model(
    state: State<'_, AppState>,
) -> Result<ActiveEmbeddingSummary, String> {
    match active_embedding_model_id(&state.sqlite).await? {
        Some(id) => match storage::embedding_models::get_by_id(&state.sqlite, id).await {
            Ok(m) => Ok(ActiveEmbeddingSummary {
                id: Some(id),
                name: Some(m.name),
                model: Some(m.model),
            }),
            Err(_) => Ok(ActiveEmbeddingSummary {
                id: None,
                name: None,
                model: None,
            }),
        },
        None => Ok(ActiveEmbeddingSummary {
            id: None,
            name: None,
            model: None,
        }),
    }
}

#[tauri::command]
async fn embed_text(
    state: State<'_, AppState>,
    text: String,
) -> Result<Vec<f32>, String> {
    let e = load_active_embedding(&state.sqlite).await?;
    let provider_kind = match e.provider.as_str() {
        "azure" => {
            if e.deployment.is_empty() {
                return Err("Azure provider requires a deployment name.".to_string());
            }
            if e.api_version.is_empty() {
                return Err("Azure provider requires an api-version.".to_string());
            }
            embed::Provider::Azure {
                deployment: &e.deployment,
                api_version: &e.api_version,
            }
        }
        _ => embed::Provider::OpenAi { model: &e.model },
    };
    embed::embed(provider_kind, &e.base_url, &e.api_key, &text, e.dimensions).await
}

async fn build_schema_context(pool: &MySqlPool) -> Result<String, String> {
    let dbs: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list databases failed: {e}"))?;

    let mut out = String::new();
    for (db,) in dbs {
        if matches!(
            db.as_str(),
            "information_schema" | "performance_schema" | "mysql" | "sys"
        ) {
            continue;
        }
        out.push_str(&format!("Database `{db}`:\n"));

        let tables: Vec<(String, String)> = sqlx::query_as(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR) \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(&db)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list columns failed: {e}"))?;

        let mut current_table: Option<String> = None;
        let mut cols: Vec<String> = Vec::new();
        for (t, c) in tables {
            if current_table.as_deref() != Some(t.as_str()) {
                if let Some(prev) = current_table.take() {
                    out.push_str(&format!("  - {prev}({})\n", cols.join(", ")));
                    cols.clear();
                }
                current_table = Some(t);
            }
            cols.push(c);
        }
        if let Some(prev) = current_table {
            out.push_str(&format!("  - {prev}({})\n", cols.join(", ")));
        }
    }

    Ok(out)
}

#[tauri::command]
async fn generate_sql(
    state: State<'_, AppState>,
    connection_id: i64,
    prompt: String,
    current_sql: Option<String>,
    current_table: Option<String>,
) -> Result<String, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let schema_context = build_schema_context(&pool).await?;

    ai::generate_sql(
        &cfg,
        &api_key,
        &schema_context,
        &prompt,
        current_sql.as_deref(),
        current_table.as_deref(),
    )
    .await
}

#[tauri::command]
async fn analyze_schema(
    state: State<'_, AppState>,
    connection_id: i64,
) -> Result<analyze::AnalyzeReport, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    analyze::analyze_connection(&pool, &state.sqlite, connection_id).await
}

#[tauri::command]
async fn list_annotations(
    state: State<'_, AppState>,
    connection_id: i64,
    database: Option<String>,
) -> Result<Vec<storage::annotation::Annotation>, String> {
    storage::annotation::list(&state.sqlite, connection_id, database.as_deref())
        .await
        .map_err(|e| format!("list_annotations failed: {e}"))
}

#[tauri::command]
async fn list_relations(
    state: State<'_, AppState>,
    connection_id: i64,
    database: Option<String>,
) -> Result<Vec<storage::relation::Relation>, String> {
    storage::relation::list(&state.sqlite, connection_id, database.as_deref())
        .await
        .map_err(|e| format!("list_relations failed: {e}"))
}

#[tauri::command]
async fn generate_ai_relations(
    state: State<'_, AppState>,
    connection_id: i64,
) -> Result<analyze::AiRelationsReport, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    analyze::generate_ai_relations(&pool, &state.sqlite, connection_id, &cfg, &api_key).await
}

#[tauri::command]
async fn generate_ai_relations_for_project(
    state: State<'_, AppState>,
    connection_id: i64,
    project_id: i64,
) -> Result<analyze::AiRelationsReport, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    analyze::generate_ai_relations_for_project(
        &pool,
        &state.sqlite,
        project_id,
        connection_id,
        &cfg,
        &api_key,
    )
    .await
}

#[tauri::command]
async fn list_tables_for_ai(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
) -> Result<Vec<String>, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    analyze::list_tables_in_db(&pool, &database).await
}

#[tauri::command]
async fn generate_table_comments(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
) -> Result<analyze::TableCommentReport, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    analyze::generate_table_comments(
        &pool,
        &state.sqlite,
        connection_id,
        &database,
        &table,
        &cfg,
        &api_key,
    )
    .await
}

#[tauri::command]
async fn export_data_dictionary(
    state: State<'_, AppState>,
    connection_id: i64,
    database: Option<String>,
) -> Result<String, String> {
    let annotations = storage::annotation::list(&state.sqlite, connection_id, database.as_deref())
        .await
        .map_err(|e| format!("list annotations failed: {e}"))?;
    let relations = storage::relation::list(&state.sqlite, connection_id, database.as_deref())
        .await
        .map_err(|e| format!("list relations failed: {e}"))?;

    let mut by_table: HashMap<(String, String), Vec<storage::annotation::Annotation>> =
        HashMap::new();
    let mut table_level: HashMap<(String, String), String> = HashMap::new();

    for a in annotations {
        let key = (a.database_name.clone(), a.table_name.clone());
        if a.column_name.is_none() {
            if let Some(c) = &a.ai_comment {
                table_level.insert(key.clone(), c.clone());
            }
        } else {
            by_table.entry(key).or_default().push(a);
        }
    }

    let mut keys: Vec<_> = by_table.keys().cloned().collect();
    for k in table_level.keys() {
        if !keys.contains(k) {
            keys.push(k.clone());
        }
    }
    keys.sort();

    let mut out = String::from("# Data Dictionary\n\n");
    let mut current_db: Option<String> = None;
    for (db, table) in &keys {
        if current_db.as_deref() != Some(db.as_str()) {
            out.push_str(&format!("## Database `{db}`\n\n"));
            current_db = Some(db.clone());
        }
        out.push_str(&format!("### `{db}`.`{table}`\n\n"));
        if let Some(c) = table_level.get(&(db.clone(), table.clone())) {
            out.push_str(&format!("{c}\n\n"));
        }
        if let Some(cols) = by_table.get(&(db.clone(), table.clone())) {
            if !cols.is_empty() {
                out.push_str("| Column | Role | PII | Comment |\n");
                out.push_str("|---|---|---|---|\n");
                for c in cols {
                    out.push_str(&format!(
                        "| `{}` | {} | {} | {} |\n",
                        c.column_name.as_deref().unwrap_or(""),
                        c.semantic_role.as_deref().unwrap_or(""),
                        c.pii_type.as_deref().unwrap_or(""),
                        c.ai_comment.as_deref().unwrap_or("").replace('\n', " "),
                    ));
                }
                out.push('\n');
            }
        }
    }

    if !relations.is_empty() {
        out.push_str("## Inferred Relations\n\n");
        out.push_str("| From | To | Confidence | Source |\n");
        out.push_str("|---|---|---|---|\n");
        for r in relations {
            out.push_str(&format!(
                "| `{}`.`{}`.`{}` | `{}`.`{}`.`{}` | {:.2} | {} |\n",
                r.from_db, r.from_table, r.from_column,
                r.to_db, r.to_table, r.to_column,
                r.confidence, r.source,
            ));
        }
    }

    Ok(out)
}

#[tauri::command]
async fn list_columns(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
) -> Result<Vec<String>, String> {
    if is_sqlite(&state, connection_id).await {
        if !is_safe_sqlite_ident(&table) {
            return Err(format!("invalid table name: {table}"));
        }
        let pool = get_sqlite_pool(&state, connection_id).await?;
        let rows = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("list_columns failed: {e}"))?;
        use sqlx::Row;
        return Ok(rows
            .into_iter()
            .map(|r| r.try_get::<String, _>("name").unwrap_or_default())
            .collect());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT CAST(COLUMN_NAME AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(&database)
    .bind(&table)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("list_columns failed: {e}"))?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

fn is_safe_sqlite_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 200
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

#[derive(Serialize)]
struct TableMetaForTree {
    name: String,
    kind: String,
    estimated_rows: i64,
    comment: String,
}

#[tauri::command]
async fn list_table_meta(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
) -> Result<Vec<TableMetaForTree>, String> {
    if is_milvus(&state, connection_id).await {
        let client = get_milvus_client(&state, connection_id).await?;
        let db_opt = Some(database.as_str()).filter(|s| !s.is_empty());
        let cols = client.list_collections_in(db_opt).await?;
        // Skip per-collection stats for the listing — kept lazy to avoid N
        // REST round-trips on sidebar mount. row count is fetched on expand
        // via list_columns_meta path (describe_collection has row_count).
        return Ok(cols
            .into_iter()
            .map(|c| TableMetaForTree {
                name: c.name,
                kind: "collection".to_string(),
                estimated_rows: 0,
                comment: String::new(),
            })
            .collect());
    }

    if is_sqlite(&state, connection_id).await {
        let pool = get_sqlite_pool(&state, connection_id).await?;
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') \
             AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("list_table_meta failed: {e}"))?;
        return Ok(rows
            .into_iter()
            .map(|(name, kind)| TableMetaForTree {
                name,
                kind,
                estimated_rows: 0,
                comment: String::new(),
            })
            .collect());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    let rows: Vec<(String, String, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT \
            CAST(TABLE_NAME AS CHAR), \
            CAST(TABLE_TYPE AS CHAR), \
            CAST(TABLE_ROWS AS SIGNED), \
            CAST(TABLE_COMMENT AS CHAR) \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? \
         ORDER BY TABLE_NAME",
    )
    .bind(&database)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("list_table_meta failed: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(name, kind, rows_opt, comment)| {
            let kind_norm = match kind.as_str() {
                "BASE TABLE" => "table",
                "VIEW" => "view",
                "SYSTEM VIEW" => "system",
                other => other,
            }
            .to_string();
            TableMetaForTree {
                name,
                kind: kind_norm,
                estimated_rows: rows_opt.unwrap_or(0),
                comment: comment.unwrap_or_default(),
            }
        })
        .collect())
}

#[derive(Serialize)]
struct ColumnMetaForTree {
    name: String,
    data_type: String,
    column_type: String,
    is_primary: bool,
    is_indexed: bool,
    is_foreign_key: bool,
    nullable: bool,
}

#[tauri::command]
async fn list_columns_meta(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
) -> Result<Vec<ColumnMetaForTree>, String> {
    if is_milvus(&state, connection_id).await {
        let client = get_milvus_client(&state, connection_id).await?;
        let db_opt = Some(database.as_str()).filter(|s| !s.is_empty());
        let desc = client.describe_collection_in(&table, db_opt).await?;
        let indexed: std::collections::HashSet<String> =
            desc.indexes.iter().map(|i| i.field_name.clone()).collect();
        return Ok(desc
            .fields
            .into_iter()
            .map(|f| {
                let column_type = if let Some(dim) = f.dim {
                    format!("{}({})", f.data_type, dim)
                } else {
                    f.data_type.clone()
                };
                ColumnMetaForTree {
                    name: f.name.clone(),
                    data_type: f.data_type.clone(),
                    column_type,
                    is_primary: f.is_primary,
                    is_indexed: indexed.contains(&f.name),
                    is_foreign_key: false,
                    nullable: f.nullable,
                }
            })
            .collect());
    }

    if is_sqlite(&state, connection_id).await {
        if !is_safe_sqlite_ident(&table) {
            return Err(format!("invalid table name: {table}"));
        }
        let pool = get_sqlite_pool(&state, connection_id).await?;
        use sqlx::Row;

        let col_rows = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("list_columns_meta failed: {e}"))?;

        // FK columns
        let fk_rows = sqlx::query(&format!("PRAGMA foreign_key_list(\"{table}\")"))
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("list_columns_meta fk lookup failed: {e}"))?;
        let fk_cols: std::collections::HashSet<String> = fk_rows
            .iter()
            .map(|r| r.try_get::<String, _>("from").unwrap_or_default())
            .collect();

        // Indexed columns
        let idx_rows = sqlx::query(&format!("PRAGMA index_list(\"{table}\")"))
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("list_columns_meta index lookup failed: {e}"))?;
        let mut indexed_cols: std::collections::HashSet<String> = std::collections::HashSet::new();
        for r in idx_rows.iter() {
            let idx_name: String = r.try_get("name").unwrap_or_default();
            if !is_safe_sqlite_ident(&idx_name) {
                continue;
            }
            let info_rows = sqlx::query(&format!("PRAGMA index_info(\"{idx_name}\")"))
                .fetch_all(&pool)
                .await
                .unwrap_or_default();
            for ir in info_rows.iter() {
                let c: String = ir.try_get("name").unwrap_or_default();
                if !c.is_empty() {
                    indexed_cols.insert(c);
                }
            }
        }

        return Ok(col_rows
            .into_iter()
            .map(|r| {
                let name: String = r.try_get("name").unwrap_or_default();
                let declared_type: String = r.try_get("type").unwrap_or_default();
                let notnull: i64 = r.try_get("notnull").unwrap_or(0);
                let pk: i64 = r.try_get("pk").unwrap_or(0);
                ColumnMetaForTree {
                    is_indexed: indexed_cols.contains(&name) || pk > 0,
                    is_foreign_key: fk_cols.contains(&name),
                    is_primary: pk > 0,
                    nullable: notnull == 0,
                    data_type: declared_type.clone(),
                    column_type: declared_type,
                    name,
                }
            })
            .collect());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT \
            CAST(COLUMN_NAME AS CHAR), \
            CAST(DATA_TYPE AS CHAR), \
            CAST(COLUMN_TYPE AS CHAR), \
            CAST(COLUMN_KEY AS CHAR), \
            CAST(IS_NULLABLE AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(&database)
    .bind(&table)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("list_columns_meta failed: {e}"))?;

    let fk_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT CAST(COLUMN_NAME AS CHAR) \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         AND REFERENCED_TABLE_NAME IS NOT NULL",
    )
    .bind(&database)
    .bind(&table)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("list_columns_meta fk lookup failed: {e}"))?;
    let fk_set: std::collections::HashSet<String> = fk_rows.into_iter().map(|(c,)| c).collect();

    Ok(rows
        .into_iter()
        .map(|(name, data_type, column_type, column_key, is_nullable)| {
            let is_primary = column_key == "PRI";
            let is_indexed = !column_key.is_empty();
            let is_foreign_key = fk_set.contains(&name);
            let nullable = is_nullable == "YES";
            ColumnMetaForTree {
                name,
                data_type,
                column_type,
                is_primary,
                is_indexed,
                is_foreign_key,
                nullable,
            }
        })
        .collect())
}

#[tauri::command]
async fn list_project_relations(
    state: State<'_, AppState>,
    project_id: i64,
) -> Result<Vec<storage::project::ProjectRelation>, String> {
    storage::project::list_relations(&state.sqlite, project_id)
        .await
        .map_err(|e| format!("list_project_relations failed: {e}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn add_project_relation(
    state: State<'_, AppState>,
    project_id: i64,
    from_connection_id: i64,
    from_db: String,
    from_table: String,
    from_column: String,
    to_connection_id: i64,
    to_db: String,
    to_table: String,
    to_column: String,
    cardinality: String,
) -> Result<i64, String> {
    storage::project::add_relation(
        &state.sqlite,
        project_id,
        from_connection_id,
        &from_db,
        &from_table,
        &from_column,
        to_connection_id,
        &to_db,
        &to_table,
        &to_column,
        &cardinality,
        "manual",
    )
    .await
    .map_err(|e| format!("add_project_relation failed: {e}"))
}

#[tauri::command]
async fn remove_project_relation(
    state: State<'_, AppState>,
    relation_id: i64,
) -> Result<(), String> {
    storage::project::remove_relation(&state.sqlite, relation_id)
        .await
        .map_err(|e| format!("remove_project_relation failed: {e}"))
}

#[tauri::command]
async fn import_schema_relations_to_project(
    state: State<'_, AppState>,
    project_id: i64,
    connection_id: i64,
) -> Result<i64, String> {
    let schema_rels = storage::relation::list(&state.sqlite, connection_id, None)
        .await
        .map_err(|e| format!("list schema relations failed: {e}"))?;
    let project_tables = storage::project::list_tables(&state.sqlite, project_id)
        .await
        .map_err(|e| format!("list project tables failed: {e}"))?;

    let in_project: std::collections::HashSet<(String, String)> = project_tables
        .iter()
        .map(|t| (t.database_name.clone(), t.table_name.clone()))
        .collect();

    let mut imported = 0i64;
    for r in schema_rels {
        let from = (r.from_db.clone(), r.from_table.clone());
        let to = (r.to_db.clone(), r.to_table.clone());
        if !in_project.contains(&from) || !in_project.contains(&to) {
            continue;
        }
        storage::project::add_relation(
            &state.sqlite,
            project_id,
            connection_id,
            &r.from_db,
            &r.from_table,
            &r.from_column,
            connection_id,
            &r.to_db,
            &r.to_table,
            &r.to_column,
            "N-1",
            "imported",
        )
        .await
        .map_err(|e| format!("add_relation failed: {e}"))?;
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
async fn suggest_chart(
    state: State<'_, AppState>,
    columns: Vec<query::ColumnMeta>,
    sample_rows: Vec<Vec<serde_json::Value>>,
) -> Result<ai::ChartConfig, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let mut block = String::new();
    for c in &columns {
        block.push_str(&format!("- {} ({})\n", c.name, c.type_name));
    }

    let sample: Vec<serde_json::Map<String, serde_json::Value>> = sample_rows
        .iter()
        .take(10)
        .map(|row| {
            let mut obj = serde_json::Map::new();
            for (i, c) in columns.iter().enumerate() {
                if let Some(v) = row.get(i) {
                    obj.insert(c.name.clone(), v.clone());
                }
            }
            obj
        })
        .collect();
    let sample_json = serde_json::to_string(&sample)
        .map_err(|e| format!("encode sample failed: {e}"))?;

    ai::suggest_chart(&cfg, &api_key, &block, &sample_json).await
}

#[tauri::command]
async fn suggest_queries(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
) -> Result<Vec<ai::QuerySuggestion>, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
                CAST(COALESCE(COLUMN_COMMENT, '') AS CHAR) \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(&database)
    .bind(&table)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("fetch columns failed: {e}"))?;

    let annotations = storage::annotation::list(&state.sqlite, connection_id, Some(&database))
        .await
        .map_err(|e| format!("list annotations failed: {e}"))?;
    let mut hints: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for a in annotations {
        if a.table_name == table {
            if let Some(c) = a.column_name {
                hints.insert(c, (a.semantic_role, a.pii_type));
            }
        }
    }

    let mut block = String::new();
    for (col, ty, comment) in &rows {
        let h = hints.get(col);
        let role = h.and_then(|(r, _)| r.clone()).unwrap_or_default();
        let pii = h.and_then(|(_, p)| p.clone()).unwrap_or_default();
        block.push_str(&format!(
            "- `{col}` {ty}{}{}{}\n",
            if comment.is_empty() {
                String::new()
            } else {
                format!(" -- {comment}")
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

    let list = ai::suggest_queries(&cfg, &api_key, &database, &table, &block).await?;
    Ok(list.queries)
}

#[tauri::command]
async fn fix_sql_error(
    state: State<'_, AppState>,
    connection_id: i64,
    sql: String,
    error: String,
) -> Result<ai::SqlFixSuggestion, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let schema_context = build_schema_context(&pool).await?;
    ai::fix_sql_error(&cfg, &api_key, &schema_context, &sql, &error).await
}

#[tauri::command]
async fn drill_project(
    state: State<'_, AppState>,
    connection_id: i64,
    project_id: i64,
    database: String,
    table: String,
    column: String,
    value: serde_json::Value,
) -> Result<drill::DrillResult, String> {
    // Snapshot the pool map so drill can dispatch each relation to the
    // right connection. Cross-connection projects rely on this — relations
    // may target tables on other connection_ids than the lookup root.
    let pools = state.active_pools.lock().await.clone();
    let redis_mgrs = state.active_redis.lock().await.clone();
    let result = drill::drill(
        &pools,
        &redis_mgrs,
        &state.sqlite,
        project_id,
        connection_id,
        &database,
        &table,
        &column,
        &value,
    )
    .await?;

    // Record this drill in project history (best effort — we don't want to
    // fail the user's drill just because we couldn't log it).
    let value_json = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
    let _ = storage::drill_history::record(
        &state.sqlite,
        project_id,
        connection_id,
        &database,
        &table,
        &column,
        &value_json,
    )
    .await;

    Ok(result)
}

#[tauri::command]
async fn list_drill_history(
    state: State<'_, AppState>,
    project_id: i64,
    limit: Option<i64>,
) -> Result<Vec<storage::drill_history::DrillHistoryEntry>, String> {
    storage::drill_history::list(&state.sqlite, project_id, limit.unwrap_or(10))
        .await
        .map_err(|e| format!("list_drill_history failed: {e}"))
}

#[tauri::command]
async fn list_projects(
    state: State<'_, AppState>,
) -> Result<Vec<storage::project::Project>, String> {
    storage::project::list_all(&state.sqlite)
        .await
        .map_err(|e| format!("list_projects failed: {e}"))
}

#[tauri::command]
async fn save_project(
    state: State<'_, AppState>,
    project: storage::project::Project,
) -> Result<storage::project::Project, String> {
    let mut saved = project.clone();
    if let Some(id) = project.id {
        storage::project::update(&state.sqlite, &project)
            .await
            .map_err(|e| format!("update project failed: {e}"))?;
        saved.id = Some(id);
    } else {
        let new_id = storage::project::insert(&state.sqlite, &project)
            .await
            .map_err(|e| format!("insert project failed: {e}"))?;
        saved.id = Some(new_id);
    }
    Ok(saved)
}

#[tauri::command]
async fn delete_project(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    storage::project::delete_by_id(&state.sqlite, id)
        .await
        .map_err(|e| format!("delete project failed: {e}"))
}

#[tauri::command]
async fn list_project_tables(
    state: State<'_, AppState>,
    project_id: i64,
) -> Result<Vec<storage::project::ProjectTable>, String> {
    storage::project::list_tables(&state.sqlite, project_id)
        .await
        .map_err(|e| format!("list_project_tables failed: {e}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn add_project_table(
    state: State<'_, AppState>,
    project_id: i64,
    connection_id: i64,
    database_name: String,
    table_name: String,
    alias: Option<String>,
    is_primary: bool,
) -> Result<i64, String> {
    storage::project::add_table(
        &state.sqlite,
        project_id,
        connection_id,
        &database_name,
        &table_name,
        alias.as_deref(),
        is_primary,
    )
    .await
    .map_err(|e| format!("add_project_table failed: {e}"))
}

#[tauri::command]
async fn remove_project_table(
    state: State<'_, AppState>,
    project_table_id: i64,
) -> Result<(), String> {
    storage::project::remove_table(&state.sqlite, project_table_id)
        .await
        .map_err(|e| format!("remove_project_table failed: {e}"))
}

#[tauri::command]
async fn set_project_primary_table(
    state: State<'_, AppState>,
    project_id: i64,
    project_table_id: i64,
) -> Result<(), String> {
    storage::project::set_primary_table(&state.sqlite, project_id, project_table_id)
        .await
        .map_err(|e| format!("set_primary_table failed: {e}"))
}

#[derive(Serialize)]
struct ExplainSqlResponse {
    plan: perf::ExplainResult,
    explanation: Option<ai::ExplainExplanation>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn explain_sql(
    state: State<'_, AppState>,
    connection_id: i64,
    sql: String,
    include_ai: bool,
) -> Result<ExplainSqlResponse, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let plan = perf::explain_sql(&pool, &sql).await?;

    let mut explanation = None;
    let mut ai_error = None;

    if include_ai {
        match load_active_ai(&state.sqlite).await {
            Ok((cfg, api_key)) => {
                let json_str = serde_json::to_string(&plan.raw_json).unwrap_or_default();
                match ai::explain_query(&cfg, &api_key, &sql, &json_str).await {
                    Ok(e) => explanation = Some(e),
                    Err(e) => ai_error = Some(e),
                }
            }
            Err(e) => ai_error = Some(e),
        }
    }

    Ok(ExplainSqlResponse {
        plan,
        explanation,
        ai_error,
    })
}

#[tauri::command]
async fn get_perf_status(
    state: State<'_, AppState>,
    connection_id: i64,
) -> Result<perf::PerfStatus, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    perf::get_perf_status(&pool).await
}

#[tauri::command]
async fn list_slow_queries(
    state: State<'_, AppState>,
    connection_id: i64,
    limit: Option<i64>,
    min_avg_ms: Option<f64>,
) -> Result<Vec<perf::SlowQuery>, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    perf::list_slow_queries(&pool, limit.unwrap_or(50), min_avg_ms.unwrap_or(0.0)).await
}

#[tauri::command]
async fn recommend_indexes(
    state: State<'_, AppState>,
    connection_id: i64,
    sql: String,
    tables: Vec<perf::InvolvedTableRef>,
) -> Result<ai::IndexRecommendations, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let plan = perf::explain_sql(&pool, &sql).await?;
    let explain_json = serde_json::to_string(&plan.raw_json).unwrap_or_default();

    let mut block = String::new();
    let mut seen = std::collections::HashSet::new();
    for t in &tables {
        let key = (t.database.clone(), t.table.clone());
        if !seen.insert(key) {
            continue;
        }
        match perf::show_create_table(&pool, &t.database, &t.table).await {
            Ok(ddl) => {
                block.push_str(&format!("-- {}.{}\n{}\n\n", t.database, t.table, ddl));
            }
            Err(e) => {
                block.push_str(&format!(
                    "-- {}.{} (failed: {})\n\n",
                    t.database, t.table, e
                ));
            }
        }
    }

    ai::recommend_indexes(&cfg, &api_key, &sql, &block, &explain_json).await
}

#[tauri::command]
async fn list_processlist(
    state: State<'_, AppState>,
    connection_id: i64,
) -> Result<Vec<perf::ProcessRow>, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    perf::list_processlist(&pool).await
}

#[tauri::command]
async fn kill_process(
    state: State<'_, AppState>,
    connection_id: i64,
    process_id: i64,
) -> Result<(), String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    perf::kill_process(&pool, process_id).await
}

#[tauri::command]
async fn server_status(
    state: State<'_, AppState>,
    connection_id: i64,
) -> Result<perf::ServerStatus, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    perf::server_status(&pool).await
}

#[tauri::command]
async fn list_variables(
    state: State<'_, AppState>,
    connection_id: i64,
    filter: Option<String>,
) -> Result<Vec<perf::VariableEntry>, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    perf::list_variables(&pool, filter.as_deref()).await
}

#[tauri::command]
async fn compare_schemas(
    state: State<'_, AppState>,
    connection_id: i64,
    source_db: String,
    target_db: String,
) -> Result<diff::DiffReport, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    diff::compare_schemas(&pool, &source_db, &target_db).await
}

#[tauri::command]
async fn assess_migrations(
    state: State<'_, AppState>,
    migrations: Vec<diff::MigrationStatement>,
) -> Result<ai::MigrationRiskReport, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;

    let mut block = String::new();
    for (i, m) in migrations.iter().enumerate() {
        block.push_str(&format!("{i}. [{}] {}\n", m.kind, m.sql));
    }

    ai::assess_migrations(&cfg, &api_key, &block).await
}

#[derive(Serialize)]
struct HealthReportResponse {
    report: health::HealthReport,
    ai_overview: Option<ai::HealthOverview>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn run_health_check(
    state: State<'_, AppState>,
    connection_id: i64,
    include_ai: bool,
) -> Result<HealthReportResponse, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let report = health::run_health_check(&pool).await?;

    let mut ai_overview = None;
    let mut ai_error = None;

    if include_ai {
        match load_active_ai(&state.sqlite).await {
            Ok((cfg, api_key)) => {
                let summary = build_health_summary(&report);
                match ai::health_overview(&cfg, &api_key, &summary).await {
                    Ok(o) => ai_overview = Some(o),
                    Err(e) => ai_error = Some(e),
                }
            }
            Err(e) => ai_error = Some(e),
        }
    }

    Ok(HealthReportResponse {
        report,
        ai_overview,
        ai_error,
    })
}

fn build_health_summary(r: &health::HealthReport) -> String {
    use std::fmt::Write;
    let mut s = String::new();
    let _ = writeln!(s, "Server: {}", r.server_version);
    let _ = writeln!(
        s,
        "Databases scanned: {} ({})",
        r.databases_scanned.len(),
        r.databases_scanned.join(", ")
    );
    let _ = writeln!(s, "\nIndexes:");
    let _ = writeln!(s, "  Total indexes: {}", r.indexes.total_indexes);
    let _ = writeln!(s, "  Redundant pairs: {}", r.indexes.redundant.len());
    for ri in r.indexes.redundant.iter().take(10) {
        let _ = writeln!(
            s,
            "    {}.{}: {} ({}) ⊂ {} ({})",
            ri.database, ri.table, ri.index_a, ri.index_a_cols, ri.index_b, ri.index_b_cols
        );
    }
    let _ = writeln!(s, "  Unused indexes: {}", r.indexes.unused.len());
    for ui in r.indexes.unused.iter().take(10) {
        let _ = writeln!(s, "    {}.{}.{}", ui.database, ui.table, ui.index);
    }

    let _ = writeln!(s, "\nTables:");
    let _ = writeln!(s, "  Without primary key: {}", r.tables.no_primary_key.len());
    for t in r.tables.no_primary_key.iter().take(10) {
        let _ = writeln!(s, "    {}.{}", t.database, t.table);
    }
    let _ = writeln!(s, "  Fragmented (≥10MB, >20% free): {}", r.tables.fragmented.len());
    for f in r.tables.fragmented.iter().take(10) {
        let _ = writeln!(
            s,
            "    {}.{}: {:.1}MB free / {:.1}MB data ({:.0}%)",
            f.database,
            f.table,
            f.data_free_mb,
            f.data_length_mb,
            f.fragmentation_ratio * 100.0
        );
    }
    let _ = writeln!(s, "  Top 5 largest:");
    for t in r.tables.largest.iter().take(5) {
        let _ = writeln!(
            s,
            "    {}.{}: {:.1}MB ({} rows)",
            t.database, t.table, t.total_mb, t.rows
        );
    }

    let _ = writeln!(s, "\nSlow queries: top {} by total time", r.slow_queries.len());
    for q in r.slow_queries.iter().take(5) {
        let preview: String = q.digest_text.chars().take(120).collect();
        let _ = writeln!(
            s,
            "    avg {:.1}ms · {} calls · {}",
            q.avg_ms, q.count_star, preview
        );
    }

    let _ = writeln!(s, "\nSecurity:");
    let _ = writeln!(s, "  SSL available: {}", r.security.ssl_enabled);
    let _ = writeln!(
        s,
        "  require_secure_transport: {}",
        r.security.require_secure_transport
    );
    let _ = writeln!(
        s,
        "  Remote root accounts: {}",
        r.security.remote_root.len()
    );
    for u in &r.security.remote_root {
        let _ = writeln!(s, "    '{}'@'{}'", u.user, u.host);
    }
    if let Some(e) = &r.security.mysql_user_unavailable_reason {
        let _ = writeln!(s, "  (mysql.user check failed: {e})");
    }

    s
}

#[derive(Serialize)]
struct OnboardingResponse {
    snapshot: agent::OnboardingSnapshot,
    report: Option<ai::OnboardingReport>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn run_onboarding(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    max_tables: Option<usize>,
    include_ai: bool,
) -> Result<OnboardingResponse, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let cap = max_tables.unwrap_or(40).clamp(5, 80);
    let snapshot = agent::collect_snapshot(&pool, &database, cap).await?;

    let mut report = None;
    let mut ai_error = None;

    if include_ai {
        if snapshot.tables.is_empty() {
            ai_error = Some("Database has no tables to analyze.".into());
        } else {
            match load_active_ai(&state.sqlite).await {
                Ok((cfg, api_key)) => {
                    let block = build_onboarding_block(&snapshot);
                    match ai::onboarding_analysis(&cfg, &api_key, &block).await {
                        Ok(r) => report = Some(r),
                        Err(e) => ai_error = Some(e),
                    }
                }
                Err(e) => ai_error = Some(e),
            }
        }
    }

    Ok(OnboardingResponse {
        snapshot,
        report,
        ai_error,
    })
}

fn build_onboarding_block(s: &agent::OnboardingSnapshot) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "Database: `{}`", s.database);
    let _ = writeln!(out, "Server: {}", s.server_version);
    let _ = writeln!(
        out,
        "Tables (showing {} of {}):",
        s.tables.len(),
        s.total_tables
    );
    for t in &s.tables {
        let _ = writeln!(
            out,
            "\n- `{}` (~{} rows, {:.1} MB){}",
            t.name,
            t.estimated_rows,
            t.data_mb,
            if t.comment.is_empty() {
                String::new()
            } else {
                format!(" — {}", t.comment)
            }
        );
        for c in &t.columns {
            let mut tags = Vec::new();
            if c.is_primary {
                tags.push("PK");
            } else if c.is_indexed {
                tags.push("idx");
            }
            let tag_str = if tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", tags.join(","))
            };
            let comment = if c.comment.is_empty() {
                String::new()
            } else {
                format!(" -- {}", c.comment)
            };
            let _ = writeln!(out, "    {} {}{}{}", c.name, c.data_type, tag_str, comment);
        }
    }
    if !s.fks.is_empty() {
        let _ = writeln!(out, "\nForeign keys:");
        for fk in &s.fks {
            let _ = writeln!(
                out,
                "  {}.{} → {}.{}",
                fk.from_table, fk.from_column, fk.to_table, fk.to_column
            );
        }
    }
    out
}

#[derive(Serialize)]
struct ImpactResponse {
    report: agent::ImpactReport,
    assessment: Option<ai::ImpactAssessment>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn run_impact_analysis(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
    column: String,
    include_ai: bool,
) -> Result<ImpactResponse, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let report =
        agent::analyze_impact(&pool, &state.sqlite, connection_id, &database, &table, &column)
            .await?;

    let mut assessment = None;
    let mut ai_error = None;

    if include_ai {
        match load_active_ai(&state.sqlite).await {
            Ok((cfg, api_key)) => {
                let block = build_impact_block(&report);
                match ai::impact_analysis(&cfg, &api_key, &block).await {
                    Ok(a) => assessment = Some(a),
                    Err(e) => ai_error = Some(e),
                }
            }
            Err(e) => ai_error = Some(e),
        }
    }

    Ok(ImpactResponse {
        report,
        assessment,
        ai_error,
    })
}

fn build_impact_block(r: &agent::ImpactReport) -> String {
    use std::fmt::Write;
    let c = &r.column;
    let mut s = String::new();
    let _ = writeln!(
        s,
        "Column: `{}`.`{}`.`{}`",
        c.database, c.table, c.column
    );
    let _ = writeln!(
        s,
        "Type: {} ({}); nullable={}; default={}; key={}{}",
        c.data_type,
        c.column_type,
        c.nullable,
        c.default.clone().unwrap_or_else(|| "NULL".into()),
        if c.column_key.is_empty() {
            "-".to_string()
        } else {
            c.column_key.clone()
        },
        if c.comment.is_empty() {
            String::new()
        } else {
            format!("; comment={}", c.comment)
        }
    );

    let _ = writeln!(s, "\nViews referencing it ({}):", r.views.len());
    for v in r.views.iter().take(20) {
        let _ = writeln!(s, "  {}.{}: {}", v.database, v.view, v.snippet);
    }
    if let Some(e) = &r.views_scan_error {
        let _ = writeln!(s, "  (scan error: {e})");
    }

    let _ = writeln!(s, "\nRoutines referencing it ({}):", r.routines.len());
    for rt in r.routines.iter().take(20) {
        let _ = writeln!(
            s,
            "  {}.{} ({}): {}",
            rt.database, rt.name, rt.routine_type, rt.snippet
        );
    }
    if let Some(e) = &r.routines_scan_error {
        let _ = writeln!(s, "  (scan error: {e})");
    }

    let _ = writeln!(s, "\nTriggers referencing it ({}):", r.triggers.len());
    for t in r.triggers.iter().take(20) {
        let _ = writeln!(
            s,
            "  {}.{} on {}.{}: {}",
            t.database, t.trigger, t.event_table, t.event, t.snippet
        );
    }
    if let Some(e) = &r.triggers_scan_error {
        let _ = writeln!(s, "  (scan error: {e})");
    }

    let _ = writeln!(s, "\nForeign keys ({}):", r.fks.len());
    for fk in &r.fks {
        let _ = writeln!(
            s,
            "  [{}] {}.{}.{} ↔ {}.{}.{}",
            fk.direction, fk.from_db, fk.from_table, fk.from_column, fk.to_db, fk.to_table, fk.to_column
        );
    }

    let _ = writeln!(
        s,
        "\nLocal query history mentions: {} occurrences",
        r.history.count
    );
    for q in r.history.recent_sql.iter().take(5) {
        let _ = writeln!(s, "  {}", q);
    }

    s
}

#[derive(Serialize)]
struct ProjectImpactResponse {
    report: agent::ProjectImpactReport,
    assessment: Option<ai::ImpactAssessment>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn run_project_impact(
    state: State<'_, AppState>,
    project_id: i64,
    connection_id: i64,
    database: String,
    table: String,
    column: String,
    include_ai: bool,
) -> Result<ProjectImpactResponse, String> {
    let pools_snapshot: HashMap<i64, MySqlPool> = {
        let guard = state.active_pools.lock().await;
        guard.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    let report = agent::analyze_project_impact(
        &state.sqlite,
        &pools_snapshot,
        project_id,
        connection_id,
        &database,
        &table,
        &column,
    )
    .await?;

    let mut assessment = None;
    let mut ai_error = None;

    if include_ai {
        match load_active_ai(&state.sqlite).await {
            Ok((cfg, api_key)) => {
                let block = build_project_impact_block(&report);
                match ai::impact_analysis(&cfg, &api_key, &block).await {
                    Ok(a) => assessment = Some(a),
                    Err(e) => ai_error = Some(e),
                }
            }
            Err(e) => ai_error = Some(e),
        }
    }

    Ok(ProjectImpactResponse {
        report,
        assessment,
        ai_error,
    })
}

fn build_project_impact_block(r: &agent::ProjectImpactReport) -> String {
    use std::fmt::Write;
    let c = &r.column;
    let mut s = String::new();
    let _ = writeln!(
        s,
        "Project: `{}` (impact scoped to user-curated relations)",
        r.project_name
    );
    let _ = writeln!(
        s,
        "Column: [{}] `{}`.`{}`.`{}`",
        r.connection_name, c.database, c.table, c.column
    );
    let _ = writeln!(
        s,
        "Type: {} ({}); nullable={}; default={}; key={}{}",
        c.data_type,
        c.column_type,
        c.nullable,
        c.default.clone().unwrap_or_else(|| "NULL".into()),
        if c.column_key.is_empty() {
            "-".to_string()
        } else {
            c.column_key.clone()
        },
        if c.comment.is_empty() {
            String::new()
        } else {
            format!("; comment={}", c.comment)
        }
    );

    let _ = writeln!(
        s,
        "\nPropagation via user-curated project relations ({} paths, max depth {}):",
        r.propagation_paths.len(),
        3
    );
    for (i, p) in r.propagation_paths.iter().enumerate().take(30) {
        let mut chain = String::new();
        if let Some(first) = p.edges.first() {
            chain.push_str(&format!(
                "{}.{}.{}",
                first.from_db, first.from_table, first.from_column
            ));
        }
        for e in &p.edges {
            let mut tags = Vec::new();
            if e.cross_conn {
                tags.push("X-CONN");
            } else if e.cross_db {
                tags.push("X-DB");
            }
            let tag_str = if tags.is_empty() {
                String::new()
            } else {
                format!("[{}]", tags.join(","))
            };
            chain.push_str(&format!(
                " --{}{}/{} → {}.{}.{}",
                e.cardinality, tag_str, e.source, e.to_db, e.to_table, e.to_column
            ));
        }
        let _ = writeln!(s, "  {}. (d={}) {}", i + 1, p.depth, chain);
    }

    let _ = writeln!(s, "\nViews referencing it ({}):", r.views.len());
    for v in r.views.iter().take(15) {
        let _ = writeln!(s, "  {}.{}: {}", v.database, v.view, v.snippet);
    }
    if let Some(e) = &r.views_scan_error {
        let _ = writeln!(s, "  (scan error: {e})");
    }

    let _ = writeln!(s, "\nRoutines referencing it ({}):", r.routines.len());
    for rt in r.routines.iter().take(15) {
        let _ = writeln!(
            s,
            "  {}.{} ({}): {}",
            rt.database, rt.name, rt.routine_type, rt.snippet
        );
    }
    if let Some(e) = &r.routines_scan_error {
        let _ = writeln!(s, "  (scan error: {e})");
    }

    let _ = writeln!(s, "\nTriggers referencing it ({}):", r.triggers.len());
    for t in r.triggers.iter().take(15) {
        let _ = writeln!(
            s,
            "  {}.{} on {}.{}: {}",
            t.database, t.trigger, t.event_table, t.event, t.snippet
        );
    }
    if let Some(e) = &r.triggers_scan_error {
        let _ = writeln!(s, "  (scan error: {e})");
    }

    let _ = writeln!(s, "\nForeign keys ({}):", r.fks.len());
    for fk in &r.fks {
        let _ = writeln!(
            s,
            "  [{}] {}.{}.{} ↔ {}.{}.{}",
            fk.direction, fk.from_db, fk.from_table, fk.from_column, fk.to_db, fk.to_table, fk.to_column
        );
    }

    let _ = writeln!(
        s,
        "\nProject-wide query history mentions: {} occurrences",
        r.history.count
    );
    for q in r.history.recent_sql.iter().take(5) {
        let _ = writeln!(s, "  {}", q);
    }

    s
}

#[derive(Serialize)]
struct ProjectHealthResponse {
    report: health::ProjectHealthReport,
    ai_overview: Option<ai::HealthOverview>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn run_project_health_check(
    state: State<'_, AppState>,
    project_id: i64,
    include_ai: bool,
) -> Result<ProjectHealthResponse, String> {
    let pools_snapshot: HashMap<i64, MySqlPool> = {
        let guard = state.active_pools.lock().await;
        guard.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    let report =
        health::run_project_health_check(&state.sqlite, &pools_snapshot, project_id).await?;

    let mut ai_overview = None;
    let mut ai_error = None;

    if include_ai {
        match load_active_ai(&state.sqlite).await {
            Ok((cfg, api_key)) => {
                let summary = build_project_health_summary(&report);
                match ai::health_overview(&cfg, &api_key, &summary).await {
                    Ok(o) => ai_overview = Some(o),
                    Err(e) => ai_error = Some(e),
                }
            }
            Err(e) => ai_error = Some(e),
        }
    }

    Ok(ProjectHealthResponse {
        report,
        ai_overview,
        ai_error,
    })
}

fn build_project_health_summary(r: &health::ProjectHealthReport) -> String {
    use std::fmt::Write;
    let mut s = String::new();
    let _ = writeln!(s, "Project: {}", r.project_name);
    let _ = writeln!(
        s,
        "Scope: {} curated tables across databases [{}]",
        r.project_tables_count,
        r.scanned_databases.join(", ")
    );
    if !r.missing_connection_names.is_empty() {
        let _ = writeln!(
            s,
            "Partial: {} connection(s) closed — {} not scanned",
            r.missing_connection_names.len(),
            r.missing_connection_names.join(", ")
        );
    }
    let _ = writeln!(s, "\nIndexes (scope-limited):");
    let _ = writeln!(s, "  Total indexes: {}", r.indexes.total_indexes);
    let _ = writeln!(s, "  Redundant pairs: {}", r.indexes.redundant.len());
    for ri in r.indexes.redundant.iter().take(10) {
        let _ = writeln!(
            s,
            "    [{}] {}.{}: {} ({}) ⊂ {} ({})",
            ri.connection_name.clone().unwrap_or_default(),
            ri.database,
            ri.table,
            ri.index_a,
            ri.index_a_cols,
            ri.index_b,
            ri.index_b_cols
        );
    }
    let _ = writeln!(s, "  Unused indexes: {}", r.indexes.unused.len());
    for ui in r.indexes.unused.iter().take(10) {
        let _ = writeln!(
            s,
            "    [{}] {}.{}.{}",
            ui.connection_name.clone().unwrap_or_default(),
            ui.database,
            ui.table,
            ui.index
        );
    }

    let _ = writeln!(s, "\nTables (scope-limited):");
    let _ = writeln!(s, "  Without primary key: {}", r.tables.no_primary_key.len());
    for t in r.tables.no_primary_key.iter().take(10) {
        let _ = writeln!(
            s,
            "    [{}] {}.{}",
            t.connection_name.clone().unwrap_or_default(),
            t.database,
            t.table
        );
    }
    let _ = writeln!(s, "  Fragmented (≥10MB, >20% free): {}", r.tables.fragmented.len());
    for f in r.tables.fragmented.iter().take(10) {
        let _ = writeln!(
            s,
            "    [{}] {}.{}: {:.1}MB free / {:.1}MB data ({:.0}%)",
            f.connection_name.clone().unwrap_or_default(),
            f.database,
            f.table,
            f.data_free_mb,
            f.data_length_mb,
            f.fragmentation_ratio * 100.0
        );
    }
    let _ = writeln!(s, "  Top 5 largest:");
    for t in r.tables.largest.iter().take(5) {
        let _ = writeln!(
            s,
            "    [{}] {}.{}: {:.1}MB ({} rows)",
            t.connection_name.clone().unwrap_or_default(),
            t.database,
            t.table,
            t.total_mb,
            t.rows
        );
    }

    let _ = writeln!(s, "\nSecurity (per connection):");
    for c in &r.security_by_connection {
        let _ = writeln!(
            s,
            "  [{}] ssl_enabled={} require_secure_transport={} remote_root={}",
            c.connection_name,
            c.check.ssl_enabled,
            c.check.require_secure_transport,
            c.check.remote_root.len()
        );
        for u in &c.check.remote_root {
            let _ = writeln!(s, "    '{}'@'{}'", u.user, u.host);
        }
        if let Some(e) = &c.check.mysql_user_unavailable_reason {
            let _ = writeln!(s, "    (mysql.user check failed: {e})");
        }
    }

    s
}

#[derive(Serialize)]
struct ProjectBriefingResponse {
    snapshot: agent::ProjectBriefingSnapshot,
    report: Option<ai::ProjectBriefingReport>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn run_project_briefing(
    state: State<'_, AppState>,
    project_id: i64,
    include_ai: bool,
) -> Result<ProjectBriefingResponse, String> {
    let pools_snapshot: HashMap<i64, MySqlPool> = {
        let guard = state.active_pools.lock().await;
        guard.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    let snapshot =
        agent::collect_project_briefing(&state.sqlite, &pools_snapshot, project_id).await?;

    let mut report = None;
    let mut ai_error = None;

    if include_ai {
        if snapshot.tables.is_empty() {
            ai_error = Some("Project has no tables yet. Add tables in Edit project.".into());
        } else {
            match load_active_ai(&state.sqlite).await {
                Ok((cfg, api_key)) => {
                    let block = build_briefing_block(&snapshot);
                    match ai::project_briefing(&cfg, &api_key, &block).await {
                        Ok(r) => report = Some(r),
                        Err(e) => ai_error = Some(e),
                    }
                }
                Err(e) => ai_error = Some(e),
            }
        }
    }

    Ok(ProjectBriefingResponse {
        snapshot,
        report,
        ai_error,
    })
}

fn build_briefing_block(s: &agent::ProjectBriefingSnapshot) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "Project: `{}`", s.project_name);
    if let Some(desc) = &s.project_description {
        if !desc.is_empty() {
            let _ = writeln!(out, "Description: {}", desc);
        }
    }
    if !s.missing_connection_ids.is_empty() {
        let _ = writeln!(
            out,
            "WARNING: {} required connection(s) are closed — column data partial.",
            s.missing_connection_ids.len()
        );
    }
    let _ = writeln!(
        out,
        "\nCurated tables ({}):",
        s.tables.len()
    );
    for t in &s.tables {
        let primary_mark = if t.is_primary { " ★PRIMARY" } else { "" };
        let closed_mark = if t.closed { " (connection closed)" } else { "" };
        let _ = writeln!(
            out,
            "\n- `{}`.`{}`{} via [{}]{}{}",
            t.database,
            t.table,
            primary_mark,
            t.connection_name,
            closed_mark,
            if t.comment.is_empty() {
                String::new()
            } else {
                format!(" — {}", t.comment)
            }
        );
        if !t.closed {
            let _ = writeln!(
                out,
                "    ~{} rows, {:.1} MB",
                t.estimated_rows, t.data_mb
            );
        }
        for c in &t.columns {
            let mut tags = Vec::new();
            if c.is_primary {
                tags.push("PK");
            } else if c.is_indexed {
                tags.push("idx");
            }
            let tag_str = if tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", tags.join(","))
            };
            let cmt = if c.comment.is_empty() {
                String::new()
            } else {
                format!(" -- {}", c.comment)
            };
            let _ = writeln!(out, "    {} {}{}{}", c.name, c.data_type, tag_str, cmt);
        }
    }
    let _ = writeln!(
        out,
        "\nUser-curated relations ({}):",
        s.relations.len()
    );
    for r in &s.relations {
        let mut tags = Vec::new();
        if r.cross_conn {
            tags.push("X-CONN");
        } else if r.cross_db {
            tags.push("X-DB");
        }
        let tag_str = if tags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", tags.join(","))
        };
        let _ = writeln!(
            out,
            "  {}.{}.{} → {}.{}.{}  ({}, src={}){}",
            r.from_db,
            r.from_table,
            r.from_column,
            r.to_db,
            r.to_table,
            r.to_column,
            r.cardinality,
            r.source,
            tag_str
        );
    }
    out
}

/// Load the user's active AI model — base_url / model / api_key / thinking — for
/// any LLM call. All inline reads of `ai.base_url` / `ai.model` / `get_ai_key`
/// were replaced with this helper so adding / removing fields stays single-source.
async fn load_active_ai(
    pool: &sqlx::SqlitePool,
) -> Result<(ai::AiConfig, String), String> {
    let id = active_ai_model_id(pool)
        .await?
        .ok_or_else(|| "No active AI model. Open Settings (⚙) → Chat to add one.".to_string())?;
    let m = storage::ai_models::get_by_id(pool, id).await.map_err(|_| {
        "Active AI model not found. Open Settings (⚙) → Chat to set one.".to_string()
    })?;
    let api_key = crypto::get_ai_model_key(pool, id).await?;
    if api_key.is_empty() {
        return Err(format!(
            "API key not set for model '{}'. Open Settings (⚙) → Chat.",
            m.name
        ));
    }
    let enable_thinking = m.enable_thinking.map(|v| v != 0);
    Ok((
        ai::AiConfig {
            base_url: m.base_url,
            model: m.model,
            enable_thinking,
        },
        api_key,
    ))
}

pub struct ActiveEmbedding {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub deployment: String,
    pub api_version: String,
    pub dimensions: Option<u32>,
    pub api_key: String,
}

async fn load_active_embedding(pool: &sqlx::SqlitePool) -> Result<ActiveEmbedding, String> {
    let id = active_embedding_model_id(pool)
        .await?
        .ok_or_else(|| {
            "No active embedding model. Open Settings (⚙) → Embedding to add one.".to_string()
        })?;
    let m = storage::embedding_models::get_by_id(pool, id)
        .await
        .map_err(|_| {
            "Active embedding model not found. Open Settings (⚙) → Embedding to set one."
                .to_string()
        })?;
    let api_key = crypto::get_embedding_model_key(pool, id).await?;
    if api_key.is_empty() {
        return Err(format!(
            "API key not set for embedding model '{}'. Open Settings (⚙) → Embedding.",
            m.name
        ));
    }
    Ok(ActiveEmbedding {
        provider: m.provider,
        base_url: m.base_url,
        model: m.model,
        deployment: m.deployment,
        api_version: m.api_version,
        dimensions: m.dimensions.and_then(|d| u32::try_from(d).ok()),
        api_key,
    })
}

async fn active_ai_model_id(pool: &sqlx::SqlitePool) -> Result<Option<i64>, String> {
    Ok(storage::settings::get(pool, "ai.active_model_id")
        .await
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse().ok()))
}

async fn active_embedding_model_id(pool: &sqlx::SqlitePool) -> Result<Option<i64>, String> {
    Ok(storage::settings::get(pool, "embedding.active_model_id")
        .await
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse().ok()))
}

/// On first run after upgrade, copy the legacy single `ai.*` settings + keychain
/// blob into an `ai_models` row named "Default" and mark it active. Same for
/// embedding. Idempotent: no-op once `ai_models` / `embedding_models` is non-empty.
async fn migrate_legacy_ai_models(pool: &sqlx::SqlitePool) -> Result<(), String> {
    if storage::ai_models::count(pool).await.map_err(|e| e.to_string())? == 0 {
        let base_url_opt = storage::settings::get(pool, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?;
        let legacy_key = crypto::get_ai_key(pool).await?;
        if base_url_opt.is_some() || !legacy_key.is_empty() {
            let model = storage::settings::get(pool, "ai.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
            let enable_thinking = storage::settings::get(pool, "ai.enable_thinking")
                .await
                .map_err(|e| e.to_string())?
                .and_then(|s| match s.as_str() {
                    "1" => Some(1i64),
                    "0" => Some(0i64),
                    _ => None,
                });
            let m = storage::ai_models::AiModel {
                id: None,
                name: "Default".to_string(),
                base_url: base_url_opt.unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string()),
                model,
                enable_thinking,
                created_at: None,
            };
            let id = storage::ai_models::insert(pool, &m)
                .await
                .map_err(|e| e.to_string())?;
            if !legacy_key.is_empty() {
                crypto::set_ai_model_key(pool, id, &legacy_key).await?;
            }
            storage::settings::set(pool, "ai.active_model_id", &id.to_string())
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if storage::embedding_models::count(pool)
        .await
        .map_err(|e| e.to_string())?
        == 0
    {
        let base_url_opt = storage::settings::get(pool, "embedding.base_url")
            .await
            .map_err(|e| e.to_string())?;
        let legacy_key = crypto::get_embedding_key(pool).await?;
        if base_url_opt.is_some() || !legacy_key.is_empty() {
            let provider = storage::settings::get(pool, "embedding.provider")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_EMBEDDING_PROVIDER.to_string());
            let model = storage::settings::get(pool, "embedding.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_string());
            let deployment = storage::settings::get(pool, "embedding.deployment")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            let api_version = storage::settings::get(pool, "embedding.api_version")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            let dimensions = storage::settings::get(pool, "embedding.dimensions")
                .await
                .map_err(|e| e.to_string())?
                .and_then(|s| s.parse::<i64>().ok());
            let m = storage::embedding_models::EmbeddingModel {
                id: None,
                name: "Default".to_string(),
                provider,
                base_url: base_url_opt.unwrap_or_else(|| DEFAULT_EMBEDDING_BASE_URL.to_string()),
                model,
                deployment,
                api_version,
                dimensions,
                created_at: None,
            };
            let id = storage::embedding_models::insert(pool, &m)
                .await
                .map_err(|e| e.to_string())?;
            if !legacy_key.is_empty() {
                crypto::set_embedding_model_key(pool, id, &legacy_key).await?;
            }
            storage::settings::set(pool, "embedding.active_model_id", &id.to_string())
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn require_mysql_pool(
    state: &State<'_, AppState>,
    connection_id: i64,
) -> Result<MySqlPool, String> {
    let guard = state.active_pools.lock().await;
    guard
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| format!("Connection #{connection_id} is not open."))
}

#[tauri::command]
async fn repair_start(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    scope_tables: Option<Vec<String>>,
    goal: String,
) -> Result<storage::repair::RepairSession, String> {
    let mysql = require_mysql_pool(&state, connection_id).await?;
    let (cfg, key) = load_active_ai(&state.sqlite).await?;
    agent::repair::start_session(
        &state.sqlite,
        &mysql,
        &cfg,
        &key,
        connection_id,
        &database,
        scope_tables.as_deref(),
        &goal,
    )
    .await
}

#[tauri::command]
async fn repair_propose_strategy(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<storage::repair::RepairSession, String> {
    let session = storage::repair::get(&state.sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    let mysql = require_mysql_pool(&state, session.connection_id).await?;
    let (cfg, key) = load_active_ai(&state.sqlite).await?;
    agent::repair::propose_strategy(&state.sqlite, &mysql, &cfg, &key, session_id).await
}

#[tauri::command]
async fn repair_approve_strategy(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<storage::repair::RepairSession, String> {
    agent::repair::approve_strategy(&state.sqlite, session_id).await
}

#[tauri::command]
async fn repair_create_backup(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<storage::repair::RepairSession, String> {
    let session = storage::repair::get(&state.sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    let mysql = require_mysql_pool(&state, session.connection_id).await?;
    agent::repair::create_backup(&state.sqlite, &mysql, session_id).await
}

#[tauri::command]
async fn repair_execute(
    state: State<'_, AppState>,
    session_id: i64,
    confirm_text: String,
) -> Result<storage::repair::RepairSession, String> {
    let session = storage::repair::get(&state.sqlite, session_id)
        .await
        .map_err(|e| format!("session not found: {e}"))?;
    let mysql = require_mysql_pool(&state, session.connection_id).await?;
    agent::repair::execute(&state.sqlite, &mysql, session_id, &confirm_text).await
}

#[tauri::command]
async fn repair_cancel(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<storage::repair::RepairSession, String> {
    agent::repair::cancel(&state.sqlite, session_id).await
}

#[tauri::command]
async fn repair_get_session(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<storage::repair::RepairSession, String> {
    storage::repair::get(&state.sqlite, session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_repair_sessions(
    state: State<'_, AppState>,
    connection_id: i64,
    limit: Option<i64>,
) -> Result<Vec<storage::repair::RepairSession>, String> {
    storage::repair::list_by_connection(&state.sqlite, connection_id, limit.unwrap_or(20))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ProjectSchemaDiffResponse {
    report: diff::ProjectSchemaDiffReport,
    risk: Option<ai::MigrationRiskReport>,
    ai_error: Option<String>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_project_schema_diff(
    state: State<'_, AppState>,
    project_id: i64,
    source_connection_id: i64,
    source_db: String,
    target_connection_id: i64,
    target_db: String,
    include_ai: bool,
) -> Result<ProjectSchemaDiffResponse, String> {
    let pools_snapshot: HashMap<i64, MySqlPool> = {
        let guard = state.active_pools.lock().await;
        guard.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    let report = diff::collect_project_schema_diff(
        &state.sqlite,
        &pools_snapshot,
        project_id,
        source_connection_id,
        &source_db,
        target_connection_id,
        &target_db,
    )
    .await?;

    let mut risk = None;
    let mut ai_error = None;

    if include_ai && !report.diff.migrations.is_empty() {
        match load_active_ai(&state.sqlite).await {
            Ok((cfg, api_key)) => {
                let mut block = String::new();
                for (i, m) in report.diff.migrations.iter().enumerate() {
                    block.push_str(&format!("{i}. [{}] {}\n", m.kind, m.sql));
                }
                match ai::assess_migrations(&cfg, &api_key, &block).await {
                    Ok(r) => risk = Some(r),
                    Err(e) => ai_error = Some(e),
                }
            }
            Err(e) => ai_error = Some(e),
        }
    } else if include_ai {
        ai_error = Some("No migrations generated — AI risk assessment skipped.".into());
    }

    Ok(ProjectSchemaDiffResponse {
        report,
        risk,
        ai_error,
    })
}

#[derive(Serialize)]
struct ProjectSlowQueryResponse {
    report: perf::ProjectSlowQueryReport,
    ai_overview: Option<ai::ProjectSlowOverview>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn run_project_slow_queries(
    state: State<'_, AppState>,
    project_id: i64,
    per_conn_limit: Option<i64>,
    min_avg_ms: Option<f64>,
    include_ai: bool,
) -> Result<ProjectSlowQueryResponse, String> {
    let pools_snapshot: HashMap<i64, MySqlPool> = {
        let guard = state.active_pools.lock().await;
        guard.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    let limit = per_conn_limit.unwrap_or(200);
    let min = min_avg_ms.unwrap_or(0.0);
    let report = perf::collect_project_slow_queries(
        &state.sqlite,
        &pools_snapshot,
        project_id,
        limit,
        min,
    )
    .await?;

    let mut ai_overview = None;
    let mut ai_error = None;

    if include_ai {
        match load_active_ai(&state.sqlite).await {
            Ok((cfg, api_key)) => {
                let block = build_project_slow_block(&report);
                match ai::project_slow_overview(&cfg, &api_key, &block).await {
                    Ok(o) => ai_overview = Some(o),
                    Err(e) => ai_error = Some(e),
                }
            }
            Err(e) => ai_error = Some(e),
        }
    }

    Ok(ProjectSlowQueryResponse {
        report,
        ai_overview,
        ai_error,
    })
}

fn build_project_slow_block(r: &perf::ProjectSlowQueryReport) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "Project: `{}`", r.project_name);
    let _ = writeln!(
        out,
        "Scanned {} connection(s), {} slow rows total, {} matched project tables.",
        r.scanned_connection_ids.len(),
        r.total_scanned,
        r.total_matched
    );
    if !r.missing_connection_names.is_empty() {
        let _ = writeln!(
            out,
            "WARNING: connections closed (not scanned): {}",
            r.missing_connection_names.join(", ")
        );
    }
    if !r.scan_errors.is_empty() {
        let _ = writeln!(out, "Scan errors:");
        for e in &r.scan_errors {
            let _ = writeln!(out, "  [{}] {}", e.connection_name, e.error);
        }
    }
    let _ = writeln!(out, "\nMatched slow queries (top 30 by total_ms):");
    for (i, q) in r.queries.iter().take(30).enumerate() {
        let no_idx = if q.slow.no_index_used > 0 {
            " NO_INDEX"
        } else {
            ""
        };
        let _ = writeln!(
            out,
            "\n{}. [{}] {} (matched: {}){}",
            i + 1,
            q.connection_name,
            q.slow
                .schema_name
                .as_deref()
                .unwrap_or("(no schema)"),
            q.matched_tables.join(", "),
            no_idx
        );
        let _ = writeln!(
            out,
            "   count={} avg={:.1}ms max={:.1}ms total={:.1}ms rows_examined~{:.0} rows_sent~{:.0}",
            q.slow.count_star,
            q.slow.avg_ms,
            q.slow.max_ms,
            q.slow.total_ms,
            q.slow.avg_rows_examined,
            q.slow.avg_rows_sent
        );
        let dt = q.slow.digest_text.replace('\n', " ");
        let snippet = if dt.len() > 400 { &dt[..400] } else { &dt };
        let _ = writeln!(out, "   sql: {}", snippet);
    }
    out
}

#[derive(Serialize)]
struct ProjectDictionaryResponse {
    snapshot: dictionary::ProjectDictionarySnapshot,
    markdown: String,
    html: String,
    ai_summary: Option<String>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn export_project_dictionary(
    state: State<'_, AppState>,
    project_id: i64,
    include_ai: bool,
) -> Result<ProjectDictionaryResponse, String> {
    let pools_snapshot: HashMap<i64, MySqlPool> = {
        let guard = state.active_pools.lock().await;
        guard.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    let snapshot =
        dictionary::collect_project_dictionary(&state.sqlite, &pools_snapshot, project_id).await?;

    let mut ai_summary = None;
    let mut ai_error = None;

    if include_ai {
        if snapshot.tables.is_empty() {
            ai_error = Some("Project has no tables yet. Add tables in Edit project.".into());
        } else {
            match load_active_ai(&state.sqlite).await {
                Ok((cfg, api_key)) => {
                    let block = build_dictionary_block(&snapshot);
                    match ai::project_dictionary_summary(&cfg, &api_key, &block).await {
                        Ok(s) => ai_summary = Some(s),
                        Err(e) => ai_error = Some(e),
                    }
                }
                Err(e) => ai_error = Some(e),
            }
        }
    }

    let markdown = dictionary::render_markdown(&snapshot, ai_summary.as_deref());
    let html = dictionary::render_html(&snapshot, ai_summary.as_deref());

    Ok(ProjectDictionaryResponse {
        snapshot,
        markdown,
        html,
        ai_summary,
        ai_error,
    })
}

fn build_dictionary_block(s: &dictionary::ProjectDictionarySnapshot) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "Project: `{}`", s.project_name);
    if let Some(desc) = &s.project_description {
        if !desc.is_empty() {
            let _ = writeln!(out, "Description: {}", desc);
        }
    }
    let _ = writeln!(
        out,
        "Stats: {} tables, {} relations, {} annotated columns, {} PII columns",
        s.total_tables, s.total_relations, s.annotated_columns_count, s.pii_columns_count
    );
    if !s.missing_connection_names.is_empty() {
        let _ = writeln!(
            out,
            "WARNING: connections closed (partial data): {}",
            s.missing_connection_names.join(", ")
        );
    }
    let _ = writeln!(out, "\nCurated tables:");
    for t in &s.tables {
        let primary_mark = if t.is_primary { " ★PRIMARY" } else { "" };
        let closed_mark = if t.closed { " (closed)" } else { "" };
        let _ = writeln!(
            out,
            "\n- `{}`.`{}`{} via [{}]{}{}",
            t.database,
            t.table,
            primary_mark,
            t.connection_name,
            closed_mark,
            if t.comment.is_empty() {
                String::new()
            } else {
                format!(" — {}", t.comment)
            }
        );
        for c in &t.columns {
            let mut tags = Vec::new();
            if c.column_key == "PRI" {
                tags.push("PK".to_string());
            } else if !c.column_key.is_empty() {
                tags.push(c.column_key.clone());
            }
            if let Some(pii) = c.pii_type.as_deref().filter(|s| !s.is_empty()) {
                tags.push(format!("PII:{pii}"));
            }
            let tag_str = if tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", tags.join(","))
            };
            let role = c
                .semantic_role
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" role={s}"))
                .unwrap_or_default();
            let cmt = c
                .ai_comment
                .as_deref()
                .filter(|s| !s.is_empty())
                .or(Some(c.comment.as_str()).filter(|s| !s.is_empty()))
                .map(|s| format!(" -- {s}"))
                .unwrap_or_default();
            let _ = writeln!(out, "    {} {}{}{}{}", c.name, c.column_type, tag_str, role, cmt);
        }
    }
    let _ = writeln!(out, "\nCurated relations ({}):", s.relations.len());
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
            "  {}.{}.{} → {}.{}.{}  ({}, src={}){}",
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

#[derive(Serialize)]
struct ErDiagramResponse {
    snapshot: er::ErSnapshot,
    mermaid: String,
    ai_overview: Option<String>,
    ai_error: Option<String>,
}

const ER_CONNECTION_MAX_TABLES: usize = 80;

#[tauri::command]
async fn export_connection_er(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    tables: Option<Vec<String>>,
    include_ai: bool,
) -> Result<ErDiagramResponse, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let conn = storage::connection::get_by_id(&state.sqlite, connection_id)
        .await
        .map_err(|e| format!("load connection failed: {e}"))?;
    let conn_name = conn.name;

    let filter: Option<std::collections::BTreeSet<String>> =
        tables.map(|v| v.into_iter().collect());

    let snapshot = er::collect_connection_er(
        &state.sqlite,
        &pool,
        connection_id,
        &conn_name,
        &database,
        filter.as_ref(),
        ER_CONNECTION_MAX_TABLES,
    )
    .await?;

    let mut ai_overview = None;
    let mut ai_error = None;
    if include_ai {
        if snapshot.tables.is_empty() {
            ai_error = Some("No tables in scope.".into());
        } else {
            match load_active_ai(&state.sqlite).await {
                Ok((cfg, api_key)) => {
                    let block = er::build_ai_block(&snapshot);
                    match ai::er_diagram_overview(&cfg, &api_key, &block).await {
                        Ok(s) => ai_overview = Some(s),
                        Err(e) => ai_error = Some(e),
                    }
                }
                Err(e) => ai_error = Some(e),
            }
        }
    }

    let mermaid = er::render_mermaid(&snapshot);
    Ok(ErDiagramResponse {
        snapshot,
        mermaid,
        ai_overview,
        ai_error,
    })
}

#[tauri::command]
async fn export_project_er(
    state: State<'_, AppState>,
    project_id: i64,
    include_ai: bool,
) -> Result<ErDiagramResponse, String> {
    let pools_snapshot: HashMap<i64, MySqlPool> = {
        let guard = state.active_pools.lock().await;
        guard.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    let snapshot = er::collect_project_er(&state.sqlite, &pools_snapshot, project_id).await?;

    let mut ai_overview = None;
    let mut ai_error = None;
    if include_ai {
        if snapshot.tables.is_empty() {
            ai_error = Some("Project has no tables yet. Add tables in Edit project.".into());
        } else {
            match load_active_ai(&state.sqlite).await {
                Ok((cfg, api_key)) => {
                    let block = er::build_ai_block(&snapshot);
                    match ai::er_diagram_overview(&cfg, &api_key, &block).await {
                        Ok(s) => ai_overview = Some(s),
                        Err(e) => ai_error = Some(e),
                    }
                }
                Err(e) => ai_error = Some(e),
            }
        }
    }

    let mermaid = er::render_mermaid(&snapshot);
    Ok(ErDiagramResponse {
        snapshot,
        mermaid,
        ai_overview,
        ai_error,
    })
}

#[derive(Serialize)]
struct DeadlockAnalysisResponse {
    has_deadlock: bool,
    report: Option<deadlock::DeadlockReport>,
    status_truncated: bool,
    status_chars: usize,
    message: Option<String>,
    ai_analysis: Option<ai::DeadlockAnalysis>,
    ai_error: Option<String>,
}

#[tauri::command]
async fn analyze_deadlock(
    state: State<'_, AppState>,
    connection_id: i64,
    include_ai: bool,
) -> Result<DeadlockAnalysisResponse, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let (text, truncated) = deadlock::fetch_innodb_status(&pool).await?;
    let status_chars = text.len();
    let report = deadlock::parse_latest_deadlock(&text);

    let has_deadlock = report.is_some();
    let mut ai_analysis = None;
    let mut ai_error = None;

    let message = if !has_deadlock {
        Some(
            "No LATEST DETECTED DEADLOCK section found. Either the server has not had a deadlock \
             since startup, or its status output was truncated."
                .to_string(),
        )
    } else {
        None
    };

    if include_ai {
        if let Some(rep) = &report {
            match load_active_ai(&state.sqlite).await {
                Ok((cfg, api_key)) => {
                    let block = deadlock::build_ai_block(rep);
                    match ai::analyze_deadlock(&cfg, &api_key, &block).await {
                        Ok(a) => ai_analysis = Some(a),
                        Err(e) => ai_error = Some(e),
                    }
                }
                Err(e) => ai_error = Some(e),
            }
        }
    }

    Ok(DeadlockAnalysisResponse {
        has_deadlock,
        report,
        status_truncated: truncated,
        status_chars,
        message,
        ai_analysis,
        ai_error,
    })
}

#[tauri::command]
async fn get_innodb_status_raw(
    state: State<'_, AppState>,
    connection_id: i64,
) -> Result<String, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    let (text, _) = deadlock::fetch_innodb_status(&pool).await?;
    Ok(text)
}

// ---------- Cloud sync (S3) ---------- //

const APP_VERSION_FOR_SYNC: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
async fn sync_get_config(
    state: State<'_, AppState>,
) -> Result<sync::config::SyncConfigDisplay, String> {
    sync::config::load_display(&state.sqlite).await
}

#[tauri::command]
async fn sync_save_config(
    state: State<'_, AppState>,
    input: sync::config::SyncConfigInput,
) -> Result<(), String> {
    sync::config::save(&state.sqlite, &input).await?;
    // Verify by listing — surfaces wrong AK/SK / bucket / endpoint early.
    let cfg = sync::config::load_full(&state.sqlite).await?;
    sync::s3::list_devices(&cfg)
        .await
        .map_err(|e| format!("verify list: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn sync_clear_config(state: State<'_, AppState>) -> Result<(), String> {
    sync::config::clear(&state.sqlite).await
}

#[derive(Serialize)]
struct SyncPushResult {
    device_name: String,
    object_key: String,
    bytes: usize,
    pushed_at: String,
}

#[tauri::command]
async fn sync_push(state: State<'_, AppState>) -> Result<SyncPushResult, String> {
    let cfg = sync::config::load_full(&state.sqlite).await?;
    let disp = sync::config::load_display(&state.sqlite).await?;
    let snapshot =
        sync::snapshot::dump(&state.sqlite, &disp.device_name, APP_VERSION_FOR_SYNC).await?;
    let bytes = sync::bundle::pack(&snapshot)?;
    let key = sync::s3::build_key(&cfg.prefix, &disp.device_name);
    sync::s3::put_object(&cfg, &key, &bytes).await?;
    let now = chrono::Utc::now().to_rfc3339();
    sync::config::mark_pushed(&state.sqlite, &now).await?;
    Ok(SyncPushResult {
        device_name: disp.device_name,
        object_key: key,
        bytes: bytes.len(),
        pushed_at: now,
    })
}

#[tauri::command]
async fn sync_list_devices(
    state: State<'_, AppState>,
) -> Result<Vec<sync::s3::DeviceObject>, String> {
    let cfg = sync::config::load_full(&state.sqlite).await?;
    sync::s3::list_devices(&cfg).await
}

#[derive(Serialize)]
struct SyncPullPreview {
    device_name: String,
    meta: sync::bundle::BundleMeta,
    conflict_report: sync::snapshot::ConflictReport,
    snapshot: sync::snapshot::Snapshot,
}

#[tauri::command]
async fn sync_preview_pull(
    state: State<'_, AppState>,
    device_name: String,
) -> Result<SyncPullPreview, String> {
    let cfg = sync::config::load_full(&state.sqlite).await?;
    let key = sync::s3::build_key(&cfg.prefix, &device_name);
    let bytes = sync::s3::get_object(&cfg, &key).await?;
    let (meta, snapshot) = sync::bundle::unpack(&bytes)?;
    let conflict_report = sync::snapshot::diff(&state.sqlite, &snapshot).await?;
    Ok(SyncPullPreview {
        device_name,
        meta,
        conflict_report,
        snapshot,
    })
}

#[tauri::command]
async fn sync_apply_pull(
    state: State<'_, AppState>,
    device_name: String,
    snapshot: sync::snapshot::Snapshot,
    resolutions: sync::snapshot::ResolutionMap,
) -> Result<sync::snapshot::RestoreReport, String> {
    let report = sync::snapshot::restore(&state.sqlite, &snapshot, &resolutions).await?;
    let now = chrono::Utc::now().to_rfc3339();
    sync::config::mark_pulled(&state.sqlite, &now, &device_name).await?;
    Ok(report)
}

#[tauri::command]
async fn sync_delete_device(
    state: State<'_, AppState>,
    device_name: String,
) -> Result<(), String> {
    let cfg = sync::config::load_full(&state.sqlite).await?;
    let key = sync::s3::build_key(&cfg.prefix, &device_name);
    sync::s3::delete_object(&cfg, &key).await
}

// ---------- MCP settings commands ---------- //

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStatus {
    enabled: bool,
    bind_port: u16,
    read_only: bool,
    allowed_conn_ids: Vec<i64>,
    write_databases: Vec<storage::mcp_settings::WriteDbPerm>,
    running: bool,
    actual_port: u16,
    requires_restart: bool,
}

fn requires_restart(saved: &McpSettings) -> bool {
    let running = mcp::SERVER_RUNNING.load(std::sync::atomic::Ordering::SeqCst);
    let actual = mcp::SERVER_PORT.load(std::sync::atomic::Ordering::SeqCst);
    if saved.enabled != running {
        return true;
    }
    if saved.enabled && actual != saved.bind_port {
        return true;
    }
    false
}

#[tauri::command]
async fn get_mcp_status(state: State<'_, AppState>) -> Result<McpStatus, String> {
    let settings = storage::mcp_settings::get(&state.sqlite).await?;
    let running = mcp::SERVER_RUNNING.load(std::sync::atomic::Ordering::SeqCst);
    let actual_port = mcp::SERVER_PORT.load(std::sync::atomic::Ordering::SeqCst);
    let requires_restart = requires_restart(&settings);
    Ok(McpStatus {
        enabled: settings.enabled,
        bind_port: settings.bind_port,
        read_only: settings.read_only,
        allowed_conn_ids: settings.allowed_conn_ids,
        write_databases: settings.write_databases,
        running,
        actual_port,
        requires_restart,
    })
}

#[tauri::command]
async fn set_mcp_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<McpStatus, String> {
    let mut s = storage::mcp_settings::get(&state.sqlite).await?;
    s.enabled = enabled;
    storage::mcp_settings::save(&state.sqlite, &s).await?;
    get_mcp_status(state).await
}

#[tauri::command]
async fn set_mcp_port(
    state: State<'_, AppState>,
    port: u16,
) -> Result<McpStatus, String> {
    if port < 1024 {
        return Err("port must be >= 1024".to_string());
    }
    let mut s = storage::mcp_settings::get(&state.sqlite).await?;
    s.bind_port = port;
    storage::mcp_settings::save(&state.sqlite, &s).await?;
    get_mcp_status(state).await
}

#[tauri::command]
async fn set_mcp_allowed_conns(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<McpStatus, String> {
    let mut s = storage::mcp_settings::get(&state.sqlite).await?;
    s.allowed_conn_ids = ids.clone();
    storage::mcp_settings::save(&state.sqlite, &s).await?;
    // Live-update the shared snapshot — server picks it up on next request.
    *state.mcp_allowed_conns.write().await = ids;
    get_mcp_status(state).await
}

#[tauri::command]
async fn set_mcp_read_only(
    state: State<'_, AppState>,
    read_only: bool,
) -> Result<McpStatus, String> {
    let mut s = storage::mcp_settings::get(&state.sqlite).await?;
    s.read_only = read_only;
    storage::mcp_settings::save(&state.sqlite, &s).await?;
    get_mcp_status(state).await
}

#[tauri::command]
async fn set_mcp_write_databases(
    state: State<'_, AppState>,
    write_databases: Vec<storage::mcp_settings::WriteDbPerm>,
) -> Result<McpStatus, String> {
    let mut s = storage::mcp_settings::get(&state.sqlite).await?;
    // Drop empty-op grants so they don't linger as no-op rows.
    s.write_databases = write_databases
        .into_iter()
        .filter(|p| !p.ops.is_empty())
        .collect();
    storage::mcp_settings::save(&state.sqlite, &s).await?;
    get_mcp_status(state).await
}

#[tauri::command]
async fn get_mcp_token(state: State<'_, AppState>) -> Result<String, String> {
    crypto::ensure_mcp_token(&state.sqlite).await
}

#[tauri::command]
async fn regenerate_mcp_token(state: State<'_, AppState>) -> Result<String, String> {
    let token = crypto::generate_mcp_token();
    crypto::set_mcp_token(&state.sqlite, &token).await?;
    Ok(token)
}

#[tauri::command]
async fn get_table_structure(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
) -> Result<ddl::TableStructure, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    ddl::get_table_structure(&pool, &database, &table).await
}

#[tauri::command]
async fn generate_alter_sql(edit: ddl::TableEdit) -> Result<ddl::AlterPlan, String> {
    ddl::generate_alter_sql(&edit)
}

#[tauri::command]
async fn generate_create_sql(spec: ddl::TableStructure) -> Result<String, String> {
    ddl::generate_create_sql(&spec)
}

#[tauri::command]
async fn dump_database_schema(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
) -> Result<String, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    ddl::dump_database_schema(&pool, &database).await
}

#[tauri::command]
async fn save_query(
    state: State<'_, AppState>,
    connection_id: i64,
    name: String,
    sql: String,
) -> Result<storage::saved_query::SavedQuery, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if sql.trim().is_empty() {
        return Err("SQL cannot be empty".into());
    }
    storage::saved_query::create(&state.sqlite, connection_id, &name, &sql)
        .await
        .map_err(|e| format!("save query failed: {e}"))
}

#[tauri::command]
async fn list_saved_queries(
    state: State<'_, AppState>,
    connection_id: i64,
) -> Result<Vec<storage::saved_query::SavedQuery>, String> {
    storage::saved_query::list(&state.sqlite, connection_id)
        .await
        .map_err(|e| format!("list saved queries failed: {e}"))
}

#[tauri::command]
async fn list_saved_queries_for_connections(
    state: State<'_, AppState>,
    connection_ids: Vec<i64>,
) -> Result<Vec<storage::saved_query::SavedQuery>, String> {
    storage::saved_query::list_for_connections(&state.sqlite, &connection_ids)
        .await
        .map_err(|e| format!("list saved queries failed: {e}"))
}

#[tauri::command]
async fn update_saved_query(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    sql: String,
) -> Result<storage::saved_query::SavedQuery, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    storage::saved_query::update(&state.sqlite, id, &name, &sql)
        .await
        .map_err(|e| format!("update saved query failed: {e}"))
}

#[tauri::command]
async fn delete_saved_query(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    storage::saved_query::delete(&state.sqlite, id)
        .await
        .map_err(|e| format!("delete saved query failed: {e}"))
}

#[tauri::command]
async fn list_project_cache_mappings(
    state: State<'_, AppState>,
    project_id: i64,
) -> Result<Vec<storage::project_cache::ProjectCacheMapping>, String> {
    storage::project_cache::list(&state.sqlite, project_id)
        .await
        .map_err(|e| format!("list project cache mappings failed: {e}"))
}

#[tauri::command]
async fn create_project_cache_mapping(
    state: State<'_, AppState>,
    project_id: i64,
    mysql_connection_id: i64,
    mysql_database: String,
    mysql_table: String,
    redis_connection_id: i64,
    redis_db: i64,
    key_pattern: String,
    command: String,
    label: Option<String>,
) -> Result<storage::project_cache::ProjectCacheMapping, String> {
    let cmd = command.trim().to_uppercase();
    if !matches!(cmd.as_str(), "GET" | "HGETALL" | "LRANGE" | "SMEMBERS" | "ZRANGE") {
        return Err(format!("unsupported command `{cmd}`"));
    }
    if !(0..=15).contains(&redis_db) {
        return Err(format!("redis db must be 0..15, got {redis_db}"));
    }
    if cache::parse_placeholders(&key_pattern).is_empty() {
        return Err("key pattern must contain at least one `{column}` placeholder".to_string());
    }
    let lbl = label.as_deref().map(str::trim).filter(|s| !s.is_empty());
    storage::project_cache::create(
        &state.sqlite,
        project_id,
        mysql_connection_id,
        &mysql_database,
        &mysql_table,
        redis_connection_id,
        redis_db,
        key_pattern.trim(),
        &cmd,
        lbl,
    )
    .await
    .map_err(|e| format!("create project cache mapping failed: {e}"))
}

#[tauri::command]
async fn update_project_cache_mapping(
    state: State<'_, AppState>,
    id: i64,
    redis_db: i64,
    key_pattern: String,
    command: String,
    label: Option<String>,
) -> Result<storage::project_cache::ProjectCacheMapping, String> {
    let cmd = command.trim().to_uppercase();
    if !matches!(cmd.as_str(), "GET" | "HGETALL" | "LRANGE" | "SMEMBERS" | "ZRANGE") {
        return Err(format!("unsupported command `{cmd}`"));
    }
    if !(0..=15).contains(&redis_db) {
        return Err(format!("redis db must be 0..15, got {redis_db}"));
    }
    if cache::parse_placeholders(&key_pattern).is_empty() {
        return Err("key pattern must contain at least one `{column}` placeholder".to_string());
    }
    let lbl = label.as_deref().map(str::trim).filter(|s| !s.is_empty());
    storage::project_cache::update(
        &state.sqlite,
        id,
        redis_db,
        key_pattern.trim(),
        &cmd,
        lbl,
    )
    .await
    .map_err(|e| format!("update project cache mapping failed: {e}"))
}

#[tauri::command]
async fn delete_project_cache_mapping(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    storage::project_cache::delete(&state.sqlite, id)
        .await
        .map_err(|e| format!("delete project cache mapping failed: {e}"))
}

#[tauri::command]
async fn execute_ddl(
    state: State<'_, AppState>,
    connection_id: i64,
    sql: String,
) -> Result<ddl::ExecResult, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    ddl::execute_ddl(&pool, &sql).await
}

#[tauri::command]
async fn drop_table(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
    confirm_token: String,
) -> Result<ddl::ExecResult, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    ddl::drop_table(&pool, &database, &table, &confirm_token).await
}

#[tauri::command]
async fn ai_table_edit(
    state: State<'_, AppState>,
    current: ddl::TableStructure,
    instruction: String,
) -> Result<ai::TableEditProposal, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;
    ai::ai_table_edit(&cfg, &api_key, &current, &instruction).await
}

#[tauri::command]
async fn ai_create_table(
    state: State<'_, AppState>,
    database: String,
    instruction: String,
) -> Result<ai::TableCreateProposal, String> {
    let (cfg, api_key) = load_active_ai(&state.sqlite).await?;
    ai::ai_create_table(&cfg, &api_key, &database, &instruction).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("squiredb.db");

            llm_log::init(app_data_dir.join("logs"));
            eprintln!(
                "[LLM] log dir: {}",
                app_data_dir.join("logs").display()
            );

            let pool = tauri::async_runtime::block_on(async {
                storage::init_pool(&db_path).await
            })?;

            if let Err(e) = tauri::async_runtime::block_on(async {
                migrate_legacy_ai_models(&pool).await
            }) {
                eprintln!("[migration] legacy ai/embedding migration failed: {e}");
            }

            let active_pools = Arc::new(Mutex::new(HashMap::<i64, MySqlPool>::new()));

            // Seed allowlist from SQLite on boot so the Tauri command and the
            // MCP server start in sync. Shared Arc lets later edits propagate
            // to the server without a restart.
            let initial_settings = tauri::async_runtime::block_on(async {
                storage::mcp_settings::get(&pool).await
            })
            .unwrap_or_default();
            let mcp_allowed_conns =
                Arc::new(RwLock::new(initial_settings.allowed_conn_ids.clone()));

            // Boot MCP server if enabled. Token is seeded on first run.
            let mcp_sqlite = pool.clone();
            let mcp_pools = active_pools.clone();
            let mcp_allowed_for_server = mcp_allowed_conns.clone();
            let bind_port = initial_settings.bind_port;
            let enabled = initial_settings.enabled;
            tauri::async_runtime::spawn(async move {
                if !enabled {
                    eprintln!("[MCP] disabled in settings; not starting server");
                    return;
                }
                let token = match crypto::ensure_mcp_token(&mcp_sqlite).await {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("[MCP] failed to ensure token: {e}");
                        return;
                    }
                };
                if let Err(e) = mcp::serve(
                    bind_port,
                    token,
                    mcp_sqlite,
                    mcp_pools,
                    mcp_allowed_for_server,
                )
                .await
                {
                    eprintln!("[MCP] server exited: {e}");
                }
            });

            app.manage(AppState {
                sqlite: pool,
                active_pools,
                active_milvus: Mutex::new(HashMap::new()),
                active_sqlite: Mutex::new(HashMap::new()),
                active_redis: Mutex::new(HashMap::new()),
                running_queries: Arc::new(Mutex::new(HashMap::new())),
                mcp_allowed_conns,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mysql_ping,
            sqlite_ping,
            redis_ping,
            redis_scan,
            redis_get_value,
            redis_exec,
            list_connections,
            save_connection,
            delete_connection,
            get_connection_password,
            open_connection,
            list_open_connection_ids,
            close_connection,
            execute_query,
            cancel_query,
            update_cell,
            insert_row,
            delete_rows,
            list_databases,
            list_tables,
            list_ai_models,
            create_ai_model,
            update_ai_model,
            delete_ai_model,
            set_active_ai_model,
            get_active_ai_model,
            list_embedding_models,
            create_embedding_model,
            update_embedding_model,
            delete_embedding_model,
            set_active_embedding_model,
            get_active_embedding_model,
            embed_text,
            generate_sql,
            list_history,
            analyze_schema,
            list_annotations,
            list_relations,
            list_tables_for_ai,
            generate_table_comments,
            generate_ai_relations,
            generate_ai_relations_for_project,
            export_data_dictionary,
            list_projects,
            save_project,
            delete_project,
            list_project_tables,
            add_project_table,
            remove_project_table,
            set_project_primary_table,
            list_columns,
            list_table_meta,
            list_columns_meta,
            list_project_relations,
            add_project_relation,
            remove_project_relation,
            import_schema_relations_to_project,
            drill_project,
            list_drill_history,
            fix_sql_error,
            suggest_queries,
            suggest_chart,
            explain_sql,
            get_perf_status,
            list_slow_queries,
            recommend_indexes,
            list_processlist,
            kill_process,
            server_status,
            list_variables,
            compare_schemas,
            assess_migrations,
            run_health_check,
            run_onboarding,
            run_impact_analysis,
            run_project_briefing,
            run_project_health_check,
            run_project_impact,
            run_project_slow_queries,
            run_project_schema_diff,
            export_project_dictionary,
            export_connection_er,
            export_project_er,
            analyze_deadlock,
            get_innodb_status_raw,
            repair_start,
            repair_propose_strategy,
            repair_approve_strategy,
            repair_create_backup,
            repair_execute,
            repair_cancel,
            repair_get_session,
            list_repair_sessions,
            milvus_ping,
            milvus_list_databases,
            milvus_list_collections,
            milvus_describe_collection,
            milvus_search,
            milvus_query,
            get_mcp_status,
            set_mcp_enabled,
            set_mcp_port,
            set_mcp_allowed_conns,
            set_mcp_read_only,
            set_mcp_write_databases,
            get_mcp_token,
            regenerate_mcp_token,
            get_table_structure,
            generate_alter_sql,
            generate_create_sql,
            dump_database_schema,
            save_query,
            list_saved_queries,
            list_saved_queries_for_connections,
            update_saved_query,
            delete_saved_query,
            list_project_cache_mappings,
            create_project_cache_mapping,
            update_project_cache_mapping,
            delete_project_cache_mapping,
            execute_ddl,
            drop_table,
            ai_table_edit,
            ai_create_table,
            sync_get_config,
            sync_save_config,
            sync_clear_config,
            sync_push,
            sync_list_devices,
            sync_preview_pull,
            sync_apply_pull,
            sync_delete_device,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
