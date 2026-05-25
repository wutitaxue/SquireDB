import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type {
  FragmentedTable,
  HealthReport,
  HealthReportResponse,
  HealthTableRef,
  RedundantIndex,
  TableSize,
  UnusedIndex,
} from "../types";
import {
  HEALTH_EXPORT_META,
  healthFilename,
  toConnectionHealthHtml,
  toConnectionHealthMarkdown,
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

const HEALTH_EXPORT_FORMATS: HealthExportFormat[] = ["html", "markdown"];

type Props = {
  connectionId: number;
  onClose: () => void;
};

export function HealthCheckWorkspace({ connectionId, onClose }: Props) {
  const [response, setResponse] = useState<HealthReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState<HealthExportFormat | null>(null);
  const [exportNotice, setExportNotice] = useState("");
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Close the export menu on outside click / Escape — same idiom as
  // ResultsPane so behavior is consistent across workspaces.
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
      const r = await invoke<HealthReportResponse>("run_health_check", {
        connectionId,
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
    void navigator.clipboard.writeText(toConnectionHealthMarkdown(response));
    setExportNotice("Markdown copied to clipboard.");
  }

  async function runExport(fmt: HealthExportFormat) {
    if (!response) return;
    setExportOpen(false);
    setExportNotice("");
    const meta = HEALTH_EXPORT_META[fmt];
    const hint = response.report.databases_scanned[0] ?? null;
    const path = await saveDialog({
      defaultPath: healthFilename(fmt, hint),
      filters: [{ name: meta.label, extensions: [meta.ext] }],
    }).catch(() => null);
    if (!path) return;
    setExportBusy(fmt);
    try {
      const text =
        fmt === "html"
          ? toConnectionHealthHtml(response)
          : toConnectionHealthMarkdown(response);
      await writeTextFile(path, text);
      setExportNotice(`Exported as ${meta.label}.`);
    } catch (e) {
      setExportNotice(`Export failed: ${e}`);
    } finally {
      setExportBusy(null);
    }
  }

  const subtitle = response
    ? `${response.report.databases_scanned.length} dbs scanned · ${response.report.elapsed_ms}ms`
    : "One-click full database scan";

  return (
    <AgentPanel
      icon="📋"
      title="Health Check"
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
        {!response && (
          <Card>
            <div className="flex items-center gap-3">
              <PrimaryButton onClick={() => void run()} disabled={loading}>
                {loading ? "Scanning…" : "Run health check"}
              </PrimaryButton>
              <span className="text-[12px] text-muted">
                Scans indexes · tables · slow queries · security across user databases. Takes seconds to minutes.
              </span>
            </div>
          </Card>
        )}

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

        {response && (
          <>
            {response.ai_overview ? (
              <AiOverviewCard overview={response.ai_overview} />
            ) : (
              response.ai_error && (
                <Card className="bg-warn-soft border-warn/20">
                  <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
                    AI unavailable
                  </div>
                  <div className="text-[12px] text-ink-2">{response.ai_error}</div>
                </Card>
              )
            )}

            <SecondaryButton onClick={() => void run()} disabled={loading}>
              {loading ? "Rescanning…" : "Run again"}
            </SecondaryButton>

            <Section title="Indexes" subtitle={`${response.report.indexes.total_indexes} total`}>
              <Subgroup
                title="Redundant index pairs"
                count={response.report.indexes.redundant.length}
                tone={response.report.indexes.redundant.length > 0 ? "warn" : "ok"}
              >
                {response.report.indexes.redundant.length === 0 ? (
                  <Empty>None</Empty>
                ) : (
                  <RedundantTable rows={response.report.indexes.redundant} />
                )}
              </Subgroup>

              <Subgroup
                title="Unused indexes"
                count={response.report.indexes.unused.length}
                tone={response.report.indexes.unused.length > 0 ? "warn" : "ok"}
                note={response.report.indexes.unused_unavailable_reason ?? undefined}
              >
                {response.report.indexes.unused.length === 0 ? (
                  <Empty>None</Empty>
                ) : (
                  <UnusedTable rows={response.report.indexes.unused} />
                )}
              </Subgroup>
            </Section>

            <Section title="Tables">
              <Subgroup
                title="Tables without primary key"
                count={response.report.tables.no_primary_key.length}
                tone={response.report.tables.no_primary_key.length > 0 ? "warn" : "ok"}
              >
                {response.report.tables.no_primary_key.length === 0 ? (
                  <Empty>None</Empty>
                ) : (
                  <NoPkTable rows={response.report.tables.no_primary_key} />
                )}
              </Subgroup>

              <Subgroup
                title="Fragmented (≥10MB, >20% free)"
                count={response.report.tables.fragmented.length}
                tone={response.report.tables.fragmented.length > 0 ? "warn" : "ok"}
              >
                {response.report.tables.fragmented.length === 0 ? (
                  <Empty>None</Empty>
                ) : (
                  <FragmentedTableView rows={response.report.tables.fragmented} />
                )}
              </Subgroup>

              <Subgroup title="Top 10 largest" count={response.report.tables.largest.length}>
                {response.report.tables.largest.length === 0 ? (
                  <Empty>No tables</Empty>
                ) : (
                  <LargestTable rows={response.report.tables.largest} />
                )}
              </Subgroup>
            </Section>

            <Section title="Slow Queries (Top 10)">
              {response.report.slow_queries.length === 0 ? (
                <Empty>No slow queries recorded.</Empty>
              ) : (
                <SlowQueryTable rows={response.report.slow_queries} />
              )}
            </Section>

            <Section title="Security">
              <SecurityBlock report={response.report} />
            </Section>
          </>
        )}
      </div>
    </AgentPanel>
  );
}

function AiOverviewCard({
  overview,
}: {
  overview: { score: number; summary: string; priorities: string[] };
}) {
  const tone: SevTone =
    overview.score >= 85 ? "ok" : overview.score >= 65 ? "warn" : "crit";
  const ringClass: Record<SevTone, string> = {
    ok: "bg-ok text-white",
    warn: "bg-warn text-white",
    crit: "bg-crit text-white",
    info: "bg-info text-white",
    pii: "bg-pii text-white",
    neutral: "bg-bg-2 text-ink",
  };
  return (
    <Card>
      <div className="flex gap-4 items-start">
        <div
          className={`w-[92px] h-[92px] rounded-full flex flex-col items-center justify-center shrink-0 ${ringClass[tone]}`}
          title="AI overall score"
        >
          <div className="text-[32px] font-bold leading-none tabular-nums">
            {overview.score}
          </div>
          <div className="text-[10px] uppercase tracking-wider font-bold opacity-80 mt-0.5">
            score
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <SectionTitle>AI summary</SectionTitle>
          <div className="text-[13px] text-ink-2 leading-relaxed">{overview.summary}</div>
          {overview.priorities.length > 0 && (
            <div className="mt-3">
              <SectionTitle>Priorities</SectionTitle>
              <ul className="list-disc pl-5 text-[12px] text-ink-2 space-y-1">
                {overview.priorities.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-baseline gap-2 mb-3">
        <div className="text-[13px] font-bold text-ink">{title}</div>
        {subtitle && <div className="text-[11px] text-muted">{subtitle}</div>}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </Card>
  );
}

function Subgroup({
  title,
  count,
  tone,
  note,
  children,
}: {
  title: string;
  count: number;
  tone?: SevTone;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[12.5px] font-medium text-ink-2">{title}</span>
        <SevPill tone={tone ?? "neutral"}>{count}</SevPill>
      </div>
      {note && (
        <div className="text-[11px] text-crit mb-1.5">⚠ {note}</div>
      )}
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12px] text-subtle italic py-1">{children}</div>
  );
}

function MonoTable({ children }: { children: React.ReactNode }) {
  return <table className="w-full text-[12px] border-collapse">{children}</table>;
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`bg-bg-2 ${right ? "text-right" : "text-left"} px-2 h-7 font-semibold text-muted text-[11px] border-b border-border whitespace-nowrap`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  tone,
}: {
  children: React.ReactNode;
  right?: boolean;
  tone?: "warn" | "default";
}) {
  return (
    <td
      className={`px-2 h-7 ${right ? "text-right tabular-nums" : "text-left"} font-mono ${
        tone === "warn" ? "text-warn font-semibold" : "text-ink-2"
      }`}
    >
      {children}
    </td>
  );
}

function RedundantTable({ rows }: { rows: RedundantIndex[] }) {
  return (
    <MonoTable>
      <thead>
        <tr>
          <Th>Table</Th>
          <Th>Index A</Th>
          <Th>Index B (covers A)</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border">
            <Td>{r.database}.{r.table}</Td>
            <Td>
              <code>{r.index_a}</code> <span className="text-subtle">({r.index_a_cols})</span>
            </Td>
            <Td>
              <code>{r.index_b}</code> <span className="text-subtle">({r.index_b_cols})</span>
            </Td>
          </tr>
        ))}
      </tbody>
    </MonoTable>
  );
}

