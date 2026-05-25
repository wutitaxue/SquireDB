import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnPerfStatus,
  ConnScanError,
  ProjectSlowQuery,
  ProjectSlowQueryReport,
  ProjectSlowQueryResponse,
} from "../types";
import {
  AgentPanel,
  Card,
  ErrorPre,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SevPill,
  type SevTone,
} from "../shell/AgentPanel";

type Props = {
  projectId: number;
  projectName: string;
  onClose: () => void;
};

export function ProjectSlowQueriesWorkspace({
  projectId,
  projectName,
  onClose,
}: Props) {
  const [response, setResponse] = useState<ProjectSlowQueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [minAvgMs, setMinAvgMs] = useState(0);

  async function run() {
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      const r = await invoke<ProjectSlowQueryResponse>(
        "run_project_slow_queries",
        {
          projectId,
          perConnLimit: 200,
          minAvgMs,
          includeAi: true,
        },
      );
      setResponse(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const subtitle = response
    ? `${response.report.total_matched}/${response.report.total_scanned} matched · ${response.report.scanned_connection_ids.length} conn scanned`
    : `Slow queries hitting curated tables of ${projectName}`;

  return (
    <AgentPanel
      icon="🐢"
      title="Project Slow Queries"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
                Min avg ms
              </span>
              <input
                type="number"
                min={0}
                step={10}
                value={minAvgMs}
                onChange={(e) => setMinAvgMs(Math.max(0, Number(e.target.value) || 0))}
                disabled={loading}
                className="h-7 w-20 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50"
              />
            </span>
            <PrimaryButton onClick={() => void run()} disabled={loading}>
              {loading ? "Scanning…" : response ? "Rescan" : "Scan slow queries"}
            </PrimaryButton>
            <span className="text-[11px] text-muted ml-auto">
              perf_schema.events_statements_summary_by_digest · per-conn LIMIT 200.
            </span>
          </div>
        </Card>

        {error && <ErrorPre>{error}</ErrorPre>}

        {response?.ai_error && (
          <Card className="bg-warn-soft border-warn/20">
            <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
              AI warning
            </div>
            <div className="text-[12px] text-ink-2">{response.ai_error}</div>
          </Card>
        )}

        {response && (
          <>
            {response.ai_overview && <AiOverviewCard ov={response.ai_overview} />}

            <PerfStatusCard
              perf={response.report.perf_by_connection}
              missing={response.report.missing_connection_names}
              errors={response.report.scan_errors}
            />

            <SlowQueriesCard report={response.report} />

            <div className="text-[11px] text-muted text-right tabular-nums">
              scan {response.report.elapsed_ms}ms
            </div>
          </>
        )}
      </div>
    </AgentPanel>
  );
}

function AiOverviewCard({
  ov,
}: {
  ov: ProjectSlowQueryResponse["ai_overview"];
}) {
  if (!ov) return null;
  return (
    <Card>
      <SectionTitle>AI overview</SectionTitle>
      <div className="text-[13px] text-ink-2 leading-relaxed mb-2">
        {ov.summary}
      </div>
      {ov.hotspot_tables.length > 0 && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
            Hotspot tables
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ov.hotspot_tables.map((t) => (
              <SevPill key={t} tone="warn">
                {t}
              </SevPill>
            ))}
          </div>
        </div>
      )}
      {ov.priorities.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
            Priorities
          </div>
          <ol className="list-decimal pl-5 text-[12px] text-ink-2 leading-relaxed space-y-1">
            {ov.priorities.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

function PerfStatusCard({
  perf,
  missing,
  errors,
}: {
  perf: ConnPerfStatus[];
  missing: string[];
  errors: ConnScanError[];
}) {
  if (perf.length === 0 && missing.length === 0 && errors.length === 0) {
    return null;
  }
  return (
    <Card>
      <SectionTitle>Connections</SectionTitle>
      <div className="flex flex-col gap-1.5">
        {perf.map((p) => (
          <div
            key={p.connection_id}
            className="flex items-center gap-2 text-[12px] bg-panel-2 rounded px-2.5 py-1.5"
          >
            <span className="font-semibold text-ink">{p.connection_name}</span>
            {p.status ? (
              <>
                <SevPill tone="info">{p.status.mysql_version}</SevPill>
                <SevPill tone={p.status.performance_schema ? "ok" : "warn"}>
                  perf_schema {p.status.performance_schema ? "on" : "off"}
                </SevPill>
                <SevPill tone={p.status.digest_table_available ? "ok" : "crit"}>
                  digest {p.status.digest_table_available ? "✓" : "✗"}
                </SevPill>
                <SevPill tone={p.status.slow_query_log ? "ok" : "neutral"}>
                  slow_log {p.status.slow_query_log ? "on" : "off"}
                </SevPill>
                <span className="text-[10.5px] text-muted ml-auto tabular-nums">
                  long_query_time {p.status.long_query_time}s
                </span>
              </>
            ) : (
              <span className="text-[11px] text-crit">{p.error}</span>
            )}
          </div>
        ))}
        {errors.map((e, i) => (
          <div
            key={`e${i}`}
            className="flex items-center gap-2 text-[12px] bg-crit-soft rounded px-2.5 py-1.5"
          >
            <SevPill tone="crit">scan error</SevPill>
            <span className="font-semibold text-ink">{e.connection_name}</span>
            <span className="text-[11px] text-crit">{e.error}</span>
          </div>
        ))}
        {missing.length > 0 && (
          <div className="flex items-center gap-2 text-[12px] bg-warn-soft rounded px-2.5 py-1.5">
            <SevPill tone="warn">closed</SevPill>
            <span className="text-ink-2">
              skipped {missing.length} closed connection(s):{" "}
              <span className="font-mono">{missing.join(", ")}</span>
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

function SlowQueriesCard({ report }: { report: ProjectSlowQueryReport }) {
  const grouped = useMemo(() => {
    const map = new Map<number, { name: string; rows: ProjectSlowQuery[] }>();
    for (const q of report.queries) {
      if (!map.has(q.connection_id)) {
        map.set(q.connection_id, { name: q.connection_name, rows: [] });
      }
      map.get(q.connection_id)!.rows.push(q);
    }
    return Array.from(map.entries());
  }, [report.queries]);

  return (
    <Card>
      <SectionTitle>
        Matched slow queries ({report.total_matched})
      </SectionTitle>
      {report.queries.length === 0 ? (
        <div className="text-[12px] text-subtle italic">
          {report.total_scanned === 0
            ? "No slow queries found in perf_schema."
            : `Scanned ${report.total_scanned} rows but none referenced project tables.`}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map(([connId, g]) => (
            <div key={connId} className="flex flex-col gap-1.5">
              <div className="text-[11px] uppercase tracking-wider font-bold text-muted">
                {g.name}  ·  {g.rows.length} queries
              </div>
              {g.rows.map((q) => (
                <SlowQueryRow key={`${connId}-${q.digest}`} q={q} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SlowQueryRow({ q }: { q: ProjectSlowQuery }) {
  const [open, setOpen] = useState(false);
  const tone: SevTone =
    q.no_index_used > 0 ? "crit" : q.avg_ms >= 100 ? "warn" : "neutral";
  return (
    <div className="rounded-md border border-border bg-panel-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-panel"
      >
        <span className="text-[11px] text-subtle mt-0.5">{open ? "▾" : "▸"}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {q.matched_tables.map((t) => (
              <SevPill key={t} tone="info">
                {t}
              </SevPill>
            ))}
            {q.no_index_used > 0 && <SevPill tone="crit">NO INDEX</SevPill>}
            {q.no_good_index_used > 0 && q.no_index_used === 0 && (
              <SevPill tone="warn">no good index</SevPill>
            )}
            {q.schema_name && (
              <span className="text-[10.5px] text-muted font-mono">
                schema: {q.schema_name}
              </span>
            )}
          </div>
          <div className="font-mono text-[11.5px] text-ink-2 truncate">
            {q.digest_text}
          </div>
        </div>
        <div className="text-[11px] tabular-nums text-right shrink-0 ml-2">
          <SevPill tone={tone}>{q.avg_ms.toFixed(1)}ms avg</SevPill>
          <div className="text-muted mt-0.5">
            {q.count_star}× · {(q.total_ms / 1000).toFixed(1)}s total
          </div>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-border">
          <pre className="font-mono text-[11px] text-ink-2 whitespace-pre-wrap break-all leading-relaxed mt-2">
            {q.digest_text}
          </pre>
          <div className="grid grid-cols-3 gap-2 mt-2 text-[11px]">
            <Stat label="count" value={q.count_star.toLocaleString()} />
            <Stat label="avg" value={`${q.avg_ms.toFixed(2)} ms`} />
            <Stat label="max" value={`${q.max_ms.toFixed(2)} ms`} />
            <Stat label="total" value={`${(q.total_ms / 1000).toFixed(2)} s`} />
            <Stat label="rows examined" value={q.avg_rows_examined.toFixed(0)} />
            <Stat label="rows sent" value={q.avg_rows_sent.toFixed(0)} />
          </div>
          {(q.first_seen || q.last_seen) && (
            <div className="text-[10.5px] text-subtle mt-2 font-mono">
              {q.first_seen && `first: ${q.first_seen}`}
              {q.first_seen && q.last_seen && "  ·  "}
              {q.last_seen && `last: ${q.last_seen}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel rounded px-2 py-1 flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="font-mono text-ink tabular-nums">{value}</span>
    </div>
  );
}
