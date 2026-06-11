import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  RepairInvestigation,
  RepairInvestigationQuery,
  RepairSession,
  RepairStrategy,
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
};

type Stage = 0 | 1 | 2 | 3 | 4;

function stageFromState(state: string): Stage {
  switch (state) {
    case "investigating":
      return 0;
    case "proposing":
      return 1;
    case "awaiting_approval":
      return 1;
    case "backing_up":
      return 2;
    case "awaiting_final":
      return 3;
    case "executing":
    case "done":
    case "failed":
    case "cancelled":
      return 4;
    default:
      return 0;
  }
}

const STAGES = [
  { id: 0, label: "Investigate" },
  { id: 1, label: "Propose" },
  { id: 2, label: "Backup" },
  { id: 3, label: "Execute" },
  { id: 4, label: "Done" },
] as const;

export function RepairWorkspace({ connectionId, databases, onClose }: Props) {
  const [database, setDatabase] = useState(databases[0] ?? "");
  const [scopeInput, setScopeInput] = useState("");
  const [goal, setGoal] = useState("");
  const [session, setSession] = useState<RepairSession | null>(null);
  const [sessions, setSessions] = useState<RepairSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    void refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  async function refreshSessions() {
    try {
      const list = await invoke<RepairSession[]>("list_repair_sessions", {
        connectionId,
        limit: 20,
      });
      setSessions(list);
    } catch {
      // ignore
    }
  }

  const investigation: RepairInvestigation | null = useMemo(() => {
    if (!session?.investigation_json) return null;
    try {
      return JSON.parse(session.investigation_json) as RepairInvestigation;
    } catch {
      return null;
    }
  }, [session]);

  const strategy: RepairStrategy | null = useMemo(() => {
    if (!session?.strategy_json) return null;
    try {
      return JSON.parse(session.strategy_json) as RepairStrategy;
    } catch {
      return null;
    }
  }, [session]);

  const stage = session ? stageFromState(session.state) : 0;

  async function start() {
    if (!goal.trim()) {
      setError("Goal is required.");
      return;
    }
    if (!database) {
      setError("Pick a database.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const scope_tables = scopeInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const s = await invoke<RepairSession>("repair_start", {
        connectionId,
        database,
        scopeTables: scope_tables.length > 0 ? scope_tables : null,
        goal,
      });
      setSession(s);
      setConfirmText("");
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function callStage(cmd: string, extraArgs?: Record<string, unknown>) {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const s = await invoke<RepairSession>(cmd, {
        sessionId: session.id,
        ...extraArgs,
      });
      setSession(s);
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadSession(id: number) {
    setBusy(true);
    setError("");
    try {
      const s = await invoke<RepairSession>("repair_get_session", {
        sessionId: id,
      });
      setSession(s);
      setConfirmText("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function newSession() {
    setSession(null);
    setConfirmText("");
    setError("");
    setGoal("");
    setScopeInput("");
  }

  const subtitle = session
    ? `Session #${session.id} · ${session.database_name} · state=${session.state}`
    : "Goal → Investigate → Propose → Backup → Execute";

  return (
    <AgentPanel
      icon="🛠"
      title="Data Repair"
      subtitle={subtitle}
      actions={
        <div className="flex items-center gap-2">
          {session && (
            <SecondaryButton onClick={newSession} disabled={busy}>
              New session
            </SecondaryButton>
          )}
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Stepper stage={stage} state={session?.state ?? null} />

        {!session && (
          <Card>
            <SectionTitle>1. Describe what to fix</SectionTitle>
            <div className="flex flex-col gap-2">
              <label className="text-[11px] uppercase tracking-wider font-bold text-muted">
                Database
              </label>
              <select
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                disabled={busy || databases.length === 0}
                className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50 max-w-[280px]"
              >
                {databases.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <label className="text-[11px] uppercase tracking-wider font-bold text-muted mt-2">
                Scope tables (optional, comma-separated)
              </label>
              <input
                type="text"
                value={scopeInput}
                onChange={(e) => setScopeInput(e.target.value)}
                placeholder="e.g. users, orders"
                disabled={busy}
                className="h-7 px-2 text-[12px] font-mono bg-panel-2 border border-border rounded-md disabled:opacity-50"
              />
              <label className="text-[11px] uppercase tracking-wider font-bold text-muted mt-2">
                Goal (natural language)
              </label>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Remove duplicate users sharing the same phone, keep the earliest registration."
                disabled={busy}
                rows={3}
                className="px-2 py-1.5 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50 resize-y"
              />
              <div>
                <PrimaryButton onClick={() => void start()} disabled={busy}>
                  {busy ? "Investigating…" : "Start investigation"}
                </PrimaryButton>
              </div>
            </div>
          </Card>
        )}

        {error && <ErrorPre>{error}</ErrorPre>}

        {session && (
          <>
            <GoalCard session={session} />
            {investigation && (
              <InvestigationCard
                investigation={investigation}
                onProposeStrategy={() =>
                  void callStage("repair_propose_strategy")
                }
                canPropose={session.state === "proposing"}
                busy={busy}
              />
            )}
            {strategy && (
              <StrategyCard
                strategy={strategy}
                state={session.state}
                onApprove={() => void callStage("repair_approve_strategy")}
                onCreateBackup={() => void callStage("repair_create_backup")}
                busy={busy}
              />
            )}
            {session.state !== "investigating" &&
              session.state !== "proposing" &&
              session.state !== "awaiting_approval" && (
                <BackupCard session={session} />
              )}
            {(session.state === "awaiting_final" ||
              session.state === "executing") && (
              <ExecuteCard
                session={session}
                strategy={strategy}
                confirmText={confirmText}
                onConfirmTextChange={setConfirmText}
                onExecute={() =>
                  void callStage("repair_execute", { confirmText })
                }
                busy={busy}
              />
            )}
            {(session.state === "done" ||
              session.state === "failed" ||
              session.state === "cancelled") && (
              <TerminalCard session={session} />
            )}
            {!["done", "failed", "cancelled", "executing"].includes(
              session.state,
            ) && (
              <div>
                <SecondaryButton
                  onClick={() => void callStage("repair_cancel")}
                  disabled={busy}
                >
                  Cancel session
                </SecondaryButton>
              </div>
            )}
          </>
        )}

        <SessionsCard
          sessions={sessions}
          activeId={session?.id ?? null}
          onPick={(id) => void loadSession(id)}
        />
      </div>
    </AgentPanel>
  );
}

function Stepper({ stage, state }: { stage: Stage; state: string | null }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {STAGES.map((s, i) => {
        const done = i < stage;
        const active = i === stage;
        const tone: SevTone = done
          ? "ok"
          : active
            ? state === "failed"
              ? "crit"
              : "info"
            : "neutral";
        return (
          <div key={s.id} className="flex items-center gap-2">
            <SevPill tone={tone}>{i + 1}. {s.label}</SevPill>
            {i < STAGES.length - 1 && (
              <span className="text-subtle">→</span>
            )}
          </div>
        );
      })}
      {state && (
        <span className="text-[10.5px] text-subtle ml-2 font-mono">
          state: {state}
        </span>
      )}
    </div>
  );
}

function GoalCard({ session }: { session: RepairSession }) {
  return (
    <Card>
      <SectionTitle>Goal</SectionTitle>
      <div className="text-[12.5px] text-ink-2 whitespace-pre-wrap">
        {session.goal}
      </div>
      <div className="text-[11px] text-muted mt-2">
        Database <code>{session.database_name}</code>
        {session.scope_tables_json &&
          ` · scope: ${session.scope_tables_json
            .replace(/^\[|\]$/g, "")
            .replace(/"/g, "")}`}
      </div>
    </Card>
  );
}

function InvestigationCard({
  investigation,
  onProposeStrategy,
  canPropose,
  busy,
}: {
  investigation: RepairInvestigation;
  onProposeStrategy: () => void;
  canPropose: boolean;
  busy: boolean;
}) {
  return (
    <Card>
      <SectionTitle>
        Investigation ({investigation.queries.length} read-only queries)
      </SectionTitle>
      <div className="flex flex-col gap-2">
        {investigation.queries.map((q, i) => (
          <QueryRow key={i} q={q} idx={i} />
        ))}
      </div>
      {canPropose && (
        <div className="mt-3">
          <PrimaryButton onClick={onProposeStrategy} disabled={busy}>
            {busy ? "Proposing…" : "Ask AI to propose a strategy"}
          </PrimaryButton>
        </div>
      )}
    </Card>
  );
}

function QueryRow({ q, idx }: { q: RepairInvestigationQuery; idx: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-panel-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-start gap-2 px-3 py-2 hover:bg-panel"
      >
        <span className="text-[11px] text-subtle mt-0.5">
          {open ? "▾" : "▸"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-ink font-semibold flex items-center gap-2 flex-wrap">
            <SevPill tone={q.error ? "crit" : "ok"}>
              Q{idx + 1}
            </SevPill>
            <span>{q.purpose}</span>
            <span className="ml-auto text-[10.5px] text-muted tabular-nums">
              {q.row_count} rows{q.truncated && " (truncated)"} · {q.elapsed_ms}ms
            </span>
          </div>
          <pre className="font-mono text-[11px] text-ink-2 whitespace-pre-wrap break-all leading-relaxed mt-1">
            {q.sql}
          </pre>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {q.error ? (
            <div className="text-[11.5px] text-crit">{q.error}</div>
          ) : q.rows.length === 0 ? (
            <div className="text-[11.5px] text-subtle italic">
              No rows returned.
            </div>
          ) : (
            <ResultTable rows={q.rows} />
          )}
        </div>
      )}
    </div>
  );
}

function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows.slice(0, 10)) {
      Object.keys(r).forEach((k) => set.add(k));
    }
    return Array.from(set);
  }, [rows]);
  const shown = rows.slice(0, 20);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono min-w-[640px]">
        <thead>
          <tr className="text-left text-muted">
            {cols.map((c) => (
              <th key={c} className="py-1 pr-3 font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="border-t border-border/60">
              {cols.map((c) => (
                <td key={c} className="py-1 pr-3 text-ink-2">
                  {r[c] === null || r[c] === undefined ? (
                    <span className="text-subtle">null</span>
                  ) : (
                    String(r[c])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div className="text-[10.5px] text-subtle mt-1">
          showing first {shown.length} of {rows.length}
        </div>
      )}
    </div>
  );
}

function StrategyCard({
  strategy,
  state,
  onApprove,
  onCreateBackup,
  busy,
}: {
  strategy: RepairStrategy;
  state: string;
  onApprove: () => void;
  onCreateBackup: () => void;
  busy: boolean;
}) {
  const kindTone: SevTone =
    strategy.kind === "delete" ? "crit" : "warn";
  return (
    <Card>
      <SectionTitle>Proposed strategy</SectionTitle>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <SevPill tone={kindTone}>
          {strategy.kind.toUpperCase()}
        </SevPill>
        <code className="text-[12.5px] font-mono font-semibold text-ink">
          {strategy.target_table}
        </code>
        <SevPill tone="warn">~{strategy.estimated_rows} rows</SevPill>
      </div>
      <div className="text-[12.5px] text-ink-2 leading-relaxed mb-2">
        {strategy.strategy_summary}
      </div>
      <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1 mt-2">
        Final SQL
      </div>
      <pre className="font-mono text-[11.5px] text-ink-2 whitespace-pre-wrap break-all leading-relaxed bg-panel-2 rounded px-2 py-1.5 mb-2">
        {strategy.final_sql}
      </pre>
      <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
        Row-count probe
      </div>
      <pre className="font-mono text-[11px] text-muted whitespace-pre-wrap break-all leading-relaxed bg-panel-2 rounded px-2 py-1.5 mb-2">
        {strategy.count_probe_sql}
      </pre>
      {strategy.risks.length > 0 && (
        <>
          <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
            Risks
          </div>
          <ul className="list-disc pl-5 text-[12px] text-ink-2 leading-relaxed space-y-1 mb-2">
            {strategy.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {state === "awaiting_approval" && (
        <PrimaryButton onClick={onApprove} disabled={busy}>
          {busy ? "Approving…" : "Approve this strategy"}
        </PrimaryButton>
      )}
      {state === "backing_up" && (
        <PrimaryButton onClick={onCreateBackup} disabled={busy}>
          {busy ? "Creating backup…" : "Create backup table"}
        </PrimaryButton>
      )}
    </Card>
  );
}

function BackupCard({ session }: { session: RepairSession }) {
  if (!session.backup_table_name) return null;
  return (
    <Card className="bg-ok-soft border-ok/20">
      <SectionTitle>Backup table created</SectionTitle>
      <div className="text-[12px] text-ink-2">
        Affected rows are copied to:
      </div>
      <code className="text-[13px] font-mono font-bold text-ok mt-1 inline-block">
        {session.database_name}.{session.backup_table_name}
      </code>
      <div className="text-[11px] text-muted mt-2">
        Keep this table until you've verified the repair. To roll back, replay
        these rows back into the original table.
      </div>
    </Card>
  );
}

function ExecuteCard({
  session,
  strategy,
  confirmText,
  onConfirmTextChange,
  onExecute,
  busy,
}: {
  session: RepairSession;
  strategy: RepairStrategy | null;
  confirmText: string;
  onConfirmTextChange: (v: string) => void;
  onExecute: () => void;
  busy: boolean;
}) {
  const ready = confirmText === "CONFIRM" && session.state === "awaiting_final";
  return (
    <Card className="bg-crit-soft border-crit/30">
      <SectionTitle>⚠ Final execute</SectionTitle>
      <div className="text-[12.5px] text-ink-2 mb-2">
        About to {strategy?.kind?.toUpperCase()}{" "}
        <span className="font-mono text-crit font-bold">
          ~{strategy?.estimated_rows ?? "?"} rows
        </span>{" "}
        from <code>{session.database_name}.{strategy?.target_table}</code> in a
        single transaction. Backup is at{" "}
        <code>{session.backup_table_name}</code>.
      </div>
      <pre className="font-mono text-[11.5px] text-ink-2 whitespace-pre-wrap break-all leading-relaxed bg-panel-2 rounded px-2 py-1.5 mb-3">
        {strategy?.final_sql}
      </pre>
      <label className="text-[11px] uppercase tracking-wider font-bold text-muted">
        Type <code className="text-crit">CONFIRM</code> to enable execution
      </label>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => onConfirmTextChange(e.target.value)}
        disabled={busy || session.state !== "awaiting_final"}
        className="h-8 px-2 text-[13px] font-mono bg-panel-2 border border-border rounded-md disabled:opacity-50 w-40 mt-1 mb-3 block"
        placeholder="CONFIRM"
      />
      <button
        type="button"
        onClick={onExecute}
        disabled={!ready || busy}
        className="px-3 h-8 bg-crit text-white text-[12px] font-semibold rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? "Executing…" : "Execute repair"}
      </button>
    </Card>
  );
}

function TerminalCard({ session }: { session: RepairSession }) {
  const tone: SevTone =
    session.state === "done"
      ? "ok"
      : session.state === "cancelled"
        ? "neutral"
        : "crit";
  return (
    <Card>
      <SectionTitle>Result</SectionTitle>
      <div className="flex items-center gap-2 mb-2">
        <SevPill tone={tone}>{session.state.toUpperCase()}</SevPill>
        {session.executed_rows !== null && (
          <span className="text-[12px] text-ink-2">
            {session.executed_rows} row(s) affected
          </span>
        )}
      </div>
      {session.error && (
        <div className="text-[11.5px] text-crit mb-2">{session.error}</div>
      )}
      {session.final_sql && (
        <>
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
            Final SQL
          </div>
          <pre className="font-mono text-[11.5px] text-ink-2 whitespace-pre-wrap break-all leading-relaxed bg-panel-2 rounded px-2 py-1.5 mb-2">
            {session.final_sql}
          </pre>
        </>
      )}
      {session.backup_table_name && (
        <div className="text-[11px] text-muted">
          Backup retained at{" "}
          <code>
            {session.database_name}.{session.backup_table_name}
          </code>
        </div>
      )}
    </Card>
  );
}

function SessionsCard({
  sessions,
  activeId,
  onPick,
}: {
  sessions: RepairSession[];
  activeId: number | null;
  onPick: (id: number) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <Card>
      <SectionTitle>Recent sessions ({sessions.length})</SectionTitle>
      <div className="flex flex-col gap-1">
        {sessions.map((s) => {
          const tone: SevTone =
            s.state === "done"
              ? "ok"
              : s.state === "failed"
                ? "crit"
                : s.state === "cancelled"
                  ? "neutral"
                  : "info";
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              className={`text-left px-2.5 py-1.5 rounded text-[12px] hover:bg-panel ${
                activeId === s.id ? "bg-panel-2 border border-border" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <SevPill tone={tone}>#{s.id}</SevPill>
                <span className="font-mono text-[11px] text-muted">
                  {s.database_name}
                </span>
                <span className="ml-auto text-[10.5px] text-subtle">
                  {s.updated_at}
                </span>
              </div>
              <div className="text-[11.5px] text-ink-2 truncate mt-0.5">
                {s.goal}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
