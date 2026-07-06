import { format } from "sql-formatter";

/**
 * Pretty-print MySQL SQL. Keeps keywords upper-cased to match the editor's
 * completion / highlight style. Returns the input unchanged if the formatter
 * throws (e.g. on syntactically incomplete SQL the user is mid-typing) so a
 * failed Format is a no-op rather than an error.
 */
export function formatSql(sql: string): string {
  try {
    return format(sql, {
      language: "mysql",
      keywordCase: "upper",
      tabWidth: 2,
      linesBetweenQueries: 1,
    });
  } catch {
    return sql;
  }
}