function UnusedTable({ rows }: { rows: UnusedIndex[] }) {
  return (
    <MonoTable>
      <thead>
        <tr>
          <Th>Database</Th>
          <Th>Table</Th>
          <Th>Index</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border">
            <Td>{r.database}</Td>
            <Td>{r.table}</Td>
            <Td>
              <code>{r.index}</code>
            </Td>
          </tr>
        ))}
      </tbody>
    </MonoTable>
  );
}

function NoPkTable({ rows }: { rows: HealthTableRef[] }) {
  return (
    <MonoTable>
      <thead>
        <tr>
          <Th>Database</Th>
          <Th>Table</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border">
            <Td>{r.database}</Td>
            <Td>{r.table}</Td>
          </tr>
        ))}
      </tbody>
    </MonoTable>
  );
}

function FragmentedTableView({ rows }: { rows: FragmentedTable[] }) {
  return (
    <MonoTable>
      <thead>
        <tr>
          <Th>Table</Th>
          <Th right>Data size</Th>
          <Th right>Free</Th>
          <Th right>Frag %</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border">
            <Td>{r.database}.{r.table}</Td>
            <Td right>{r.data_length_mb.toFixed(1)} MB</Td>
            <Td right>{r.data_free_mb.toFixed(1)} MB</Td>
            <Td right tone="warn">
              {(r.fragmentation_ratio * 100).toFixed(0)}%
            </Td>
          </tr>
        ))}
      </tbody>
    </MonoTable>
  );
}

