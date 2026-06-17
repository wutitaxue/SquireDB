import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChartConfig,
  Connection,
  ExplainSqlResponse,
  Injection,
  QueryResult,
  SqlFixSuggestion,
} from "../types";
import { SqlEditor, getSelection } from "../panels/SqlEditor";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { AiStrip } from "../panels/AiStrip";
import { ResultsPane } from "../panels/ResultsPane";
import { useStableCallback } from "../hooks/useStableCallback";
import { applyOrderBy, clearOrderBy } from "../sqlSort";
import { splitSqlStatements } from "../splitSql";

/**
 * One result tab inside a batch. A single Run on a multi-statement SQL
 * produces an array of these; the result-tab strip lets the user flip
 * between them. We continue past errors — failed entries stay in the
 * batch with `error` set, but execution proceeds to the next statement
 * (per user pref, mirrors TablePlus).
 */
type BatchEntry =
  | { kind: "ok"; sql: string; result: QueryResult }
  | { kind: "err"; sql: string; error: string };

type Props = {
  conn: Connection;
  injection: Injection;
  onAiInject: (sql: string) => void;
  onExecuted: (connId: number) => void;
  onRequestSaveQuery: (connectionId: number, sql: string) => void;
  /** Database list shown in the toolbar dropdown. Pass an empty array to
   *  hide the picker (e.g. when the schema hasn't loaded yet). */
  databases: string[];
  /** Currently-picked database for this tab, or undefined to use the
   *  connection's default. */
  database: string | undefined;
  onChangeDatabase: (next: string | undefined) => void;
};

