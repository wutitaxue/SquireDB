//! Project-level Redis cache lookup, driven by `project_cache_mappings`.
//!
//! Given a MySQL row that drill produced, we substitute placeholders in the
//! mapping's key pattern (e.g. `user:{id}`) with the row's column values and
//! issue the configured Redis command alongside a TTL probe.

use redis::aio::ConnectionManager;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

use crate::storage::project_cache::ProjectCacheMapping;

const COLLECTION_LIMIT: isize = 100;

#[derive(Debug, Serialize, Clone)]
pub struct ZsetEntry {
    pub member: String,
    pub score: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct CacheValue {
    pub mapping_id: i64,
    pub label: Option<String>,
    pub command: String,
    pub key: String,
    /// Redis TTL semantics: -1 no expiry, -2 no key, ≥0 seconds. None means
    /// the command failed before TTL could be probed.
    pub ttl_seconds: Option<i64>,
    pub exists: bool,
    pub truncated: bool,
    pub string_value: Option<String>,
    pub hash_value: Option<BTreeMap<String, String>>,
    pub list_value: Option<Vec<String>>,
    pub set_value: Option<Vec<String>>,
    pub zset_value: Option<Vec<ZsetEntry>>,
    pub error: Option<String>,
}

impl CacheValue {
    fn shell(mapping: &ProjectCacheMapping, key: String) -> Self {
        CacheValue {
            mapping_id: mapping.id,
            label: mapping.label.clone(),
            command: mapping.command.clone(),
            key,
            ttl_seconds: None,
            exists: false,
            truncated: false,
            string_value: None,
            hash_value: None,
            list_value: None,
            set_value: None,
            zset_value: None,
            error: None,
        }
    }

    fn with_error(mapping: &ProjectCacheMapping, key: String, err: String) -> Self {
        let mut v = Self::shell(mapping, key);
        v.error = Some(err);
        v
    }
}

/// Extract `{col}` placeholders in order of appearance.
pub fn parse_placeholders(pattern: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end_off) = pattern[i + 1..].find('}') {
                let name = &pattern[i + 1..i + 1 + end_off];
                if !name.is_empty() && !out.iter().any(|n: &String| n == name) {
                    out.push(name.to_string());
                }
                i += 1 + end_off + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Substitute `{col}` tokens with stringified row values. Returns Err for
/// missing or null placeholders — building a cache key from null is too
/// dangerous to do silently.
pub fn substitute(pattern: &str, row: &serde_json::Map<String, Value>) -> Result<String, String> {
    let placeholders = parse_placeholders(pattern);
    let mut filled = pattern.to_string();
    for name in &placeholders {
        let v = row
            .get(name)
            .ok_or_else(|| format!("missing column `{name}` in row"))?;
        let s = match v {
            Value::Null => {
                return Err(format!("column `{name}` is NULL — skip cache lookup"));
            }
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            other => other.to_string(),
        };
        filled = filled.replace(&format!("{{{name}}}"), &s);
    }
    Ok(filled)
}

/// Execute one cache mapping against the row. Always issues a TTL probe.
pub async fn fetch_one(
    mgr: &ConnectionManager,
    mapping: &ProjectCacheMapping,
    row: &serde_json::Map<String, Value>,
) -> CacheValue {
    let key = match substitute(&mapping.key_pattern, row) {
        Ok(k) => k,
        Err(e) => {
            return CacheValue::with_error(mapping, mapping.key_pattern.clone(), e);
        }
    };

    let cmd = mapping.command.to_uppercase();
    let mut value = CacheValue::shell(mapping, key.clone());

    let mut conn = mgr.clone();
    // ConnectionManager is shared across mappings, each of which may target a
    // different logical db — SELECT before every read so we land on the right
    // one. The pipe also batches the TTL probe in the same round-trip.
    let pipe_res: Result<((), i64), redis::RedisError> = redis::pipe()
        .cmd("SELECT")
        .arg(mapping.redis_db)
        .cmd("TTL")
        .arg(&key)
        .query_async(&mut conn)
        .await;
    let ttl_res = pipe_res.map(|(_, ttl)| ttl);
    value.ttl_seconds = ttl_res.ok();
    // -2 = key doesn't exist in redis (per `TTL` spec).
    value.exists = !matches!(value.ttl_seconds, Some(-2));

    if !value.exists {
        return value;
    }

    let result = match cmd.as_str() {
        "GET" => run_get(&mut conn, &key).await.map(|v| {
            value.string_value = v;
        }),
        "HGETALL" => run_hgetall(&mut conn, &key).await.map(|v| {
            value.hash_value = Some(v);
        }),
        "LRANGE" => run_lrange(&mut conn, &key).await.map(|(items, truncated)| {
            value.list_value = Some(items);
            value.truncated = truncated;
        }),
        "SMEMBERS" => run_smembers(&mut conn, &key).await.map(|(items, truncated)| {
            value.set_value = Some(items);
            value.truncated = truncated;
        }),
        "ZRANGE" => run_zrange(&mut conn, &key).await.map(|(items, truncated)| {
            value.zset_value = Some(items);
            value.truncated = truncated;
        }),
        other => Err(format!("unsupported command `{other}`")),
    };

    if let Err(e) = result {
        value.error = Some(e);
    }
    value
}

async fn run_get(conn: &mut ConnectionManager, key: &str) -> Result<Option<String>, String> {
    let out: Option<String> = redis::cmd("GET")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(out)
}

async fn run_hgetall(
    conn: &mut ConnectionManager,
    key: &str,
) -> Result<BTreeMap<String, String>, String> {
    let pairs: Vec<(String, String)> = redis::cmd("HGETALL")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(pairs.into_iter().collect())
}

async fn run_lrange(
    conn: &mut ConnectionManager,
    key: &str,
) -> Result<(Vec<String>, bool), String> {
    let total: i64 = redis::cmd("LLEN")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    let items: Vec<String> = redis::cmd("LRANGE")
        .arg(key)
        .arg(0)
        .arg(COLLECTION_LIMIT - 1)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    let truncated = total > COLLECTION_LIMIT as i64;
    Ok((items, truncated))
}

async fn run_smembers(
    conn: &mut ConnectionManager,
    key: &str,
) -> Result<(Vec<String>, bool), String> {
    let total: i64 = redis::cmd("SCARD")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    // SRANDMEMBER with positive count returns up to N distinct members; we
    // use it instead of SMEMBERS to cap the response size on huge sets.
    let items: Vec<String> = redis::cmd("SRANDMEMBER")
        .arg(key)
        .arg(COLLECTION_LIMIT)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    let truncated = total > COLLECTION_LIMIT as i64;
    Ok((items, truncated))
}

async fn run_zrange(
    conn: &mut ConnectionManager,
    key: &str,
) -> Result<(Vec<ZsetEntry>, bool), String> {
    let total: i64 = redis::cmd("ZCARD")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, f64)> = redis::cmd("ZRANGE")
        .arg(key)
        .arg(0)
        .arg(COLLECTION_LIMIT - 1)
        .arg("WITHSCORES")
        .query_async(conn)
        .await
        .map_err(|e| e.to_string())?;
    let truncated = total > COLLECTION_LIMIT as i64;
    Ok((
        pairs
            .into_iter()
            .map(|(member, score)| ZsetEntry { member, score })
            .collect(),
        truncated,
    ))
}
