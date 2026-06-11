use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub struct AiConfig {
    pub base_url: String,
    pub model: String,
    /// `None` = don't send the `thinking` field (use whatever the model defaults to).
    /// `Some(true)` = explicitly enable reasoning. `Some(false)` = explicitly disable
    /// (saves tokens on reasoning-capable models like deepseek-v4-pro/flash).
    pub enable_thinking: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct TableComments {
    #[serde(default)]
    pub table_comment: Option<String>,
    #[serde(default)]
    pub columns: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct InferredRelation {
    pub from_db: String,
    pub from_table: String,
    pub from_column: String,
    pub to_db: String,
    pub to_table: String,
    pub to_column: String,
    #[serde(default)]
    pub cardinality: Option<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
}

fn default_confidence() -> f64 {
    0.7
}

#[derive(Debug, Deserialize)]
pub struct InferredRelations {
    #[serde(default)]
    pub relations: Vec<InferredRelation>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SqlFixSuggestion {
    pub explanation: String,
    #[serde(default)]
    pub fixed_sql: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct QuerySuggestion {
    pub title: String,
    pub sql: String,
}

#[derive(Debug, Deserialize)]
pub struct QuerySuggestionList {
    #[serde(default)]
    pub queries: Vec<QuerySuggestion>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExplainExplanation {
    pub summary: String,
    pub bottleneck: String,
    pub severity: String,
    pub advice: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct IndexRecommendation {
    pub table: String,
    pub columns: Vec<String>,
    #[serde(default = "default_index_type")]
    pub index_type: String,
    pub reason: String,
    pub alter_sql: String,
}

fn default_index_type() -> String {
    "BTREE".to_string()
}

#[derive(Debug, Deserialize, Serialize)]
pub struct IndexRecommendations {
    #[serde(default)]
    pub recommendations: Vec<IndexRecommendation>,
    #[serde(default)]
    pub expected_benefit: String,
    #[serde(default)]
    pub cost_warning: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct HealthOverview {
    pub score: i32,
    pub summary: String,
    #[serde(default)]
    pub priorities: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MigrationRisk {
    pub index: usize,
    pub level: String,
    pub reason: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MigrationRiskReport {
    #[serde(default)]
    pub assessments: Vec<MigrationRisk>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OnboardingEntity {
    pub table: String,
    pub purpose: String,
    #[serde(default)]
    pub importance: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OnboardingFlow {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OnboardingProject {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tables: Vec<String>,
    pub primary_table: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ChangeScenario {
    pub action: String,
    pub level: String,
    #[serde(default)]
    pub breaks: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ImpactAssessment {
    pub risk_summary: String,
    #[serde(default)]
    pub overall_level: String,
    #[serde(default)]
    pub change_scenarios: Vec<ChangeScenario>,
    #[serde(default)]
    pub before_action_advice: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OnboardingReport {
    pub overview: String,
    #[serde(default)]
    pub domain_guess: String,
    #[serde(default)]
    pub core_entities: Vec<OnboardingEntity>,
    #[serde(default)]
    pub business_flows: Vec<OnboardingFlow>,
    #[serde(default)]
    pub suggested_projects: Vec<OnboardingProject>,
    #[serde(default)]
    pub next_steps: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BriefingKeyRelation {
    pub from_table: String,
    pub to_table: String,
    pub via: String,
    #[serde(default)]
    pub reads_like: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ProjectBriefingReport {
    pub overview: String,
    #[serde(default)]
    pub focus_summary: String,
    #[serde(default)]
    pub core_entities: Vec<OnboardingEntity>,
    #[serde(default)]
    pub business_flows: Vec<OnboardingFlow>,
    #[serde(default)]
    pub key_relations: Vec<BriefingKeyRelation>,
    #[serde(default)]
    pub next_steps: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ChartConfig {
    #[serde(rename = "type")]
    pub chart_type: String,
    pub x_axis: String,
    pub y_axis: String,
    #[serde(default)]
    pub series: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingMode>,
}

#[derive(Serialize)]
struct ThinkingMode {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

/// Single entry point for every chat/completions call. All AI features in this
/// module must route through here — adding a new direct `reqwest` call is a
/// drift risk because logging / retry / model fallback / cost accounting must
/// stay in one place.
///
/// Logs the full request body and full response body to stderr, prefixed with
/// `[LLM][<caller>]` so individual features can be traced in the dev console.
async fn call_chat(
    config: &AiConfig,
    api_key: &str,
    messages: Vec<ChatMessage>,
    temperature: f32,
    timeout_secs: u64,
    caller: &str,
) -> Result<String, String> {
    let thinking = config.enable_thinking.map(|on| ThinkingMode {
        kind: if on { "enabled" } else { "disabled" },
    });
    let thinking_label = match config.enable_thinking {
        Some(true) => "enabled",
        Some(false) => "disabled",
        None => "model-default",
    };
    let body = ChatRequest {
        model: config.model.clone(),
        messages,
        temperature,
        thinking,
    };
    let url = format!(
        "{}/chat/completions",
        config.base_url.trim_end_matches('/')
    );

    let req_pretty = serde_json::to_string_pretty(&body)
        .unwrap_or_else(|_| "<serialize failed>".to_string());
    let req_line = format!(
        "[LLM][{caller}] → POST {url}  model={}  temperature={}  thinking={}  timeout={}s\n{}",
        body.model, temperature, thinking_label, timeout_secs, req_pretty
    );
    eprintln!("{req_line}");
    crate::llm_log::write(&req_line);
    let start = std::time::Instant::now();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("AI client init failed: {e}"))?;

    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let line = format!(
                "[LLM][{caller}] ✗ network error after {}ms: {e}",
                start.elapsed().as_millis()
            );
            eprintln!("{line}");
            crate::llm_log::write(&line);
            format!("AI request failed: {e}")
        })?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    let resp_line = format!(
        "[LLM][{caller}] ← {} ({}ms)\n{}",
        status,
        start.elapsed().as_millis(),
        body_text
    );
    eprintln!("{resp_line}");
    crate::llm_log::write(&resp_line);

    if !status.is_success() {
        return Err(format!("AI API error {status}: {body_text}"));
    }

    let parsed: ChatResponse = serde_json::from_str(&body_text)
        .map_err(|e| format!("parse AI response failed: {e}; raw: {body_text}"))?;

    parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "AI response has no choices".to_string())
        .map(|c| c.message.content)
}

pub async fn generate_sql(
    config: &AiConfig,
    api_key: &str,
    schema_context: &str,
    user_prompt: &str,
    current_sql: Option<&str>,
    current_table: Option<&str>,
) -> Result<String, String> {
    let mut context_block = String::new();
    if let Some(t) = current_table.and_then(|s| {
        let s = s.trim();
        if s.is_empty() { None } else { Some(s) }
    }) {
        context_block.push_str(&format!("\nCurrent table the user is viewing: {t}"));
    }
    if let Some(s) = current_sql.and_then(|s| {
        let s = s.trim();
        if s.is_empty() { None } else { Some(s) }
    }) {
        context_block.push_str(&format!("\nCurrent SQL in the editor:\n```sql\n{s}\n```"));
    }
    if !context_block.is_empty() {
        context_block.insert_str(
            0,
            "\n\nUser's current context — treat as the implicit subject of their request unless they say otherwise:",
        );
    }

    let system_prompt = format!(
        "You are a MySQL expert. Given a database schema and a user request in natural language, generate a single MySQL query.\n\
\n\
Rules:\n\
- Return ONLY the SQL query — no explanation, no comments, no markdown code fences.\n\
- Use backticks around identifiers (databases, tables, columns).\n\
- Default to LIMIT 100 unless the user asks otherwise.\n\
- If the request is ambiguous, pick the most reasonable interpretation.\n\
- If the user's request is a refinement of the editor SQL (e.g. \"add a filter\", \"sort by X\"), modify that SQL rather than starting from scratch.\n\
\n\
Database schema:\n\
{schema_context}{context_block}"
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt,
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt.to_string(),
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 60, "generate_sql").await?;

    Ok(strip_sql_fence(&content).trim().to_string())
}

pub async fn generate_table_comments(
    config: &AiConfig,
    api_key: &str,
    db: &str,
    table: &str,
    columns_block: &str,
) -> Result<TableComments, String> {
    let system_prompt = "You are a database documentation assistant. Given a MySQL table schema, \
write a concise comment for the table and each column.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no explanation outside JSON.\n\
- JSON shape: {\"table_comment\": \"...\", \"columns\": {\"col_name\": \"...\"}}\n\
- Each comment ≤ 80 characters. Be specific about purpose, not just a translation of the name.\n\
- If a column's purpose is unclear, write a best guess prefixed with \"likely\".\n\
- Respond in the same language the column names suggest (CJK names → 中文; English → English).";

    let user_prompt = format!(
        "Database: `{db}`\nTable: `{table}`\nColumns:\n{columns_block}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 60, "generate_table_comments").await?;

    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<TableComments>(&cleaned)
        .map_err(|e| format!("parse comments JSON failed: {e}; raw: {content}"))
}

pub async fn suggest_chart(
    config: &AiConfig,
    api_key: &str,
    columns_block: &str,
    sample_rows_json: &str,
) -> Result<ChartConfig, String> {
    let system_prompt = "You are a data visualization expert. Given a result set's columns and a sample of rows, recommend the most informative chart configuration.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown code fences, no text outside JSON.\n\
- JSON shape: {\"type\": \"bar|line|pie|scatter|area\", \"x_axis\": \"column\", \"y_axis\": \"column\", \"series\": \"column or null\", \"title\": \"...\", \"reasoning\": \"...\"}\n\
- chart_type rules:\n\
  - bar: categorical x, numeric y (top-N, status breakdown)\n\
  - line / area: time-series or ordered continuous x, numeric y\n\
  - pie: 2-15 distinct categories with a single numeric value\n\
  - scatter: two numeric columns to show correlation\n\
- x_axis and y_axis MUST be names from the provided columns list.\n\
- series is optional — set null unless multiple groups make sense.\n\
- Title is concise (≤ 50 chars). Match column-name language (CJK or English).\n\
- If data clearly cannot be charted meaningfully, still pick the best fit and explain in reasoning.";

    let user_prompt = format!(
        "Columns:\n{columns_block}\n\nSample rows (JSON):\n{sample_rows_json}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 60, "suggest_chart").await?;

    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<ChartConfig>(&cleaned)
        .map_err(|e| format!("parse chart JSON failed: {e}; raw: {content}"))
}

pub async fn suggest_queries(
    config: &AiConfig,
    api_key: &str,
    db: &str,
    table: &str,
    columns_block: &str,
) -> Result<QuerySuggestionList, String> {
    let system_prompt = "You are a MySQL expert. Given a table schema, suggest 4 useful exploratory SQL queries a developer or analyst would commonly run on this table.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown code fences, no text outside JSON.\n\
- JSON shape: {\"queries\": [{\"title\": \"...\", \"sql\": \"...\"}]}\n\
- Each title is a short label under 40 chars describing the intent.\n\
- Each sql is a complete, executable MySQL query using `db`.`table` notation. Include LIMIT 100 unless aggregating.\n\
- Mix: row count, recent rows, group-by-status, top-N by something, time-series — pick what fits the schema.\n\
- If columns indicate timestamps, status, foreign keys, take advantage.\n\
- Use backticks around identifiers. No comments.\n\
- Match the language hint of column names (CJK → Chinese title; English → English title).";

    let user_prompt = format!(
        "Database: `{db}`\nTable: `{table}`\nColumns:\n{columns_block}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 60, "suggest_queries").await?;

    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<QuerySuggestionList>(&cleaned)
        .map_err(|e| format!("parse suggestions JSON failed: {e}; raw: {content}"))
}

pub async fn fix_sql_error(
    config: &AiConfig,
    api_key: &str,
    schema_context: &str,
    sql: &str,
    error: &str,
) -> Result<SqlFixSuggestion, String> {
    let system_prompt = "You are a MySQL expert. Given a failing SQL query and its error message, \
explain what's wrong and provide a corrected version.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown code fences, no text outside JSON.\n\
- JSON shape: {\"explanation\": \"...\", \"fixed_sql\": \"...\"}\n\
- Keep explanation under 200 characters.\n\
- If you cannot determine a fix, leave fixed_sql as an empty string but still explain.\n\
- Match the language of the error message or SQL comments (CJK or English).\n\
- Refer to the schema below — do not invent tables or columns.";

    let user_prompt = format!(
        "Schema:\n{schema_context}\n\nFailing SQL:\n{sql}\n\nError:\n{error}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 60, "fix_sql_error").await?;

    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<SqlFixSuggestion>(&cleaned)
        .map_err(|e| format!("parse fix JSON failed: {e}; raw: {content}"))
}

pub async fn generate_relations(
    config: &AiConfig,
    api_key: &str,
    schema_context: &str,
) -> Result<InferredRelations, String> {
    let system_prompt = "You are a database schema analyst. Given a MySQL schema, predict \
foreign-key-like relations between tables.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown code fences, no text outside JSON.\n\
- JSON shape: {\"relations\": [{\"from_db\": \"\", \"from_table\": \"\", \"from_column\": \"\", \"to_db\": \"\", \"to_table\": \"\", \"to_column\": \"\", \"cardinality\": \"N-1\", \"confidence\": 0.85, \"reasoning\": \"short why\"}]}\n\
- Cardinality is one of: \"1-1\", \"1-N\", \"N-1\", \"N-N\". Most _id columns are N-1.\n\
- Only include relations with confidence >= 0.5.\n\
- Consider: naming patterns (user_id → users.id), semantic similarity (author → users, owner → users), Chinese / non-English names (用户_id → 用户表).\n\
- DO NOT invent tables or columns that are not present in the schema below.\n\
- Skip relations that are obvious self-references unless the column suggests parent/child (e.g., parent_id).";

    let user_prompt = format!("Schema:\n{schema_context}\n\nProduce the JSON now.");

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 120, "generate_relations").await?;

    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<InferredRelations>(&cleaned)
        .map_err(|e| format!("parse relations JSON failed: {e}; raw: {content}"))
}

pub async fn explain_query(
    config: &AiConfig,
    api_key: &str,
    sql: &str,
    explain_json: &str,
) -> Result<ExplainExplanation, String> {
    let system_prompt = "You are a MySQL performance expert. Given a SQL query and its EXPLAIN FORMAT=JSON output, \
explain in plain language what's happening and where the bottleneck is.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"summary\": \"...\", \"bottleneck\": \"...\", \"severity\": \"good|ok|slow|critical\", \"advice\": \"...\"}\n\
- summary: 1-2 sentences on what the query does in plain language.\n\
- bottleneck: where the cost is — full scan? bad join order? missing index? sort? temp table? Cite numbers from EXPLAIN.\n\
- severity rules: good (uses indexes, small scan), ok (acceptable), slow (large scan / filesort / temp table), critical (cartesian product / billion-row scan).\n\
- advice: concrete next step (e.g., \"add index on orders(user_id, created_at)\" or \"rewrite to avoid OR\"). Keep ≤ 200 chars.\n\
- Match the language of the SQL/column names (CJK → 中文, English → English).";

    let user_prompt = format!(
        "SQL:\n{sql}\n\nEXPLAIN FORMAT=JSON:\n{explain_json}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 60, "explain_query").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<ExplainExplanation>(&cleaned)
        .map_err(|e| format!("parse explain JSON failed: {e}; raw: {content}"))
}

pub async fn recommend_indexes(
    config: &AiConfig,
    api_key: &str,
    sql: &str,
    create_tables_block: &str,
    explain_json: &str,
) -> Result<IndexRecommendations, String> {
    let system_prompt = "You are a MySQL DBA. Given a SQL query, the CREATE TABLE of involved tables, and EXPLAIN output, \
suggest indexes that would help this query run faster.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"recommendations\": [{\"table\":\"...\",\"columns\":[\"col1\",\"col2\"],\"index_type\":\"BTREE\",\"reason\":\"...\",\"alter_sql\":\"ALTER TABLE `db`.`table` ADD INDEX `idx_x` (`col1`,`col2`);\"}], \"expected_benefit\":\"...\",\"cost_warning\":\"...\"}\n\
- Only suggest indexes that clearly help this specific query. Prefer composite indexes for multi-column WHERE / JOIN / ORDER BY.\n\
- Column order in composite indexes: equality columns first, range last.\n\
- Look at the existing indexes in CREATE TABLE — do NOT suggest duplicate or redundant indexes.\n\
- If the query is already well-served by an index, return an empty recommendations array and explain in expected_benefit.\n\
- alter_sql: use backticks for identifiers; give the index a meaningful name like idx_<table>_<col1>_<col2>.\n\
- expected_benefit: cite the estimated rows reduction or what becomes index-driven.\n\
- cost_warning: mention write overhead if many indexes added, or large composite key size.\n\
- Match the language of the SQL/column names.";

    let user_prompt = format!(
        "SQL:\n{sql}\n\nInvolved tables (CREATE TABLE):\n{create_tables_block}\n\nEXPLAIN FORMAT=JSON:\n{explain_json}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 60, "recommend_indexes").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<IndexRecommendations>(&cleaned)
        .map_err(|e| format!("parse index recommendations JSON failed: {e}; raw: {content}"))
}

pub async fn health_overview(
    config: &AiConfig,
    api_key: &str,
    report_summary: &str,
) -> Result<HealthOverview, String> {
    let system_prompt = "You are a senior MySQL DBA. Given a database health scan summary, \
produce an overall assessment.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"score\": 0-100, \"summary\": \"...\", \"priorities\": [\"...\", ...]}\n\
- score rules: 90-100 healthy, 70-89 minor issues, 50-69 several issues to address, 30-49 multiple urgent issues, 0-29 critical.\n\
- summary: ≤ 300 chars, mention the most relevant facts (table count, biggest concern, overall posture).\n\
- priorities: 3-5 short action items (≤ 100 chars each), ordered by urgency. Be specific (cite tables/indexes when possible).\n\
- Match the language of object names in the report (CJK → 中文, English → English).";

    let user_prompt = format!("Health scan report:\n{report_summary}\n\nProduce the JSON now.");

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 90, "health_overview").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<HealthOverview>(&cleaned)
        .map_err(|e| format!("parse health overview JSON failed: {e}; raw: {content}"))
}

pub async fn assess_migrations(
    config: &AiConfig,
    api_key: &str,
    migrations_block: &str,
) -> Result<MigrationRiskReport, String> {
    let system_prompt = "You are a MySQL migration safety reviewer. Given a numbered list of \
ALTER/CREATE/DROP statements, assess each one's risk in production.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"assessments\": [{\"index\": 0, \"level\": \"safe|warning|danger\", \"reason\": \"...\"}, ...]}\n\
- One assessment per input statement, matching the input index.\n\
- level rules:\n\
  - safe: pure additive (ADD COLUMN nullable, ADD INDEX on small/medium tables, CREATE TABLE)\n\
  - warning: locking risk (MODIFY COLUMN type widening on large table, ADD COLUMN with default backfill), reversible\n\
  - danger: data loss (DROP COLUMN, DROP TABLE, MODIFY COLUMN narrowing or NOT NULL without default)\n\
- reason: ≤ 100 chars, cite the specific concern (e.g., \"DROP COLUMN loses data permanently\", \"MODIFY may rewrite full table\").\n\
- Match the language of comments / column names (CJK or English).";

    let user_prompt = format!(
        "Migrations:\n{migrations_block}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 60, "assess_migrations").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<MigrationRiskReport>(&cleaned)
        .map_err(|e| format!("parse migration risks JSON failed: {e}; raw: {content}"))
}

pub async fn impact_analysis(
    config: &AiConfig,
    api_key: &str,
    impact_block: &str,
) -> Result<ImpactAssessment, String> {
    let system_prompt = "You are a senior database schema reviewer. You have been given the metadata for a single \
MySQL column and a list of places that reference it (views, stored routines, triggers, FK relationships, recent query history). \
Some references may be false positives from substring matching; use judgment.\n\
\n\
Produce a risk assessment for changing this column.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\n\
  \"risk_summary\": \"≤300 chars overall description of who depends on this column\",\n\
  \"overall_level\": \"low|medium|high|critical\",\n\
  \"change_scenarios\": [{\"action\": \"rename|widen|narrow|drop|change_nullability|change_default\", \"level\": \"safe|warning|danger\", \"breaks\": [\"specific item that breaks\", ...]}, ...],\n\
  \"before_action_advice\": [\"≤120 chars action item\", ...]\n\
}\n\
- Always include rename, widen, narrow, drop scenarios at minimum (4 entries). Add change_nullability or change_default if relevant.\n\
- breaks: cite specific view/routine/trigger names from the input. If empty, return [].\n\
- overall_level rules: critical = drop would break FK or core view; high = multiple downstream uses; medium = a few uses; low = no external references.\n\
- before_action_advice: 2-5 specific steps (e.g. \"Check 5 occurrences in query_history before renaming\", \"Verify view `v_sales_summary` after type change\").\n\
- Match the language of the column comments / referenced names (CJK → 中文, English → English).";

    let user_prompt = format!("Impact scan:\n{impact_block}\n\nProduce the JSON now.");

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 120, "impact_analysis").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<ImpactAssessment>(&cleaned)
        .map_err(|e| format!("parse impact JSON failed: {e}; raw: {content}"))
}

pub async fn onboarding_analysis(
    config: &AiConfig,
    api_key: &str,
    snapshot_block: &str,
) -> Result<OnboardingReport, String> {
    let system_prompt = "You are a senior data architect onboarding a developer to an unfamiliar MySQL database. \
Given a snapshot of tables, columns, foreign keys, and row counts, produce a structured business-level overview.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\n\
  \"overview\": \"<≤300 chars one-paragraph plain-language description of what this database is>\",\n\
  \"domain_guess\": \"<e-commerce | SaaS billing | CMS | CRM | analytics | finance | logistics | unknown — pick one>\",\n\
  \"core_entities\": [{\"table\": \"...\", \"purpose\": \"≤80 chars\", \"importance\": \"high|medium|low\"}, ...],\n\
  \"business_flows\": [{\"name\": \"...\", \"description\": \"≤200 chars\", \"tables\": [\"t1\", \"t2\"]}, ...],\n\
  \"suggested_projects\": [{\"name\": \"...\", \"description\": \"≤200 chars\", \"tables\": [\"t1\", ...], \"primary_table\": \"t1\"}, ...],\n\
  \"next_steps\": [\"≤120 chars action\", ...]\n\
}\n\
- core_entities: 3-8 most important tables. Skip junction/log/audit tables.\n\
- business_flows: 2-5 typical end-to-end flows that span multiple tables (e.g. \"user places order: users → orders → order_items → products\"). Each flow names the tables involved.\n\
- suggested_projects: 2-4 logical project groupings the developer could create as workspace bundles. Each picks one primary table and includes related tables.\n\
- next_steps: 3-5 concrete things the developer should do next (e.g. \"Sample top 5 rows of `users` to learn the status enum\").\n\
- Only use table names that appear in the snapshot. Never invent tables.\n\
- Match the language of object names in the snapshot (CJK → 中文, English → English).";

    let user_prompt = format!(
        "Database snapshot:\n{snapshot_block}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 120, "onboarding_analysis").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<OnboardingReport>(&cleaned)
        .map_err(|e| format!("parse onboarding JSON failed: {e}; raw: {content}"))
}

pub async fn project_briefing(
    config: &AiConfig,
    api_key: &str,
    briefing_block: &str,
) -> Result<ProjectBriefingReport, String> {
    let system_prompt = "You are a senior data architect writing a handbook for an existing project workspace. \
The user has already curated which tables and relationships belong to this project — your job is to write a \
sharp, opinionated handbook that explains how the curated scope works as a whole. Do NOT propose new projects.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\n\
  \"overview\": \"<≤300 chars one-paragraph plain-language description of what this project covers>\",\n\
  \"focus_summary\": \"<≤200 chars one-line stating who would use this project and for what tasks>\",\n\
  \"core_entities\": [{\"table\": \"...\", \"purpose\": \"≤80 chars\", \"importance\": \"high|medium|low\"}, ...],\n\
  \"business_flows\": [{\"name\": \"...\", \"description\": \"≤200 chars\", \"tables\": [\"t1\", \"t2\"]}, ...],\n\
  \"key_relations\": [{\"from_table\": \"a\", \"to_table\": \"b\", \"via\": \"a.x → b.y\", \"reads_like\": \"≤120 chars business explanation\"}, ...],\n\
  \"next_steps\": [\"≤120 chars action\", ...]\n\
}\n\
- core_entities: cover EVERY curated table in scope (not just the primary). Mark primary table as high.\n\
- business_flows: 2-4 flows. Only use curated tables. Reference flow steps by table name.\n\
- key_relations: 2-6 most load-bearing user-curated relations. Use `via` to give concrete column linkage. The user manually wired these — explain why they matter.\n\
- next_steps: 3-5 things a new dev should do first to validate the project setup.\n\
- Never invent tables. Never list tables outside the curated set.\n\
- If a curated connection is closed and table columns are missing, you may still describe the table by its name and primary role inferred from the relation graph; mention the partial data caveat in `overview`.\n\
- Match the language of object names in the snapshot (CJK → 中文, English → English).";

    let user_prompt = format!(
        "Project briefing source:\n{briefing_block}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 120, "project_briefing").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<ProjectBriefingReport>(&cleaned)
        .map_err(|e| format!("parse briefing JSON failed: {e}; raw: {content}"))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RepairQuery {
    pub purpose: String,
    pub sql: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RepairInvestigationResponse {
    pub queries: Vec<RepairQuery>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RepairStrategy {
    pub kind: String,
    pub target_table: String,
    pub strategy_summary: String,
    pub final_sql: String,
    pub count_probe_sql: String,
    pub where_clause: String,
    pub risks: Vec<String>,
}

pub async fn repair_investigate(
    config: &AiConfig,
    api_key: &str,
    goal: &str,
    database: &str,
    schema_block: &str,
) -> Result<Vec<RepairQuery>, String> {
    let system_prompt = "You are a senior MySQL DBA helping a user investigate data BEFORE proposing a fix. \
Generate a short list of read-only diagnostic SELECT queries.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"queries\": [{\"purpose\": \"≤80 chars\", \"sql\": \"<single-statement SELECT>\"}, ...]}\n\
- 1-6 queries, ordered from coarse (counts/groups) to fine (sample rows).\n\
- EVERY sql MUST start with SELECT (or WITH ... SELECT). No INSERT/UPDATE/DELETE/DDL — they will be rejected.\n\
- Use only tables shown in the schema. Reference them as `db`.`table` or `table` (single statement, no semicolons).\n\
- DO NOT include LIMIT — the runtime will append LIMIT 100 automatically.\n\
- Focus on confirming the user's goal: count affected rows, group by interesting dimensions, sample borderline rows.\n\
- Match the language of object names (CJK → 中文, English → English).";

    let user_prompt = format!(
        "Goal: {goal}\nDatabase: `{database}`\n\nSchema:\n{schema_block}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 90, "repair_investigate").await?;
    let cleaned = strip_json_fence(&content);
    let parsed: RepairInvestigationResponse = serde_json::from_str(&cleaned)
        .map_err(|e| format!("parse investigation JSON failed: {e}; raw: {content}"))?;
    Ok(parsed.queries)
}

pub async fn repair_strategy(
    config: &AiConfig,
    api_key: &str,
    goal: &str,
    database: &str,
    schema_block: &str,
    investigation_json: &str,
) -> Result<RepairStrategy, String> {
    let system_prompt = "You are a senior MySQL DBA proposing a SINGLE concrete data-repair strategy. \
Given a user goal, schema and investigation results, design ONE precise SQL statement.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\n\
  \"kind\": \"delete\" or \"update\",\n\
  \"target_table\": \"<table_name only, no backticks, no schema prefix>\",\n\
  \"strategy_summary\": \"≤300 chars plain-language explanation of what will change and why\",\n\
  \"final_sql\": \"<single-statement DELETE FROM ... WHERE ... | UPDATE ... SET ... WHERE ...>\",\n\
  \"count_probe_sql\": \"SELECT COUNT(*) FROM <target> WHERE <same predicate>\",\n\
  \"where_clause\": \"<the WHERE predicate ONLY, without the WHERE keyword>\",\n\
  \"risks\": [\"≤120 chars\", ...]\n\
}\n\
- final_sql MUST be exactly one statement, no trailing semicolon, MUST contain a WHERE clause.\n\
- where_clause MUST be identical to the predicate after WHERE in final_sql (the executor uses it to build the backup table). Do NOT include the literal word WHERE.\n\
- target_table is a single unqualified table identifier; use it for the backup table name.\n\
- count_probe_sql MUST be SELECT COUNT(*) on the same table with the same WHERE predicate. It will be executed before approval to show the user the affected row count.\n\
- Prefer narrow, indexed predicates. AVOID predicates that rely on volatile values like NOW() unless required by the goal.\n\
- risks: 1-4 honest concerns (cascading FKs, large row count, hard-to-undo updates, etc.).\n\
- If the goal cannot be satisfied with a single safe statement, set kind=\"delete\" with where_clause=\"1=0\" and explain why in strategy_summary and risks.\n\
- Match the language of object names (CJK → 中文, English → English).";

    let user_prompt = format!(
        "Goal: {goal}\nDatabase: `{database}`\n\nSchema:\n{schema_block}\n\nInvestigation results (JSON):\n{investigation_json}\n\nProduce the JSON now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.15, 120, "repair_strategy").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<RepairStrategy>(&cleaned)
        .map_err(|e| format!("parse strategy JSON failed: {e}; raw: {content}"))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ProjectSlowOverview {
    pub summary: String,
    pub hotspot_tables: Vec<String>,
    pub priorities: Vec<String>,
}

pub async fn project_slow_overview(
    config: &AiConfig,
    api_key: &str,
    block: &str,
) -> Result<ProjectSlowOverview, String> {
    let system_prompt = "You are a senior MySQL DBA looking at slow queries scoped to one project's curated tables. \
Produce an opinionated overview that highlights the worst offenders and the tables that recur.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"summary\": \"...\", \"hotspot_tables\": [\"db.table\", ...], \"priorities\": [\"...\", ...]}\n\
- summary: ≤ 300 chars, mention how many slow queries matched, the total time burned, the most painful pattern.\n\
- hotspot_tables: 1-5 `db.table` strings that appear in multiple slow queries OR drive the most total_ms. Use the exact db.table strings shown in the input.\n\
- priorities: 3-5 short actions (≤ 100 chars each), ordered by urgency. Be specific — recommend missing indexes, rewrites, or schema changes when supported by the data.\n\
- If the input has no matched slow queries, return an empty hotspot_tables and a priorities list whose first item is \"No project queries found in perf_schema — consider running representative workload first.\"\n\
- Match the language of object names in the input (CJK → 中文, English → English).";

    let user_prompt = format!("Project slow-query report:\n{block}\n\nProduce the JSON now.");

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 90, "project_slow_overview").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<ProjectSlowOverview>(&cleaned)
        .map_err(|e| format!("parse slow-query overview JSON failed: {e}; raw: {content}"))
}

pub async fn project_dictionary_summary(
    config: &AiConfig,
    api_key: &str,
    dictionary_block: &str,
) -> Result<String, String> {
    let system_prompt = "You are a senior data architect producing an executive summary for a project data dictionary. \
The user has curated the tables and relationships that define this project's scope. Your job is to write 2-3 short \
paragraphs (≤450 chars total) that a new engineer or stakeholder can read in 30 seconds to understand what the project covers.\n\
\n\
Rules:\n\
- Output PLAIN TEXT only — no markdown, no JSON, no headings, no bullet points.\n\
- 2-3 short paragraphs separated by blank lines.\n\
- Paragraph 1: what business domain this project covers (inferred from curated tables/relations).\n\
- Paragraph 2: how data flows through the core entities (use curated relations to describe the join graph in words).\n\
- Paragraph 3 (optional): notable caveats — PII columns, partial scans from closed connections, cross-connection scope.\n\
- Never invent tables. Use only what's in the snapshot.\n\
- Match the language of object names (CJK → 中文, English → English).";

    let user_prompt = format!(
        "Dictionary source:\n{dictionary_block}\n\nWrite the executive summary now."
    );

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 120, "project_dictionary_summary").await?;
    Ok(content.trim().to_string())
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct DeadlockAnalysis {
    pub summary: String,
    pub conflict_cycle: String,
    pub root_cause: String,
    pub recommendations: Vec<String>,
}

pub async fn analyze_deadlock(
    config: &AiConfig,
    api_key: &str,
    deadlock_block: &str,
) -> Result<DeadlockAnalysis, String> {
    let system_prompt = "You are a MySQL/InnoDB expert diagnosing a deadlock. \
The user pastes the LATEST DETECTED DEADLOCK section. Return STRICT JSON:\n\
{\n\
  \"summary\": string,         // 1-2 sentences: what happened\n\
  \"conflict_cycle\": string,   // describe the wait cycle: TX(1) holds X waiting Y; TX(2) holds Y waiting X\n\
  \"root_cause\": string,       // why this happened (lock ordering, range locks, gap locks, FK locks, ...)\n\
  \"recommendations\": [string] // 2-5 concrete fixes: index changes, transaction ordering, isolation, SQL tweaks\n\
}\n\
Rules:\n\
- Output JSON only, no fences, no prose.\n\
- Quote concrete table/index/column names from the data.\n\
- Be terse — total ≤900 chars.\n\
- Match the language of object names (CJK → 中文, English → English).";

    let user_prompt = format!("Deadlock data:\n{deadlock_block}\n\nReturn the JSON now.");

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.2, 120, "analyze_deadlock").await?;
    let cleaned = strip_json_fence(&content);
    let analysis: DeadlockAnalysis = serde_json::from_str(&cleaned)
        .map_err(|e| format!("parse deadlock JSON failed: {e}\nraw: {cleaned}"))?;
    Ok(analysis)
}

pub async fn er_diagram_overview(
    config: &AiConfig,
    api_key: &str,
    er_block: &str,
) -> Result<String, String> {
    let system_prompt = "You are a senior data architect commenting on an ER diagram. \
Produce a SHORT (≤350 chars), plain-text reading guide so an engineer can quickly grok the diagram.\n\
\n\
Rules:\n\
- Output PLAIN TEXT only — no markdown, no headings, no bullets.\n\
- 2 short paragraphs separated by a blank line.\n\
- Paragraph 1: which tables look like the central hubs (highest fan-in/fan-out from relations) and why.\n\
- Paragraph 2: any structural risks worth noting (orphan tables with no relations, cross-DB / cross-conn joins, PII-heavy hubs).\n\
- Never invent tables/columns. Use only what's in the snapshot.\n\
- Match the language of object names (CJK → 中文, English → English).";

    let user_prompt = format!("ER snapshot:\n{er_block}\n\nWrite the reading guide now.");

    let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user_prompt,
            },
        ];

    let content = call_chat(config, api_key, messages, 0.3, 120, "er_diagram_overview").await?;
    Ok(content.trim().to_string())
}

fn strip_json_fence(s: &str) -> String {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let after_first_newline = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or(rest);
        if let Some(end) = after_first_newline.rfind("```") {
            return after_first_newline[..end].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn strip_sql_fence(s: &str) -> String {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        // skip language tag line e.g. ```sql
        let after_first_newline = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or(rest);
        if let Some(end) = after_first_newline.rfind("```") {
            return after_first_newline[..end].trim().to_string();
        }
    }
    trimmed.to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableEditProposal {
    pub modified: crate::ddl::TableStructure,
    pub summary: String,
}

pub async fn ai_table_edit(
    config: &AiConfig,
    api_key: &str,
    current: &crate::ddl::TableStructure,
    instruction: &str,
) -> Result<TableEditProposal, String> {
    let system_prompt = "You are a MySQL schema designer. Given an existing table structure (JSON) and a natural-language change request, \
return the modified table structure plus a 1-sentence summary.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"summary\": \"...\", \"modified\": <TableStructure>}\n\
- TableStructure fields (must match exactly): database, table, engine, charset, collation, comment (string or null), columns[], indexes[], foreign_keys[].\n\
- columns[] item fields: name, data_type, nullable (bool), default_value (string or null), default_is_expression (bool), auto_increment (bool), on_update (string or null), comment (string or null), charset (string or null), collation (string or null).\n\
- data_type must be a full MySQL column type including size, e.g. \"varchar(255)\", \"int unsigned\", \"decimal(10,2)\", \"datetime\". Do NOT use generic SQL types.\n\
- default_is_expression = true when default_value is an SQL expression (CURRENT_TIMESTAMP, NULL, function call). false when it's a literal.\n\
- indexes[] item fields: name, kind (one of \"primary\"|\"unique\"|\"index\"|\"fulltext\"|\"spatial\"), columns[{name,length(uint or null),desc(bool)}], comment (string or null).\n\
- foreign_keys[] item fields: name, columns[], ref_database (string or null), ref_table, ref_columns[], on_delete / on_update (one of \"no_action\"|\"restrict\"|\"cascade\"|\"set_null\"|\"set_default\").\n\
- Preserve any column/index/fk the user did not ask to change. Do NOT renumber or reorder unless asked.\n\
- If the request is ambiguous, choose the safer interpretation (do not drop data, do not widen permissions).\n\
- summary: ≤ 1 sentence describing what changed.\n\
- Match the language of the instruction (CJK → 中文 summary, English → English).";

    let current_json = serde_json::to_string(current)
        .map_err(|e| format!("serialize current structure failed: {e}"))?;
    let user_prompt = format!(
        "Current table structure:\n{current_json}\n\nChange request:\n{instruction}\n\nProduce the JSON now."
    );

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: system_prompt.into(),
        },
        ChatMessage {
            role: "user".into(),
            content: user_prompt,
        },
    ];

    let content = call_chat(config, api_key, messages, 0.2, 90, "ai_table_edit").await?;
    let cleaned = strip_json_fence(&content);
    serde_json::from_str::<TableEditProposal>(&cleaned)
        .map_err(|e| format!("parse table edit JSON failed: {e}; raw: {content}"))
}

#[derive(Debug, Serialize)]
pub struct TableCreateProposal {
    pub structure: crate::ddl::TableStructure,
    pub summary: String,
}

#[derive(Debug, Deserialize)]
struct TableCreateRaw {
    summary: String,
    structure: crate::ddl::TableStructure,
}

pub async fn ai_create_table(
    config: &AiConfig,
    api_key: &str,
    database: &str,
    instruction: &str,
) -> Result<TableCreateProposal, String> {
    let system_prompt = "You are a MySQL schema designer. Given a natural-language description, \
design a new MySQL table.\n\
\n\
Rules:\n\
- Output strictly valid JSON, no markdown fences, no text outside JSON.\n\
- JSON shape: {\"summary\": \"...\", \"structure\": <TableStructure>}\n\
- TableStructure fields (must match exactly): database, table, engine, charset, collation, comment (string or null), columns[], indexes[], foreign_keys[].\n\
- Default to engine=\"InnoDB\", charset=\"utf8mb4\", collation=\"utf8mb4_0900_ai_ci\".\n\
- columns[] item fields: name, data_type, nullable (bool), default_value (string or null), default_is_expression (bool), auto_increment (bool), on_update (string or null), comment (string or null), charset (string or null), collation (string or null).\n\
- Always include an `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY unless the user explicitly defines another primary key.\n\
- Always include created_at / updated_at DATETIME DEFAULT CURRENT_TIMESTAMP and ON UPDATE CURRENT_TIMESTAMP for updated_at, unless the user explicitly says otherwise.\n\
- data_type must be a full MySQL column type including size.\n\
- indexes[] item fields: name, kind (one of \"primary\"|\"unique\"|\"index\"|\"fulltext\"|\"spatial\"), columns[{name,length(uint or null),desc(bool)}], comment (string or null).\n\
- foreign_keys[] item fields: name, columns[], ref_database (null), ref_table, ref_columns[], on_delete / on_update (one of \"no_action\"|\"restrict\"|\"cascade\"|\"set_null\"|\"set_default\").\n\
- Set database to the value provided by the user; leave foreign_keys[] empty unless the user explicitly references another table.\n\
- table name: snake_case, plural noun by convention.\n\
- summary: ≤ 1 sentence describing the table purpose.\n\
- Match the language of the instruction.";

    let user_prompt = format!(
        "Database: {database}\nDescription:\n{instruction}\n\nProduce the JSON now."
    );

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: system_prompt.into(),
        },
        ChatMessage {
            role: "user".into(),
            content: user_prompt,
        },
    ];

    let content = call_chat(config, api_key, messages, 0.3, 90, "ai_create_table").await?;
    let cleaned = strip_json_fence(&content);
    let raw: TableCreateRaw = serde_json::from_str(&cleaned)
        .map_err(|e| format!("parse create table JSON failed: {e}; raw: {content}"))?;
    Ok(TableCreateProposal {
        structure: raw.structure,
        summary: raw.summary,
    })
}
