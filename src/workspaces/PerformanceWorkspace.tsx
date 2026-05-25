import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ExplainSqlResponse,
  PerfStatus,
  ProcessRow,
  RuntimeStatus,
  SlowQuery,
  VariableEntry,
} from "../types";
import { ExplainPanel } from "../panels/ExplainPanel";
import { isImeComposing } from "../utils";
import {
  AgentPanel,
  Card,
  ErrorPre,
  KpiCard,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SevPill,
  type SevTone,
} from "../shell/AgentPanel";

type Tab = "slow" | "processlist" | "variables";

type Props = {
  connectionId: number;
  onClose: () => void;
  onInjectSql: (sql: string) => void;
};

export function PerformanceWorkspace({ connectionId, onClose, onInjectSql }: Props) {
  const [tab, setTab] = useState<Tab>("slow");
  const [status, setStatus] = useState<PerfStatus | null>(null);

  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [qps, setQps] = useState<number | null>(null);
  const prevRuntime = useRef<{ status: RuntimeStatus; at: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<PerfStatus>("get_perf_status", { connectionId })
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  async function refreshRuntime() {
    try {
      const s = await invoke<RuntimeStatus>("server_status", { connectionId });
      const now = Date.now();
      if (prevRuntime.current) {
        const dt = (now - prevRuntime.current.at) / 1000;
        if (dt > 0.5) {
          const dq = s.queries - prevRuntime.current.status.queries;
          setQps(dq / dt);
        }
      }
      prevRuntime.current = { status: s, at: now };
      setRuntime(s);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void refreshRuntime();
    const t = setInterval(() => void refreshRuntime(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  return (
    <AgentPanel
      icon="🐢"
      title="Performance"
      subtitle={
        status
          ? `MySQL ${status.mysql_version} · perf_schema ${status.performance_schema ? "ON" : "OFF"}`
          : "Slow queries · processes · variables"
      }
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        <Kpis status={status} runtime={runtime} qps={qps} />

        <Card padded={false}>
          <div className="flex items-stretch h-9 border-b border-border">
            <TabBtn active={tab === "slow"} onClick={() => setTab("slow")}>
              Slow Queries
            </TabBtn>
            <TabBtn active={tab === "processlist"} onClick={() => setTab("processlist")}>
              Processlist
            </TabBtn>
            <TabBtn active={tab === "variables"} onClick={() => setTab("variables")}>
              Variables
            </TabBtn>
          </div>
          <div className="p-4">
            {tab === "slow" && (
              <SlowQueriesTab connectionId={connectionId} onInjectSql={onInjectSql} />
            )}
            {tab === "processlist" && <ProcesslistTab connectionId={connectionId} />}
            {tab === "variables" && <VariablesTab connectionId={connectionId} />}
          </div>
        </Card>
      </div>
    </AgentPanel>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 text-[12.5px] font-medium ${
        active ? "text-acc-ink" : "text-muted hover:text-ink-2"
      }`}
    >
      {active && <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-acc" />}
      {children}
    </button>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function Kpis({
  status,
  runtime,
  qps,
}: {
  status: PerfStatus | null;
  runtime: RuntimeStatus | null;
  qps: number | null;
}) {
  if (!status && !runtime) return null;
  return (
    <div className="grid grid-cols-4 gap-3">
      <KpiCard
        label="QPS"
        value={qps != null ? qps.toFixed(1) : "…"}
        sub="queries / sec"
        tone="info"
      />
      <KpiCard
        label="Threads running"
        value={runtime?.threads_running ?? "—"}
        sub={runtime ? `${runtime.threads_connected} connected` : ""}
        tone={runtime && runtime.threads_running > 50 ? "warn" : "neutral"}
      />
      <KpiCard
        label="Slow queries (total)"
        value={runtime ? runtime.slow_queries.toLocaleString() : "—"}
        sub="since startup"
        tone={runtime && runtime.slow_queries > 0 ? "warn" : "ok"}
      />
      <KpiCard
        label="Uptime"
        value={runtime ? formatDuration(runtime.uptime) : "—"}
        sub={
          status
            ? `slow_query_log ${status.slow_query_log ? "ON" : "OFF"} · long ${status.long_query_time}s`
            : ""
        }
        tone="neutral"
      />
    </div>
  );
}

function SlowQueriesTab({
  connectionId,
  onInjectSql,
}: {
  connectionId: number;
  onInjectSql: (sql: string) => void;
}) {
  const [slow, setSlow] = useState<SlowQuery[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [minAvgMs, setMinAvgMs] = useState(0);
  const [limit, setLimit] = useState(50);
  const [sortBy, setSortBy] = useState<"total_ms" | "avg_ms" | "count_star">("total_ms");
  const [openExplain, setOpenExplain] = useState<{
    sql: string;
    schema: string | null;
    data: ExplainSqlResponse | null;
    busy: boolean;
    error: string;
  } | null>(null);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const sl = await invoke<SlowQuery[]>("list_slow_queries", {
        connectionId,
        limit,
        minAvgMs,
      });
      setSlow(sl);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const sorted = useMemo(() => {
    if (!slow) return [];
    const list = [...slow];
    list.sort((a, b) => (b[sortBy] as number) - (a[sortBy] as number));
    return list;
  }, [slow, sortBy]);

  async function explainOne(q: SlowQuery) {
    const sql = q.digest_text;
    setOpenExplain({ sql, schema: q.schema_name, data: null, busy: true, error: "" });
    try {
      const r = await invoke<ExplainSqlResponse>("explain_sql", {
        connectionId,
        sql,
        includeAi: true,
      });
      setOpenExplain((prev) =>
        prev && prev.sql === sql ? { ...prev, data: r, busy: false } : prev,
      );
    } catch (e) {
      const msg = String(e);
      setOpenExplain((prev) =>
        prev && prev.sql === sql ? { ...prev, error: msg, busy: false } : prev,
      );
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap text-[12px]">
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
            Min avg ms
          </span>
          <input
            type="number"
            value={minAvgMs}
            onChange={(e) => setMinAvgMs(Number(e.target.value) || 0)}
            className="h-7 w-20 px-2 text-[12px] bg-panel-2 border border-border rounded-md tabular-nums"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
            Limit
          </span>
          <input
            type="number"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 50)}
            className="h-7 w-16 px-2 text-[12px] bg-panel-2 border border-border rounded-md tabular-nums"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
            Sort by
          </span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md"
          >
            <option value="total_ms">Total time</option>
            <option value="avg_ms">Avg time</option>
            <option value="count_star">Call count</option>
          </select>
        </label>
        <PrimaryButton onClick={() => void refresh()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </PrimaryButton>
        <span className="text-[12px] text-muted ml-auto">{sorted.length} queries</span>
      </div>

      {error && <ErrorPre>{error}</ErrorPre>}

      <div className="border border-border rounded-lg overflow-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-left px-3 h-8 text-[11px] font-semibold text-muted">
                SQL
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-right px-3 h-8 text-[11px] font-semibold text-muted">
                Calls
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-right px-3 h-8 text-[11px] font-semibold text-muted">
                Avg ms
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-right px-3 h-8 text-[11px] font-semibold text-muted">
                Max ms
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-right px-3 h-8 text-[11px] font-semibold text-muted">
                Total ms
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-right px-3 h-8 text-[11px] font-semibold text-muted">
                Avg rows
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-left px-3 h-8 text-[11px] font-semibold text-muted">
                No index
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-left px-3 h-8 text-[11px] font-semibold text-muted">
                Schema
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border px-3 h-8" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((q) => (
              <tr
                key={q.digest || q.digest_text}
                className="border-b border-border hover:bg-[rgba(0,109,104,0.04)]"
              >
                <td
                  className="px-3 h-8 font-mono max-w-[500px] overflow-hidden text-ellipsis whitespace-nowrap text-ink-2"
                  title={q.digest_text}
                >
                  {q.digest_text}
                </td>
                <td className="px-3 h-8 font-mono text-right tabular-nums text-ink-2">
                  {q.count_star}
                </td>
                <td className="px-3 h-8 font-mono text-right tabular-nums text-ink-2">
                  {q.avg_ms.toFixed(2)}
                </td>
                <td className="px-3 h-8 font-mono text-right tabular-nums text-ink-2">
                  {q.max_ms.toFixed(2)}
                </td>
                <td className="px-3 h-8 font-mono text-right tabular-nums text-ink font-semibold">
                  {q.total_ms.toFixed(0)}
                </td>
                <td className="px-3 h-8 font-mono text-right tabular-nums text-ink-2">
                  {q.avg_rows_examined.toFixed(0)}
                </td>
                <td className="px-3 h-8 font-mono text-warn">
                  {q.no_index_used > 0 ? `⚠ ${q.no_index_used}` : "-"}
                </td>
                <td className="px-3 h-8 font-mono text-ink-2">{q.schema_name ?? "-"}</td>
                <td className="px-2 h-8">
                  <button
                    onClick={() => void explainOne(q)}
                    className="h-5 px-2 text-[10px] text-acc bg-acc-soft rounded hover:bg-acc hover:text-white"
                  >
                    Explain
                  </button>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-6 text-[12px] text-muted text-center italic"
                >
                  No queries match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openExplain && (
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <SectionTitle>Explain for selected query</SectionTitle>
            <div className="flex-1" />
            <SecondaryButton onClick={() => setOpenExplain(null)}>Close</SecondaryButton>
          </div>
          <pre className="m-0 p-2 mb-2 bg-panel-2 border border-border rounded font-mono text-[11px] text-ink-2 whitespace-pre-wrap max-h-[80px] overflow-auto">
            {openExplain.sql}
          </pre>
          {openExplain.busy && (
            <div className="text-[12px] text-muted">Running EXPLAIN…</div>
          )}
          {openExplain.error && <ErrorPre>{openExplain.error}</ErrorPre>}
          {openExplain.data && (
            <ExplainPanel
              connectionId={connectionId}
              sql={openExplain.sql}
              response={openExplain.data}
              defaultDatabase={openExplain.schema ?? undefined}
              onClose={() => setOpenExplain(null)}
              onInjectSql={onInjectSql}
            />
          )}
        </Card>
      )}
    </div>
  );
}

function ProcesslistTab({ connectionId }: { connectionId: number }) {
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [hideSleep, setHideSleep] = useState(true);
  const [killBusy, setKillBusy] = useState<number | null>(null);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const list = await invoke<ProcessRow[]>("list_processlist", { connectionId });
      setRows(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, connectionId]);

  async function killOne(id: number) {
    if (!confirm(`KILL process ${id}? This terminates the connection.`)) return;
    setKillBusy(id);
    setError("");
    try {
      await invoke("kill_process", { connectionId, processId: id });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setKillBusy(null);
    }
  }

  const visible = useMemo(
    () =>
      hideSleep ? rows.filter((r) => (r.command ?? "").toLowerCase() !== "sleep") : rows,
    [rows, hideSleep],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-[12px] flex-wrap">
        <PrimaryButton onClick={() => void refresh()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </PrimaryButton>
        <label className="flex items-center gap-1.5 text-ink-2">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="accent-acc"
          />
          Auto-refresh (2s)
        </label>
        <label className="flex items-center gap-1.5 text-ink-2">
          <input
            type="checkbox"
            checked={hideSleep}
            onChange={(e) => setHideSleep(e.target.checked)}
            className="accent-acc"
          />
          Hide Sleep
        </label>
        <span className="text-[12px] text-muted ml-auto">
          {visible.length} / {rows.length} threads
        </span>
      </div>

      {error && <ErrorPre>{error}</ErrorPre>}

      <div className="border border-border rounded-lg overflow-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr>
              {["ID", "User", "Host", "DB", "Command", "Time", "State", "Info"].map((h) => (
                <th
                  key={h}
                  className="sticky top-0 bg-bg-2 border-b border-border text-left px-3 h-8 text-[11px] font-semibold text-muted whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
              <th className="sticky top-0 bg-bg-2 border-b border-border h-8" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const cmd = (r.command ?? "").toLowerCase();
              const cmdTone: SevTone =
                cmd === "query"
                  ? "ok"
                  : cmd === "killed"
                    ? "crit"
                    : cmd === "sleep"
                      ? "neutral"
                      : "info";
              const longRunning = r.time >= 60 && cmd !== "sleep";
              return (
                <tr
                  key={r.id}
                  className="border-b border-border hover:bg-[rgba(0,109,104,0.04)]"
                >
                  <td className="px-3 h-8 font-mono text-ink-2 tabular-nums">{r.id}</td>
                  <td className="px-3 h-8 font-mono text-ink-2">{r.user ?? "-"}</td>
                  <td className="px-3 h-8 font-mono text-ink-2">{r.host ?? "-"}</td>
                  <td className="px-3 h-8 font-mono text-ink-2">{r.db ?? "-"}</td>
                  <td className="px-3 h-8">
                    <SevPill tone={cmdTone}>{r.command ?? "-"}</SevPill>
                  </td>
                  <td
                    className={`px-3 h-8 font-mono tabular-nums ${
                      longRunning ? "text-crit font-semibold" : "text-ink-2"
                    }`}
                  >
                    {r.time}s
                  </td>
                  <td className="px-3 h-8 font-mono text-ink-2">{r.state ?? "-"}</td>
                  <td
                    className="px-3 h-8 font-mono max-w-[400px] overflow-hidden text-ellipsis whitespace-nowrap text-ink-2"
                    title={r.info ?? ""}
                  >
                    {r.info ?? ""}
                  </td>
                  <td className="px-2 h-8">
                    <button
                      onClick={() => void killOne(r.id)}
                      disabled={killBusy === r.id}
                      className="h-5 px-2 text-[10px] text-crit bg-crit-soft rounded hover:bg-crit hover:text-white disabled:opacity-50"
                    >
                      {killBusy === r.id ? "…" : "Kill"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-6 text-[12px] text-muted text-center italic"
                >
                  No threads.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VariablesTab({ connectionId }: { connectionId: number }) {
  const [vars, setVars] = useState<VariableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  async function refresh(f: string) {
    setLoading(true);
    setError("");
    try {
      const list = await invoke<VariableEntry[]>("list_variables", {
        connectionId,
        filter: f || null,
      });
      setVars(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px]">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void refresh(filter);
            }
          }}
          placeholder="Filter variable name (Enter to search)…"
          className="flex-1 h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md outline-none focus:border-acc"
        />
        <PrimaryButton onClick={() => void refresh(filter)} disabled={loading}>
          {loading ? "Loading…" : "Search"}
        </PrimaryButton>
        <SecondaryButton
          onClick={() => {
            setFilter("");
            void refresh("");
          }}
          disabled={loading}
        >
          Clear
        </SecondaryButton>
        <span className="text-[12px] text-muted ml-2">{vars.length} vars</span>
      </div>

      {error && <ErrorPre>{error}</ErrorPre>}

      <div className="border border-border rounded-lg overflow-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-left px-3 h-8 text-[11px] font-semibold text-muted">
                Name
              </th>
              <th className="sticky top-0 bg-bg-2 border-b border-border text-left px-3 h-8 text-[11px] font-semibold text-muted">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => (
              <tr key={v.name} className="border-b border-border">
                <td className="px-3 h-8 font-mono text-ink-2 font-medium">{v.name}</td>
                <td className="px-3 py-1.5 font-mono text-ink-2 break-all whitespace-pre-wrap max-w-[600px]">
                  {v.value || <em className="text-subtle">(empty)</em>}
                </td>
              </tr>
            ))}
            {vars.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={2}
                  className="px-4 py-6 text-[12px] text-muted text-center italic"
                >
                  No variables match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
