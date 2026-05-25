import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChangeScenario,
  FkReference,
  HistoryReference,
  ImpactAssessment,
  ImpactColumnMeta,
  ImpactResponse,
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
  connectionId: number;
  databases: string[];
  initialDb?: string;
  initialTable?: string;
  initialColumn?: string;
  onClose: () => void;
};

export function ImpactWorkspace({
  connectionId,
  databases,
  initialDb,
  initialTable,
  initialColumn,
  onClose,
}: Props) {
  const [database, setDatabase] = useState(initialDb ?? databases[0] ?? "");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState(initialTable ?? "");
  const [columns, setColumns] = useState<string[]>([]);
  const [column, setColumn] = useState(initialColumn ?? "");
  const [response, setResponse] = useState<ImpactResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!database) {
      setTables([]);
      return;
    }
    invoke<string[]>("list_tables", { id: connectionId, database })
      .then((ts) => {
        setTables(ts);
        if (!ts.includes(table)) {
          setTable(ts[0] ?? "");
        }
      })
      .catch((e) => setError(String(e)));
  }, [database, connectionId]);

  useEffect(() => {
    if (!database || !table) {
      setColumns([]);
      return;
    }
    invoke<string[]>("list_columns", { connectionId, database, table })
      .then((cs) => {
        setColumns(cs);
        if (!cs.includes(column)) {
          setColumn(cs[0] ?? "");
        }
      })
      .catch((e) => setError(String(e)));
  }, [database, table, connectionId]);

  async function run() {
    if (!database || !table || !column) {
      setError("Pick a database, table, and column.");
      return;
    }
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      const r = await invoke<ImpactResponse>("run_impact_analysis", {
        connectionId,
        database,
        table,
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

  return (
    <AgentPanel
      icon="🎯"
      title="Impact Analysis"
      subtitle={
        column ? `${database}.${table}.${column}` : "Pick a column to scan its consumers"
      }
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <Selector
              label="Database"
              value={database}
              onChange={setDatabase}
              options={databases}
              disabled={loading}
            />
            <Selector
              label="Table"
              value={table}
              onChange={setTable}
              options={tables}
              disabled={loading || tables.length === 0}
              minWidth={160}
            />
            <Selector
              label="Column"
              value={column}
              onChange={setColumn}
              options={columns}
              disabled={loading || columns.length === 0}
              minWidth={160}
            />
            <PrimaryButton onClick={() => void run()} disabled={loading || !column}>
              {loading ? "Scanning…" : "Run impact analysis"}
            </PrimaryButton>
            <span className="text-[11px] text-muted ml-auto">
              Scans views · routines · triggers · FKs · local history.
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
            <ColumnMetaCard meta={response.report.column} />
            {response.assessment && <AssessmentCard assessment={response.assessment} />}
            <ViewsCard refs={response.report.views} err={response.report.views_scan_error} />
            <RoutinesCard refs={response.report.routines} err={response.report.routines_scan_error} />
            <TriggersCard refs={response.report.triggers} err={response.report.triggers_scan_error} />
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

function Selector({
  label,
  value,
  onChange,
  options,
  disabled,
  minWidth,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled?: boolean;
  minWidth?: number;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wider font-bold text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ minWidth }}
        className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </span>
  );
}

function ColumnMetaCard({ meta }: { meta: ImpactColumnMeta }) {
  return (
    <Card>
      <SectionTitle>Column</SectionTitle>
      <div className="font-mono text-[14px] font-semibold text-ink">
        {meta.database}.{meta.table}.<span className="text-acc">{meta.column}</span>
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
  const tone: SevTone = s.level === "danger" ? "crit" : s.level === "warning" ? "warn" : "ok";
  const borderTone: Record<SevTone, string> = {
    crit: "border-l-crit",
    warn: "border-l-warn",
    info: "border-l-info",
    ok: "border-l-ok",
    pii: "border-l-pii",
    neutral: "border-l-subtle",
  };
  return (
    <div className={`px-2.5 py-1.5 bg-panel border border-border rounded border-l-4 ${borderTone[tone]}`}>
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

function RoutinesCard({ refs, err }: { refs: RoutineReference[]; err: string | null }) {
  return (
    <ReferenceCard
      title="Stored routines"
      count={refs.length}
      emptyText="No procedures or functions reference this column."
      err={err}
    >
      {refs.map((r, i) => (
        <RefRow key={i}>
          <div className="font-mono text-[12.5px] font-semibold text-ink flex items-baseline gap-2">
            {r.database}.{r.name}
            <span className="text-[10px] text-subtle font-normal">{r.routine_type}</span>
          </div>
          <Snippet text={r.snippet} />
        </RefRow>
      ))}
    </ReferenceCard>
  );
}

function TriggersCard({ refs, err }: { refs: TriggerReference[]; err: string | null }) {
  return (
    <ReferenceCard
      title="Triggers"
      count={refs.length}
      emptyText="No triggers reference this column."
      err={err}
    >
      {refs.map((t, i) => (
        <RefRow key={i}>
          <div className="font-mono text-[12.5px] font-semibold text-ink flex items-baseline gap-2">
            {t.database}.{t.trigger}
            <span className="text-[10px] text-subtle font-normal">
              {t.event} on {t.event_table}
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
    <ReferenceCard title="Foreign keys" count={fks.length} emptyText="No FK references." err={null}>
      {fks.map((fk, i) => (
        <RefRow key={i}>
          <div className="flex items-center gap-2">
            <SevPill tone={fk.direction === "inbound" ? "crit" : "info"}>
              {fk.direction}
            </SevPill>
            <code className="font-mono text-[12px] text-ink-2">
              {fk.from_db}.{fk.from_table}.{fk.from_column}
              <span className="text-subtle"> → </span>
              {fk.to_db}.{fk.to_table}.{fk.to_column}
            </code>
          </div>
        </RefRow>
      ))}
    </ReferenceCard>
  );
}

function HistoryCard({ history }: { history: HistoryReference }) {
  if (history.count === 0) {
    return (
      <ReferenceCard
        title="Local query history"
        count={0}
        emptyText="Never appeared in this connection's query history."
        err={null}
      >
        {null}
      </ReferenceCard>
    );
  }
  return (
    <Card>
      <SectionTitle>
        Local query history ({history.count} occurrence{history.count === 1 ? "" : "s"})
      </SectionTitle>
      <div className="flex flex-col gap-1">
        {history.recent_sql.map((q, i) => (
          <RefRow key={i}>
            <div className="font-mono text-[11.5px] text-ink-2 whitespace-pre-wrap break-all">
              {q}
            </div>
          </RefRow>
        ))}
      </div>
    </Card>
  );
}
