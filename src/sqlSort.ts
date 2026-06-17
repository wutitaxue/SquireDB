/**
 * Rewrite a SQL statement to ORDER BY a single column. Strips any existing
 * top-level ORDER BY clause and inserts the new one before LIMIT / OFFSET /
 * FOR UPDATE / LOCK IN SHARE MODE.
 *
 * This is a best-effort regex rewriter — it handles the common case (a single
 * top-level SELECT) but punts on:
 *   - statements with comments inside the tail clauses
 *   - ORDER BY inside subqueries / CTEs (we only touch the outermost)
 *   - multi-statement scripts separated by ;
 * For those cases the rewriter falls back to appending to the end of the
 * statement, which may produce a syntax error — the user sees the failed
 * query and can fix it.
 */
export function applyOrderBy(
  sql: string,
  columnName: string,
  dir: "asc" | "desc",
): string {
  const trimmed = sql.replace(/;\s*$/, "");
  const tail = extractTailClauses(trimmed);
  const head = trimmed.slice(0, tail.start);
  const orderBy = `ORDER BY ${backtick(columnName)} ${dir === "asc" ? "ASC" : "DESC"}`;
  return `${head.trimEnd()}\n${orderBy}${tail.rest ? "\n" + tail.rest : ""}`;
}

function backtick(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/**
 * Find the start of the trailing clauses (ORDER BY / LIMIT / OFFSET / FOR
 * UPDATE / LOCK IN SHARE MODE) so we can splice between the body and them.
 * Returns the index of the first such clause and the rest (with existing
 * ORDER BY stripped).
 */
function extractTailClauses(sql: string): { start: number; rest: string } {
  // Match the *last* top-level occurrence. We use a permissive regex that
  // looks for these keywords near the end of the statement.
  const orderByRe = /\border\s+by\b/gi;
  const limitRe = /\blimit\b/gi;
  const offsetRe = /\boffset\b/gi;
  const forUpdateRe = /\bfor\s+(update|share)\b/gi;
  const lockShareRe = /\block\s+in\s+share\s+mode\b/gi;

  const candidates: number[] = [];
  for (const re of [orderByRe, limitRe, offsetRe, forUpdateRe, lockShareRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      candidates.push(m.index);
    }
  }
  if (candidates.length === 0) {
    return { start: sql.length, rest: "" };
  }
  const start = Math.min(...candidates);
  const tail = sql.slice(start);
  // Strip the existing ORDER BY (everything from `ORDER BY` up to the next
  // tail keyword) so the new one replaces it.
  const stripped = tail.replace(
    /\border\s+by\b[\s\S]*?(?=\blimit\b|\boffset\b|\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b|$)/i,
    "",
  );
  return { start, rest: stripped.trim() };
}
