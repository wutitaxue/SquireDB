import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChangeScenario,
  ColumnMetaForTree,
  FkReference,
  HistoryReference,
  ImpactAssessment,
  ImpactColumnMeta,
  ProjectImpactReport,
  ProjectImpactResponse,
  ProjectTable,
  PropagationEdge,
  PropagationPath,
  RoutineReference,
  TriggerReference,
  ViewReference,
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

type TableOpt = ProjectTable & {
  label: string;
  connectionLabel: string;
};

export function ProjectImpactWorkspace({ projectId, projectName, onClose }: Props) {
  const [projectTables, setProjectTables] = useState<ProjectTable[]>([]);
  const [connectionNames, setConnectionNames] = useState<Record<number, string>>({});
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [columns, setColumns] = useState<ColumnMetaForTree[]>([]);
  const [column, setColumn] = useState("");
  const [response, setResponse] = useState<ProjectImpactResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [tables, conns] = await Promise.all([
          invoke<ProjectTable[]>("list_project_tables", { projectId }),
          invoke<{ id: number; name: string }[]>("list_connections"),
        ]);
        setProjectTables(tables);
        const nameMap: Record<number, string> = {};
        for (const c of conns) nameMap[c.id] = c.name;
        setConnectionNames(nameMap);
        if (tables.length > 0 && selectedTableId === null) {
          setSelectedTableId(tables[0].id);
        }
      } catch (e) {
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const tableOptions: TableOpt[] = useMemo(
    () =>
      projectTables.map((t) => {
        const cname = connectionNames[t.connection_id] ?? `#${t.connection_id}`;
        return {
          ...t,
          label: `${t.database_name}.${t.table_name}`,
          connectionLabel: cname,
        };
      }),
    [projectTables, connectionNames],
  );

  const selected = tableOptions.find((t) => t.id === selectedTableId) ?? null;

  useEffect(() => {
    if (!selected) {
      setColumns([]);
      setColumn("");
      return;
    }
    invoke<ColumnMetaForTree[]>("list_columns_meta", {
      connectionId: selected.connection_id,
      database: selected.database_name,
      table: selected.table_name,
    })
      .then((cs) => {
        setColumns(cs);
        if (!cs.some((c) => c.name === column)) {
          setColumn(cs[0]?.name ?? "");
        }
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function run() {
    if (!selected || !column) {
      setError("Pick a table and column.");
      return;
    }
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      const r = await invoke<ProjectImpactResponse>("run_project_impact", {
        projectId,
        connectionId: selected.connection_id,
        database: selected.database_name,
        table: selected.table_name,
        column,
        includeAi: true,
      });
      setResponse(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const subtitle = selected
    ? `${selected.label}${column ? "." + column : ""}`
    : `Trace impact through curated relations of ${projectName}`;

  return (
    <AgentPanel
      icon="🎯"
      title="Project Impact"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
                Table
              </span>
              <select
                value={selectedTableId ?? ""}
                onChange={(e) => setSelectedTableId(Number(e.target.value))}
                disabled={loading || tableOptions.length === 0}
                className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50 min-w-[240px]"
              >
                {tableOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}  ·  {t.connectionLabel}
                  </option>
                ))}
              </select>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
                Column
              </span>
              <select
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                disabled={loading || columns.length === 0}
                className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50 min-w-[160px]"
              >
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.is_primary ? " (PK)" : c.is_foreign_key ? " (FK)" : ""}
                  </option>
                ))}
              </select>
            </span>
            <PrimaryButton onClick={() => void run()} disabled={loading || !column}>
              {loading ? "Tracing…" : "Trace impact"}
            </PrimaryButton>
            <span className="text-[11px] text-muted ml-auto">
              Curated relations + FK + views + routines + triggers + project history.
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
            <ColumnMetaCard
              meta={response.report.column}
              connectionLabel={response.report.connection_name}
            />
            {response.assessment && <AssessmentCard assessment={response.assessment} />}
            <PropagationCard paths={response.report.propagation_paths} report={response.report} />
            <ViewsCard refs={response.report.views} err={response.report.views_scan_error} />
            <RoutinesCard
              refs={response.report.routines}
              err={response.report.routines_scan_error}
            />
            <TriggersCard
              refs={response.report.triggers}
              err={response.report.triggers_scan_error}
            />
            <FksCard fks={response.report.fks} />
            <HistoryCard history={response.report.history} />
            <div className="text-[11px] text-muted text-right tabular-nums">
              scan {response.report.elapsed_ms}ms
            </div>
          </>
        )}
      </div>
    </AgentPanel>
  );
}

