import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DeadlockLockEntry,
  DeadlockResponse,
  DeadlockTransaction,
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
  onClose: () => void;
};

export function DeadlockWorkspace({ connectionId, onClose }: Props) {
  const [response, setResponse] = useState<DeadlockResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [includeAi, setIncludeAi] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);

  async function run() {
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      const r = await invoke<DeadlockResponse>("analyze_deadlock", {
        connectionId,
        includeAi,
      });
      setResponse(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const subtitle = response
    ? response.has_deadlock
      ? `Detected at ${response.report?.detected_at ?? "unknown"} · victim: TX(${response.report?.victim_slot ?? "?"})`
      : "No deadlock recorded since server start"
    : "Read LATEST DETECTED DEADLOCK from InnoDB status";

  return (
    <AgentPanel
      icon="🔒"
      title="Deadlock Analysis"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-[12px] text-muted flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={includeAi}
              onChange={(e) => setIncludeAi(e.target.checked)}
            />
            Include AI root-cause analysis
          </label>
          <PrimaryButton onClick={() => void run()} disabled={loading}>
            {loading ? "Reading…" : response ? "Re-scan" : "Scan now"}
          </PrimaryButton>
          {response && (
            <span className="text-[11px] text-muted">
              Status raw: {response.status_chars.toLocaleString()} chars
              {response.status_truncated && " · truncated"}
            </span>
          )}
        </div>
        {error && <ErrorPre>{error}</ErrorPre>}
      </Card>

      {response && !response.has_deadlock && (
        <Card>
          <SectionTitle>No deadlock</SectionTitle>
          <div className="text-[12px] text-muted whitespace-pre-line">
            {response.message ?? "InnoDB has no LATEST DETECTED DEADLOCK section."}
          </div>
          <div className="mt-2 text-[11px] text-muted">
            InnoDB only retains the most recent deadlock; if you missed it, enable{" "}
            <code className="font-mono">innodb_print_all_deadlocks=ON</code> so future ones are
            logged to the MySQL error log.
          </div>
        </Card>
      )}

      {response?.has_deadlock && response.report && (
        <>
          {response.ai_error && !response.ai_analysis && (
            <Card className="bg-warn-soft border-warn/20">
              <SectionTitle>AI analysis unavailable</SectionTitle>
              <div className="text-[12px] text-warn">{response.ai_error}</div>
            </Card>
          )}

          {response.ai_analysis && (
            <Card>
              <div className="flex items-center gap-2 mb-1.5">
                <SectionTitle>AI root cause</SectionTitle>
                <SevPill tone="crit">deadlock</SevPill>
              </div>
              <div className="text-[12px] mb-2">{response.ai_analysis.summary}</div>
              <div className="text-[12px] mb-2">
                <span className="text-muted">Conflict cycle: </span>
                {response.ai_analysis.conflict_cycle}
              </div>
              <div className="text-[12px] mb-2">
                <span className="text-muted">Root cause: </span>
                {response.ai_analysis.root_cause}
              </div>
              {response.ai_analysis.recommendations.length > 0 && (
                <>
                  <div className="text-[11px] uppercase tracking-wider text-muted mt-2 mb-1">
                    Recommendations
                  </div>
                  <ol className="text-[12px] list-decimal pl-5 space-y-1">
                    {response.ai_analysis.recommendations.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ol>
                </>
              )}
            </Card>
          )}

          <Card>
            <SectionTitle>Transactions</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {response.report.transactions.map((tx) => (
                <TransactionCard key={tx.slot} tx={tx} />
              ))}
            </div>
          </Card>

          <Card>
            <details open={rawOpen} onToggle={(e) => setRawOpen((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-[12px] text-muted">
                Raw LATEST DETECTED DEADLOCK section ({response.report.raw_section.length} chars)
              </summary>
              <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap max-h-[400px] overflow-auto">
                {response.report.raw_section}
              </pre>
            </details>
          </Card>
        </>
      )}
    </AgentPanel>
  );
}

function TransactionCard({ tx }: { tx: DeadlockTransaction }) {
  const headerTone: SevTone = tx.victim ? "crit" : "warn";
  return (
    <div className="border border-border rounded p-2.5 bg-bg-2">
      <div className="flex items-center gap-2 mb-2">
        <SevPill tone={headerTone}>
          TX ({tx.slot}){tx.victim ? " · ROLLED BACK" : ""}
        </SevPill>
        {tx.txn_id && (
          <span className="text-[11px] font-mono text-muted">id={tx.txn_id}</span>
        )}
        {tx.mysql_thread_id != null && (
          <span className="text-[11px] font-mono text-muted">
            thread={tx.mysql_thread_id}
          </span>
        )}
        {tx.query_started_seconds_ago != null && (
          <span className="text-[11px] text-muted">
            running {tx.query_started_seconds_ago}s
          </span>
        )}
      </div>

      {tx.user_host && (
        <div className="text-[11px] text-muted font-mono mb-1">{tx.user_host}</div>
      )}

      {tx.statement && (
        <div className="mb-2">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
            Statement
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap bg-bg p-2 rounded border border-border max-h-[160px] overflow-auto">
            {tx.statement}
          </pre>
        </div>
      )}

      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Locks</div>
      {tx.locks.length === 0 ? (
        <div className="text-[11px] text-muted">No lock entries parsed.</div>
      ) : (
        <div className="space-y-2">
          {tx.locks.map((l, i) => (
            <LockRow key={i} lock={l} />
          ))}
        </div>
      )}
    </div>
  );
}

function LockRow({ lock }: { lock: DeadlockLockEntry }) {
  const tone: SevTone = lock.state === "waiting" ? "crit" : "info";
  const stateLabel = lock.state === "waiting" ? "WAITING" : "HOLDING";
  const target = [lock.database, lock.table].filter(Boolean).join(".") || "?";
  return (
    <div className="text-[11px] font-mono leading-relaxed">
      <div className="flex items-center gap-2 mb-0.5">
        <SevPill tone={tone}>{stateLabel}</SevPill>
        <span>{target}</span>
        {lock.index && (
          <span className="text-muted">
            · idx <span className="text-fg">{lock.index}</span>
          </span>
        )}
        {lock.gap && <SevPill tone="warn">gap</SevPill>}
      </div>
      {lock.mode && (
        <div className="text-muted pl-3">mode: {lock.mode}</div>
      )}
      {lock.record_text && (
        <pre className="pl-3 text-muted text-[10.5px] whitespace-pre-wrap max-h-[80px] overflow-auto">
          {lock.record_text}
        </pre>
      )}
    </div>
  );
}
