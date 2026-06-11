import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  connectionId: number;
  database: string;
  table: string;
  onClose: () => void;
  onDropped: () => void;
};

export function DropTableModal({
  connectionId,
  database,
  table,
  onClose,
  onDropped,
}: Props) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const armed = token === table;

  async function execute() {
    if (!armed || busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("drop_table", {
        connectionId,
        database,
        table,
        confirmToken: token,
      });
      onDropped();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50">
      <div className="bg-panel border border-border rounded-md shadow-xl w-[480px] max-w-[92vw] p-5">
        <div className="text-[13px] font-semibold text-danger mb-2">
          🗑 Drop table
        </div>
        <div className="text-[12px] text-ink-2 mb-3">
          You are about to permanently drop{" "}
          <span className="font-mono text-danger">
            {database}.{table}
          </span>
          . This cannot be undone.
        </div>
        <div className="rounded border border-danger-soft bg-danger/5 px-3 py-2 mb-3 text-[11px] text-danger">
          MySQL DDL is implicitly committed. There is no rollback once executed.
        </div>
        <label className="block text-[11px] text-muted mb-1">
          Type{" "}
          <span className="font-mono text-ink-2 select-text">{table}</span> to
          confirm:
        </label>
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
          disabled={busy}
          className="w-full h-8 px-2 bg-bg border border-border rounded text-[12px] font-mono"
          placeholder={table}
        />
        {error && (
          <div className="mt-2 text-[11px] text-danger break-words">{error}</div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-8 px-3 text-[12px] text-ink-2 hover:bg-bg rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void execute()}
            disabled={!armed || busy}
            className={[
              "h-8 px-3 text-[12px] rounded",
              armed && !busy
                ? "bg-danger text-white hover:bg-danger/90"
                : "bg-bg-2 text-muted cursor-not-allowed",
            ].join(" ")}
          >
            {busy ? "Dropping…" : "Drop table"}
          </button>
        </div>
      </div>
    </div>
  );
}
