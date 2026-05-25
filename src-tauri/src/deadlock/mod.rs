use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use sqlx::{MySqlPool, Row};

#[derive(Debug, Serialize, Clone)]
pub struct LockEntry {
    pub kind: String,
    pub state: String,
    pub mode: String,
    pub database: Option<String>,
    pub table: Option<String>,
    pub index: Option<String>,
    pub gap: bool,
    pub record_text: Option<String>,
    pub raw: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeadlockTransaction {
    pub slot: u8,
    pub mysql_thread_id: Option<u64>,
    pub txn_id: Option<String>,
    pub query_started_seconds_ago: Option<u64>,
    pub status: Option<String>,
    pub os_thread_handle: Option<String>,
    pub thread_query_id: Option<String>,
    pub user_host: Option<String>,
    pub statement: Option<String>,
    pub locks: Vec<LockEntry>,
    pub victim: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeadlockReport {
    pub detected_at: Option<String>,
    pub server_time: Option<String>,
    pub transactions: Vec<DeadlockTransaction>,
    pub victim_slot: Option<u8>,
    pub raw_section: String,
}

pub async fn fetch_innodb_status(pool: &MySqlPool) -> Result<(String, bool), String> {
    let row = sqlx::query("SHOW ENGINE INNODB STATUS")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("SHOW ENGINE INNODB STATUS failed: {e}"))?;

    // Standard MySQL output: columns (Type, Name, Status)
    let text: String = row
        .try_get::<String, _>(2)
        .or_else(|_| row.try_get::<String, _>("Status"))
        .map_err(|e| format!("read status column failed: {e}"))?;

    // The status field is limited to ~1MB; detect truncation marker.
    let truncated = text.contains("...TRUNCATED")
        || text.contains("END OF INNODB MONITOR OUTPUT") == false;
    Ok((text, truncated))
}

pub fn parse_latest_deadlock(text: &str) -> Option<DeadlockReport> {
    let start_marker = "LATEST DETECTED DEADLOCK";
    let start = text.find(start_marker)?;
    // Section ends at next "----" line block "WE ROLL BACK" line or next major header
    let tail = &text[start..];

    // The terminator is the next line of only dashes after we've consumed the deadlock body.
    // Common patterns: "------------\nTRANSACTIONS" appears after deadlock report.
    let end_candidates = [
        "\n------------\nTRANSACTIONS",
        "\n--------\nFILE I/O",
        "\nINNODB MONITOR OUTPUT",
    ];
    let mut end_idx = tail.len();
    for marker in end_candidates {
        if let Some(i) = tail.find(marker) {
            if i < end_idx {
                end_idx = i;
            }
        }
    }
    let section = tail[..end_idx].trim_end().to_string();

    // Skip past the heading and the line of dashes that follows.
    let after_heading = section
        .find('\n')
        .map(|i| &section[i + 1..])
        .unwrap_or(&section);
    let after_dashes = after_heading
        .find('\n')
        .map(|i| &after_heading[i + 1..])
        .unwrap_or(after_heading);

    // First line after dashes is usually the timestamp (e.g. "2026-05-28 12:34:56 0x7f...").
    let mut lines = after_dashes.lines();
    let detected_at = lines.next().map(|s| s.trim().to_string());

    // If no transaction markers exist, this is not a real deadlock (just heading).
    if !section.contains("*** (1) TRANSACTION:") {
        return None;
    }

    let body = after_dashes;
    let mut transactions: Vec<DeadlockTransaction> = Vec::new();
    let mut victim_slot: Option<u8> = None;

    let txn_positions = find_transaction_blocks(body);
    for (slot, range) in txn_positions {
        let chunk = &body[range.0..range.1];
        let mut txn = parse_transaction(slot, chunk);
        if let Some(v) = find_victim_in(body) {
            if v == slot {
                txn.victim = true;
                victim_slot = Some(v);
            }
        }
        transactions.push(txn);
    }

    Some(DeadlockReport {
        detected_at,
        server_time: None,
        transactions,
        victim_slot,
        raw_section: section,
    })
}

fn find_transaction_blocks(body: &str) -> Vec<(u8, (usize, usize))> {
    static RE_HEAD: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)^\*\*\* \((\d+)\) TRANSACTION:").unwrap());
    let mut hits: Vec<(u8, usize)> = Vec::new();
    for cap in RE_HEAD.captures_iter(body) {
        let slot: u8 = cap[1].parse().unwrap_or(0);
        let mat = cap.get(0).unwrap();
        hits.push((slot, mat.start()));
    }
    if hits.is_empty() {
        return Vec::new();
    }
    // Find the terminator line for the last block (line starting with "*** WE ROLL BACK")
    static RE_VICTIM_LINE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)^\*\*\* WE ROLL BACK").unwrap());
    let end_of_body = RE_VICTIM_LINE
        .find(body)
        .map(|m| m.start())
        .unwrap_or(body.len());

    let mut ranges = Vec::with_capacity(hits.len());
    for i in 0..hits.len() {
        let start = hits[i].1;
        let end = if i + 1 < hits.len() {
            hits[i + 1].1
        } else {
            end_of_body
        };
        ranges.push((hits[i].0, (start, end)));
    }
    ranges
}

