mod agent;
mod ai;
mod analyze;
mod crypto;
mod deadlock;
mod dictionary;
mod diff;
mod er;
mod drill;
mod embed;
mod health;
mod llm_log;
mod milvus;
mod perf;
mod query;
mod storage;

use serde::Serialize;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::{MySqlPool, SqlitePool};
use std::collections::HashMap;
use std::fs;
use std::time::Duration;
use tauri::{Manager, State};
use tokio::sync::Mutex;

use query::QueryResult;
use storage::connection::Connection;

const DEFAULT_AI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_AI_MODEL: &str = "gpt-4o-mini";
const DEFAULT_EMBEDDING_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";

struct AppState {
    sqlite: SqlitePool,
    active_pools: Mutex<HashMap<i64, MySqlPool>>,
    active_milvus: Mutex<HashMap<i64, milvus::MilvusClient>>,
    // query_token -> (connection_id, mysql_thread_id) for in-flight queries
    running_queries: Mutex<HashMap<String, (i64, u64)>>,
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
    // Close active pools first (both MySQL and Milvus)
    if let Some(pool) = state.active_pools.lock().await.remove(&id) {
        pool.close().await;
    }
    state.active_milvus.lock().await.remove(&id);
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
    state.active_milvus.lock().await.remove(&id);
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

#[tauri::command]
async fn execute_query(
    state: State<'_, AppState>,
    id: i64,
    sql: String,
    query_token: Option<String>,
) -> Result<QueryResult, String> {
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "Connection not open. Click 'Open' first.".to_string())?;

