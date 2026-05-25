import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DiffReport,
  MigrationRiskReport,
  MigrationStatement,
  TableDiff,
} from "../types";
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

const KIND_TONE: Record<string, SevTone> = {
  create_table: "ok",
  drop_table: "crit",
  add_column: "ok",
  drop_column: "crit",
  modify_column: "warn",
  add_index: "info",
  drop_index: "neutral",
};

function levelTone(level: string): SevTone {
  switch (level.toLowerCase()) {
    case "danger":
      return "crit";
    case "warning":
      return "warn";
    case "safe":
      return "ok";
    default:
      return "neutral";
  }
}

type Props = {
  connectionId: number;
  databases: string[];
  onClose: () => void;
  onInjectSql: (sql: string) => void;
};

export function SchemaDiffWorkspace({
  connectionId,
  databases,
  onClose,
  onInjectSql,
}: Props) {
  const [sourceDb, setSourceDb] = useState(databases[0] ?? "");
  const [targetDb, setTargetDb] = useState(databases[1] ?? databases[0] ?? "");
  const [report, setReport] = useState<DiffReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [risks, setRisks] = useState<Record<number, { level: string; reason: string }>>({});
  const [assessing, setAssessing] = useState(false);
  const [assessError, setAssessError] = useState("");

  async function compare() {
    if (!sourceDb || !targetDb || sourceDb === targetDb) {
      setError("Pick two different databases");
      return;
    }
    setLoading(true);
    setError("");
    setReport(null);
    setRisks({});
    setAssessError("");
    try {
      const r = await invoke<DiffReport>("compare_schemas", {
        connectionId,
        sourceDb,
        targetDb,
      });
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function assessAll() {
    if (!report || report.migrations.length === 0 || assessing) return;
    setAssessing(true);
    setAssessError("");
    try {
      const rpt = await invoke<MigrationRiskReport>("assess_migrations", {
        migrations: report.migrations,
      });
      const map: Record<number, { level: string; reason: string }> = {};
      for (const a of rpt.assessments) {
        map[a.index] = { level: a.level, reason: a.reason };
      }
      setRisks(map);
    } catch (e) {
      setAssessError(String(e));
    } finally {
      setAssessing(false);
    }
  }

  function copyAll() {
    if (!report) return;
    const text = report.migrations.map((m) => m.sql).join("\n\n");
    void navigator.clipboard.writeText(text);
  }

  function swapDirection() {
    const s = sourceDb;
    setSourceDb(targetDb);
    setTargetDb(s);
    setReport(null);
    setRisks({});
  }

  const dangerCount = Object.values(risks).filter((r) => r.level.toLowerCase() === "danger").length;

  return (
    <AgentPanel
      icon="🔄"
      title="Schema Diff"
      subtitle={
        report
          ? `${sourceDb} → ${targetDb} · ${report.migrations.length} statements`
          : "Compare two databases and generate a migration"
      }
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
              Source
            </span>
            <select
              value={sourceDb}
              onChange={(e) => setSourceDb(e.target.value)}
              disabled={loading}
              className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md"
            >
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <button
              onClick={swapDirection}
              title="Swap source/target"
              className="h-7 px-2 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
            >
              ⇄
            </button>
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
              Target
            </span>
            <select
              value={targetDb}
              onChange={(e) => setTargetDb(e.target.value)}
              disabled={loading}
              className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md"
            >
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <PrimaryButton onClick={() => void compare()} disabled={loading}>
              {loading ? "Comparing…" : "Compare"}
            </PrimaryButton>
            <span className="text-[11px] text-muted ml-auto">
              Bring <code className="font-mono">{targetDb || "?"}</code> in line with{" "}
              <code className="font-mono">{sourceDb || "?"}</code>.
            </span>
          </div>
        </Card>

        {error && <ErrorPre>{error}</ErrorPre>}

        {report && (
          <>
            <div className="grid grid-cols-4 gap-3">
              <KpiCard
                label="Added"
                value={report.tables_added.length}
                sub="tables in source only"
                tone="ok"
              />
              <KpiCard
                label="Removed"
                value={report.tables_removed.length}
                sub="tables in target only"
                tone="crit"
              />
              <KpiCard
                label="Changed"
                value={report.tables_changed.length}
                sub="tables with diffs"
                tone="warn"
              />
              <KpiCard
                label="Statements"
                value={report.migrations.length}
                sub="migration steps"
                tone="info"
              />
            </div>

            {report.migrations.length === 0 ? (
              <Card>
                <div className="flex items-center gap-2 text-ok">
                  <span className="w-2 h-2 rounded-full bg-ok" />
                  <span className="text-[14px] font-semibold">Schemas are identical.</span>
                </div>
              </Card>
            ) : (
              <>
                <DiffDetails report={report} />

                {dangerCount > 0 && (
                  <Card className="bg-crit-soft border-crit/20">
                    <div className="flex items-center gap-2 text-crit">
                      <SevPill tone="crit">danger</SevPill>
                      <span className="text-[13px] font-semibold">
                        {dangerCount} high-risk statement{dangerCount === 1 ? "" : "s"} flagged. Review carefully before applying to production.
                      </span>
                    </div>
                  </Card>
                )}

                <Card>
                  <div className="flex items-center gap-2 mb-3">
                    <SectionTitle>
                      Migration SQL ({report.migrations.length})
                    </SectionTitle>
                    <div className="flex-1" />
                    <SecondaryButton onClick={() => void assessAll()} disabled={assessing}>
                      {assessing ? "Assessing…" : "🤖 Assess risks"}
                    </SecondaryButton>
                    <SecondaryButton onClick={copyAll}>Copy all</SecondaryButton>
                  </div>

                  {assessError && (
                    <pre className="mb-3 p-2 bg-crit-soft text-crit text-[11px] rounded whitespace-pre-wrap">
                      {assessError}
                    </pre>
                  )}

                  <div className="flex flex-col gap-2">
                    {report.migrations.map((m, i) => (
                      <MigrationRow
                        key={i}
                        index={i}
                        migration={m}
                        risk={risks[i]}
                        onInjectSql={onInjectSql}
                      />
                    ))}
                  </div>
                </Card>
              </>
            )}
          </>
        )}
      </div>
    </AgentPanel>
  );
}

function DiffDetails({ report }: { report: DiffReport }) {
  if (
    report.tables_added.length === 0 &&
    report.tables_removed.length === 0 &&
    report.tables_changed.length === 0
  ) {
    return null;
  }
  return (
    <Card>
      <SectionTitle>Schema differences</SectionTitle>
      <div className="flex flex-col gap-2">
        {report.tables_added.length > 0 && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-ok font-semibold">
              + {report.tables_added.length} tables in source only
            </summary>
            <div className="pl-4 pt-1 text-[12px] text-muted">
              {report.tables_added.join(", ")}
            </div>
          </details>
        )}
        {report.tables_removed.length > 0 && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-crit font-semibold">
              − {report.tables_removed.length} tables in target only
            </summary>
            <div className="pl-4 pt-1 text-[12px] text-muted">
              {report.tables_removed.join(", ")}
            </div>
          </details>
        )}
        {report.tables_changed.length > 0 && (
          <details open className="text-[13px]">
            <summary className="cursor-pointer text-warn font-semibold">
              ~ {report.tables_changed.length} tables changed
            </summary>
            <div className="pl-4 pt-2 flex flex-col gap-2">
              {report.tables_changed.map((t) => (
                <TableDiffCard key={t.name} diff={t} />
              ))}
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

function TableDiffCard({ diff }: { diff: TableDiff }) {
  return (
    <div className="border border-border rounded-lg p-3 bg-panel-2">
      <div className="font-mono text-[13px] font-semibold text-ink mb-2">
        {diff.name}
      </div>
      <table className="w-full text-[11.5px] border-collapse">
        <thead>
          <tr className="bg-panel">
            <th className="text-left px-2 h-7 font-semibold text-muted border-b border-border">
              Change
            </th>
            <th className="text-left px-2 h-7 font-semibold text-muted border-b border-border">
              Name
            </th>
            <th className="text-left px-2 h-7 font-semibold text-muted border-b border-border">
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {diff.columns_added.map((c) => (
            <tr key={`ca-${c.name}`} className="border-b border-border">
              <td className="px-2 h-7 text-ok font-semibold">+ col</td>
              <td className="px-2 h-7 font-mono text-ink-2">{c.name}</td>
              <td className="px-2 h-7 font-mono text-ink-2">{c.column_type}</td>
            </tr>
          ))}
          {diff.columns_removed.map((c) => (
            <tr key={`cr-${c.name}`} className="border-b border-border">
              <td className="px-2 h-7 text-crit font-semibold">− col</td>
              <td className="px-2 h-7 font-mono text-ink-2">{c.name}</td>
              <td className="px-2 h-7 font-mono text-ink-2">{c.column_type}</td>
            </tr>
          ))}
          {diff.columns_changed.map((c) => (
            <tr key={`cc-${c.name}`} className="border-b border-border">
              <td className="px-2 h-7 text-warn font-semibold">~ col</td>
              <td className="px-2 h-7 font-mono text-ink-2">{c.name}</td>
              <td className="px-2 h-7 font-mono text-ink-2">
                {c.differences.join(", ")}: <code>{c.target.column_type}</code> →{" "}
                <code>{c.source.column_type}</code>
              </td>
            </tr>
          ))}
          {diff.indexes_added.map((i) => (
            <tr key={`ia-${i.name}`} className="border-b border-border">
              <td className="px-2 h-7 text-info font-semibold">+ idx</td>
              <td className="px-2 h-7 font-mono text-ink-2">{i.name}</td>
              <td className="px-2 h-7 font-mono text-ink-2">
                ({i.columns.join(", ")}) {i.unique ? "UNIQUE" : ""}
              </td>
            </tr>
          ))}
          {diff.indexes_removed.map((i) => (
            <tr key={`ir-${i.name}`} className="border-b border-border">
              <td className="px-2 h-7 text-muted font-semibold">− idx</td>
              <td className="px-2 h-7 font-mono text-ink-2">{i.name}</td>
              <td className="px-2 h-7 font-mono text-ink-2">
                ({i.columns.join(", ")}) {i.unique ? "UNIQUE" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MigrationRow({
  index,
  migration,
  risk,
  onInjectSql,
}: {
  index: number;
  migration: MigrationStatement;
  risk: { level: string; reason: string } | undefined;
  onInjectSql: (sql: string) => void;
}) {
  const kindTone = KIND_TONE[migration.kind] ?? "neutral";
  const tone = risk ? levelTone(risk.level) : null;
  const borderTone =
    tone === "crit"
      ? "border-l-crit"
      : tone === "warn"
        ? "border-l-warn"
        : tone === "ok"
          ? "border-l-ok"
          : migration.destructive
            ? "border-l-crit"
            : "border-l-info";

  return (
    <div className={`bg-panel border border-border border-l-4 ${borderTone} rounded-lg p-3`}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-[11px] text-subtle tabular-nums">#{index}</span>
        <SevPill tone={kindTone}>{migration.kind.replace(/_/g, " ")}</SevPill>
        <code className="text-[12px] font-mono text-ink-2">{migration.table}</code>
        {risk && tone && <SevPill tone={tone}>{risk.level}</SevPill>}
        <div className="flex-1" />
        <SecondaryButton onClick={() => void navigator.clipboard.writeText(migration.sql)}>
          Copy
        </SecondaryButton>
        <SecondaryButton onClick={() => onInjectSql(migration.sql)}>Inject</SecondaryButton>
      </div>
      {risk && (
        <div
          className={`text-[12px] mb-2 ${
            tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "text-ink-2"
          }`}
        >
          {risk.reason}
        </div>
      )}
      <pre className="m-0 p-2 bg-panel-2 border border-border rounded font-mono text-[11.5px] text-ink-2 whitespace-pre-wrap">
        {migration.sql}
      </pre>
    </div>
  );
}
