import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  OnboardingProject,
  OnboardingResponse,
  Project,
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
  onClose: () => void;
  onProjectCreated?: () => void;
};

export function OnboardingWorkspace({
  connectionId,
  databases,
  onClose,
  onProjectCreated,
}: Props) {
  const [database, setDatabase] = useState(databases[0] ?? "");
  const [maxTables, setMaxTables] = useState(40);
  const [response, setResponse] = useState<OnboardingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creatingProject, setCreatingProject] = useState<number | null>(null);
  const [createMsg, setCreateMsg] = useState("");

  async function run() {
    if (!database) {
      setError("Pick a database first.");
      return;
    }
    setLoading(true);
    setError("");
    setResponse(null);
    setCreateMsg("");
    try {
      const r = await invoke<OnboardingResponse>("run_onboarding", {
        connectionId,
        database,
        maxTables,
        includeAi: true,
      });
      setResponse(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function createProjectFromSuggestion(idx: number, p: OnboardingProject) {
    if (creatingProject !== null) return;
    setCreatingProject(idx);
    setCreateMsg("");
    try {
      const saved = await invoke<Project>("save_project", {
        project: {
          id: null,
          connection_id: connectionId,
          name: p.name,
          description: p.description,
        },
      });
      const projectId = saved.id!;
      const primary = p.primary_table;
      for (let i = 0; i < p.tables.length; i++) {
        const t = p.tables[i];
        await invoke("add_project_table", {
          projectId,
          databaseName: database,
          tableName: t,
          alias: null,
          isPrimary: t === primary || (primary === "" && i === 0),
        });
      }
      setCreateMsg(`✓ Created "${p.name}" (${p.tables.length} tables)`);
      onProjectCreated?.();
    } catch (e) {
      setCreateMsg(`✗ ${String(e)}`);
    } finally {
      setCreatingProject(null);
    }
  }

  return (
    <AgentPanel
      icon="🤖"
      title="Onboarding"
      subtitle={response ? `Snapshot of ${response.snapshot.database}` : "AI-summarize an unfamiliar database"}
      actions={
        <SecondaryButton onClick={onClose} title="Close tab">
          Close
        </SecondaryButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-[11px] uppercase tracking-wider font-bold text-muted">
              Database
            </label>
            <select
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              disabled={loading}
              className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md min-w-[160px]"
            >
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <label className="text-[11px] uppercase tracking-wider font-bold text-muted">
              Max tables
            </label>
            <input
              type="number"
              min={5}
              max={80}
              value={maxTables}
              onChange={(e) => setMaxTables(Number(e.target.value) || 40)}
              disabled={loading}
              className="h-7 w-20 px-2 text-[12px] bg-panel-2 border border-border rounded-md tabular-nums"
            />
            <PrimaryButton onClick={() => void run()} disabled={loading || !database}>
              {loading ? "Analyzing…" : "Run onboarding"}
            </PrimaryButton>
            <span className="text-[11px] text-muted ml-auto">
              Scans schema + foreign keys, then AI summarizes the domain.
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

        {response?.report && (
          <ReportView
            report={response.report}
            creatingProject={creatingProject}
            createMsg={createMsg}
            onCreate={createProjectFromSuggestion}
          />
        )}
      </div>
    </AgentPanel>
  );
}

function SnapshotMeta({ response }: { response: OnboardingResponse }) {
  const s = response.snapshot;
  return (
    <Card>
      <div className="flex gap-4 flex-wrap text-[12px] text-ink-2">
        <span>
          <strong className="text-ink">{s.database}</strong>
          <span className="text-muted ml-1">· MySQL {s.server_version}</span>
        </span>
        <span className="text-muted">
          Scanned {s.tables.length} of {s.total_tables} tables
        </span>
        <span className="text-muted">{s.fks.length} foreign keys</span>
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
  creatingProject,
  createMsg,
  onCreate,
}: {
  report: NonNullable<OnboardingResponse["report"]>;
  creatingProject: number | null;
  createMsg: string;
  onCreate: (idx: number, p: OnboardingProject) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle>
          Overview {report.domain_guess && <span className="text-acc-ink normal-case">· {report.domain_guess}</span>}
        </SectionTitle>
        <div className="text-[13px] text-ink-2 leading-relaxed whitespace-pre-wrap">
          {report.overview}
        </div>
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
                <code className="text-[12px] font-mono font-semibold text-ink">{e.table}</code>
                <SevPill tone={importanceTone(e.importance)}>{e.importance || "—"}</SevPill>
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

      {report.suggested_projects.length > 0 && (
        <Card>
          <SectionTitle>Suggested projects</SectionTitle>
          {createMsg && (
            <div
              className={`mb-2 px-2 py-1.5 rounded text-[12px] ${
                createMsg.startsWith("✓") ? "bg-ok-soft text-ok" : "bg-crit-soft text-crit"
              }`}
            >
              {createMsg}
            </div>
          )}
          <div className="flex flex-col gap-2">
            {report.suggested_projects.map((p, i) => (
              <div
                key={i}
                className="p-3 bg-acc-soft/40 border border-acc/20 rounded-lg"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-semibold text-ink">{p.name}</div>
                  <PrimaryButton
                    onClick={() => onCreate(i, p)}
                    disabled={creatingProject !== null}
                  >
                    {creatingProject === i ? "Creating…" : "Create project"}
                  </PrimaryButton>
                </div>
                <div className="text-[12px] text-ink-2 mt-1.5">{p.description}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.tables.map((t) => {
                    const isPrimary = t === p.primary_table;
                    return (
                      <code
                        key={t}
                        className={`text-[11px] font-mono px-1.5 py-0.5 rounded ${
                          isPrimary
                            ? "bg-warn-soft text-warn font-semibold"
                            : "bg-panel border border-border text-ink-2"
                        }`}
                      >
                        {isPrimary ? `★ ${t}` : t}
                      </code>
                    );
                  })}
                </div>
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
