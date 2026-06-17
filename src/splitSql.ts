export type SqlStatement = {
  /** The trimmed statement text (no trailing `;`). */
  sql: string;
  /** Offset of the first non-whitespace char in the original source. */
  offset: number;
};

/**
 * Split a multi-statement SQL string into individual statements. Splits on `;`
 * but ignores semicolons inside single-quoted, double-quoted, and backtick
 * identifiers, line comments (`-- …`, `# …`), and block comments (`/* … *\/`).
 * Empty / whitespace-only statements are filtered out.
 */
export function splitSqlStatements(source: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let buf = "";
  let start = -1;
  let i = 0;
  const n = source.length;

  const flush = (endExclusive: number) => {
    const trimmed = buf.trim();
    if (trimmed.length > 0 && start >= 0) {
      out.push({ sql: trimmed, offset: start });
    }
    buf = "";
    start = -1;
    void endExclusive;
  };

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : "";

    if (ch === "-" && next === "-") {
      const eol = source.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      buf += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "#") {
      const eol = source.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      buf += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      buf += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        const cj = source[j];
        if (cj === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (cj === quote) {
          if (source[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      if (start < 0 && /\S/.test(source.slice(i, j))) start = i;
      buf += source.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ";") {
      flush(i);
      i += 1;
      continue;
    }

    if (start < 0 && /\S/.test(ch)) start = i;
    buf += ch;
    i += 1;
  }
  flush(n);
  return out;
}