function LargestTable({ rows }: { rows: TableSize[] }) {
  return (
    <MonoTable>
      <thead>
        <tr>
          <Th>Table</Th>
          <Th right>Rows</Th>
          <Th right>Data</Th>
          <Th right>Index</Th>
          <Th right>Total</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border">
            <Td>{r.database}.{r.table}</Td>
            <Td right>{r.rows.toLocaleString()}</Td>
            <Td right>{r.data_mb.toFixed(1)} MB</Td>
            <Td right>{r.index_mb.toFixed(1)} MB</Td>
            <td className="px-2 h-7 text-right tabular-nums font-mono text-ink font-semibold">
              {r.total_mb.toFixed(1)} MB
            </td>
          </tr>
        ))}
      </tbody>
    </MonoTable>
  );
}

function SlowQueryTable({ rows }: { rows: HealthReport["slow_queries"] }) {
  return (
    <MonoTable>
      <thead>
        <tr>
          <Th>SQL</Th>
          <Th right>Calls</Th>
          <Th right>Avg ms</Th>
          <Th>Schema</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((q) => (
          <tr key={q.digest || q.digest_text} className="border-b border-border">
            <td
              className="px-2 h-7 font-mono max-w-[500px] overflow-hidden text-ellipsis whitespace-nowrap text-ink-2"
              title={q.digest_text}
            >
              {q.digest_text}
            </td>
            <Td right>{q.count_star}</Td>
            <Td right>{q.avg_ms.toFixed(2)}</Td>
            <Td>{q.schema_name ?? "-"}</Td>
          </tr>
        ))}
      </tbody>
    </MonoTable>
  );
}

function SecurityBlock({ report }: { report: HealthReport }) {
  const sec = report.security;
  return (
    <div className="flex flex-col gap-2 text-[12px] text-ink-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-ink">SSL available:</span>
        <SevPill tone={sec.ssl_enabled ? "ok" : "crit"}>
          {sec.ssl_enabled ? "yes" : "no"}
        </SevPill>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-ink">require_secure_transport:</span>
        <SevPill tone={sec.require_secure_transport ? "ok" : "neutral"}>
          {sec.require_secure_transport ? "on" : "off"}
        </SevPill>
        {!sec.require_secure_transport && (
          <span className="text-muted">clients can connect without SSL</span>
        )}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-ink">Remote root accounts:</span>
          <SevPill tone={sec.remote_root.length > 0 ? "crit" : "ok"}>
            {sec.remote_root.length}
          </SevPill>
        </div>
        {sec.remote_root.length > 0 && (
          <ul className="list-disc pl-6 mt-1.5 space-y-0.5">
            {sec.remote_root.map((u, i) => (
              <li key={i} className="font-mono">
                '{u.user}'@'{u.host}'
              </li>
            ))}
          </ul>
        )}
        {sec.mysql_user_unavailable_reason && (
          <div className="text-[11px] text-crit mt-1.5">
            ⚠ mysql.user check failed: {sec.mysql_user_unavailable_reason}
          </div>
        )}
      </div>
    </div>
  );
}

