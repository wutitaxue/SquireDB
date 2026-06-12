import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type {
  ConnSecurity,
  FragmentedTable,
  HealthOverview,
  HealthTableRef,
  ProjectHealthReport,
  ProjectHealthResponse,
  RedundantIndex,
  TableSize,
  UnusedIndex,
} from "../types";
import {
  HEALTH_EXPORT_META,
  healthFilename,
  toProjectHealthHtml,
  toProjectHealthMarkdown,
  type HealthExportFormat,
} from "../exportHealth";
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
import { copyText } from "../utils";

const HEALTH_EXPORT_FORMATS: HealthExportFormat[] = ["html", "markdown"];

type Props = {
  projectId: number;
  projectName: string;
  onClose: () => void;
};

export function ProjectHealthWorkspace({ projectId, projectName, onClose }: Props) {
  const [response, setResponse] = useState<ProjectHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState<HealthExportFormat | null>(null);
  const [exportNotice, setExportNotice] = useState("");
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    function onDocPointer(e: PointerEvent) {
      if (!exportMenuRef.current) return;
      if (!exportMenuRef.current.contains(e.target as Node)) setExportOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExportOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [exportOpen]);

  async function run() {
    setLoading(true);
    setError("");
    setResponse(null);
    setExportNotice("");
    try {
      const r = await invoke<ProjectHealthResponse>("run_project_health_check", {
        projectId,
        includeAi: true,
      });
      setResponse(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function copyMarkdown() {
    if (!response) return;
    void copyText(toProjectHealthMarkdown(response));
    setExportNotice("Markdown copied to clipboard.");
  }

  async function runExport(fmt: HealthExportFormat) {
    if (!response) return;
    setExportOpen(false);
    setExportNotice("");
    const meta = HEALTH_EXPORT_META[fmt];
    const path = await saveDialog({
      defaultPath: healthFilename(fmt, response.report.project_name),
      filters: [{ name: meta.label, extensions: [meta.ext] }],
    }).catch(() => null);
    if (!path) return;
    setExportBusy(fmt);
    try {
      const text =
        fmt === "html"
          ? toProjectHealthHtml(response)
          : toProjectHealthMarkdown(response);
      await writeTextFile(path, text);
      setExportNotice(`Exported as ${meta.label}.`);
    } catch (e) {
      setExportNotice(`Export failed: ${e}`);
    } finally {
      setExportBusy(null);
    }
  }

  const subtitle = response
    ? `${response.report.project_tables_count} curated tables · ${response.report.elapsed_ms}ms`
    : `Health scan scoped to ${projectName}`;

  return (
    <AgentPanel
      icon="🏥"
      title="Project Health"
      subtitle={subtitle}
      actions={
        <>
          {response && (
            <>
              <SecondaryButton onClick={copyMarkdown}>Copy as Markdown</SecondaryButton>
              <div className="relative inline-block" ref={exportMenuRef}>
                <SecondaryButton
                  onClick={() => setExportOpen((v) => !v)}
                  disabled={exportBusy != null}
                >
                  {exportBusy ? "Exporting…" : "Export ▾"}
                </SecondaryButton>
                {exportOpen && (
                  <div className="absolute right-0 top-9 z-20 min-w-[260px] bg-panel border border-border rounded-md shadow-lg py-1">
                    {HEALTH_EXPORT_FORMATS.map((fmt) => {
                      const meta = HEALTH_EXPORT_META[fmt];
                      return (
                        <button
                          key={fmt}
                          onClick={() => void runExport(fmt)}
                          className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-2 flex items-center justify-between gap-3"
                        >
                          <span>{meta.label}</span>
                          <span className="text-muted text-[10px] font-mono">.{meta.ext}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-3 flex-wrap">
            <PrimaryButton onClick={() => void run()} disabled={loading}>
              {loading ? "Scanning…" : "Run project health"}
            </PrimaryButton>
            <span className="text-[11px] text-muted">
              Indexes · tables · security — limited to the curated project tables (cross-connection).
            </span>
          </div>
        </Card>

        {error && <ErrorPre>{error}</ErrorPre>}
        {exportNotice && (
          <div
            className={`text-[11.5px] px-3 py-1.5 rounded border ${
              exportNotice.startsWith("Export failed")
                ? "bg-crit-soft border-crit/20 text-crit"
                : "bg-acc-soft/40 border-acc/20 text-acc-ink"
            }`}
          >
            {exportNotice}
          </div>
        )}

        {response?.ai_error && !response.ai_overview && (
          <Card className="bg-warn-soft border-warn/20">
            <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
              AI warning
            </div>
            <div className="text-[12px] text-ink-2">{response.ai_error}</div>
          </Card>
        )}

        {response && response.report.missing_connection_names.length > 0 && (
          <Card className="bg-warn-soft border-warn/20">
            <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
              Partial scan
            </div>
            <div className="text-[12px] text-ink-2">
              {response.report.missing_connection_names.length} required connection(s) are
              closed: <code>{response.report.missing_connection_names.join(", ")}</code>. Open
              them in the sidebar and re-run for a complete report.
            </div>
          </Card>
        )}

        {response?.ai_overview && <OverviewCard overview={response.ai_overview} />}

        {response && <ScopeMeta report={response.report} />}

        {response && <IndexesCard report={response.report} />}
        {response && <TablesCard report={response.report} />}
        {response && <SecurityCard items={response.report.security_by_connection} />}
      </div>
    </AgentPanel>
  );
}

function scoreTone(score: number): SevTone {
  if (score >= 80) return "ok";
  if (score >= 60) return "warn";
  return "crit";
}

function OverviewCard({ overview }: { overview: HealthOverview }) {
  return (
    <Card>
      <div className="flex items-baseline gap-3 mb-2">
        <SectionTitle>AI overview</SectionTitle>
        <SevPill tone={scoreTone(overview.score)}>Score {overview.score}</SevPill>
      </div>
      <div className="text-[13px] text-ink-2 leading-relaxed whitespace-pre-wrap">
        {overview.summary}
      </div>
      {overview.priorities.length > 0 && (
        <ul className="list-disc pl-5 text-[12.5px] text-ink-2 leading-relaxed mt-2 space-y-1">
          {overview.priorities.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ScopeMeta({ report }: { report: ProjectHealthReport }) {
  return (
    <Card>
      <div className="flex gap-4 flex-wrap text-[12px] text-ink-2 items-center">
        <span>
          <strong className="text-ink">{report.project_name}</strong>
        </span>
        <span className="text-muted">
          {report.project_tables_count} tables · {report.scanned_databases.length} dbs ·{" "}
          {report.security_by_connection.length} conns scanned
        </span>
        <span className="text-muted">{report.indexes.total_indexes} indexes in scope</span>
        <span className="text-muted tabular-nums ml-auto">{report.elapsed_ms}ms</span>
      </div>
    </Card>
  );
}

function ConnBadge({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span
      className="shrink-0 h-[14px] px-1 rounded text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 bg-bg text-muted"
      title={`Connection: ${name}`}
    >
      <span className="w-1 h-1 rounded-full bg-ok" />
      {name}
    </span>
  );
}

function IndexesCard({ report }: { report: ProjectHealthReport }) {
  const { redundant, unused, total_indexes, unused_unavailable_reason } = report.indexes;
  return (
    <Card>
      <SectionTitle>Indexes</SectionTitle>
      <div className="text-[12px] text-muted mb-2 tabular-nums">
        {total_indexes} in scope · {redundant.length} redundant · {unused.length} unused
      </div>
      {redundant.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1.5">
            Redundant index pairs
          </div>
          <div className="flex flex-col gap-1">
            {redundant.map((r: RedundantIndex, i) => (
              <div key={i} className="px-2 py-1.5 bg-panel-2 rounded text-[12px]">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-ink-2">
                    {r.database}.{r.table}
                  </code>
                  <ConnBadge name={r.connection_name} />
                </div>
                <div className="text-[11px] font-mono text-ink-2 mt-0.5">
                  <code className="text-warn">{r.index_a}</code>
                  <span className="text-muted"> ({r.index_a_cols}) </span>
                  <span className="text-subtle">⊂</span>{" "}
                  <code>{r.index_b}</code>
                  <span className="text-muted"> ({r.index_b_cols})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {unused.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1.5">
            Unused indexes
          </div>
          <div className="flex flex-wrap gap-1">
            {unused.map((u: UnusedIndex, i) => (
              <div
                key={i}
                className="px-2 py-1 bg-panel-2 rounded text-[11.5px] font-mono flex items-center gap-1.5"
              >
                <span>
                  {u.database}.{u.table}.<span className="text-warn">{u.index}</span>
                </span>
                <ConnBadge name={u.connection_name} />
              </div>
            ))}
          </div>
        </div>
      )}
      {unused_unavailable_reason && (
        <div className="text-[11px] text-subtle italic mt-2">
          Unused index check unavailable: {unused_unavailable_reason}
        </div>
      )}
      {redundant.length === 0 && unused.length === 0 && (
        <div className="text-[12px] text-muted italic">No issues in scope.</div>
      )}
    </Card>
  );
}

function TablesCard({ report }: { report: ProjectHealthReport }) {
  const { no_primary_key, fragmented, largest } = report.tables;
  return (
    <Card>
      <SectionTitle>Tables</SectionTitle>
      {no_primary_key.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1.5">
            Without primary key ({no_primary_key.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {no_primary_key.map((t: HealthTableRef, i) => (
              <div
                key={i}
                className="px-2 py-1 bg-panel-2 rounded text-[11.5px] font-mono flex items-center gap-1.5"
              >
                <span>
                  {t.database}.{t.table}
                </span>
                <ConnBadge name={t.connection_name} />
              </div>
            ))}
          </div>
        </div>
      )}
      {fragmented.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1.5">
            Fragmented (≥10MB, &gt;20% free)
          </div>
          <div className="flex flex-col gap-1">
            {fragmented.map((f: FragmentedTable, i) => (
              <div key={i} className="px-2 py-1.5 bg-panel-2 rounded text-[12px]">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-ink-2">
                    {f.database}.{f.table}
                  </code>
                  <ConnBadge name={f.connection_name} />
                  <span className="ml-auto text-[10.5px] text-warn tabular-nums">
                    {(f.fragmentation_ratio * 100).toFixed(0)}% free
                  </span>
                </div>
                <div className="text-[10.5px] text-muted tabular-nums">
                  {f.data_free_mb.toFixed(1)} MB free / {f.data_length_mb.toFixed(1)} MB data
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {largest.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1.5">
            Top {Math.min(largest.length, 10)} largest
          </div>
          <div className="flex flex-col gap-1">
            {largest.slice(0, 10).map((t: TableSize, i) => (
              <div
                key={i}
                className="px-2 py-1 bg-panel-2 rounded text-[12px] flex items-center gap-2"
              >
                <code className="font-mono text-ink-2">
                  {t.database}.{t.table}
                </code>
                <ConnBadge name={t.connection_name} />
                <span className="ml-auto text-[10.5px] text-muted tabular-nums">
                  {t.total_mb.toFixed(1)} MB · {t.rows.toLocaleString()} rows
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {no_primary_key.length === 0 && fragmented.length === 0 && largest.length === 0 && (
        <div className="text-[12px] text-muted italic">No tables in scope.</div>
      )}
    </Card>
  );
}

function SecurityCard({ items }: { items: ConnSecurity[] }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <SectionTitle>Security (per connection)</SectionTitle>
      <div className="flex flex-col gap-2">
        {items.map((s) => (
          <div key={s.connection_id} className="p-2 bg-panel-2 rounded">
            <div className="flex items-center gap-2 mb-1">
              <code className="text-[12px] font-mono font-semibold text-ink">
                {s.connection_name}
              </code>
              <SevPill tone={s.check.ssl_enabled ? "ok" : "warn"}>
                SSL {s.check.ssl_enabled ? "on" : "off"}
              </SevPill>
              <SevPill tone={s.check.require_secure_transport ? "ok" : "neutral"}>
                require_secure_transport{" "}
                {s.check.require_secure_transport ? "on" : "off"}
              </SevPill>
            </div>
            {s.check.remote_root.length > 0 && (
              <div className="text-[11.5px] text-crit mt-1">
                ⚠ {s.check.remote_root.length} remote root account(s):{" "}
                {s.check.remote_root
                  .map((u) => `'${u.user}'@'${u.host}'`)
                  .join(", ")}
              </div>
            )}
            {s.check.mysql_user_unavailable_reason && (
              <div className="text-[11px] text-subtle italic mt-0.5">
                mysql.user check failed: {s.check.mysql_user_unavailable_reason}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