    let result = if let Some(token) = query_token.as_ref() {
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

#[tauri::command]
async fn list_databases(state: State<'_, AppState>, id: i64) -> Result<Vec<String>, String> {
    if is_milvus(&state, id).await {
        let client = get_milvus_client(&state, id).await?;
        return client.list_databases().await;
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

#[derive(Serialize)]
struct AiConfigView {
    base_url: String,
    model: String,
    has_api_key: bool,
    enable_thinking: Option<bool>,
}

#[tauri::command]
async fn get_ai_config(state: State<'_, AppState>) -> Result<AiConfigView, String> {
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let has_api_key = crypto::has_ai_key(&state.sqlite).await;
    let enable_thinking = read_enable_thinking(&state.sqlite).await?;
    Ok(AiConfigView {
        base_url,
        model,
        has_api_key,
        enable_thinking,
    })
}

#[tauri::command]
async fn save_ai_config(
    state: State<'_, AppState>,
    base_url: String,
    model: String,
    api_key: String,
    enable_thinking: Option<bool>,
) -> Result<(), String> {
    storage::settings::set(&state.sqlite, "ai.base_url", &base_url)
        .await
        .map_err(|e| format!("save base_url failed: {e}"))?;
    storage::settings::set(&state.sqlite, "ai.model", &model)
        .await
        .map_err(|e| format!("save model failed: {e}"))?;
    match enable_thinking {
        Some(true) => storage::settings::set(&state.sqlite, "ai.enable_thinking", "1")
            .await
            .map_err(|e| format!("save enable_thinking failed: {e}"))?,
        Some(false) => storage::settings::set(&state.sqlite, "ai.enable_thinking", "0")
            .await
            .map_err(|e| format!("save enable_thinking failed: {e}"))?,
        None => {
            // explicit "follow model default" — clear the key so requests omit `thinking`
            sqlx::query("DELETE FROM settings WHERE key = ?")
                .bind("ai.enable_thinking")
                .execute(&state.sqlite)
                .await
                .map_err(|e| format!("clear enable_thinking failed: {e}"))?;
        }
    }
    if !api_key.is_empty() {
        crypto::set_ai_key(&state.sqlite, &api_key).await?;
    }
    Ok(())
}

#[derive(Serialize)]
struct EmbeddingConfigView {
    /// "openai" (OpenAI-compatible: OpenAI, DeepSeek-style, vLLM, Voyage, …)
    /// or "azure" (Azure OpenAI — deployment-scoped URL + api-key header).
    provider: String,
    base_url: String,
    /// OpenAI-only — the model name in the request body. Empty for Azure.
    model: String,
    /// Azure-only — deployment name baked into the request URL.
    deployment: String,
    /// Azure-only — `api-version` query string.
    api_version: String,
    /// Optional output dimension. OpenAI v3 family + Voyage accept it; older
    /// models reject the field, so we omit it when None.
    dimensions: Option<u32>,
    has_api_key: bool,
}

const DEFAULT_EMBEDDING_PROVIDER: &str = "openai";

#[tauri::command]
async fn get_embedding_config(
    state: State<'_, AppState>,
) -> Result<EmbeddingConfigView, String> {
    let provider = storage::settings::get(&state.sqlite, "embedding.provider")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_EMBEDDING_PROVIDER.to_string());
    let base_url = storage::settings::get(&state.sqlite, "embedding.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_EMBEDDING_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "embedding.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_string());
    let deployment = storage::settings::get(&state.sqlite, "embedding.deployment")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let api_version = storage::settings::get(&state.sqlite, "embedding.api_version")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let dimensions = storage::settings::get(&state.sqlite, "embedding.dimensions")
        .await
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<u32>().ok());
    let has_api_key = crypto::has_embedding_key(&state.sqlite).await;
    Ok(EmbeddingConfigView {
        provider,
        base_url,
        model,
        deployment,
        api_version,
        dimensions,
        has_api_key,
    })
}

#[tauri::command]
async fn save_embedding_config(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    model: String,
    deployment: String,
    api_version: String,
    dimensions: Option<u32>,
    api_key: String,
) -> Result<(), String> {
    storage::settings::set(&state.sqlite, "embedding.provider", &provider)
        .await
        .map_err(|e| format!("save embedding provider failed: {e}"))?;
    storage::settings::set(&state.sqlite, "embedding.base_url", &base_url)
        .await
        .map_err(|e| format!("save embedding base_url failed: {e}"))?;
    storage::settings::set(&state.sqlite, "embedding.model", &model)
        .await
        .map_err(|e| format!("save embedding model failed: {e}"))?;
    storage::settings::set(&state.sqlite, "embedding.deployment", &deployment)
        .await
        .map_err(|e| format!("save embedding deployment failed: {e}"))?;
    storage::settings::set(&state.sqlite, "embedding.api_version", &api_version)
        .await
        .map_err(|e| format!("save embedding api_version failed: {e}"))?;
    match dimensions {
        Some(d) => storage::settings::set(
            &state.sqlite,
            "embedding.dimensions",
            &d.to_string(),
        )
        .await
        .map_err(|e| format!("save embedding dimensions failed: {e}"))?,
        None => {
            sqlx::query("DELETE FROM settings WHERE key = ?")
                .bind("embedding.dimensions")
                .execute(&state.sqlite)
                .await
                .map_err(|e| format!("clear embedding dimensions failed: {e}"))?;
        }
    }
    if !api_key.is_empty() {
        crypto::set_embedding_key(&state.sqlite, &api_key).await?;
    }
    Ok(())
}

#[tauri::command]
async fn embed_text(
    state: State<'_, AppState>,
    text: String,
) -> Result<Vec<f32>, String> {
    let provider = storage::settings::get(&state.sqlite, "embedding.provider")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_EMBEDDING_PROVIDER.to_string());
    let base_url = storage::settings::get(&state.sqlite, "embedding.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_EMBEDDING_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "embedding.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_string());
    let deployment = storage::settings::get(&state.sqlite, "embedding.deployment")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let api_version = storage::settings::get(&state.sqlite, "embedding.api_version")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let dimensions = storage::settings::get(&state.sqlite, "embedding.dimensions")
        .await
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<u32>().ok());
    let api_key = crypto::get_embedding_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err(
            "Embedding API key not configured. Open AI Settings → Embedding tab to set it."
                .to_string(),
        );
    }

    let provider_kind = match provider.as_str() {
        "azure" => {
            if deployment.is_empty() {
                return Err("Azure provider requires a deployment name.".to_string());
            }
            if api_version.is_empty() {
                return Err("Azure provider requires an api-version.".to_string());
            }
            embed::Provider::Azure {
                deployment: &deployment,
                api_version: &api_version,
            }
        }
        _ => embed::Provider::OpenAi { model: &model },
    };
    embed::embed(provider_kind, &base_url, &api_key, &text, dimensions).await
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
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let schema_context = build_schema_context(&pool).await?;

    ai::generate_sql(
        &make_ai_config(&state.sqlite, base_url, model).await,
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
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let config = make_ai_config(&state.sqlite, base_url, model).await;
    analyze::generate_ai_relations(&pool, &state.sqlite, connection_id, &config, &api_key).await
}

