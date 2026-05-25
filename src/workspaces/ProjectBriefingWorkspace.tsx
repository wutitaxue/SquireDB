import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BriefingTableRef,
  ProjectBriefingResponse,
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

export function ProjectBriefingWorkspace({
  projectId,
  projectName,
  onClose,
}: Props) {
  const [response, setResponse] = useState<ProjectBriefingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      const r = await invoke<ProjectBriefingResponse>("run_project_briefing", {
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

  return (
    <AgentPanel
      icon="📋"
      title="Project Briefing"
      subtitle={
        response
          ? `${response.snapshot.total_tables} tables · ${response.snapshot.total_relations} relations`
          : `Handbook for ${projectName}`
      }
      actions={
        <SecondaryButton onClick={onClose} title="Close tab">
          Close
        </SecondaryButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-3 flex-wrap">
            <PrimaryButton onClick={() => void run()} disabled={loading}>
              {loading ? "Briefing…" : "Run briefing"}
            </PrimaryButton>
            <span className="text-[11px] text-muted">
              Reads curated tables + relations, then AI writes a project handbook.
            </span>
          </div>
        </Card>

        {error && <ErrorPre>{error}</ErrorPre>}

        {response?.ai_error && !response.report && (
          <Card className="bg-warn-soft border-warn/20">
            <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
              AI warning
            </div>
            <div className="text-[12px] text-ink-2">{response.ai_error}</div>
          </Card>
        )}

        {response && <SnapshotMeta response={response} />}

        {response && response.snapshot.missing_connection_ids.length > 0 && (
          <Card className="bg-warn-soft border-warn/20">
            <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
              Partial data
            </div>
            <div className="text-[12px] text-ink-2">
              {response.snapshot.missing_connection_ids.length} required connection(s) are
              closed. Open them from the sidebar and re-run for a complete briefing.
            </div>
          </Card>
        )}

        {response?.report && <ReportView report={response.report} />}

        {response && <TablesView tables={response.snapshot.tables} />}
      </div>
    </AgentPanel>
  );
}

function SnapshotMeta({ response }: { response: ProjectBriefingResponse }) {
  const s = response.snapshot;
  return (
    <Card>
      <div className="flex gap-4 flex-wrap text-[12px] text-ink-2 items-center">
        <span>
          <strong className="text-ink">{s.project_name}</strong>
          {s.project_description && (
            <span className="text-muted ml-1">· {s.project_description}</span>
          )}
        </span>
        <span className="text-muted">
          {s.total_tables} tables · {s.total_relations} relations
        </span>
        <span className="text-muted tabular-nums">{s.elapsed_ms}ms</span>
      </div>
    </Card>
  );
}

function importanceTone(level: string): SevTone {
  switch (level) {
    case "high":
      return "crit";
    case "medium":
      return "warn";
    case "low":
      return "neutral";
    default:
      return "neutral";
  }
}

function ReportView({
  report,
}: {
  report: NonNullable<ProjectBriefingResponse["report"]>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle>Overview</SectionTitle>
        <div className="text-[13px] text-ink-2 leading-relaxed whitespace-pre-wrap">
          {report.overview}
        </div>
        {report.focus_summary && (
          <div className="mt-2 text-[12px] text-muted italic">
            {report.focus_summary}
          </div>
        )}
      </Card>

      {report.core_entities.length > 0 && (
        <Card>
          <SectionTitle>Core entities</SectionTitle>
          <div className="flex flex-col gap-1">
            {report.core_entities.map((e, i) => (
              <div
                key={i}
                className="flex items-baseline gap-2 px-2 py-1.5 bg-panel-2 rounded"
              >
                <code className="text-[12px] font-mono font-semibold text-ink">
                  {e.table}
                </code>
                <SevPill tone={importanceTone(e.importance)}>
                  {e.importance || "—"}
                </SevPill>
                <span className="text-[12px] text-ink-2 flex-1">{e.purpose}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {report.business_flows.length > 0 && (
        <Card>
          <SectionTitle>Business flows</SectionTitle>
          <div className="flex flex-col gap-2">
            {report.business_flows.map((f, i) => (
              <div key={i} className="p-3 bg-panel-2 rounded">
                <div className="text-[13px] font-semibold text-ink">{f.name}</div>
                <div className="text-[12px] text-ink-2 mt-1">{f.description}</div>
                {f.tables.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {f.tables.map((t, j) => (
                      <span key={j} className="flex items-center">
                        <code className="text-[11px] font-mono px-1.5 py-0.5 bg-bg rounded">
                          {t}
                        </code>
                        {j < f.tables.length - 1 && (
                          <span className="mx-1 text-subtle">→</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {report.key_relations.length > 0 && (
        <Card>
          <SectionTitle>Key relations</SectionTitle>
          <div className="flex flex-col gap-2">
            {report.key_relations.map((r, i) => (
              <div key={i} className="p-3 bg-panel-2 rounded">
                <div className="flex items-center gap-2 text-[12px]">
                  <code className="font-mono font-semibold text-ink">{r.from_table}</code>
                  <span className="text-subtle">→</span>
                  <code className="font-mono font-semibold text-ink">{r.to_table}</code>
                  <span className="text-[10.5px] font-mono text-muted ml-2">
                    {r.via}
                  </span>
                </div>
                {r.reads_like && (
                  <div className="text-[12px] text-ink-2 mt-1.5">{r.reads_like}</div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {report.next_steps.length > 0 && (
        <Card>
          <SectionTitle>Next steps</SectionTitle>
          <ul className="list-disc pl-5 text-[13px] text-ink-2 leading-relaxed space-y-1">
            {report.next_steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function TablesView({ tables }: { tables: BriefingTableRef[] }) {
  if (tables.length === 0) return null;
  return (
    <Card>
      <SectionTitle>Curated scope</SectionTitle>
      <div className="flex flex-col gap-1.5">
        {tables.map((t) => (
          <div
            key={`${t.connection_id}|${t.database}|${t.table}`}
            className="flex items-center gap-2 px-2 py-1.5 bg-panel-2 rounded text-[12px]"
          >
            {t.is_primary && <span className="text-warn">★</span>}
            <code className="font-mono text-ink-2">
              {t.database}.{t.table}
            </code>
            <span
              className={`shrink-0 h-[14px] px-1 rounded text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 ${
                t.closed ? "bg-warn-soft text-warn" : "bg-bg text-muted"
              }`}
              title={`Connection: ${t.connection_name}`}
            >
              <span
                className={`w-1 h-1 rounded-full ${t.closed ? "bg-warn" : "bg-ok"}`}
              />
              {t.connection_name}
            </span>
            {t.closed ? (
              <span className="ml-auto text-[10px] text-warn italic">
                connection closed
              </span>
            ) : (
              <span className="ml-auto text-[10px] text-subtle tabular-nums font-mono">
                {t.columns.length}c · ~{t.estimated_rows}r
              </span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