fn find_victim_in(body: &str) -> Option<u8> {
    static RE_VICTIM: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?m)^\*\*\* WE ROLL BACK TRANSACTION \((\d+)\)").unwrap()
    });
    RE_VICTIM
        .captures(body)
        .and_then(|c| c[1].parse::<u8>().ok())
}

fn parse_transaction(slot: u8, chunk: &str) -> DeadlockTransaction {
    static RE_TXN_ID: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)^TRANSACTION (\d+),").unwrap());
    static RE_STATUS_LINE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?m)^TRANSACTION \d+, (.+)$").unwrap()
    });
    static RE_MYSQL_THREAD: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?m)^MySQL thread id (\d+), OS thread handle (\S+), query id (\d+)\s*(.*)$")
            .unwrap()
    });
    static RE_QUERY_AGE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?m)^.* (\d+) sec(?:ond)?s? .*$").unwrap());

    let txn_id = RE_TXN_ID.captures(chunk).map(|c| c[1].to_string());
    let status = RE_STATUS_LINE
        .captures(chunk)
        .map(|c| c[1].trim().to_string());

    let mut mysql_thread_id: Option<u64> = None;
    let mut os_thread_handle: Option<String> = None;
    let mut thread_query_id: Option<String> = None;
    let mut user_host: Option<String> = None;
    if let Some(c) = RE_MYSQL_THREAD.captures(chunk) {
        mysql_thread_id = c[1].parse().ok();
        os_thread_handle = Some(c[2].to_string());
        thread_query_id = Some(c[3].to_string());
        let tail = c[4].trim().to_string();
        if !tail.is_empty() {
            user_host = Some(tail);
        }
    }

    let query_started_seconds_ago = RE_QUERY_AGE
        .captures(chunk)
        .and_then(|c| c[1].parse::<u64>().ok());

    let statement = extract_statement(chunk);
    let locks = extract_locks(chunk);

    DeadlockTransaction {
        slot,
        mysql_thread_id,
        txn_id,
        query_started_seconds_ago,
        status,
        os_thread_handle,
        thread_query_id,
        user_host,
        statement,
        locks,
        victim: false,
    }
}

fn extract_statement(chunk: &str) -> Option<String> {
    // The statement appears between the MySQL thread line and the first lock block.
    // Common patterns: lines ending with the SQL statement(s) until "*** (N) HOLDS/WAITING" header.
    let stop_markers = [
        "*** (1) HOLDS THE LOCK",
        "*** (2) HOLDS THE LOCK",
        "*** (1) WAITING FOR THIS LOCK",
        "*** (2) WAITING FOR THIS LOCK",
        "*** WE ROLL BACK",
    ];
    let start_marker = "MySQL thread id";
    let start = chunk.find(start_marker)?;
    let rest = &chunk[start..];
    let line_end = rest.find('\n').unwrap_or(rest.len());
    let after = &rest[line_end + 1.min(rest.len() - line_end)..];

    let mut end = after.len();
    for m in stop_markers {
        if let Some(i) = after.find(m) {
            if i < end {
                end = i;
            }
        }
    }
    let body = after[..end].trim();
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

fn extract_locks(chunk: &str) -> Vec<LockEntry> {
    static RE_HEADER: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?m)^\*\*\* \(\d+\) (HOLDS THE LOCK\(S\)|WAITING FOR THIS LOCK TO BE GRANTED):\s*$")
            .unwrap()
    });
    let mut entries = Vec::new();
    let mut iter = RE_HEADER.captures_iter(chunk).peekable();
    while let Some(cap) = iter.next() {
        let kind = cap[1].to_string();
        let state = if kind.contains("WAITING") {
            "waiting"
        } else {
            "holding"
        }
        .to_string();
        let header_match = cap.get(0).unwrap();
        let block_start = header_match.end();
        let next_start = iter
            .peek()
            .map(|n| n.get(0).unwrap().start())
            .unwrap_or(chunk.len());
        // Also stop at next "*** (N)" marker (any kind) to be safe
        let block = &chunk[block_start..next_start];
        let body = trim_to_next_star(block);

        let lock = parse_lock_body(body, &kind, &state);
        entries.push(lock);
    }
    entries
}