#[tauri::command]
async fn generate_ai_relations_for_project(
    state: State<'_, AppState>,
    connection_id: i64,
    project_id: i64,
) -> Result<analyze::AiRelationsReport, String> {
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }
    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;
    let config = make_ai_config(&state.sqlite, base_url, model).await;
    analyze::generate_ai_relations_for_project(
        &pool,
        &state.sqlite,
        project_id,
        connection_id,
        &config,
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
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let config = make_ai_config(&state.sqlite, base_url, model).await;
    analyze::generate_table_comments(
        &pool,
        &state.sqlite,
        connection_id,
        &database,
        &table,
        &config,
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
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

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

    let config = make_ai_config(&state.sqlite, base_url, model).await;
    ai::suggest_chart(&config, &api_key, &block, &sample_json).await
}

#[tauri::command]
async fn suggest_queries(
    state: State<'_, AppState>,
    connection_id: i64,
    database: String,
    table: String,
) -> Result<Vec<ai::QuerySuggestion>, String> {
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

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

    let config = make_ai_config(&state.sqlite, base_url, model).await;
    let list = ai::suggest_queries(&config, &api_key, &database, &table, &block).await?;
    Ok(list.queries)
}

#[tauri::command]
async fn fix_sql_error(
    state: State<'_, AppState>,
    connection_id: i64,
    sql: String,
    error: String,
) -> Result<ai::SqlFixSuggestion, String> {
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

    let pool = state
        .active_pools
        .lock()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "Connection not open".to_string())?;

    let schema_context = build_schema_context(&pool).await?;
    let config = make_ai_config(&state.sqlite, base_url, model).await;
    ai::fix_sql_error(&config, &api_key, &schema_context, &sql, &error).await
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
    let result = drill::drill(
        &pools,
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
        let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
        let model = storage::settings::get(&state.sqlite, "ai.model")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        match crypto::get_ai_key(&state.sqlite).await {
            Ok(api_key) if !api_key.is_empty() => {
                let json_str = serde_json::to_string(&plan.raw_json).unwrap_or_default();
                let config = make_ai_config(&state.sqlite, base_url, model).await;
                match ai::explain_query(&config, &api_key, &sql, &json_str).await {
                    Ok(e) => explanation = Some(e),
                    Err(e) => ai_error = Some(e),
                }
            }
            _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

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

    let config = make_ai_config(&state.sqlite, base_url, model).await;
    ai::recommend_indexes(&config, &api_key, &sql, &block, &explain_json).await
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
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }

    let mut block = String::new();
    for (i, m) in migrations.iter().enumerate() {
        block.push_str(&format!("{i}. [{}] {}\n", m.kind, m.sql));
    }

    let config = make_ai_config(&state.sqlite, base_url, model).await;
    ai::assess_migrations(&config, &api_key, &block).await
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
        let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
        let model = storage::settings::get(&state.sqlite, "ai.model")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        match crypto::get_ai_key(&state.sqlite).await {
            Ok(api_key) if !api_key.is_empty() => {
                let summary = build_health_summary(&report);
                let config = make_ai_config(&state.sqlite, base_url, model).await;
                match ai::health_overview(&config, &api_key, &summary).await {
                    Ok(o) => ai_overview = Some(o),
                    Err(e) => ai_error = Some(e),
                }
            }
            _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
            let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
            let model = storage::settings::get(&state.sqlite, "ai.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
            match crypto::get_ai_key(&state.sqlite).await {
                Ok(api_key) if !api_key.is_empty() => {
                    let block = build_onboarding_block(&snapshot);
                    let config = make_ai_config(&state.sqlite, base_url, model).await;
                    match ai::onboarding_analysis(&config, &api_key, &block).await {
                        Ok(r) => report = Some(r),
                        Err(e) => ai_error = Some(e),
                    }
                }
                _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
        let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
        let model = storage::settings::get(&state.sqlite, "ai.model")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        match crypto::get_ai_key(&state.sqlite).await {
            Ok(api_key) if !api_key.is_empty() => {
                let block = build_impact_block(&report);
                let config = make_ai_config(&state.sqlite, base_url, model).await;
                match ai::impact_analysis(&config, &api_key, &block).await {
                    Ok(a) => assessment = Some(a),
                    Err(e) => ai_error = Some(e),
                }
            }
            _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
        let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
        let model = storage::settings::get(&state.sqlite, "ai.model")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        match crypto::get_ai_key(&state.sqlite).await {
            Ok(api_key) if !api_key.is_empty() => {
                let block = build_project_impact_block(&report);
                let config = make_ai_config(&state.sqlite, base_url, model).await;
                match ai::impact_analysis(&config, &api_key, &block).await {
                    Ok(a) => assessment = Some(a),
                    Err(e) => ai_error = Some(e),
                }
            }
            _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
        let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
        let model = storage::settings::get(&state.sqlite, "ai.model")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        match crypto::get_ai_key(&state.sqlite).await {
            Ok(api_key) if !api_key.is_empty() => {
                let summary = build_project_health_summary(&report);
                let config = make_ai_config(&state.sqlite, base_url, model).await;
                match ai::health_overview(&config, &api_key, &summary).await {
                    Ok(o) => ai_overview = Some(o),
                    Err(e) => ai_error = Some(e),
                }
            }
            _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
            let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
            let model = storage::settings::get(&state.sqlite, "ai.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
            match crypto::get_ai_key(&state.sqlite).await {
                Ok(api_key) if !api_key.is_empty() => {
                    let block = build_briefing_block(&snapshot);
                    let config = make_ai_config(&state.sqlite, base_url, model).await;
                    match ai::project_briefing(&config, &api_key, &block).await {
                        Ok(r) => report = Some(r),
                        Err(e) => ai_error = Some(e),
                    }
                }
                _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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

async fn read_enable_thinking(pool: &sqlx::SqlitePool) -> Result<Option<bool>, String> {
    let v = storage::settings::get(pool, "ai.enable_thinking")
        .await
        .map_err(|e| e.to_string())?;
    Ok(v.map(|s| s == "1" || s.eq_ignore_ascii_case("true")))
}

/// Construct an `AiConfig` given base_url + model already in scope, attaching the
/// user's persisted thinking-mode preference. All inline `AiConfig` constructions
/// in Tauri commands must go through this — otherwise the thinking switch silently
/// stops working for that caller (drift risk, per AUTO-MEMORY rule on shared funcs).
async fn make_ai_config(
    pool: &sqlx::SqlitePool,
    base_url: String,
    model: String,
) -> ai::AiConfig {
    let enable_thinking = read_enable_thinking(pool).await.ok().flatten();
    ai::AiConfig {
        base_url,
        model,
        enable_thinking,
    }
}

async fn ai_config_or_err(state: &State<'_, AppState>) -> Result<(ai::AiConfig, String), String> {
    let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
    let model = storage::settings::get(&state.sqlite, "ai.model")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    let enable_thinking = read_enable_thinking(&state.sqlite).await?;
    let api_key = crypto::get_ai_key(&state.sqlite).await?;
    if api_key.is_empty() {
        return Err("API key not set. Open Settings (⚙) to configure.".into());
    }
    Ok((
        ai::AiConfig {
            base_url,
            model,
            enable_thinking,
        },
        api_key,
    ))
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
    let (cfg, key) = ai_config_or_err(&state).await?;
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
    let (cfg, key) = ai_config_or_err(&state).await?;
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
        let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
        let model = storage::settings::get(&state.sqlite, "ai.model")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        match crypto::get_ai_key(&state.sqlite).await {
            Ok(api_key) if !api_key.is_empty() => {
                let mut block = String::new();
                for (i, m) in report.diff.migrations.iter().enumerate() {
                    block.push_str(&format!("{i}. [{}] {}\n", m.kind, m.sql));
                }
                let config = make_ai_config(&state.sqlite, base_url, model).await;
                match ai::assess_migrations(&config, &api_key, &block).await {
                    Ok(r) => risk = Some(r),
                    Err(e) => ai_error = Some(e),
                }
            }
            _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
        let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
        let model = storage::settings::get(&state.sqlite, "ai.model")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        match crypto::get_ai_key(&state.sqlite).await {
            Ok(api_key) if !api_key.is_empty() => {
                let block = build_project_slow_block(&report);
                let config = make_ai_config(&state.sqlite, base_url, model).await;
                match ai::project_slow_overview(&config, &api_key, &block).await {
                    Ok(o) => ai_overview = Some(o),
                    Err(e) => ai_error = Some(e),
                }
            }
            _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
            let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
            let model = storage::settings::get(&state.sqlite, "ai.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
            match crypto::get_ai_key(&state.sqlite).await {
                Ok(api_key) if !api_key.is_empty() => {
                    let block = build_dictionary_block(&snapshot);
                    let config = make_ai_config(&state.sqlite, base_url, model).await;
                    match ai::project_dictionary_summary(&config, &api_key, &block).await {
                        Ok(s) => ai_summary = Some(s),
                        Err(e) => ai_error = Some(e),
                    }
                }
                _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
            let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
            let model = storage::settings::get(&state.sqlite, "ai.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
            match crypto::get_ai_key(&state.sqlite).await {
                Ok(api_key) if !api_key.is_empty() => {
                    let block = er::build_ai_block(&snapshot);
                    let config = make_ai_config(&state.sqlite, base_url, model).await;
                    match ai::er_diagram_overview(&config, &api_key, &block).await {
                        Ok(s) => ai_overview = Some(s),
                        Err(e) => ai_error = Some(e),
                    }
                }
                _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
            let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
            let model = storage::settings::get(&state.sqlite, "ai.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
            match crypto::get_ai_key(&state.sqlite).await {
                Ok(api_key) if !api_key.is_empty() => {
                    let block = er::build_ai_block(&snapshot);
                    let config = make_ai_config(&state.sqlite, base_url, model).await;
                    match ai::er_diagram_overview(&config, &api_key, &block).await {
                        Ok(s) => ai_overview = Some(s),
                        Err(e) => ai_error = Some(e),
                    }
                }
                _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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
            let base_url = storage::settings::get(&state.sqlite, "ai.base_url")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string());
            let model = storage::settings::get(&state.sqlite, "ai.model")
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
            match crypto::get_ai_key(&state.sqlite).await {
                Ok(api_key) if !api_key.is_empty() => {
                    let block = deadlock::build_ai_block(rep);
                    let config = make_ai_config(&state.sqlite, base_url, model).await;
                    match ai::analyze_deadlock(&config, &api_key, &block).await {
                        Ok(a) => ai_analysis = Some(a),
                        Err(e) => ai_error = Some(e),
                    }
                }
                _ => ai_error = Some("API key not set. Open Settings (⚙) to configure.".into()),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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

            app.manage(AppState {
                sqlite: pool,
                active_pools: Mutex::new(HashMap::new()),
                active_milvus: Mutex::new(HashMap::new()),
                running_queries: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mysql_ping,
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
            get_ai_config,
            save_ai_config,
            get_embedding_config,
            save_embedding_config,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
