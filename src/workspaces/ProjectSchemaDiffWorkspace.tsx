import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Connection,
  MigrationRisk,
  MigrationStatement,
  ProjectSchemaDiffResponse,
  ProjectTable,
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
import { copyText } from "../utils";

type Props = {
  projectId: number;
  projectName: string;
  onClose: () => void;
};

type Endpoint = { connection_id: number; database: string; label: string };

const KIND_TONE: Record<string, SevTone> = {
  create_table: "ok",
  drop_table: "crit",
  add_column: "ok",
  drop_column: "crit",
  modify_column: "warn",
  add_index: "info",
  drop_index: "neutral",
};

function riskTone(level: string): SevTone {
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

export function ProjectSchemaDiffWorkspace({
  projectId,
  projectName,
  onClose,
}: Props) {
  const [projectTables, setProjectTables] = useState<ProjectTable[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [sourceKey, setSourceKey] = useState<string>("");
  const [targetKey, setTargetKey] = useState<string>("");
  const [response, setResponse] = useState<ProjectSchemaDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [tables, conns] = await Promise.all([
          invoke<ProjectTable[]>("list_project_tables", { projectId }),
          invoke<Connection[]>("list_connections"),
        ]);
        setProjectTables(tables);
        setConnections(conns);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [projectId]);

  const endpoints: Endpoint[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Endpoint[] = [];
    const connNameMap = new Map<number, string>();
    for (const c of connections) {
      if (c.id !== null) connNameMap.set(c.id, c.name);
    }
    for (const t of projectTables) {
      const key = `${t.connection_id}::${t.database_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cname = connNameMap.get(t.connection_id) ?? `#${t.connection_id}`;
      out.push({
        connection_id: t.connection_id,
        database: t.database_name,
        label: `${cname} · ${t.database_name}`,
      });
    }
    return out;
  }, [projectTables, connections]);

  useEffect(() => {
    if (endpoints.length === 0) {
      setSourceKey("");
      setTargetKey("");
      return;
    }
    setSourceKey((prev) => {
      const cur = endpoints.find(
        (e) => `${e.connection_id}::${e.database}` === prev,
      );
      return cur ? prev : `${endpoints[0].connection_id}::${endpoints[0].database}`;
    });
    setTargetKey((prev) => {
      const cur = endpoints.find(
        (e) => `${e.connection_id}::${e.database}` === prev,
      );
      if (cur) return prev;
      const next = endpoints[1] ?? endpoints[0];
      return `${next.connection_id}::${next.database}`;
    });
  }, [endpoints]);

  function endpointFromKey(k: string): Endpoint | null {
    return (
      endpoints.find((e) => `${e.connection_id}::${e.database}` === k) ?? null
    );
  }

  const source = endpointFromKey(sourceKey);
  const target = endpointFromKey(targetKey);
  const same =
    source &&
    target &&
    source.connection_id === target.connection_id &&
    source.database === target.database;

  async function run() {
    if (!source || !target) {
      setError("Pick both source and target endpoints.");
      return;
    }
    if (same) {
      setError("Source and target are identical.");
      return;
    }
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      const r = await invoke<ProjectSchemaDiffResponse>(
        "run_project_schema_diff",
        {
          projectId,
          sourceConnectionId: source.connection_id,
          sourceDb: source.database,
          targetConnectionId: target.connection_id,
          targetDb: target.database,
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
    ? `${response.report.diff.tables_added.length} added · ${response.report.diff.tables_removed.length} removed · ${response.report.diff.tables_changed.length} changed`
    : `Compare schema of ${projectName} across two endpoints`;

  return (
    <AgentPanel
      icon="🪞"
      title="Project Schema Diff"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
                Source
              </span>
              <select
                value={sourceKey}
                onChange={(e) => setSourceKey(e.target.value)}
                disabled={loading || endpoints.length === 0}
                className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50 min-w-[220px]"
              >
                {endpoints.map((e) => (
                  <option
                    key={`${e.connection_id}::${e.database}`}
                    value={`${e.connection_id}::${e.database}`}
                  >
                    {e.label}
                  </option>
                ))}
              </select>
            </span>
            <span className="text-subtle">→</span>
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
                Target
              </span>
              <select
                value={targetKey}
                onChange={(e) => setTargetKey(e.target.value)}
                disabled={loading || endpoints.length === 0}
                className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50 min-w-[220px]"
              >
                {endpoints.map((e) => (
                  <option
                    key={`${e.connection_id}::${e.database}`}
                    value={`${e.connection_id}::${e.database}`}
                  >
                    {e.label}
                  </option>
                ))}
              </select>
            </span>
            <PrimaryButton
              onClick={() => void run()}
              disabled={loading || !source || !target || !!same}
            >
              {loading ? "Diffing…" : "Run diff"}
            </PrimaryButton>
            {same && (
              <SevPill tone="warn">source = target</SevPill>
            )}
            <span className="text-[11px] text-muted ml-auto">
              Scoped to {projectTables.length} project tables.
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
            <OverviewCard r={response.report} />
            <ScopeCoverageCard r={response.report} />
            <TablesCard r={response.report} />
            <MigrationsCard
              migrations={response.report.diff.migrations}
              risk={response.risk}
            />
            <div className="text-[11px] text-muted text-right tabular-nums">
              scan {response.report.elapsed_ms}ms
            </div>
          </>
        )}
      </div>
    </AgentPanel>
  );
}

function OverviewCard({
  r,
}: {
  r: ProjectSchemaDiffResponse["report"];
}) {
  return (
    <Card>
      <SectionTitle>
        {r.source_connection_name} · <code>{r.source_db}</code>  →{" "}
        {r.target_connection_name} · <code>{r.target_db}</code>
      </SectionTitle>
      <div className="grid grid-cols-4 gap-2">
        <KpiCard label="Tables in scope" value={r.scope_tables.length} />
        <KpiCard label="Added" value={r.diff.tables_added.length} tone="ok" />
        <KpiCard
          label="Removed"
          value={r.diff.tables_removed.length}
          tone="crit"
        />
        <KpiCard
          label="Changed"
          value={r.diff.tables_changed.length}
          tone="warn"
        />
      </div>
    </Card>
  );
}

function ScopeCoverageCard({
  r,
}: {
  r: ProjectSchemaDiffResponse["report"];
}) {
  const missSrc = r.scope_tables_missing_source;
  const missTgt = r.scope_tables_missing_target;
  if (missSrc.length === 0 && missTgt.length === 0) return null;
  return (
    <Card className="bg-warn-soft border-warn/20">
      <SectionTitle>Scope coverage</SectionTitle>
      {missSrc.length > 0 && (
        <div className="text-[12px] text-ink-2 mb-1">
          <span className="font-semibold">Missing on source</span> ({missSrc.length}):{" "}
          <span className="font-mono">{missSrc.join(", ")}</span>
        </div>
      )}
      {missTgt.length > 0 && (
        <div className="text-[12px] text-ink-2">
          <span className="font-semibold">Missing on target</span> ({missTgt.length}):{" "}
          <span className="font-mono">{missTgt.join(", ")}</span>
        </div>
      )}
    </Card>
  );
}

function TablesCard({
  r,
}: {
  r: ProjectSchemaDiffResponse["report"];
}) {
  const { tables_added, tables_removed, tables_changed } = r.diff;
  if (
    tables_added.length === 0 &&
    tables_removed.length === 0 &&
    tables_changed.length === 0
  ) {
    return (
      <Card>
        <SectionTitle>Tables</SectionTitle>
        <div className="text-[12px] text-subtle italic">
          Source and target schemas match for all {r.scope_tables.length} project
          tables in scope. ✓
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <SectionTitle>Tables</SectionTitle>
      {tables_added.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wider font-bold text-ok mb-1">
            Added ({tables_added.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tables_added.map((t) => (
              <SevPill key={t} tone="ok">{t}</SevPill>
            ))}
          </div>
        </div>
      )}
      {tables_removed.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wider font-bold text-crit mb-1">
            Removed ({tables_removed.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tables_removed.map((t) => (
              <SevPill key={t} tone="crit">{t}</SevPill>
            ))}
          </div>
        </div>
      )}
      {tables_changed.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
            Changed ({tables_changed.length})
          </div>
          <div className="flex flex-col gap-1.5">
            {tables_changed.map((t) => (
              <ChangedTableRow key={t.name} t={t} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function ChangedTableRow({ t }: { t: TableDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-panel-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-panel"
      >
        <span className="text-[11px] text-subtle">{open ? "▾" : "▸"}</span>
        <code className="text-[13px] font-mono font-semibold text-ink">
          {t.name}
        </code>
        <span className="text-[11px] text-muted ml-auto tabular-nums">
          +{t.columns_added.length} cols · -{t.columns_removed.length} cols · ~{t.columns_changed.length} ·
          idx +{t.indexes_added.length}/-{t.indexes_removed.length}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-[12px]">
          {t.columns_added.length > 0 && (
            <div className="mt-2">
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-ok mb-1">
                Added columns
              </div>
              {t.columns_added.map((c) => (
                <div key={c.name} className="font-mono text-ink-2">
                  + {c.name} {c.column_type}
                  {c.nullable ? " NULL" : " NOT NULL"}
                </div>
              ))}
            </div>
          )}
          {t.columns_removed.length > 0 && (
            <div className="mt-2">
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-crit mb-1">
                Removed columns
              </div>
              {t.columns_removed.map((c) => (
                <div key={c.name} className="font-mono text-ink-2">
                  - {c.name} {c.column_type}
                </div>
              ))}
            </div>
          )}
          {t.columns_changed.length > 0 && (
            <div className="mt-2">
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-warn mb-1">
                Modified columns
              </div>
              {t.columns_changed.map((c) => (
                <div key={c.name} className="font-mono text-ink-2 mb-1">
                  <span className="text-warn">~ {c.name}</span>{" "}
                  <span className="text-subtle">
                    [{c.differences.join(", ")}]
                  </span>
                  <div className="pl-4 text-[11px] text-muted">
                    src: {c.source.column_type}
                    {c.source.nullable ? " NULL" : " NOT NULL"} → tgt:{" "}
                    {c.target.column_type}
                    {c.target.nullable ? " NULL" : " NOT NULL"}
                  </div>
                </div>
              ))}
            </div>
          )}
          {(t.indexes_added.length > 0 || t.indexes_removed.length > 0) && (
            <div className="mt-2">
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-info mb-1">
                Indexes
              </div>
              {t.indexes_added.map((i) => (
                <div key={`a-${i.name}`} className="font-mono text-ok text-[11px]">
                  + {i.unique ? "UNIQUE " : ""}{i.name} ({i.columns.join(", ")})
                </div>
              ))}
              {t.indexes_removed.map((i) => (
                <div key={`r-${i.name}`} className="font-mono text-crit text-[11px]">
                  - {i.unique ? "UNIQUE " : ""}{i.name} ({i.columns.join(", ")})
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MigrationsCard({
  migrations,
  risk,
}: {
  migrations: MigrationStatement[];
  risk: ProjectSchemaDiffResponse["risk"];
}) {
  const riskMap = useMemo(() => {
    const m = new Map<number, MigrationRisk>();
    if (risk) for (const a of risk.assessments) m.set(a.index, a);
    return m;
  }, [risk]);

  function copyAll() {
    const text = migrations.map((m) => m.sql).join("\n\n");
    if (text) void copyText(text);
  }

  return (
    <Card>
      <SectionTitle>Migrations ({migrations.length})</SectionTitle>
      {migrations.length === 0 ? (
        <div className="text-[12px] text-subtle italic">
          No migrations needed.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <SecondaryButton onClick={copyAll}>
              ⧉ Copy all SQL
            </SecondaryButton>
            <span className="text-[11px] text-muted">
              SQL targets <code>{migrations[0]?.table ? "target" : ""}</code> connection
              · review before executing.
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {migrations.map((m, i) => {
              const r = riskMap.get(i);
              return (
                <div
                  key={i}
                  className="px-2.5 py-1.5 bg-panel-2 rounded border border-border"
                >
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <SevPill tone={KIND_TONE[m.kind] ?? "neutral"}>
                      {m.kind}
                    </SevPill>
                    <code className="font-mono text-[12px] text-ink font-semibold">
                      {m.table}
                    </code>
                    {m.destructive && (
                      <SevPill tone="crit">destructive</SevPill>
                    )}
                    {r && (
                      <SevPill tone={riskTone(r.level)}>
                        AI · {r.level}
                      </SevPill>
                    )}
                  </div>
                  <pre className="font-mono text-[11.5px] text-ink-2 whitespace-pre-wrap break-all leading-relaxed">
                    {m.sql}
                  </pre>
                  {r?.reason && (
                    <div className="text-[11px] text-muted mt-1 italic">
                      {r.reason}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
