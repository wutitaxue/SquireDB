import type {
  ConnSecurity,
  HealthOverview,
  HealthReportResponse,
  ProjectHealthResponse,
  SecurityCheck,
  SlowQuery,
} from "./types";

export type HealthExportFormat = "html" | "markdown";

export const HEALTH_EXPORT_META: Record<
  HealthExportFormat,
  { label: string; ext: string }
> = {
  html: { label: "HTML (printable / Save as PDF)", ext: "html" },
  markdown: { label: "Markdown", ext: "md" },
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scoreTone(score: number): "ok" | "warn" | "crit" {
  if (score >= 80) return "ok";
  if (score >= 60) return "warn";
  return "crit";
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Print-friendly, self-contained CSS. No external fonts or assets so the
// file works offline / when pasted as an email attachment / when printed
// to PDF via the browser dialog.
const STYLES = `
  :root {
    --ink: #0f172a;
    --ink-2: #334155;
    --muted: #64748b;
    --subtle: #94a3b8;
    --border: #e2e8f0;
    --panel: #ffffff;
    --panel-2: #f8fafc;
    --ok: #027a48;
    --ok-soft: #d1fadf;
    --warn: #b54708;
    --warn-soft: #fef0c7;
    --crit: #b42318;
    --crit-soft: #fee4e2;
    --acc: #2557d6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    background: var(--panel-2);
    font-size: 13px;
    line-height: 1.55;
  }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 24px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 18px;
    margin-bottom: 16px;
    page-break-inside: avoid;
  }
  .score-row { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .score-badge {
    display: inline-block;
    padding: 6px 14px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 14px;
    tabular-nums: true;
  }
  .score-badge.ok { background: var(--ok-soft); color: var(--ok); }
  .score-badge.warn { background: var(--warn-soft); color: var(--warn); }
  .score-badge.crit { background: var(--crit-soft); color: var(--crit); }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pill.ok { background: var(--ok-soft); color: var(--ok); }
  .pill.warn { background: var(--warn-soft); color: var(--warn); }
  .pill.crit { background: var(--crit-soft); color: var(--crit); }
  .pill.neutral { background: #f1f5f9; color: var(--muted); }
  .summary { white-space: pre-wrap; color: var(--ink-2); font-size: 13.5px; }
  ul.priorities { margin: 8px 0 0; padding-left: 22px; color: var(--ink-2); }
  ul.priorities li { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td {
    padding: 6px 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.05em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .subgroup { margin-top: 12px; }
  .subgroup-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    font-weight: 700; color: var(--ink-2); margin-bottom: 6px;
    display: flex; align-items: center; gap: 8px;
  }
  .subgroup-title .count {
    background: #f1f5f9; color: var(--muted);
    padding: 1px 7px; border-radius: 999px; font-size: 10px;
  }
  .empty { color: var(--muted); font-style: italic; font-size: 12px; }
  .conn-badge {
    display: inline-block;
    background: #f1f5f9; color: var(--muted);
    padding: 1px 6px; border-radius: 4px;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; margin-left: 6px;
  }
  .footer {
    color: var(--subtle); font-size: 11px; margin-top: 24px; text-align: right;
  }
  @media print {
    body { background: white; padding: 12px; }
    .card { border-color: #cbd5e1; }
  }
`;

function renderOverview(o: HealthOverview): string {
  const tone = scoreTone(o.score);
  const priorities = o.priorities.length
    ? `<ul class="priorities">${o.priorities.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
    : "";
  return `
    <section class="card">
      <div class="score-row">
        <h2 style="margin:0;">AI overview</h2>
        <span class="score-badge ${tone}">Score ${o.score} / 100</span>
      </div>
      <div class="summary">${esc(o.summary)}</div>
      ${priorities}
    </section>
  `;
}

function renderAiError(err: string): string {
  return `
    <section class="card">
      <h2>AI unavailable</h2>
      <div class="summary">${esc(err)}</div>
    </section>
  `;
}

type IndexHealthLike = {
  redundant: Array<{
    database: string;
    table: string;
    index_a: string;
    index_a_cols: string;
    index_b: string;
    index_b_cols: string;
    connection_name?: string;
  }>;
  unused: Array<{
    database: string;
    table: string;
    index: string;
    connection_name?: string;
  }>;
  total_indexes: number;
  unused_unavailable_reason: string | null;
};

function connBadge(name?: string): string {
  return name ? ` <span class="conn-badge">${esc(name)}</span>` : "";
}

function renderIndexes(i: IndexHealthLike): string {
  const redundantBlock = i.redundant.length
    ? `<table>
         <thead><tr><th>Table</th><th>Redundant index</th><th>Covered by</th></tr></thead>
         <tbody>${i.redundant
           .map(
             (r) => `<tr>
                <td><code>${esc(r.database)}.${esc(r.table)}</code>${connBadge(r.connection_name)}</td>
                <td><code>${esc(r.index_a)}</code> <span style="color:var(--muted)">(${esc(r.index_a_cols)})</span></td>
                <td><code>${esc(r.index_b)}</code> <span style="color:var(--muted)">(${esc(r.index_b_cols)})</span></td>
              </tr>`,
           )
           .join("")}</tbody>
       </table>`
    : `<div class="empty">None</div>`;

  const unusedBlock = i.unused.length
    ? `<table>
         <thead><tr><th>Table</th><th>Index</th></tr></thead>
         <tbody>${i.unused
           .map(
             (u) => `<tr>
                <td><code>${esc(u.database)}.${esc(u.table)}</code>${connBadge(u.connection_name)}</td>
                <td><code>${esc(u.index)}</code></td>
              </tr>`,
           )
           .join("")}</tbody>
       </table>`
    : i.unused_unavailable_reason
      ? `<div class="empty">Unavailable: ${esc(i.unused_unavailable_reason)}</div>`
      : `<div class="empty">None</div>`;

  return `
    <section class="card">
      <h2>Indexes</h2>
      <div style="color:var(--muted);font-size:12px;margin-bottom:8px;">
        ${i.total_indexes} total · ${i.redundant.length} redundant · ${i.unused.length} unused
      </div>
      <div class="subgroup">
        <div class="subgroup-title">Redundant pairs <span class="count">${i.redundant.length}</span></div>
        ${redundantBlock}
      </div>
      <div class="subgroup">
        <div class="subgroup-title">Unused indexes <span class="count">${i.unused.length}</span></div>
        ${unusedBlock}
      </div>
    </section>
  `;
}

type TableHealthLike = {
  no_primary_key: Array<{ database: string; table: string; connection_name?: string }>;
  fragmented: Array<{
    database: string;
    table: string;
    data_free_mb: number;
    data_length_mb: number;
    fragmentation_ratio: number;
    connection_name?: string;
  }>;
  largest: Array<{
    database: string;
    table: string;
    rows: number;
    data_mb: number;
    index_mb: number;
    total_mb: number;
    connection_name?: string;
  }>;
};

function renderTables(t: TableHealthLike): string {
  const noPk = t.no_primary_key.length
    ? `<table>
         <thead><tr><th>Table</th></tr></thead>
         <tbody>${t.no_primary_key
           .map(
             (r) =>
               `<tr><td><code>${esc(r.database)}.${esc(r.table)}</code>${connBadge(r.connection_name)}</td></tr>`,
           )
           .join("")}</tbody>
       </table>`
    : `<div class="empty">None</div>`;

  const fragmented = t.fragmented.length
    ? `<table>
         <thead><tr><th>Table</th><th class="num">Data</th><th class="num">Free</th><th class="num">Frag %</th></tr></thead>
         <tbody>${t.fragmented
           .map(
             (r) => `<tr>
                <td><code>${esc(r.database)}.${esc(r.table)}</code>${connBadge(r.connection_name)}</td>
                <td class="num">${r.data_length_mb.toFixed(1)} MB</td>
                <td class="num">${r.data_free_mb.toFixed(1)} MB</td>
                <td class="num">${(r.fragmentation_ratio * 100).toFixed(0)}%</td>
              </tr>`,
           )
           .join("")}</tbody>
       </table>`
    : `<div class="empty">None</div>`;

  const largest = t.largest.length
    ? `<table>
         <thead><tr><th>Table</th><th class="num">Rows</th><th class="num">Data</th><th class="num">Index</th><th class="num">Total</th></tr></thead>
         <tbody>${t.largest
           .map(
             (r) => `<tr>
                <td><code>${esc(r.database)}.${esc(r.table)}</code>${connBadge(r.connection_name)}</td>
                <td class="num">${r.rows.toLocaleString()}</td>
                <td class="num">${r.data_mb.toFixed(1)} MB</td>
                <td class="num">${r.index_mb.toFixed(1)} MB</td>
                <td class="num">${r.total_mb.toFixed(1)} MB</td>
              </tr>`,
           )
           .join("")}</tbody>
       </table>`
    : `<div class="empty">None</div>`;

  return `
    <section class="card">
      <h2>Tables</h2>
      <div class="subgroup">
        <div class="subgroup-title">Without primary key <span class="count">${t.no_primary_key.length}</span></div>
        ${noPk}
      </div>
      <div class="subgroup">
        <div class="subgroup-title">Fragmented <span class="count">${t.fragmented.length}</span></div>
        ${fragmented}
      </div>
      <div class="subgroup">
        <div class="subgroup-title">Top ${t.largest.length} largest</div>
        ${largest}
      </div>
    </section>
  `;
}

function renderSlowQueries(rows: SlowQuery[]): string {
  if (rows.length === 0) {
    return `
      <section class="card">
        <h2>Slow Queries</h2>
        <div class="empty">None detected.</div>
      </section>
    `;
  }
  return `
    <section class="card">
      <h2>Slow Queries (Top ${rows.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Digest</th>
            <th class="num">Avg ms</th>
            <th class="num">Total ms</th>
            <th class="num">Calls</th>
            <th class="num">Avg rows examined</th>
          </tr>
        </thead>
        <tbody>${rows
          .map(
            (q) => `<tr>
              <td><code>${esc(q.digest_text.slice(0, 240))}</code></td>
              <td class="num">${q.avg_ms.toFixed(1)}</td>
              <td class="num">${q.total_ms.toFixed(0)}</td>
              <td class="num">${q.count_star.toLocaleString()}</td>
              <td class="num">${q.avg_rows_examined.toFixed(0)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>
    </section>
  `;
}

function renderSecuritySingle(s: SecurityCheck): string {
  return `
    <section class="card">
      <h2>Security</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <span class="pill ${s.ssl_enabled ? "ok" : "warn"}">SSL ${s.ssl_enabled ? "on" : "off"}</span>
        <span class="pill ${s.require_secure_transport ? "ok" : "neutral"}">require_secure_transport ${s.require_secure_transport ? "on" : "off"}</span>
        <span class="pill ${s.remote_root.length > 0 ? "crit" : "ok"}">remote root: ${s.remote_root.length}</span>
      </div>
      ${
        s.remote_root.length > 0
          ? `<div style="color:var(--crit);font-size:12px;">⚠ ${s.remote_root
              .map((u) => `'${esc(u.user)}'@'${esc(u.host)}'`)
              .join(", ")}</div>`
          : ""
      }
      ${
        s.mysql_user_unavailable_reason
          ? `<div class="empty">mysql.user check unavailable: ${esc(s.mysql_user_unavailable_reason)}</div>`
          : ""
      }
    </section>
  `;
}

function renderSecurityByConn(items: ConnSecurity[]): string {
  if (items.length === 0) return "";
  return `
    <section class="card">
      <h2>Security (per connection)</h2>
      ${items
        .map(
          (s) => `<div style="padding:8px 10px;background:var(--panel-2);border-radius:6px;margin-bottom:6px;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
              <code style="font-weight:700;">${esc(s.connection_name)}</code>
              <span class="pill ${s.check.ssl_enabled ? "ok" : "warn"}">SSL ${s.check.ssl_enabled ? "on" : "off"}</span>
              <span class="pill ${s.check.require_secure_transport ? "ok" : "neutral"}">require_secure_transport ${s.check.require_secure_transport ? "on" : "off"}</span>
              <span class="pill ${s.check.remote_root.length > 0 ? "crit" : "ok"}">remote root: ${s.check.remote_root.length}</span>
            </div>
            ${
              s.check.remote_root.length > 0
                ? `<div style="color:var(--crit);font-size:11.5px;">⚠ ${s.check.remote_root.map((u) => `'${esc(u.user)}'@'${esc(u.host)}'`).join(", ")}</div>`
                : ""
            }
            ${
              s.check.mysql_user_unavailable_reason
                ? `<div class="empty">mysql.user unavailable: ${esc(s.check.mysql_user_unavailable_reason)}</div>`
                : ""
            }
          </div>`,
        )
        .join("")}
    </section>
  `;
}

function shell(title: string, meta: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
<h1>${esc(title)}</h1>
<div class="meta">${esc(meta)}</div>
${body}
<div class="footer">Generated by SquireDB · ${esc(nowStamp())}</div>
</div>
</body>
</html>
`;
}

export function toConnectionHealthHtml(resp: HealthReportResponse): string {
  const r = resp.report;
  const meta = `Server: ${r.server_version} · ${r.databases_scanned.length} db(s) scanned: ${r.databases_scanned.join(", ")} · ${r.elapsed_ms} ms`;
  const body = [
    resp.ai_overview ? renderOverview(resp.ai_overview) : "",
    !resp.ai_overview && resp.ai_error ? renderAiError(resp.ai_error) : "",
    renderIndexes(r.indexes),
    renderTables(r.tables),
    renderSlowQueries(r.slow_queries),
    renderSecuritySingle(r.security),
  ].join("");
  return shell("Database Health Check", meta, body);
}

export function toProjectHealthHtml(resp: ProjectHealthResponse): string {
  const r = resp.report;
  const metaParts = [
    `Project: ${r.project_name}`,
    `${r.project_tables_count} tables`,
    `${r.scanned_databases.length} db(s)`,
    `${r.security_by_connection.length} conn(s)`,
    `${r.elapsed_ms} ms`,
  ];
  if (r.missing_connection_names.length > 0) {
    metaParts.push(
      `Partial — closed conns: ${r.missing_connection_names.join(", ")}`,
    );
  }
  const body = [
    resp.ai_overview ? renderOverview(resp.ai_overview) : "",
    !resp.ai_overview && resp.ai_error ? renderAiError(resp.ai_error) : "",
    renderIndexes(r.indexes),
    renderTables(r.tables),
    renderSecurityByConn(r.security_by_connection),
  ].join("");
  return shell("Project Health Check", metaParts.join(" · "), body);
}

// Markdown formatters live here too, so both HealthCheckWorkspace and
// ProjectHealthWorkspace pull from one place (previously only the
// connection-level one had a Markdown serializer inline).
export function toConnectionHealthMarkdown(resp: HealthReportResponse): string {
  const r = resp.report;
  const lines: string[] = [];
  lines.push(`# Database Health Check`, "");
  if (resp.ai_overview) {
    lines.push(`**Score: ${resp.ai_overview.score} / 100**`, "");
    lines.push(resp.ai_overview.summary, "");
    if (resp.ai_overview.priorities.length > 0) {
      lines.push(`## Priorities`);
      for (const p of resp.ai_overview.priorities) lines.push(`- ${p}`);
      lines.push("");
    }
  }
  lines.push(`- Server: ${r.server_version}`);
  lines.push(`- Databases scanned: ${r.databases_scanned.join(", ")}`);
  lines.push(`- Elapsed: ${r.elapsed_ms} ms`, "");

  lines.push(`## Indexes`);
  lines.push(`- Total: ${r.indexes.total_indexes}`);
  lines.push(`- Redundant pairs: ${r.indexes.redundant.length}`);
  for (const ri of r.indexes.redundant.slice(0, 20)) {
    lines.push(
      `  - \`${ri.database}.${ri.table}\` — \`${ri.index_a}\` (${ri.index_a_cols}) ⊂ \`${ri.index_b}\` (${ri.index_b_cols})`,
    );
  }
  lines.push(`- Unused indexes: ${r.indexes.unused.length}`);
  for (const ui of r.indexes.unused.slice(0, 20)) {
    lines.push(`  - \`${ui.database}.${ui.table}.${ui.index}\``);
  }
  lines.push("");

  lines.push(`## Tables`);
  lines.push(`- Without primary key: ${r.tables.no_primary_key.length}`);
  for (const t of r.tables.no_primary_key.slice(0, 20)) {
    lines.push(`  - \`${t.database}.${t.table}\``);
  }
  lines.push(`- Fragmented: ${r.tables.fragmented.length}`);
  for (const t of r.tables.fragmented.slice(0, 20)) {
    lines.push(
      `  - \`${t.database}.${t.table}\` — ${t.data_free_mb.toFixed(1)}MB free / ${t.data_length_mb.toFixed(1)}MB data (${(t.fragmentation_ratio * 100).toFixed(0)}%)`,
    );
  }
  lines.push(`- Top ${r.tables.largest.length} largest:`);
  for (const t of r.tables.largest) {
    lines.push(
      `  - \`${t.database}.${t.table}\` — ${t.total_mb.toFixed(1)}MB (${t.rows.toLocaleString()} rows)`,
    );
  }
  lines.push("");

  lines.push(`## Slow Queries (Top ${r.slow_queries.length})`);
  for (const q of r.slow_queries) {
    lines.push(
      `- avg ${q.avg_ms.toFixed(1)}ms · ${q.count_star} calls — \`${q.digest_text.slice(0, 120)}\``,
    );
  }
  lines.push("");

  lines.push(`## Security`);
  lines.push(`- SSL enabled: ${r.security.ssl_enabled ? "YES" : "NO"}`);
  lines.push(
    `- require_secure_transport: ${r.security.require_secure_transport ? "ON" : "OFF"}`,
  );
  lines.push(`- Remote root accounts: ${r.security.remote_root.length}`);
  for (const u of r.security.remote_root) {
    lines.push(`  - '${u.user}'@'${u.host}'`);
  }
  return lines.join("\n") + "\n";
}

export function toProjectHealthMarkdown(resp: ProjectHealthResponse): string {
  const r = resp.report;
  const lines: string[] = [];
  lines.push(`# Project Health Check — ${r.project_name}`, "");
  if (resp.ai_overview) {
    lines.push(`**Score: ${resp.ai_overview.score} / 100**`, "");
    lines.push(resp.ai_overview.summary, "");
    if (resp.ai_overview.priorities.length > 0) {
      lines.push(`## Priorities`);
      for (const p of resp.ai_overview.priorities) lines.push(`- ${p}`);
      lines.push("");
    }
  }
  lines.push(`- Project tables: ${r.project_tables_count}`);
  lines.push(`- Databases scanned: ${r.scanned_databases.join(", ")}`);
  lines.push(`- Connections scanned: ${r.security_by_connection.length}`);
  if (r.missing_connection_names.length > 0) {
    lines.push(
      `- ⚠ Closed (skipped) connections: ${r.missing_connection_names.join(", ")}`,
    );
  }
  lines.push(`- Elapsed: ${r.elapsed_ms} ms`, "");

  lines.push(`## Indexes`);
  lines.push(`- Total: ${r.indexes.total_indexes}`);
  lines.push(`- Redundant pairs: ${r.indexes.redundant.length}`);
  for (const ri of r.indexes.redundant.slice(0, 20)) {
    lines.push(
      `  - \`${ri.database}.${ri.table}\` — \`${ri.index_a}\` (${ri.index_a_cols}) ⊂ \`${ri.index_b}\` (${ri.index_b_cols})`,
    );
  }
  lines.push(`- Unused indexes: ${r.indexes.unused.length}`);
  for (const ui of r.indexes.unused.slice(0, 20)) {
    lines.push(`  - \`${ui.database}.${ui.table}.${ui.index}\``);
  }
  lines.push("");

  lines.push(`## Tables`);
  lines.push(`- Without primary key: ${r.tables.no_primary_key.length}`);
  for (const t of r.tables.no_primary_key.slice(0, 20)) {
    lines.push(`  - \`${t.database}.${t.table}\``);
  }
  lines.push(`- Fragmented: ${r.tables.fragmented.length}`);
  for (const t of r.tables.fragmented.slice(0, 20)) {
    lines.push(
      `  - \`${t.database}.${t.table}\` — ${t.data_free_mb.toFixed(1)}MB free / ${t.data_length_mb.toFixed(1)}MB data (${(t.fragmentation_ratio * 100).toFixed(0)}%)`,
    );
  }
  lines.push(`- Top ${r.tables.largest.length} largest:`);
  for (const t of r.tables.largest) {
    lines.push(
      `  - \`${t.database}.${t.table}\` — ${t.total_mb.toFixed(1)}MB (${t.rows.toLocaleString()} rows)`,
    );
  }
  lines.push("");

  lines.push(`## Security (per connection)`);
  for (const s of r.security_by_connection) {
    lines.push(`### ${s.connection_name}`);
    lines.push(`- SSL enabled: ${s.check.ssl_enabled ? "YES" : "NO"}`);
    lines.push(
      `- require_secure_transport: ${s.check.require_secure_transport ? "ON" : "OFF"}`,
    );
    lines.push(`- Remote root: ${s.check.remote_root.length}`);
    for (const u of s.check.remote_root) {
      lines.push(`  - '${u.user}'@'${u.host}'`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function safeSlug(s: string): string {
  return (s || "report").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function timeStampForFile(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function healthFilename(
  fmt: HealthExportFormat,
  hint: string | null,
): string {
  return `health-${safeSlug(hint ?? "report")}-${timeStampForFile()}.${HEALTH_EXPORT_META[fmt].ext}`;
}
