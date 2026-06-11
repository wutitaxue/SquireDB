import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  TableCreateProposal,
  TableEditProposal,
  TableStructure,
} from "../../types";

type Mode = "edit" | "create";

type Props = {
  mode: Mode;
  /** Current structure (used as input for edit suggestions). */
  current: TableStructure;
  /** Database scoping (used for create mode prompt). */
  database: string;
  /** Apply the proposal to the designer. */
  onApply: (next: TableStructure) => void;
};

export function AiAssistantPane({ mode, current, database, onApply }: Props) {
  const [nl, setNl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [proposed, setProposed] = useState<TableStructure | null>(null);

  async function suggest() {
    if (busy || nl.trim().length === 0) return;
    setBusy(true);
    setError("");
    setProposed(null);
    setSummary("");
    try {
      if (mode === "edit") {
        const res = await invoke<TableEditProposal>("ai_table_edit", {
          current,
          instruction: nl,
        });
        setProposed(res.modified);
        setSummary(res.summary);
      } else {
        const res = await invoke<TableCreateProposal>("ai_create_table", {
          database,
          instruction: nl,
        });
        setProposed(res.structure);
        setSummary(res.summary);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!proposed) return;
    onApply(proposed);
    setProposed(null);
    setSummary("");
    setNl("");
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center h-8 px-3 border-b border-border shrink-0 gap-2">
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
          🤖 AI Assistant
        </span>
      </div>

      <div className="flex-1 overflow-auto px-3 py-3 space-y-3">
        <div>
          <label className="block text-[11px] text-muted mb-1">
            {mode === "edit"
              ? "Describe the change in natural language"
              : "Describe the new table"}
          </label>
          <textarea
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            disabled={busy}
            rows={4}
            placeholder={
              mode === "edit"
                ? "e.g. 把 email 改成 varchar(320) 并加唯一索引"
                : "e.g. orders 表：用户 id、商品 id、数量、金额、状态、创建时间"
            }
            className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[12px] resize-none"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => void suggest()}
              disabled={busy || nl.trim().length === 0}
              className="h-7 px-3 text-[11px] bg-acc text-white hover:bg-acc/90 rounded disabled:opacity-50"
            >
              {busy ? "Thinking…" : "Suggest"}
            </button>
          </div>
        </div>

        {error && (
          <div className="text-[11px] text-danger break-words">{error}</div>
        )}

        {summary && (
          <div className="text-[11px] text-ink-2 px-2 py-1.5 bg-bg-2 rounded border border-border">
            {summary}
          </div>
        )}

        {proposed && (
          <div className="border border-border rounded">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider font-bold text-muted bg-bg-2 border-b border-border">
              Proposed structure preview
            </div>
            <div className="px-2 py-1.5 text-[11px] space-y-1 max-h-[200px] overflow-auto">
              <div>
                <span className="text-muted">columns:</span>{" "}
                <span className="font-mono">{proposed.columns.length}</span>
              </div>
              <ul className="font-mono text-[10px] text-ink-2 space-y-0.5">
                {proposed.columns.map((c) => (
                  <li key={c.name} className="truncate">
                    {c.name} {c.data_type}
                    {c.nullable ? "" : " NOT NULL"}
                  </li>
                ))}
              </ul>
              {proposed.indexes.length > 0 && (
                <div className="mt-1">
                  <span className="text-muted">indexes:</span>{" "}
                  <span className="font-mono">{proposed.indexes.length}</span>
                </div>
              )}
              {proposed.foreign_keys.length > 0 && (
                <div className="mt-1">
                  <span className="text-muted">fks:</span>{" "}
                  <span className="font-mono">
                    {proposed.foreign_keys.length}
                  </span>
                </div>
              )}
            </div>
            <div className="px-2 py-1.5 flex justify-end gap-1 border-t border-border">
              <button
                type="button"
                onClick={() => {
                  setProposed(null);
                  setSummary("");
                }}
                className="h-6 px-2 text-[10px] text-muted hover:text-ink-2"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={apply}
                className="h-6 px-2 text-[10px] bg-acc text-white hover:bg-acc/90 rounded"
              >
                Apply to designer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
