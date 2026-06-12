import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedQuery } from "../types";

type Props = {
  connectionId: number;
  sql: string;
  /** When set, edits an existing saved query instead of creating a new one. */
  existing?: SavedQuery | null;
  /** Initial name hint when creating new (typically derived from SQL). */
  defaultName?: string;
  onClose: () => void;
  onSaved: (q: SavedQuery) => void;
};

export function SaveQueryModal({
  connectionId,
  sql,
  existing,
  defaultName,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(existing?.name ?? defaultName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const q = existing
        ? await invoke<SavedQuery>("update_saved_query", {
            id: existing.id,
            name: trimmed,
            sql,
          })
        : await invoke<SavedQuery>("save_query", {
            connectionId,
            name: trimmed,
            sql,
          });
      onSaved(q);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const verbing = existing ? "Updating…" : "Saving…";
  const verbDone = existing ? "Update" : "Save";

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/50">
      <div className="bg-panel border border-border rounded-md shadow-xl w-[440px] max-w-[92vw] p-5">
        <div className="text-[13px] font-semibold text-ink mb-3">
          {existing ? "✎ Rename saved query" : "⭐ Save query"}
        </div>
        <label className="block text-[11px] text-muted mb-1">Name</label>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          disabled={busy}
          className="w-full h-8 px-2 bg-bg border border-border rounded text-[12px]"
          placeholder="Top customers by revenue"
        />
        {!existing && (
          <div className="mt-3 text-[11px] text-muted">
            Saved per connection — visible from the sidebar's
            <span className="text-ink-2"> Saved queries</span> section.
          </div>
        )}
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
            onClick={() => void submit()}
            disabled={!name.trim() || busy}
            className={[
              "h-8 px-3 text-[12px] rounded",
              name.trim() && !busy
                ? "bg-acc text-white hover:bg-acc-2"
                : "bg-bg-2 text-muted cursor-not-allowed",
            ].join(" ")}
          >
            {busy ? verbing : verbDone}
          </button>
        </div>
      </div>
    </div>
  );
}
