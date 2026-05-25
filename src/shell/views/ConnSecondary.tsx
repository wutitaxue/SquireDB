import { formatTime } from "../../utils";
import type { HistoryEntry, QuerySuggestion } from "../../types";
import { Section } from "../atoms/Section";

type Props = {
  databases: string[];

  suggestions: QuerySuggestion[];
  suggestionsTable: string;
  suggestionsBusy: boolean;
  suggestionsError: string;
  onClearSuggestions: () => void;
  onInjectSql: (sql: string) => void;

  /** Counts shown in the read-only Schema status section. */
  annotationsCount: number;
  piiCount: number;
  relationsCount: number;
  tablesCount: number;

  history: HistoryEntry[];
  onUseHistory: (sql: string) => void;
};

export function ConnSecondary(props: Props) {
  const {
    databases,
    suggestions,
    suggestionsTable,
    suggestionsBusy,
    suggestionsError,
    onClearSuggestions,
    onInjectSql,
    annotationsCount,
    piiCount,
    relationsCount,
    tablesCount,
    history,
    onUseHistory,
  } = props;

  const hasSuggestions =
    suggestionsBusy || suggestions.length > 0 || !!suggestionsError;
  const hasSchemaStatus = annotationsCount > 0 || relationsCount > 0;

  if (
    databases.length === 0 &&
    history.length === 0 &&
    !hasSuggestions &&
    !hasSchemaStatus
  ) {
    return null;
  }

  return (
    <>
      {hasSuggestions && (
        <div className="shrink-0 max-h-[160px] overflow-y-auto">
        <Section
          title="💡 Suggestions"
          actions={
            <button
              onClick={onClearSuggestions}
              className="text-[10px] text-muted hover:text-ink px-1"
            >
              Clear
            </button>
          }
          flush
        >
          <div className="text-[10px] text-subtle font-mono mb-1 px-2">
            {suggestionsTable}
          </div>
          {suggestionsBusy && (
            <div className="text-[11px] text-muted px-2">AI thinking…</div>
          )}
          {suggestionsError && (
            <div className="text-[11px] text-crit px-2 whitespace-pre-wrap break-words">
              {suggestionsError}
            </div>
          )}
          <ul>
            {suggestions.map((s, i) => (
              <li key={i}>
                <button
                  onClick={() => onInjectSql(s.sql)}
                  title={s.sql}
                  className="w-full text-left px-2 py-1 hover:bg-bg rounded"
                >
                  <div className="text-[12px] text-ink-2 font-medium truncate">
                    {s.title}
                  </div>
                  <div className="text-[10px] text-subtle font-mono truncate">
                    {s.sql.replace(/\s+/g, " ").slice(0, 80)}
                    {s.sql.length > 80 ? "…" : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Section>
        </div>
      )}

      {hasSchemaStatus && (
        <div className="shrink-0">
        <Section title="Schema status" flush>
          <div className="px-2 text-[11px] text-ink-2 leading-relaxed tabular-nums">
            <div>
              <span className="font-mono">{tablesCount}</span>{" "}
              <span className="text-muted">tables loaded</span>
            </div>
            <div>
              <span className="font-mono">{annotationsCount}</span>{" "}
              <span className="text-muted">annotations</span>
              {piiCount > 0 && (
                <>
                  {" · "}
                  <span className="font-mono text-pii">{piiCount}</span>{" "}
                  <span className="text-muted">PII</span>
                </>
              )}
            </div>
            <div>
              <span className="font-mono">{relationsCount}</span>{" "}
              <span className="text-muted">relations</span>
            </div>
            <div className="text-[10px] text-subtle mt-1 italic">
              Use AI Agents → Analyze / Infer / Dictionary
            </div>
          </div>
        </Section>
        </div>
      )}

      {history.length > 0 && (
        <div className="flex-1 min-h-0 overflow-y-auto">
        <Section
          title="History"
          actions={
            <span className="text-[10px] text-subtle">last {history.length}</span>
          }
          bordered={false}
          flush
        >
          <ul>
            {history.map((h) => {
              const truncated = h.sql.replace(/\s+/g, " ").slice(0, 60);
              const more = h.sql.length > 60 ? "…" : "";
              const ok = h.error === null;
              const meta = ok
                ? `${h.rows_returned ?? h.rows_affected ?? 0}r · ${h.elapsed_ms ?? "?"}ms`
                : "error";
              return (
                <li key={h.id}>
                  <button
                    onClick={() => onUseHistory(h.sql)}
                    title={h.sql}
                    className="w-full text-left px-2 py-1 hover:bg-bg rounded"
                  >
                    <div
                      className={`text-[11px] font-mono truncate ${ok ? "text-ink-2" : "text-crit"}`}
                    >
                      {ok ? "⚡" : "✗"} {truncated}
                      {more}
                    </div>
                    <div className="text-[10px] text-subtle">
                      {meta} · {formatTime(h.executed_at)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
        </div>
      )}
    </>
  );
}
