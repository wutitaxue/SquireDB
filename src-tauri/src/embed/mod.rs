//! OpenAI-compatible + Azure OpenAI `/embeddings` client.
//!
//! Two protocols supported because the OpenAI Python SDK quietly translates
//! between them when you instantiate `AzureOpenAI(...)` vs `OpenAI(...)`;
//! we don't go through the SDK, so the dispatch has to be explicit:
//!
//! | | OpenAI | Azure |
//! |---|---|---|
//! | URL | `{base}/embeddings` | `{base}/openai/deployments/{dep}/embeddings?api-version=X` |
//! | Auth | `Authorization: Bearer <key>` | `api-key: <key>` |
//! | Body model | `{ "model": "...", "input": "..." }` | `{ "input": "..." }` (deployment is in URL) |

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Which embeddings protocol to speak.
#[derive(Debug, Clone, Copy)]
pub enum Provider<'a> {
    /// Standard OpenAI-compatible (OpenAI, Voyage, Jina, vLLM, …).
    OpenAi { model: &'a str },
    /// Azure OpenAI — deployment-scoped URL + `api-key` header.
    Azure {
        deployment: &'a str,
        api_version: &'a str,
    },
}

#[derive(Serialize)]
struct OpenAiBody<'a> {
    model: &'a str,
    input: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<u32>,
}

#[derive(Serialize)]
struct AzureBody<'a> {
    input: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<u32>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Deserialize)]
struct EmbeddingItem {
    embedding: Vec<f32>,
}

/// POST to the appropriate endpoint, return the first embedding vector.
pub async fn embed(
    provider: Provider<'_>,
    base_url: &str,
    api_key: &str,
    text: &str,
    dimensions: Option<u32>,
) -> Result<Vec<f32>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("embedding HTTP client init failed: {e}"))?;
    let base = base_url.trim_end_matches('/');

    let request = match provider {
        Provider::OpenAi { model } => {
            let url = format!("{base}/embeddings");
            client
                .post(&url)
                .bearer_auth(api_key)
                .json(&OpenAiBody {
                    model,
                    input: text,
                    dimensions,
                })
        }
        Provider::Azure {
            deployment,
            api_version,
        } => {
            // Azure portals give endpoints either with or without a trailing
            // `/openai`; tolerate both so users don't have to guess.
            let root = base.trim_end_matches("/openai");
            let url = format!(
                "{root}/openai/deployments/{deployment}/embeddings?api-version={api_version}"
            );
            client
                .post(&url)
                .header("api-key", api_key)
                .json(&AzureBody {
                    input: text,
                    dimensions,
                })
        }
    };

    let resp = request
        .send()
        .await
        .map_err(|e| format!("embedding request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("embedding HTTP {status}: {body}"));
    }
    let parsed: EmbedResponse = resp
        .json()
        .await
        .map_err(|e| format!("decode embedding response failed: {e}"))?;
    parsed
        .data
        .into_iter()
        .next()
        .map(|i| i.embedding)
        .ok_or_else(|| "embedding response had no data".to_string())
}