fn trim_to_next_star(body: &str) -> &str {
    let mut end = body.len();
    for marker in ["*** (1)", "*** (2)", "*** WE ROLL BACK"] {
        if let Some(i) = body.find(marker) {
            if i < end {
                end = i;
            }
        }
    }
    body[..end].trim()
}

fn parse_lock_body(body: &str, kind: &str, state: &str) -> LockEntry {
    static RE_REC_LOCK: Lazy<Regex> = Lazy::new(|| {
        Regex::new(
            r"(?ms)RECORD LOCKS .*?table `([^`]+)`\.`([^`]+)` .*?index `?([^` \n]+)`? .*?(lock[^,\n]*)",
        )
        .unwrap()
    });
    static RE_TABLE_LOCK: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?ms)TABLE LOCK table `([^`]+)`\.`([^`]+)`\s+(lock[^,\n]*)")
            .unwrap()
    });

    if let Some(c) = RE_REC_LOCK.captures(body) {
        let db = c[1].to_string();
        let tbl = c[2].to_string();
        let idx = c[3].to_string();
        let mode_raw = c[4].trim().to_string();
        let gap = mode_raw.contains("gap");
        let mode = mode_raw.clone();
        let record_text = extract_record_text(body);
        return LockEntry {
            kind: kind.to_string(),
            state: state.to_string(),
            mode,
            database: Some(db),
            table: Some(tbl),
            index: Some(idx),
            gap,
            record_text,
            raw: body.to_string(),
        };
    }
    if let Some(c) = RE_TABLE_LOCK.captures(body) {
        let db = c[1].to_string();
        let tbl = c[2].to_string();
        let mode = c[3].trim().to_string();
        return LockEntry {
            kind: kind.to_string(),
            state: state.to_string(),
            mode,
            database: Some(db),
            table: Some(tbl),
            index: None,
            gap: false,
            record_text: None,
            raw: body.to_string(),
        };
    }
    LockEntry {
        kind: kind.to_string(),
        state: state.to_string(),
        mode: String::new(),
        database: None,
        table: None,
        index: None,
        gap: false,
        record_text: None,
        raw: body.to_string(),
    }
}

fn extract_record_text(body: &str) -> Option<String> {
    // Record dump typically starts with "Record lock, heap no ..." then nested fields.
    let key = "Record lock";
    let idx = body.find(key)?;
    let snippet = &body[idx..];
    let end = snippet.find("\n\n").unwrap_or(snippet.len().min(800));
    Some(snippet[..end].trim().to_string())
}

pub fn build_ai_block(report: &DeadlockReport) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    if let Some(t) = &report.detected_at {
        let _ = writeln!(out, "Detected at: {t}");
    }
    if let Some(v) = report.victim_slot {
        let _ = writeln!(out, "Victim transaction: ({v})");
    }
    for tx in &report.transactions {
        let _ = writeln!(out, "\n--- Transaction ({}) ---", tx.slot);
        if let Some(id) = &tx.txn_id {
            let _ = writeln!(out, "txn_id: {id}");
        }
        if let Some(t) = tx.mysql_thread_id {
            let _ = writeln!(out, "mysql_thread_id: {t}");
        }
        if let Some(s) = &tx.status {
            let _ = writeln!(out, "status: {s}");
        }
        if let Some(uh) = &tx.user_host {
            let _ = writeln!(out, "user_host: {uh}");
        }
        if let Some(stmt) = &tx.statement {
            let _ = writeln!(out, "statement:\n{stmt}");
        }
        for lock in &tx.locks {
            let table = lock
                .table
                .as_deref()
                .map(|t| {
                    lock.database
                        .as_deref()
                        .map(|d| format!("{d}.{t}"))
                        .unwrap_or_else(|| t.to_string())
                })
                .unwrap_or_else(|| "?".into());
            let idx = lock.index.as_deref().unwrap_or("-");
            let _ = writeln!(
                out,
                "  {} {} on {} (index {}) — {}",
                lock.state, lock.kind, table, idx, lock.mode
            );
            if let Some(rt) = &lock.record_text {
                let _ = writeln!(out, "    record: {}", rt.lines().next().unwrap_or(""));
            }
        }
        if tx.victim {
            let _ = writeln!(out, "  >>> ROLLED BACK as victim");
        }
    }
    out
}
