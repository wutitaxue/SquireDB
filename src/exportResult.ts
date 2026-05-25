import type { QueryResult } from "./types";

export type ExportFormat = "csv" | "json" | "markdown" | "sql";

export const EXPORT_FORMAT_META: Record<
  ExportFormat,
  { label: string; ext: string; mime: string }
> = {
  csv: { label: "CSV", ext: "csv", mime: "text/csv" },
  json: { label: "JSON", ext: "json", mime: "application/json" },
  markdown: { label: "Markdown", ext: "md", mime: "text/markdown" },
  sql: { label: "SQL INSERT", ext: "sql", mime: "application/sql" },
};

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
    return String(v);
  return JSON.stringify(v);
}

// RFC 4180: quote when value contains ", comma, CR or LF; escape " by doubling.
function csvEscape(v: unknown): string {
  const s = stringify(v);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCSV(result: QueryResult): string {
  const head = result.columns.map((c) => csvEscape(c.name)).join(",");
  const body = result.rows
    .map((row) => row.map((cell) => csvEscape(cell)).join(","))
    .join("\r\n");
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

export function toJSON(result: QueryResult): string {
  const names = result.columns.map((c) => c.name);
  const objects = result.rows.map((row) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) {
      o[names[i]] = row[i] ?? null;
    }
    return o;
  });
  return JSON.stringify(objects, null, 2) + "\n";
}

// Markdown: pipes/backslashes/newlines escaped so the table doesn't
// fragment when pasted into GitHub / Jira / Feishu.
function mdEscape(v: unknown): string {
  const s = stringify(v);
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

export function toMarkdown(result: QueryResult): string {
  const heads = result.columns.map((c) => mdEscape(c.name));
  const sep = result.columns.map(() => "---");
  const body = result.rows.map(
    (row) => `| ${row.map((cell) => mdEscape(cell)).join(" | ")} |`,
  );
  return [
    `| ${heads.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body,
  ].join("\n") + "\n";
}

// SQL literal: numbers/booleans inline, NULL for nullish, everything else
// rendered as a single-quoted string with backslash escapes. We deliberately
// don't try to round-trip MySQL JSON columns into JSON_OBJECT(...) — the
// resulting text-as-string still loads fine via JSON_VALID().
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "bigint") return v.toString();
  const s =
    typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
}

function backtick(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export function toSqlInsert(result: QueryResult): string {
  const tableRef = result.editable
    ? `${backtick(result.editable.schema)}.${backtick(result.editable.table)}`
    : backtick("query_result");
  const cols = result.columns.map((c) => backtick(c.name)).join(", ");
  const header = `-- ${result.rows.length} row(s) exported from ${tableRef}\n`;
  if (result.rows.length === 0) return header;
  const lines = result.rows.map((row) => {
    const values = row.map((cell) => sqlLiteral(cell)).join(", ");
    return `INSERT INTO ${tableRef} (${cols}) VALUES (${values});`;
  });
  return header + lines.join("\n") + "\n";
}

export function formatResult(result: QueryResult, fmt: ExportFormat): string {
  switch (fmt) {
    case "csv":
      return toCSV(result);
    case "json":
      return toJSON(result);
    case "markdown":
      return toMarkdown(result);
    case "sql":
      return toSqlInsert(result);
  }
}

export function defaultFilename(fmt: ExportFormat, hint?: string | null): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeHint = hint ? hint.replace(/[^a-zA-Z0-9_.-]/g, "_") : "query-result";
  return `${safeHint}-${stamp}.${EXPORT_FORMAT_META[fmt].ext}`;
}