function ColumnMetaCard({
  meta,
  connectionLabel,
}: {
  meta: ImpactColumnMeta;
  connectionLabel: string;
}) {
  return (
    <Card>
      <SectionTitle>Column</SectionTitle>
      <div className="font-mono text-[14px] font-semibold text-ink flex items-center gap-2">
        <span>
          {meta.database}.{meta.table}.<span className="text-acc">{meta.column}</span>
        </span>
        <span
          className="h-[14px] px-1 rounded text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 bg-bg text-muted"
          title={`Connection: ${connectionLabel}`}
        >
          <span className="w-1 h-1 rounded-full bg-ok" />
          {connectionLabel}
        </span>
      </div>
      <div className="flex gap-1.5 flex-wrap mt-2">
        <SevPill tone="info">{meta.column_type}</SevPill>
        <SevPill tone={meta.nullable ? "neutral" : "warn"}>
          {meta.nullable ? "NULL" : "NOT NULL"}
        </SevPill>
        {meta.column_key && <SevPill tone="warn">{meta.column_key}</SevPill>}
        {meta.default !== null && (
          <SevPill tone="neutral">default: {meta.default}</SevPill>
        )}
      </div>
      {meta.comment && (
        <div className="mt-2 text-[12px] text-warn italic">// {meta.comment}</div>
      )}
    </Card>
  );
}

function levelTone(level: string): SevTone {
  switch (level) {
    case "critical":
      return "crit";
    case "high":
      return "warn";
    case "medium":
      return "info";
    case "low":
      return "ok";
    default:
      return "neutral";
  }
}