function QueryWorkspaceImpl({
  conn,
  injection,
  onRequestSaveQuery,
  onAiInject,
  onExecuted,
  databases,
  database,
  onChangeDatabase,
}: Props) {
  const [sql, setSql] = useState(injection.sql);
  const [batch, setBatch] = useState<BatchEntry[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<{ done: number; total: number } | null>(null);
  const editorRef = useRef<ReactCodeMirrorRef | null>(null);

  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiFocusToken, setAiFocusToken] = useState(0);
  // Prefill is bumped only when a chip seeds text into the AI input (e.g.
  // "Add filter"). AiStrip owns the keystroke-by-keystroke prompt state
  // internally so typing doesn't re-render this workspace.
  const [aiPrefill, setAiPrefill] = useState({ token: 0, value: "" });

  const [fix, setFix] = useState<SqlFixSuggestion | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [fixError, setFixError] = useState("");

  const [chartConfig, setChartConfig] = useState<ChartConfig | null>(null);
  const [chartBusy, setChartBusy] = useState(false);
  const [chartError, setChartError] = useState("");

  const [explain, setExplain] = useState<ExplainSqlResponse | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);
  const [explainError, setExplainError] = useState("");

  // Tracks the column the user clicked on in the result header so we can
  // render the ▲ / ▼ indicator. The SQL itself is the source of truth — this
  // is only a UI hint and is cleared whenever the user edits the SQL manually.
  const [sortHint, setSortHint] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const runningTokenRef = useRef<string | null>(null);
  const cancellingRef = useRef(false);

  async function run(sqlOverride?: string) {
    if (!conn.id || running) return;
    const sqlToRun = (sqlOverride ?? sql).trim();
    if (!sqlToRun) return;
    const statements = splitSqlStatements(sqlToRun);
    if (statements.length === 0) return;

    setRunning(true);
    setCancelling(false);
    setFix(null);
    setFixError("");
    setChartConfig(null);
    setChartError("");
    setExplain(null);
    setExplainError("");
    // Overwrite: each Run wipes the previous batch — DataGrip default.
    setBatch([]);
    setActiveIdx(0);
    setRunProgress({ done: 0, total: statements.length });

    const collected: BatchEntry[] = [];
    let cancelled = false;
    try {
      for (let i = 0; i < statements.length; i += 1) {
        if (cancelled) break;
        const stmt = statements[i];
        const queryToken = `q-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        runningTokenRef.current = queryToken;
        try {
          const r = await invoke<QueryResult>("execute_query", {
            id: conn.id,
            sql: stmt.sql,
            queryToken,
            database: database ?? null,
          });
          collected.push({ kind: "ok", sql: stmt.sql, result: r });
        } catch (e) {
          const msg = String(e);
          collected.push({ kind: "err", sql: stmt.sql, error: msg });
          // Continue past errors (per user pref) — but if the cancel was
          // user-initiated, stop draining the remaining statements.
          if (cancellingRef.current) cancelled = true;
        } finally {
          runningTokenRef.current = null;
        }
        setBatch([...collected]);
        setRunProgress({ done: i + 1, total: statements.length });
      }
    } finally {
      setRunning(false);
      setCancelling(false);
      cancellingRef.current = false;
      setRunProgress(null);
      // Activate the first error if any, else the last successful tab —
      // mirrors DataGrip "jump to the thing that needs attention".
      const firstErr = collected.findIndex((e) => e.kind === "err");
      setActiveIdx(firstErr >= 0 ? firstErr : Math.max(0, collected.length - 1));
      if (conn.id != null) onExecuted(conn.id);
    }
  }

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    cancellingRef.current = true;
    const token = runningTokenRef.current;
    if (!token) return;
    try {
      await invoke("cancel_query", { queryToken: token });
    } catch {
      // ignore — KILL might race with completion
    }
  }

  async function askExplain() {
    if (!conn.id || explainBusy || !sql.trim()) return;
    setExplainBusy(true);
    setExplainError("");
    setExplain(null);
    try {
      const r = await invoke<ExplainSqlResponse>("explain_sql", {
        connectionId: conn.id,
        sql,
        includeAi: true,
      });
      setExplain(r);
    } catch (e) {
      setExplainError(String(e));
    } finally {
      setExplainBusy(false);
    }
  }

  async function askChart() {
    const active = batch[activeIdx];
    if (!active || active.kind !== "ok" || chartBusy || active.result.rows.length === 0) return;
    setChartBusy(true);
    setChartError("");
    setChartConfig(null);
    try {
      const cfg = await invoke<ChartConfig>("suggest_chart", {
        columns: active.result.columns,
        sampleRows: active.result.rows.slice(0, 30),
      });
      setChartConfig(cfg);
    } catch (e) {
      setChartError(String(e));
    } finally {
      setChartBusy(false);
    }
  }

  async function askAi(prompt: string) {
    if (!conn.id || aiBusy) return;
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setAiBusy(true);
    setAiError("");
    try {
      const activeOk = batch[activeIdx]?.kind === "ok" ? batch[activeIdx] : null;
      const editable = activeOk?.kind === "ok" ? activeOk.result.editable : null;
      const currentTable = editable ? `${editable.schema}.${editable.table}` : null;
      const generated = await invoke<string>("generate_sql", {
        connectionId: conn.id,
        prompt: trimmed,
        currentSql: sql.trim() ? sql : null,
        currentTable,
      });
      setSql(generated);
      onAiInject(generated);
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function askFix() {
    const active = batch[activeIdx];
    if (!conn.id || fixBusy || !active || active.kind !== "err") return;
    setFixBusy(true);
    setFixError("");
    setFix(null);
    try {
      const f = await invoke<SqlFixSuggestion>("fix_sql_error", {
        connectionId: conn.id,
        sql: active.sql,
        error: active.error,
      });
      setFix(f);
    } catch (e) {
      setFixError(String(e));
    } finally {
      setFixBusy(false);
    }
  }

  function applyFix() {
    if (fix?.fixed_sql) {
      setSql(fix.fixed_sql);
      setFix(null);
      setFixError("");
      // Clear the active error tab so the editor area shows fresh prompt.
      setBatch((prev) => prev.filter((_, i) => i !== activeIdx));
      setActiveIdx(0);
    }
  }

  function focusAiStrip(prefill?: string) {
    if (prefill !== undefined) {
      setAiPrefill((p) => ({ token: p.token + 1, value: prefill }));
    } else {
      setAiFocusToken((n) => n + 1);
    }
  }

  // Stable identities for callbacks passed to memo'd children (ResultsPane,
  // SqlEditor). Without these, every keystroke recreates the arrow closures
  // and defeats the child memos, which makes typing visibly laggy when a
  // large result set is mounted below the editor.
  // Mod-Enter from SqlEditor passes the current selection (if any) so we run
  // only the highlighted fragment — DataGrip / TablePlus behavior. The Run
  // button reads the selection separately via the editor ref so clicking it
  // with a selection also runs only that fragment.
  const stableRun = useStableCallback((selected?: string) => {
    const fragment = selected?.trim() ? selected : undefined;
    void run(fragment);
  });
  const runFromButton = () => {
    const sel = getSelection(editorRef)?.trim() || undefined;
    void run(sel);
  };
  const stableAskChart = useStableCallback(() => void askChart());
  const stableAskExplain = useStableCallback(() => void askExplain());
  const stableChartClose = useStableCallback(() => setChartConfig(null));
  const stableSort = useStableCallback((column: string, dir: "asc" | "desc") => {
    const next = applyOrderBy(sql, column, dir);
    setSql(next);
    setSortHint({ column, dir });
    void run(next);
  });
  const stableClearSort = useStableCallback(() => {
    const next = clearOrderBy(sql);
    setSql(next);
    setSortHint(null);
    void run(next);
  });
  // Manual edits to the SQL invalidate the sort indicator — the column may
  // have been renamed, dropped, or the ORDER BY clause rewritten by hand.
  const stableSetSql = useStableCallback((next: string) => {
    setSql(next);
    setSortHint(null);
  });

  useEffect(() => {
    setSql(injection.sql);
    if (injection.autorun && injection.nonce > 0) {
      void run(injection.sql);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injection.nonce]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sqlRef = useRef(sql);
  sqlRef.current = sql;
  const connIdRef = useRef(conn.id);
  connIdRef.current = conn.id;
  const onRequestSaveRef = useRef(onRequestSaveQuery);
  onRequestSaveRef.current = onRequestSaveQuery;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s";
      if (!isSave) return;
      // Only the visible workspace instance reacts — inactive tabs are
      // .hidden (display:none) by the parent, so offsetParent is null.
      if (!containerRef.current || containerRef.current.offsetParent === null) {
        return;
      }
      e.preventDefault();
      const s = sqlRef.current;
      const cid = connIdRef.current;
      if (!s.trim() || !cid) return;
      onRequestSaveRef.current(cid, s);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const breadcrumb = (
    <div className="flex items-center gap-1.5 text-[12px] text-muted min-w-0">
      <span className="text-acc-ink font-semibold truncate">{conn.name}</span>
      <span className="text-border-2">/</span>
      <span className="font-mono text-ink-2 truncate">query.sql</span>
    </div>
  );

  const canRun = !running && !!sql.trim() && conn.id !== null;

  const activeEntry: BatchEntry | undefined = batch[activeIdx];
  const activeResult = activeEntry?.kind === "ok" ? activeEntry.result : null;
  const activeError = activeEntry?.kind === "err" ? activeEntry.error : "";

  const updateActiveResult = useStableCallback((next: QueryResult) => {
    setBatch((prev) =>
      prev.map((e, i) =>
        i === activeIdx && e.kind === "ok" ? { ...e, result: next } : e,
      ),
    );
  });

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-bg overflow-hidden">
      <div className="flex items-center h-9 px-3 gap-3 bg-bg border-b border-border shrink-0">
        {breadcrumb}
        {databases.length > 0 && (
          <label
            className="flex items-center gap-1 text-[11px] text-muted shrink-0"
            title="Run queries in this tab against the selected database. Uses the connection's default when blank."
          >
            <span className="opacity-70">DB</span>
            <select
              value={database ?? ""}
              onChange={(e) => onChangeDatabase(e.target.value || undefined)}
              className="h-6 px-1.5 text-[11px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2 focus:outline-none focus:border-acc max-w-[160px]"
            >
              <option value="">(default)</option>
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            if (!conn.id) return;
            onRequestSaveQuery(conn.id, sql);
          }}
          disabled={!sql.trim() || !conn.id}
          title="Save this SQL for later (Cmd+S)"
          className="h-6 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          ⭐ Save
        </button>
        <span className="h-4 w-px bg-border" />
        {running ? (
          <button
            onClick={() => void cancel()}
            disabled={cancelling}
            className="h-6 px-3 text-[12px] font-semibold text-white bg-crit rounded-md hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {cancelling ? "Stopping…" : "Stop"}
            <span className="w-2 h-2 bg-white rounded-sm" />
          </button>
        ) : (
          <button
            onClick={runFromButton}
            disabled={!canRun}
            className="h-6 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            Run
            <kbd className="text-[10px] font-mono bg-acc-ink/30 px-1 rounded">⌘⏎</kbd>
          </button>
        )}
      </div>

      <div
        className="flex flex-col bg-panel-2 border-b border-border shrink-0 overflow-hidden"
        style={{ height: "34%", minHeight: 180, maxHeight: "60%" }}
      >
        <div className="flex-1 min-h-0 overflow-y-auto">
          <SqlEditor value={sql} onChange={stableSetSql} onRun={stableRun} editorRef={editorRef} />
        </div>
        <div className="px-2 py-2 bg-panel-2 border-t border-border shrink-0">
          <AiStrip
            onSubmit={(prompt) => void askAi(prompt)}
            busy={aiBusy}
            focusToken={aiFocusToken}
            prefill={aiPrefill}
            chips={[
              {
                label: "Explain",
                action: () => void askExplain(),
                disabled: !sql.trim() || explainBusy,
                title: "Explain query plan",
              },
              {
                label: "Optimize",
                action: () =>
                  void askAi(
                    `Rewrite this MySQL query for better performance, keep semantics identical:\n${sql}`,
                  ),
                disabled: !sql.trim(),
                title: "AI rewrite for performance",
              },
              {
                label: "Add filter",
                action: () => focusAiStrip("Add a WHERE filter for "),
                disabled: !sql.trim(),
                title: "Ask AI to add a filter",
              },
              {
                label: "Generate chart",
                action: () => void askChart(),
                disabled:
                  !activeResult || activeResult.rows.length === 0 || chartBusy,
                title: activeResult?.rows.length
                  ? "Suggest a chart from results"
                  : "Run a query first",
              },
            ]}
          />
          {aiError && (
            <pre className="mt-2 px-2 py-1.5 bg-crit-soft text-crit text-[11px] rounded whitespace-pre-wrap">
              {aiError}
            </pre>
          )}
        </div>
      </div>

      {batch.length > 1 && (
        <div className="flex items-center gap-0.5 px-2 h-7 bg-bg-2 border-b border-border shrink-0 overflow-x-auto">
          {batch.map((e, i) => {
            const isActive = i === activeIdx;
            const isErr = e.kind === "err";
            const label =
              e.kind === "ok"
                ? e.result.rows_affected != null && e.result.columns.length === 0
                  ? `Result ${i + 1} · ${e.result.rows_affected} affected · ${e.result.elapsed_ms}ms`
                  : `Result ${i + 1} · ${e.result.rows.length} rows · ${e.result.elapsed_ms}ms`
                : `Error ${i + 1}`;
            return (
              <button
                key={i}
                onClick={() => setActiveIdx(i)}
                title={e.sql}
                className={
                  "shrink-0 h-6 px-2 text-[11px] rounded-md border " +
                  (isActive
                    ? isErr
                      ? "bg-crit-soft border-crit/40 text-crit"
                      : "bg-panel border-acc/40 text-ink"
                    : isErr
                      ? "border-transparent text-crit/80 hover:bg-crit-soft/60"
                      : "border-transparent text-muted hover:bg-bg")
                }
              >
                {label}
              </button>
            );
          })}
          {runProgress && runProgress.done < runProgress.total && (
            <span className="ml-2 text-[10px] text-muted shrink-0">
              {runProgress.done}/{runProgress.total} running…
            </span>
          )}
        </div>
      )}

      {activeError ? (
        <div className="flex flex-col gap-2 p-3 overflow-auto">
          <div className="bg-crit-soft border border-crit/20 rounded-lg p-3 flex items-start gap-3">
            <pre className="flex-1 text-[12px] text-crit font-mono whitespace-pre-wrap m-0">
              {activeError}
            </pre>
            <button
              onClick={() => void askFix()}
              disabled={fixBusy}
              className="shrink-0 h-7 px-2.5 text-[11px] font-medium text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50"
            >
              {fixBusy ? "Asking AI…" : "🤖 Explain & Fix"}
            </button>
          </div>
          {fixError && (
            <pre className="px-2 py-1.5 bg-crit-soft text-crit text-[11px] rounded whitespace-pre-wrap">
              {fixError}
            </pre>
          )}
          {fix && (
            <div className="bg-acc-soft/40 border border-acc/30 rounded-lg p-3 flex flex-col gap-2">
              <div className="text-[12px] text-acc-ink whitespace-pre-wrap">
                {fix.explanation}
              </div>
              {fix.fixed_sql && (
                <>
                  <pre className="m-0 p-2 bg-panel border border-border rounded font-mono text-[11.5px] text-ink-2 whitespace-pre-wrap max-h-[200px] overflow-auto">
                    {fix.fixed_sql}
                  </pre>
                  <div className="flex gap-2">
                    <button
                      onClick={applyFix}
                      className="h-6 px-2.5 text-[11px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2"
                    >
                      Apply fix
                    </button>
                    <button
                      onClick={() => setFix(null)}
                      className="h-6 px-2.5 text-[11px] text-muted hover:text-ink"
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : activeResult ? (
        <ResultsPane
          connectionId={conn.id}
          result={activeResult}
          onResultUpdate={updateActiveResult}
          onRerun={stableRun}
          chartConfig={chartConfig}
          chartBusy={chartBusy}
          chartError={chartError}
          onAskChart={stableAskChart}
          onChartChange={setChartConfig}
          onChartClose={stableChartClose}
          explain={explain}
          explainBusy={explainBusy}
          explainError={explainError}
          onAskExplain={stableAskExplain}
          onSort={stableSort}
          onClearSort={stableClearSort}
          sort={sortHint}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted text-[12px]">
          {running ? "Running query…" : "Press Run to execute the query."}
        </div>
      )}
    </div>
  );
}

/**
 * memo-wrapped: every query tab is kept mounted (so result / SQL / chart state
 * survives tab switches), which means a `setActiveTabId` in App.tsx re-renders
 * the whole tab list. Memoizing here keeps the heavy ResultsPane inside each
 * inactive tab quiet. Callers MUST pass stable callback identities for
 * `onAiInject` / `onExecuted` (see hooks/useStableCallback) or this memo
 * is a no-op.
 */
export const QueryWorkspace = memo(QueryWorkspaceImpl);
