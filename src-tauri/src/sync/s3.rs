use std::time::Duration;

use http::header::{HeaderMap, HeaderName, HeaderValue};
use s3::bucket::Bucket;
use s3::command::Command;
use s3::creds::Credentials;
use s3::region::Region;
use s3::request::tokio_backend::HyperRequest;
use s3::request::Request;
use serde::{Deserialize, Serialize};

const BUNDLE_EXT: &str = ".bundle";
const SSE_HEADER: &str = "x-amz-server-side-encryption";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Config {
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub path_style: bool,
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceObject {
    pub device_name: String,
    pub key: String,
    pub last_modified: String,
    pub size: u64,
}

pub fn build_key(prefix: &str, device_name: &str) -> String {
    let p = prefix.trim_matches('/');
    if p.is_empty() {
        format!("{device_name}{BUNDLE_EXT}")
    } else {
        format!("{p}/{device_name}{BUNDLE_EXT}")
    }
}

fn parse_device_name(key: &str, prefix: &str) -> Option<String> {
    let p = prefix.trim_matches('/');
    let trimmed = if p.is_empty() {
        key
    } else {
        let pat = format!("{p}/");
        key.strip_prefix(&pat)?
    };
    let stem = trimmed.strip_suffix(BUNDLE_EXT)?;
    if stem.contains('/') {
        None
    } else {
        Some(stem.to_string())
    }
}

fn sse_headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        HeaderName::from_static(SSE_HEADER),
        HeaderValue::from_static("AES256"),
    );
    h
}

fn build_bucket(cfg: &S3Config) -> Result<Box<Bucket>, String> {
    let region = if cfg.endpoint.trim().is_empty() {
        cfg.region
            .parse::<Region>()
            .map_err(|e| format!("invalid region: {e}"))?
    } else {
        Region::Custom {
            region: cfg.region.clone(),
            endpoint: cfg.endpoint.clone(),
        }
    };
    let credentials = Credentials::new(
        Some(&cfg.access_key),
        Some(&cfg.secret_key),
        None,
        None,
        None,
    )
    .map_err(|e| format!("credentials: {e}"))?;

    let mut bucket = Bucket::new(&cfg.bucket, region, credentials)
        .map_err(|e| format!("bucket: {e}"))?;
    bucket = bucket
        .with_request_timeout(Duration::from_secs(60))
        .map_err(|e| format!("bucket timeout: {e}"))?;
    if cfg.path_style {
        bucket = bucket.with_path_style();
    }
    Ok(bucket)
}

pub async fn put_object(cfg: &S3Config, key: &str, body: &[u8]) -> Result<(), String> {
    let bucket = build_bucket(cfg)?;
    let bucket = bucket
        .with_extra_headers(sse_headers())
        .map_err(|e| format!("set sse header: {e}"))?;
    let resp = bucket
        .put_object_with_content_type(key, body, "application/zip")
        .await
        .map_err(|e| format!("put_object: {e}"))?;
    let status = resp.status_code();
    if !(200..300).contains(&status) {
        return Err(format!("put_object returned HTTP {status}"));
    }
    Ok(())
}

pub async fn get_object(cfg: &S3Config, key: &str) -> Result<Vec<u8>, String> {
    let bucket = build_bucket(cfg)?;
    let resp = bucket
        .get_object(key)
        .await
        .map_err(|e| format!("get_object: {e}"))?;
    let status = resp.status_code();
    if !(200..300).contains(&status) {
        return Err(format!("get_object returned HTTP {status}"));
    }
    Ok(resp.bytes().to_vec())
}

pub async fn delete_object(cfg: &S3Config, key: &str) -> Result<(), String> {
    let bucket = build_bucket(cfg)?;
    let resp = bucket
        .delete_object(key)
        .await
        .map_err(|e| format!("delete_object: {e}"))?;
    let status = resp.status_code();
    if !(200..300).contains(&status) {
        return Err(format!("delete_object returned HTTP {status}"));
    }
    Ok(())
}

