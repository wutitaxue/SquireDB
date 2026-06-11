import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DdlExecResult, Risk } from "../../types";

type Props = {
  connectionId: number;
  sql: string;
  risks: Risk[];
  /** Title shown in the modal — "Apply changes" / "Create table". */
  title: string;
  onClose: () => void;
  onApplied: (result: DdlExecResult) => void;
};

function riskClasses(level: Risk["level"]): string {
  switch (level) {
    case "critical":
      return "bg-danger/15 text-danger border-danger/40";
    case "warn":
      return "bg-warn-soft text-warn border-warn/30";
    case "info":
    default:
      return "bg-bg text-muted border-border";
  }
}

export function ApplyDdlModal({
  connectionId,
  sql,
  risks,
  title,
  onClose,
  onApplied,
}: Props) {
  const [token, setToken] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const armed = token === "CONFIRM";

  async function execute() {
    if (!armed || running) return;
    setRunning(true);
    setError("");
    try {
      const res = await invoke<DdlExecResult>("execute_ddl", {
        connectionId,
        sql,
      });
      onApplied(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-panel border border-border rounded-md shadow-xl w-[640px] max-w-[95vw] max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0">
          <div className="text-[13px] font-semibold text-ink-2">{title}</div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="text-muted hover:text-ink-2 text-[14px]"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3 space-y-3">
          {risks.length > 0 && (
            <div className="space-y-1">
              {risks.map((r, i) => (
                <div
                  key={i}
                  className={`text-[11px] px-2 py-1 rounded border ${riskClasses(r.level)}`}
                >
                  <span className="uppercase font-bold text-[9px] mr-2">
                    {r.level}
                  </span>
                  {r.message}
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
              SQL to execute
            </div>
            <pre className="px-3 py-2 bg-bg border border-border rounded text-[11px] font-mono whitespace-pre-wrap text-ink-2 max-h-[280px] overflow-auto">
              {sql}
            </pre>
          </div>
        </div>

        <div className="border-t border-border px-5 py-3 space-y-2 shrink-0">
          <div className="text-[11px] text-ink-2">
            Type{" "}
            <span className="font-mono text-acc-ink select-text">CONFIRM</span>{" "}
            to execute.
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
              placeholder="CONFIRM"
              disabled={running}
              className="flex-1 h-8 px-2 bg-bg border border-border rounded font-mono text-[12px]"
            />
            <button
              type="button"
              onClick={onClose}
              disabled={running}
              className="h-8 px-3 text-[12px] text-muted hover:text-ink-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void execute()}
              disabled={!armed || running}
              className={[
                "h-8 px-4 text-[12px] rounded",
                armed && !running
                  ? "bg-acc text-white hover:bg-acc/90"
                  : "bg-bg-2 text-muted cursor-not-allowed",
              ].join(" ")}
            >
              {running ? "Executing…" : "Execute"}
            </button>
          </div>
          {error && (
            <div className="text-[11px] text-danger break-words">{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}
