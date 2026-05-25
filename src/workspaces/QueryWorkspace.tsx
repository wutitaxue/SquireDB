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
import { SqlEditor } from "../panels/SqlEditor";
import { AiStrip } from "../panels/AiStrip";
import { ResultsPane } from "../panels/ResultsPane";
import { useStableCallback } from "../hooks/useStableCallback";

type Props = {
  conn: Connection;
  injection: Injection;
  onAiInject: (sql: string) => void;
  onExecuted: (connId: number) => void;
};

function QueryWorkspaceImpl({
  conn,
  injection,
  onAiInject,
  onExecuted,
}: Props) {
  const [sql, setSql] = useState(injection.sql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

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

  const [cancelling, setCancelling] = useState(false);
  const runningTokenRef = useRef<string | null>(null);

  async function run(sqlOverride?: string) {
    if (!conn.id || running) return;
    const sqlToRun = (sqlOverride ?? sql).trim();
    if (!sqlToRun) return;
    const queryToken = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    runningTokenRef.current = queryToken;
    setRunning(true);
    setCancelling(false);
    setError("");
    setResult(null);
    setFix(null);
    setFixError("");
    setChartConfig(null);
    setChartError("");
    setExplain(null);
    setExplainError("");
    try {
      const r = await invoke<QueryResult>("execute_query", {
        id: conn.id,
        sql: sqlToRun,
        queryToken,
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      runningTokenRef.current = null;
      setRunning(false);
      setCancelling(false);
      if (conn.id != null) onExecuted(conn.id);
    }
  }

  async function cancel() {
    const token = runningTokenRef.current;
    if (!token || cancelling) return;
    setCancelling(true);
    try {
      await invoke("cancel_query", { queryToken: token });
    } catch {
      // ignore — KILL might race with completion
      setCancelling(false);
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
    if (!result || chartBusy || result.rows.length === 0) return;
    setChartBusy(true);
    setChartError("");
    setChartConfig(null);
    try {
      const cfg = await invoke<ChartConfig>("suggest_chart", {
        columns: result.columns,
        sampleRows: result.rows.slice(0, 30),
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
      const currentTable = result?.editable
        ? `${result.editable.schema}.${result.editable.table}`
        : null;
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
    if (!conn.id || fixBusy || !error) return;
    setFixBusy(true);
    setFixError("");
    setFix(null);
    try {
      const f = await invoke<SqlFixSuggestion>("fix_sql_error", {
        connectionId: conn.id,
        sql,
        error,
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
      setError("");
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
  const stableRun = useStableCallback(() => void run());
  const stableAskChart = useStableCallback(() => void askChart());
  const stableAskExplain = useStableCallback(() => void askExplain());
  const stableChartClose = useStableCallback(() => setChartConfig(null));

  useEffect(() => {
    setSql(injection.sql);
    if (injection.autorun && injection.nonce > 0) {
      void run(injection.sql);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injection.nonce]);

  const breadcrumb = (
    <div className="flex items-center gap-1.5 text-[12px] text-muted min-w-0">
      <span className="text-acc-ink font-semibold truncate">{conn.name}</span>
      <span className="text-border-2">/</span>
      <span className="font-mono text-ink-2 truncate">query.sql</span>
    </div>
  );

  const canRun = !running && !!sql.trim() && conn.id !== null;

  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      <div className="flex items-center h-9 px-3 gap-3 bg-bg border-b border-border shrink-0">
        {breadcrumb}
        <div className="flex-1" />
        <button
          disabled
          title="Coming soon"
          className="h-6 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded-md disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Save
        </button>
        <button
          disabled
          title="Coming soon"
          className="h-6 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded-md disabled:opacity-60 disabled:cursor-not-allowed"
        >
          History
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
            onClick={() => void run()}
            disabled={!canRun}
            className="h-6 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            Run
            <kbd className="text-[10px] font-mono bg-acc-ink/30 px-1 rounded">⌘⏎</kbd>
          </button>
        )}
      </div>

      <div
        className="flex flex-col bg-panel-2 border-b border-border shrink-0"
        style={{ height: "34%", minHeight: 180, maxHeight: "60%" }}
      >
        <div className="flex-1 min-h-0">
          <SqlEditor value={sql} onChange={setSql} onRun={stableRun} />
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
                disabled: !result || result.rows.length === 0 || chartBusy,
                title: result?.rows.length ? "Suggest a chart from results" : "Run a query first",
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

      {error ? (
        <div className="flex flex-col gap-2 p-3 overflow-auto">
          <div className="bg-crit-soft border border-crit/20 rounded-lg p-3 flex items-start gap-3">
            <pre className="flex-1 text-[12px] text-crit font-mono whitespace-pre-wrap m-0">
              {error}
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
      ) : result ? (
        <ResultsPane
          connectionId={conn.id}
          result={result}
          onResultUpdate={setResult}
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