function AssessmentCard({ assessment }: { assessment: ImpactAssessment }) {
  const tone = levelTone(assessment.overall_level);
  const toneClass: Record<SevTone, string> = {
    crit: "bg-crit-soft border-crit/20",
    warn: "bg-warn-soft border-warn/20",
    info: "bg-info-soft border-info/20",
    ok: "bg-ok-soft border-ok/20",
    pii: "bg-pii-soft border-pii/20",
    neutral: "bg-bg-2 border-border",
  };

  return (
    <Card className={`${toneClass[tone]}`}>
      <div className="flex items-center gap-2 mb-2">
        <SevPill tone={tone}>
          AI assessment · {assessment.overall_level?.toUpperCase() || "—"}
        </SevPill>
      </div>
      <div className="text-[13px] text-ink-2 leading-relaxed">{assessment.risk_summary}</div>

      {assessment.change_scenarios.length > 0 && (
        <div className="mt-3">
          <SectionTitle>Change scenarios</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {assessment.change_scenarios.map((s, i) => (
              <ScenarioRow key={i} s={s} />
            ))}
          </div>
        </div>
      )}

      {assessment.before_action_advice.length > 0 && (
        <div className="mt-3">
          <SectionTitle>Before you change it</SectionTitle>
          <ul className="list-disc pl-5 text-[12px] text-ink-2 leading-relaxed space-y-1">
            {assessment.before_action_advice.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ScenarioRow({ s }: { s: ChangeScenario }) {
  const tone: SevTone =
    s.level === "danger" ? "crit" : s.level === "warning" ? "warn" : "ok";
  const borderTone: Record<SevTone, string> = {
    crit: "border-l-crit",
    warn: "border-l-warn",
    info: "border-l-info",
    ok: "border-l-ok",
    pii: "border-l-pii",
    neutral: "border-l-subtle",
  };
  return (
    <div
      className={`px-2.5 py-1.5 bg-panel border border-border rounded border-l-4 ${borderTone[tone]}`}
    >
      <div className="flex items-center gap-2">
        <code className="text-[12px] font-mono font-semibold text-ink">{s.action}</code>
        <SevPill tone={tone}>{s.level}</SevPill>
      </div>
      {s.breaks.length > 0 && (
        <ul className="list-disc pl-5 mt-1 text-[12px] text-ink-2 space-y-0.5">
          {s.breaks.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PropagationCard({
  paths,
  report,
}: {
  paths: PropagationPath[];
  report: ProjectImpactReport;
}) {
  const rootLabel = `${report.column.database}.${report.column.table}.${report.column.column}`;
  return (
    <Card>
      <SectionTitle>
        Propagation via curated relations ({paths.length})
      </SectionTitle>
      {paths.length === 0 ? (
        <div className="text-[12px] text-subtle italic">
          No user-curated relations reach beyond {rootLabel}.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {paths.map((p, i) => (
            <PathRow key={i} path={p} root={rootLabel} />
          ))}
        </div>
      )}
    </Card>
  );
}

function PathRow({ path, root }: { path: PropagationPath; root: string }) {
  return (
    <div className="px-2.5 py-1.5 bg-panel-2 rounded">
      <div className="flex items-center gap-2 text-[10.5px] text-muted mb-1">
        <SevPill tone={path.depth >= 3 ? "warn" : "neutral"}>
          depth {path.depth}
        </SevPill>
      </div>
      <div className="font-mono text-[11.5px] text-ink-2 leading-relaxed">
        <code>{root}</code>
        {path.edges.map((e, i) => (
          <EdgeArrow key={i} edge={e} />
        ))}
      </div>
    </div>
  );
}

function EdgeArrow({ edge }: { edge: PropagationEdge }) {
  const tone: SevTone = edge.cross_conn ? "pii" : edge.cross_db ? "warn" : "neutral";
  const label = edge.cross_conn ? "X-CONN" : edge.cross_db ? "X-DB" : null;
  return (
    <>
      <span className="text-subtle mx-1.5">→</span>
      {label && <SevPill tone={tone}>{label}</SevPill>}
      <span className="text-[9.5px] text-subtle font-sans mx-1">
        {edge.cardinality} · {edge.source}
      </span>
      <code>
        {edge.to_db}.{edge.to_table}.{edge.to_column}
      </code>
    </>
  );
}

function ReferenceCard({
  title,
  count,
  emptyText,
  err,
  children,
}: {
  title: string;
  count: number;
  emptyText: string;
  err: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <SectionTitle>
        {title} ({count})
      </SectionTitle>
      {err && <div className="text-[12px] text-crit mb-2">{err}</div>}
      {count === 0 ? (
        <div className="text-[12px] text-subtle italic">{emptyText}</div>
      ) : (
        <div className="flex flex-col gap-1">{children}</div>
      )}
    </Card>
  );
}

function RefRow({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1.5 bg-panel-2 rounded">{children}</div>;
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="font-mono text-[11px] text-ink-2 mt-1 whitespace-pre-wrap break-all leading-relaxed">
      {text}
    </div>
  );
}

function ViewsCard({ refs, err }: { refs: ViewReference[]; err: string | null }) {
  return (
    <ReferenceCard
      title="Views"
      count={refs.length}
      emptyText="No views reference this column."
      err={err}
    >
      {refs.map((v, i) => (
        <RefRow key={i}>
          <div className="font-mono text-[12.5px] font-semibold text-ink">
            {v.database}.{v.view}
          </div>
          <Snippet text={v.snippet} />
        </RefRow>
      ))}
    </ReferenceCard>
  );
}

function RoutinesCard({
  refs,
  err,
}: {
  refs: RoutineReference[];
  err: string | null;
}) {
  return (
    <ReferenceCard
      title="Routines"
      count={refs.length}
      emptyText="No routines reference this column."
      err={err}
    >
      {refs.map((r, i) => (
        <RefRow key={i}>
          <div className="font-mono text-[12.5px] font-semibold text-ink">
            {r.database}.{r.name}{" "}
            <span className="text-[10.5px] text-muted">({r.routine_type})</span>
          </div>
          <Snippet text={r.snippet} />
        </RefRow>
      ))}
    </ReferenceCard>
  );
}

function TriggersCard({
  refs,
  err,
}: {
  refs: TriggerReference[];
  err: string | null;
}) {
  return (
    <ReferenceCard
      title="Triggers"
      count={refs.length}
      emptyText="No triggers reference this column."
      err={err}
    >
      {refs.map((t, i) => (
        <RefRow key={i}>
          <div className="font-mono text-[12.5px] font-semibold text-ink">
            {t.database}.{t.trigger}{" "}
            <span className="text-[10.5px] text-muted">
              on {t.event_table} {t.event}
            </span>
          </div>
          <Snippet text={t.snippet} />
        </RefRow>
      ))}
    </ReferenceCard>
  );
}

function FksCard({ fks }: { fks: FkReference[] }) {
  return (
    <ReferenceCard
      title="Foreign keys"
      count={fks.length}
      emptyText="No FK references on this column."
      err={null}
    >
      {fks.map((fk, i) => (
        <RefRow key={i}>
          <div className="flex items-center gap-2 text-[12px]">
            <SevPill tone={fk.direction === "inbound" ? "info" : "neutral"}>
              {fk.direction}
            </SevPill>
            <code className="font-mono text-ink-2">
              {fk.from_db}.{fk.from_table}.{fk.from_column} ↔ {fk.to_db}.{fk.to_table}.
              {fk.to_column}
            </code>
          </div>
        </RefRow>
      ))}
    </ReferenceCard>
  );
}

function HistoryCard({ history }: { history: HistoryReference }) {
  return (
    <Card>
      <SectionTitle>
        Project query history ({history.count} mentions)
      </SectionTitle>
      {history.recent_sql.length === 0 ? (
        <div className="text-[12px] text-subtle italic">
          No mentions in any connection's local history.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {history.recent_sql.map((sql, i) => (
            <div
              key={i}
              className="px-2 py-1.5 bg-panel-2 rounded font-mono text-[11px] text-ink-2 whitespace-pre-wrap break-all"
            >
              {sql}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
