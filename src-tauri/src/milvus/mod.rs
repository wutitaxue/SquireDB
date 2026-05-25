//! Milvus 2.4+ v2 REST client.
//!
//! Endpoint format:
//!   - "https://foo.zillizcloud.com:19541" or "http://localhost:19530" (scheme respected)
//!   - "localhost" + port 19530 → "http://localhost:19530"
//!
//! Auth header: `Authorization: Bearer <token>` where token is:
//!   - the raw API key (Zilliz Cloud), OR
//!   - "user:password" for self-hosted clusters with auth enabled.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct MilvusClient {
    base: String,
    token: Option<String>,
    db_name: Option<String>,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionField {
    pub name: String,
    pub data_type: String,
    pub is_primary: bool,
    pub auto_id: bool,
    pub nullable: bool,
    /// Vector dim if applicable, else None.
    pub dim: Option<u32>,
    pub description: String,
    /// element_type for ARRAY types.
    pub element_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionIndex {
    pub field_name: String,
    pub index_name: String,
    pub index_type: String,
    pub metric_type: Option<String>,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionDescription {
    pub name: String,
    pub description: String,
    pub fields: Vec<CollectionField>,
    pub indexes: Vec<CollectionIndex>,
    pub row_count: Option<u64>,
    pub auto_id: bool,
    pub enable_dynamic_field: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub fields: serde_json::Map<String, Value>,
    pub distance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResponse {
    pub rows: Vec<serde_json::Map<String, Value>>,
    pub elapsed_ms: u128,
}

impl MilvusClient {
    pub fn new(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: Option<&str>,
    ) -> Result<Self, String> {
        let base = build_base_url(host, port);
        let token = build_token(username, password);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| format!("milvus http client init failed: {e}"))?;

        Ok(MilvusClient {
            base,
            token,
            db_name: database.filter(|s| !s.is_empty()).map(|s| s.to_string()),
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn add_db<'a>(&self, mut payload: serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
        // Always include dbName; some Milvus versions require it explicitly.
        let db = self
            .db_name
            .clone()
            .unwrap_or_else(|| "default".to_string());
        payload.insert("dbName".to_string(), Value::String(db));
        payload
    }

    fn add_db_override(
        &self,
        mut payload: serde_json::Map<String, Value>,
        db_override: Option<&str>,
    ) -> serde_json::Map<String, Value> {
        let db = db_override
            .map(|s| s.to_string())
            .or_else(|| self.db_name.clone())
            .unwrap_or_else(|| "default".to_string());
        payload.insert("dbName".to_string(), Value::String(db));
        payload
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let mut req = self.http.post(self.url(path));
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        req = req.header("Content-Type", "application/json").json(&body);

        let resp = req
            .send()
            .await
            .map_err(|e| format!("milvus request failed: {e}"))?;

        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("milvus read body failed: {e}"))?;

        if !status.is_success() {
            let text = String::from_utf8_lossy(&bytes);
            return Err(format!("milvus http {status}: {text}"));
        }

        let v: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("milvus parse json failed: {e}"))?;

        let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code != 0 {
            let msg = v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("(no message)");
            return Err(format!("milvus error code={code}: {msg}"));
        }

        Ok(v.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Lightweight handshake — call list collections.
    pub async fn ping(&self) -> Result<String, String> {
        let data = self
            .post("/v2/vectordb/collections/list", Value::Object(self.add_db(serde_json::Map::new())))
            .await?;
        let count = data.as_array().map(|a| a.len()).unwrap_or(0);
        Ok(format!("Connected. {count} collection(s) found."))
    }

    pub async fn list_databases(&self) -> Result<Vec<String>, String> {
        // Milvus 2.4+ exposes /v2/vectordb/databases/list. Earlier versions
        // 404 — fall back to ["default"] gracefully.
        let result = self
            .post("/v2/vectordb/databases/list", Value::Object(serde_json::Map::new()))
            .await;
        let data = match result {
            Ok(v) => v,
            Err(_) => return Ok(vec!["default".to_string()]),
        };
        let arr: Vec<Value> = if let Some(a) = data.as_array() {
            a.clone()
        } else if let Some(a) = data.get("databases").and_then(|v| v.as_array()) {
            a.clone()
        } else if let Some(a) = data.get("dbNames").and_then(|v| v.as_array()) {
            a.clone()
        } else {
            Vec::new()
        };
        let mut out: Vec<String> = arr
            .iter()
            .filter_map(|v| {
                v.as_str().map(|s| s.to_string()).or_else(|| {
                    v.get("name")
                        .or_else(|| v.get("dbName"))
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                })
            })
            .collect();
        if out.is_empty() {
            out.push("default".to_string());
        }
        out.sort();
        Ok(out)
    }

    pub async fn list_collections_in(
        &self,
        db_override: Option<&str>,
    ) -> Result<Vec<CollectionInfo>, String> {
        let mut payload = serde_json::Map::new();
        let db = db_override
            .map(|s| s.to_string())
            .or_else(|| self.db_name.clone())
            .unwrap_or_else(|| "default".to_string());
        payload.insert("dbName".to_string(), Value::String(db.clone()));

        let data = self
            .post("/v2/vectordb/collections/list", Value::Object(payload))
            .await?;
        parse_collection_list(&data, &db)
    }

    pub async fn list_collections(&self) -> Result<Vec<CollectionInfo>, String> {
        let db = self
            .db_name
            .clone()
            .unwrap_or_else(|| "default".to_string());
        self.list_collections_in(Some(&db)).await
    }

    pub async fn describe_collection_in(
        &self,
        name: &str,
        db_override: Option<&str>,
    ) -> Result<CollectionDescription, String> {
        let mut payload = serde_json::Map::new();
        payload.insert("collectionName".to_string(), Value::String(name.to_string()));
        let payload = self.add_db_override(payload, db_override);

        let data = self
            .post("/v2/vectordb/collections/describe", Value::Object(payload))
            .await?;

        let description = data
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let auto_id = data.get("autoId").and_then(|v| v.as_bool()).unwrap_or(false);
        let enable_dynamic_field = data
            .get("enableDynamicField")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let fields_raw = data
            .get("fields")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut fields = Vec::with_capacity(fields_raw.len());
        for f in fields_raw {
            fields.push(parse_field(&f));
        }

        let indexes_raw = data
            .get("indexes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut indexes = Vec::with_capacity(indexes_raw.len());
        for idx in indexes_raw {
            indexes.push(parse_index(&idx));
        }

        // Best-effort stats (some Milvus versions/permissions may not allow this).
        let row_count = self
            .try_get_row_count(name, db_override)
            .await
            .ok()
            .flatten();

        Ok(CollectionDescription {
            name: name.to_string(),
            description,
            fields,
            indexes,
            row_count,
            auto_id,
            enable_dynamic_field,
        })
    }

    async fn try_get_row_count(
        &self,
        name: &str,
        db_override: Option<&str>,
    ) -> Result<Option<u64>, String> {
        let mut payload = serde_json::Map::new();
        payload.insert("collectionName".to_string(), Value::String(name.to_string()));
        let payload = self.add_db_override(payload, db_override);
        let data = self
            .post("/v2/vectordb/collections/get_stats", Value::Object(payload))
            .await?;
        let row_count = data
            .get("rowCount")
            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
        Ok(row_count)
    }

    pub async fn search(
        &self,
        collection: &str,
        vector: Vec<f64>,
        anns_field: Option<&str>,
        limit: u32,
        filter: Option<&str>,
        output_fields: Option<Vec<String>>,
        db_override: Option<&str>,
    ) -> Result<SearchResponse, String> {
        let started = std::time::Instant::now();

        let mut payload = serde_json::Map::new();
        payload.insert("collectionName".to_string(), Value::String(collection.to_string()));
        payload.insert("data".to_string(), json!([vector]));
        payload.insert("limit".to_string(), Value::from(limit));
        if let Some(af) = anns_field.filter(|s| !s.is_empty()) {
            payload.insert("annsField".to_string(), Value::String(af.to_string()));
        }
        if let Some(f) = filter.filter(|s| !s.trim().is_empty()) {
            payload.insert("filter".to_string(), Value::String(f.to_string()));
        }
        if let Some(of) = output_fields {
            payload.insert(
                "outputFields".to_string(),
                Value::Array(of.into_iter().map(Value::String).collect()),
            );
        }
        let payload = self.add_db_override(payload, db_override);

        let data = self
            .post("/v2/vectordb/entities/search", Value::Object(payload))
            .await?;

        let mut hits = Vec::new();
        if let Some(arr) = data.as_array() {
            for v in arr {
                let distance = v
                    .get("distance")
                    .and_then(|d| d.as_f64())
                    .unwrap_or(0.0);
                let mut fields = serde_json::Map::new();
                if let Some(obj) = v.as_object() {
                    for (k, val) in obj {
                        if k == "distance" {
                            continue;
                        }
                        fields.insert(k.clone(), val.clone());
                    }
                }
                hits.push(SearchHit { fields, distance });
            }
        }

        Ok(SearchResponse {
            hits,
            elapsed_ms: started.elapsed().as_millis(),
        })
    }

    pub async fn query(
        &self,
        collection: &str,
        filter: &str,
        output_fields: Option<Vec<String>>,
        limit: u32,
        db_override: Option<&str>,
    ) -> Result<QueryResponse, String> {
        let started = std::time::Instant::now();

        let mut payload = serde_json::Map::new();
        payload.insert("collectionName".to_string(), Value::String(collection.to_string()));
        payload.insert("filter".to_string(), Value::String(filter.to_string()));
        payload.insert("limit".to_string(), Value::from(limit));
        if let Some(of) = output_fields {
            payload.insert(
                "outputFields".to_string(),
                Value::Array(of.into_iter().map(Value::String).collect()),
            );
        }
        let payload = self.add_db_override(payload, db_override);

        let data = self
            .post("/v2/vectordb/entities/query", Value::Object(payload))
            .await?;

        let mut rows = Vec::new();
        if let Some(arr) = data.as_array() {
            for v in arr {
                if let Some(obj) = v.as_object() {
                    rows.push(obj.clone());
                }
            }
        }

        Ok(QueryResponse {
            rows,
            elapsed_ms: started.elapsed().as_millis(),
        })
    }
}

fn build_base_url(host: &str, port: u16) -> String {
    let h = host.trim().trim_end_matches('/');
    if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else {
        format!("http://{h}:{port}")
    }
}

/// Build the Bearer token value.
/// - empty user → password is the raw token (Zilliz Cloud)
/// - non-empty user → "user:password" (self-hosted with auth)
/// - both empty → no auth (self-hosted no-auth dev cluster)
fn build_token(user: &str, password: &str) -> Option<String> {
    let user = user.trim();
    let password = password;
    if user.is_empty() && password.is_empty() {
        None
    } else if user.is_empty() {
        Some(password.to_string())
    } else {
        Some(format!("{user}:{password}"))
    }
}

fn parse_field(f: &Value) -> CollectionField {
    let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let data_type = f
        .get("type")
        .or_else(|| f.get("dataType"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let is_primary = f
        .get("primaryKey")
        .or_else(|| f.get("isPrimary"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let auto_id = f.get("autoID").or_else(|| f.get("autoId")).and_then(|v| v.as_bool()).unwrap_or(false);
    let nullable = f.get("nullable").and_then(|v| v.as_bool()).unwrap_or(false);
    let description = f
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let element_type = f
        .get("elementType")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // dim may live in elementTypeParams.dim, params.dim, or top-level dim.
    let dim = f
        .get("dim")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            f.get("elementTypeParams")
                .and_then(|p| p.get("dim"))
                .and_then(|d| d.as_u64().or_else(|| d.as_str().and_then(|s| s.parse().ok())))
        })
        .or_else(|| {
            f.get("params")
                .and_then(|p| p.get("dim"))
                .and_then(|d| d.as_u64().or_else(|| d.as_str().and_then(|s| s.parse().ok())))
        })
        .map(|n| n as u32);

    CollectionField {
        name,
        data_type,
        is_primary,
        auto_id,
        nullable,
        dim,
        description,
        element_type,
    }
}

/// Parse list-collections response. Handles:
///   data: ["c1", "c2"]                          (2.4 standard)
///   data: [{"name": "c1"}, ...]
///   data: [{"collectionName": "c1"}, ...]
///   data: {"collections": [...]}                (older proxies)
fn parse_collection_list(data: &Value, db: &str) -> Result<Vec<CollectionInfo>, String> {
    let arr: Vec<Value> = if let Some(a) = data.as_array() {
        a.clone()
    } else if let Some(a) = data.get("collections").and_then(|v| v.as_array()) {
        a.clone()
    } else {
        Vec::new()
    };

    let mut out = Vec::new();
    for v in &arr {
        let name = if let Some(s) = v.as_str() {
            Some(s.to_string())
        } else {
            v.get("name")
                .or_else(|| v.get("collectionName"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        };
        if let Some(n) = name {
            out.push(CollectionInfo { name: n });
        }
    }

    if out.is_empty() {
        eprintln!(
            "[Milvus] list_collections (db={}) returned 0 entries. raw = {}",
            db,
            serde_json::to_string(data).unwrap_or_default()
        );
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn parse_index(idx: &Value) -> CollectionIndex {
    CollectionIndex {
        field_name: idx
            .get("fieldName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        index_name: idx
            .get("indexName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        index_type: idx
            .get("indexType")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        metric_type: idx
            .get("metricType")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        params: idx.get("params").cloned().unwrap_or(Value::Null),
    }
}
