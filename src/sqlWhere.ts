/**
 * Server-side column filtering by rewriting the SQL's WHERE clause. Companion
 * to sqlSort.ts (which rewrites ORDER BY). The generated conditions live in a
 * marked block — `WHERE ... AND /* squire-filter *\/ (conds)` — so re-applying
 * replaces only our block and never clobbers a hand-written WHERE.
 *
 * Best-effort regex rewriter for a single top-level SELECT. Grouped/UNION
 * queries aren't supported (see `whereIsSupported`); the caller disables the
 * DB filter for those.
 */

export type FilterOp =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "LIKE"
  | "NOT LIKE"
  | "IN"
  | "IS NULL"
  | "IS NOT NULL";

export type ColumnFilter = { op: FilterOp; value: string };

const MARKER = "/* squire-filter */";

/** True when the statement is a shape we can safely rewrite the WHERE of. We
 *  bail on GROUP BY / HAVING / UNION and multi-statement scripts. */
export function whereIsSupported(sql: string): boolean {
  const s = sql.replace(/;\s*$/, "");
  if (/;/.test(s)) return false;
  if (/\bgroup\s+by\b/i.test(s)) return false;
  if (/\bhaving\b/i.test(s)) return false;
  if (/\bunion\b/i.test(s)) return false;
  return /\bfrom\b/i.test(s);
}

function backtick(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Quote a scalar value: bare if it's a plain number, single-quoted otherwise
 *  (with quote-escaping). */
function literal(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

/** Build one SQL condition from a column + filter. Returns null for an
 *  incomplete filter (e.g. an operator that needs a value but has none). */
export function buildCondition(column: string, f: ColumnFilter): string | null {
  const col = backtick(column);
  switch (f.op) {
    case "IS NULL":
      return `${col} IS NULL`;
    case "IS NOT NULL":
      return `${col} IS NOT NULL`;
    case "IN": {
      const parts = f.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return null;
      return `${col} IN (${parts.map(literal).join(", ")})`;
    }
    case "LIKE":
    case "NOT LIKE": {
      if (f.value.trim() === "") return null;
      // Wrap in %…% only if the user didn't include their own wildcards.
      const raw = f.value;
      const pattern = /[%_]/.test(raw) ? raw : `%${raw}%`;
      return `${col} ${f.op} ${literal(pattern)}`;
    }
    default: {
      if (f.value.trim() === "") return null;
      return `${col} ${f.op} ${literal(f.value)}`;
    }
  }
}

/** Locate the trailing clauses we must splice before (ORDER BY / LIMIT / OFFSET
 *  / FOR / LOCK). Mirrors sqlSort's tail detection. */
function tailStart(sql: string): number {
  const res: number[] = [];
  for (const re of [
    /\border\s+by\b/gi,
    /\blimit\b/gi,
    /\boffset\b/gi,
    /\bfor\s+(update|share)\b/gi,
    /\block\s+in\s+share\s+mode\b/gi,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) res.push(m.index);
  }
  return res.length === 0 ? sql.length : Math.min(...res);
}

/** Strip our previously-inserted marked filter block (and a dangling WHERE /
 *  AND left behind), returning SQL with only the user's own conditions. */
function stripManaged(sql: string): string {
  // Case: `WHERE /* squire-filter */ (…)` — the whole WHERE was ours.
  let out = sql.replace(
    new RegExp(`\\bwhere\\s+${escapeRe(MARKER)}\\s*\\([\\s\\S]*?\\)`, "i"),
    "",
  );
  // Case: `… AND /* squire-filter */ (…)` — ours was appended to a user WHERE.
  out = out.replace(
    new RegExp(`\\s+and\\s+${escapeRe(MARKER)}\\s*\\([\\s\\S]*?\\)`, "i"),
    "",
  );
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite `sql` so the managed filter block reflects `conditions`. Removes any
 * prior managed block first, then re-inserts the new one (ANDed onto a
 * hand-written WHERE if present, else as a fresh WHERE), before the tail
 * clauses. Passing an empty array clears the managed block.
 */
export function applyWhereFilters(sql: string, conditions: string[]): string {
  const trimmed = sql.replace(/;\s*$/, "");
  const cleaned = stripManaged(trimmed);
  if (conditions.length === 0) return cleaned.replace(/\s+$/, "");

  const block = `${MARKER} (${conditions.join(" AND ")})`;
  const start = tailStart(cleaned);
  const head = cleaned.slice(0, start);
  const tail = cleaned.slice(start).trim();

  const hasWhere = /\bwhere\b/i.test(head);
  const joined = hasWhere
    ? `${head.trimEnd()} AND ${block}`
    : `${head.trimEnd()}\nWHERE ${block}`;
  return `${joined}${tail ? "\n" + tail : ""}`;
}
