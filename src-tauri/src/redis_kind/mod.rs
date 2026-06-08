use redis::aio::ConnectionManager;
use redis::{Client, Value as RedisValue};
use serde::Serialize;

pub async fn build_manager(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> Result<ConnectionManager, redis::RedisError> {
    // We always open at db 0; per-request SELECT in a pipeline switches db.
    // This lets one ConnectionManager serve multi-db browsing without keeping
    // separate connections per db.
    let url = match (username.is_empty(), password.is_empty()) {
        (true, true) => format!("redis://{host}:{port}"),
        (true, false) => format!("redis://:{}@{host}:{port}", urlencode(password)),
        // username without password is rare but supported by ACL "nopass" users.
        (false, true) => format!("redis://{}@{host}:{port}", urlencode(username)),
        (false, false) => format!(
            "redis://{}:{}@{host}:{port}",
            urlencode(username),
            urlencode(password)
        ),
    };
    let client = Client::open(url)?;
    ConnectionManager::new(client).await
}

fn urlencode(s: &str) -> String {
    // Percent-encode characters that would break the redis URL.
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
}

pub async fn ping(mgr: &ConnectionManager, db: u8) -> Result<String, String> {
    let mut conn = mgr.clone();
    let (_, resp): ((), String) = redis::pipe()
        .cmd("SELECT").arg(db)
        .cmd("PING")
        .query_async(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp)
}

pub async fn scan(
    mgr: &ConnectionManager,
    db: u8,
    pattern: &str,
    cursor: u64,
    count: u32,
) -> Result<(u64, Vec<String>), String> {
    let mut conn = mgr.clone();
    let (_, (next, keys)): ((), (u64, Vec<String>)) = redis::pipe()
        .cmd("SELECT").arg(db)
        .cmd("SCAN").arg(cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(count)
        .query_async(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok((next, keys))
}

pub async fn key_type(mgr: &ConnectionManager, db: u8, key: &str) -> Result<String, String> {
    let mut conn = mgr.clone();
    let (_, t): ((), String) = redis::pipe()
        .cmd("SELECT").arg(db)
        .cmd("TYPE").arg(key)
        .query_async(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(t)
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum KeyValue {
    String { value: String },
    List { values: Vec<String>, truncated: bool, total: i64 },
    Set { values: Vec<String>, truncated: bool, total: i64 },
    Hash { entries: Vec<(String, String)>, truncated: bool, total: i64 },
    Zset { entries: Vec<(String, f64)>, truncated: bool, total: i64 },
    None,
    Other { type_name: String },
}

const VALUE_PREVIEW_LIMIT: i64 = 200;

pub async fn get_value(
    mgr: &ConnectionManager,
    db: u8,
    key: &str,
) -> Result<KeyValue, String> {
    let t = key_type(mgr, db, key).await?;
    let mut conn = mgr.clone();
    let limit = VALUE_PREVIEW_LIMIT;

    match t.as_str() {
        "string" => {
            let (_, v): ((), Option<String>) = redis::pipe()
                .cmd("SELECT").arg(db)
                .cmd("GET").arg(key)
                .query_async(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(KeyValue::String { value: v.unwrap_or_default() })
        }
        "list" => {
            let (_, total, values): ((), i64, Vec<String>) = redis::pipe()
                .cmd("SELECT").arg(db)
                .cmd("LLEN").arg(key)
                .cmd("LRANGE").arg(key).arg(0).arg(limit - 1)
                .query_async(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(KeyValue::List {
                truncated: total > limit,
                total,
                values,
            })
        }
        "set" => {
            let (_, total, values): ((), i64, Vec<String>) = redis::pipe()
                .cmd("SELECT").arg(db)
                .cmd("SCARD").arg(key)
                .cmd("SRANDMEMBER").arg(key).arg(limit)
                .query_async(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(KeyValue::Set {
                truncated: total > limit,
                total,
                values,
            })
        }
        "hash" => {
            let (_, total, entries): ((), i64, Vec<(String, String)>) = redis::pipe()
                .cmd("SELECT").arg(db)
                .cmd("HLEN").arg(key)
                .cmd("HGETALL").arg(key)
                .query_async(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            let total_i = total;
            let truncated = (entries.len() as i64) > limit;
            let limited: Vec<(String, String)> =
                entries.into_iter().take(limit as usize).collect();
            Ok(KeyValue::Hash {
                truncated,
                total: total_i,
                entries: limited,
            })
        }
        "zset" => {
            let (_, total, raw): ((), i64, Vec<(String, f64)>) = redis::pipe()
                .cmd("SELECT").arg(db)
                .cmd("ZCARD").arg(key)
                .cmd("ZRANGE").arg(key).arg(0).arg(limit - 1).arg("WITHSCORES")
                .query_async(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(KeyValue::Zset {
                truncated: total > limit,
                total,
                entries: raw,
            })
        }
        "none" => Ok(KeyValue::None),
        other => Ok(KeyValue::Other { type_name: other.to_string() }),
    }
}

pub async fn exec_command(
    mgr: &ConnectionManager,
    db: u8,
    cmd_text: &str,
) -> Result<serde_json::Value, String> {
    let parts = tokenize_command(cmd_text)?;
    if parts.is_empty() {
        return Err("empty command".into());
    }
    let head = parts[0].to_uppercase();
    if head == "SELECT" {
        return Err(
            "explicit SELECT not allowed; use the DB picker. Each command is auto-scoped to the selected db."
                .into(),
        );
    }

    let mut conn = mgr.clone();
    let mut cmd = redis::cmd(&parts[0]);
    for p in &parts[1..] {
        cmd.arg(p.as_bytes());
    }

    let (_, resp): ((), RedisValue) = redis::pipe()
        .cmd("SELECT").arg(db)
        .add_command(cmd)
        .query_async(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(redis_value_to_json(resp))
}

fn redis_value_to_json(v: RedisValue) -> serde_json::Value {
    match v {
        RedisValue::Nil => serde_json::Value::Null,
        RedisValue::Int(i) => serde_json::Value::from(i),
        RedisValue::BulkString(bytes) => match String::from_utf8(bytes) {
            Ok(s) => serde_json::Value::String(s),
            Err(e) => serde_json::Value::String(format!("<binary {} bytes>", e.as_bytes().len())),
        },
        RedisValue::SimpleString(s) => serde_json::Value::String(s),
        RedisValue::Okay => serde_json::Value::String("OK".into()),
        RedisValue::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(redis_value_to_json).collect())
        }
        RedisValue::Set(arr) => {
            serde_json::Value::Array(arr.into_iter().map(redis_value_to_json).collect())
        }
        RedisValue::Map(pairs) => {
            let mut obj = serde_json::Map::new();
            for (k, val) in pairs {
                let key_str = match redis_value_to_json(k) {
                    serde_json::Value::String(s) => s,
                    other => other.to_string(),
                };
                obj.insert(key_str, redis_value_to_json(val));
            }
            serde_json::Value::Object(obj)
        }
        RedisValue::Double(f) => serde_json::Value::from(f),
        RedisValue::Boolean(b) => serde_json::Value::from(b),
        RedisValue::VerbatimString { text, .. } => serde_json::Value::String(text),
        RedisValue::BigNumber(n) => serde_json::Value::String(n.to_string()),
        other => serde_json::Value::String(format!("{:?}", other)),
    }
}

/// Quote-aware whitespace tokenizer for redis-cli style input.
/// Handles single quotes, double quotes (with \" \\ escapes), and backslash
/// escapes outside quotes. Good enough for v1 command terminal.
fn tokenize_command(input: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                cur.push(c);
            }
        } else if in_double {
            match c {
                '"' => in_double = false,
                '\\' => {
                    if let Some(next) = chars.next() {
                        cur.push(next);
                    }
                }
                _ => cur.push(c),
            }
        } else {
            match c {
                '\'' => in_single = true,
                '"' => in_double = true,
                '\\' => {
                    if let Some(next) = chars.next() {
                        cur.push(next);
                    }
                }
                c if c.is_whitespace() => {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                }
                _ => cur.push(c),
            }
        }
    }
    if in_single || in_double {
        return Err("unterminated quote".into());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}