/// List device bundles. We deliberately do NOT use `Bucket::list`, because its
/// `ListBucketResult` deserialization requires a `<Name>` element and ignores the
/// HTTP status code. Several S3-compatible providers (Qiniu, some MinIO setups)
/// either omit `<Name>` or return an `<Error>` document — both surface as the
/// misleading "missing field `Name`". We reuse rust-s3's request signing to fetch
/// the raw XML, surface real errors, and parse the keys tolerantly (works for both
/// ListObjects v1 and v2 since both wrap each object in `<Contents><Key>`).
pub async fn list_devices(cfg: &S3Config) -> Result<Vec<DeviceObject>, String> {
    let bucket = build_bucket(cfg)?;
    let p = cfg.prefix.trim_matches('/');
    let list_prefix = if p.is_empty() {
        String::new()
    } else {
        format!("{p}/")
    };

    let mut out = Vec::new();
    let mut continuation_token: Option<String> = None;
    loop {
        let command = Command::ListObjectsV2 {
            prefix: list_prefix.clone(),
            delimiter: Some("/".to_string()),
            continuation_token: continuation_token.clone(),
            start_after: None,
            max_keys: None,
        };
        let request = HyperRequest::new(&bucket, "/", command)
            .await
            .map_err(|e| format!("list request: {e}"))?;
        let resp = request
            .response_data(false)
            .await
            .map_err(|e| format!("list http: {e}"))?;
        let status = resp.status_code();
        let xml = resp
            .to_string()
            .map_err(|e| format!("list decode: {e}"))?;

        if !(200..300).contains(&status) {
            return Err(format!(
                "list returned HTTP {status}: {}",
                extract_s3_error(&xml).unwrap_or_else(|| truncate(&xml, 300))
            ));
        }
        if let Some(err) = extract_s3_error(&xml) {
            return Err(format!("list error: {err}"));
        }

        for block in iter_contents(&xml) {
            let Some(key) = extract_tag(block, "Key") else {
                continue;
            };
            let key = xml_unescape(&key);
            let Some(name) = parse_device_name(&key, &cfg.prefix) else {
                continue;
            };
            let last_modified =
                extract_tag(block, "LastModified").unwrap_or_default();
            let size = extract_tag(block, "Size")
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0);
            out.push(DeviceObject {
                device_name: name,
                key,
                last_modified,
                size,
            });
        }

        let truncated = extract_tag(&xml, "IsTruncated")
            .map(|v| v.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let next = extract_tag(&xml, "NextContinuationToken").map(|s| xml_unescape(&s));
        if truncated && next.is_some() {
            continuation_token = next;
        } else {
            break;
        }
    }
    Ok(out)
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

/// Pull `<Code>` / `<Message>` out of an S3 `<Error>` document, if present.
fn extract_s3_error(xml: &str) -> Option<String> {
    if !xml.contains("<Error") {
        return None;
    }
    let code = extract_tag(xml, "Code").unwrap_or_else(|| "Error".to_string());
    let message = extract_tag(xml, "Message").unwrap_or_default();
    Some(if message.is_empty() {
        code
    } else {
        format!("{code}: {message}")
    })
}

/// Yield each `<Contents>…</Contents>` block in document order.
fn iter_contents(xml: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Contents>") {
        let after = &rest[start + "<Contents>".len()..];
        let Some(end) = after.find("</Contents>") else {
            break;
        };
        blocks.push(&after[..end]);
        rest = &after[end + "</Contents>".len()..];
    }
    blocks
}

/// Extract the text inside the first `<tag>…</tag>` (namespace-less) occurrence.
fn extract_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = s.find(&open)? + open.len();
    let rest = &s[start..];
    let end = rest.find(&close)?;
    Some(rest[..end].to_string())
}

fn xml_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_key_handles_trailing_slash() {
        assert_eq!(build_key("squiredb-sync", "MacA"), "squiredb-sync/MacA.bundle");
        assert_eq!(
            build_key("squiredb-sync/", "MacA"),
            "squiredb-sync/MacA.bundle"
        );
        assert_eq!(build_key("", "MacA"), "MacA.bundle");
    }

    #[test]
    fn parse_device_name_handles_prefix() {
        assert_eq!(
            parse_device_name("squiredb-sync/MacA.bundle", "squiredb-sync"),
            Some("MacA".to_string()),
        );
        assert_eq!(
            parse_device_name("squiredb-sync/MacA.bundle", "squiredb-sync/"),
            Some("MacA".to_string()),
        );
        assert_eq!(
            parse_device_name("squiredb-sync/sub/MacA.bundle", "squiredb-sync"),
            None,
        );
        assert_eq!(
            parse_device_name("squiredb-sync/MacA.txt", "squiredb-sync"),
            None,
        );
    }
}
