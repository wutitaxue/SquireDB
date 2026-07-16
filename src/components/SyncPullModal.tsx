import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AdditionCounts,
  RestoreReport,
  SyncConflict,
  SyncPullPreview,
  SyncResolution,
} from "../types";

type ResolutionChoice = "overwrite" | "rename" | "skip";

const KIND_LABEL: Record<string, string> = {
  connection: "🔌 连接",
  project: "📁 项目",
  project_table: "📋 项目表",
  project_relation: "🔗 项目关系",
  schema_relation: "🔗 表关系",
  saved_query: "💾 保存的查询",
  ai_model: "🤖 AI 模型",
  embedding_model: "🧬 Embedding 模型",
  mcp_settings: "⚙ MCP 设置",
  setting: "⚙ 设置",
};

const ADDITION_ROWS: { key: keyof AdditionCounts; label: string }[] = [
  { key: "connections", label: "连接" },
  { key: "projects", label: "项目" },
  { key: "project_tables", label: "项目表" },
  { key: "project_relations", label: "项目关系" },
  { key: "schema_relations", label: "表关系" },
  { key: "saved_queries", label: "保存的查询" },
  { key: "ai_models", label: "AI 模型" },
  { key: "embedding_models", label: "Embedding 模型" },
  { key: "mcp_settings", label: "MCP 设置" },
  { key: "settings", label: "设置" },
];

function conflictKey(c: SyncConflict): string {
  return `${c.kind}:${c.local_key}`;
}

function defaultRenameFor(c: SyncConflict, fromDevice: string): string {
  // local_key may be composite ("conn|db|tbl"); take the trailing segment as a name base.
  const base = c.local_key.split("|").pop() ?? c.local_key;
  return `${base}-from-${fromDevice}`;
}

export function SyncPullModal({
  preview,
  onClose,
  onApplied,
  onError,
}: {
  preview: SyncPullPreview;
  onClose: () => void;
  onApplied: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { conflict_report, meta, device_name, snapshot } = preview;
  const conflicts = conflict_report.conflicts;

  const [choices, setChoices] = useState<Record<string, ResolutionChoice>>(() => {
    const init: Record<string, ResolutionChoice> = {};
    for (const c of conflicts) init[conflictKey(c)] = "overwrite";
    return init;
  });
  const [renames, setRenames] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of conflicts) {
      if (c.supports_rename) init[conflictKey(c)] = defaultRenameFor(c, device_name);
    }
    return init;
  });
  const [busy, setBusy] = useState(false);

  const additionTotal = useMemo(
    () =>
      ADDITION_ROWS.reduce(
        (sum, r) => sum + (conflict_report.additions[r.key] ?? 0),
        0,
      ),
    [conflict_report],
  );

  function setChoice(key: string, choice: ResolutionChoice) {
    setChoices((prev) => ({ ...prev, [key]: choice }));
  }

  function bulkSet(choice: ResolutionChoice) {
    setChoices((prev) => {
      const next = { ...prev };
      for (const c of conflicts) {
        if (choice === "rename" && !c.supports_rename) continue;
        next[conflictKey(c)] = choice;
      }
      return next;
    });
  }

  async function apply() {
    // Build ResolutionMap
    const entries: Record<string, SyncResolution> = {};
    for (const c of conflicts) {
      const key = conflictKey(c);
      const choice = choices[key] ?? "overwrite";
      if (choice === "overwrite") {
        entries[key] = { type: "Overwrite" };
      } else if (choice === "skip") {
        entries[key] = { type: "Skip" };
      } else {
        const newName = (renames[key] ?? "").trim();
        if (!newName) {
          onError(`「${c.local_key}」的改名不能为空。`);
          return;
        }
        entries[key] = { type: "KeepBothRename", new_name: newName };
      }
    }

    setBusy(true);
    try {
      const report = await invoke<RestoreReport>("sync_apply_pull", {
        deviceName: device_name,
        snapshot,
        resolutions: { entries },
      });
      onApplied(summarize(report, device_name));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{ background: "rgba(20,20,15,0.4)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-panel border border-border rounded-lg w-[720px] max-w-[94vw] max-h-[88vh] flex flex-col"
        style={{ boxShadow: "var(--sh-3)" }}
      >
        <div className="flex items-center justify-between px-4 h-10 border-b border-border shrink-0">
          <div className="text-[13px] font-semibold text-ink">
            Pull 来自「{device_name}」
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 text-muted hover:text-ink hover:bg-bg-2 rounded flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto p-4 flex flex-col gap-4">
          {/* Source meta */}
          <div className="text-[11px] text-muted">
            导出时间 {new Date(meta.exported_at).toLocaleString()} · App v
            {meta.app_version} · protocol v{meta.protocol_version}
          </div>

          {/* Additions */}
          <div className="flex flex-col gap-1.5">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
              新增（无冲突，将直接写入）
            </div>
            {additionTotal === 0 ? (
              <div className="text-[12px] text-muted">无新增项。</div>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink">
                {ADDITION_ROWS.filter(
                  (r) => (conflict_report.additions[r.key] ?? 0) > 0,
                ).map((r) => (
                  <span key={r.key}>
                    {r.label}{" "}
                    <span className="text-ok font-semibold">
                      +{conflict_report.additions[r.key]}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Conflicts */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
                冲突（{conflicts.length} 条需要你决定）
              </div>
              {conflicts.length > 0 && (
                <div className="flex items-center gap-1">
                  <BulkBtn onClick={() => bulkSet("overwrite")}>全部覆盖</BulkBtn>
                  <BulkBtn onClick={() => bulkSet("rename")}>全部改名</BulkBtn>
                  <BulkBtn onClick={() => bulkSet("skip")}>全部跳过</BulkBtn>
                </div>
              )}
            </div>

            {conflicts.length === 0 ? (
              <div className="text-[12px] text-muted">无冲突，可直接应用。</div>
            ) : (
              <div className="flex flex-col gap-2">
                {conflicts.map((c) => {
                  const key = conflictKey(c);
                  const choice = choices[key] ?? "overwrite";
                  return (
                    <div
                      key={key}
                      className="border border-border rounded p-2.5 flex flex-col gap-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[12px] text-ink font-medium">
                            {KIND_LABEL[c.kind] ?? c.kind}{" "}
                            <span className="font-mono text-[11px] text-ink-2">
                              {c.local_key}
                            </span>
                          </div>
                          <ul className="mt-1 flex flex-col gap-0.5">
                            {c.diff_lines.map((line, i) => (
                              <li
                                key={i}
                                className="text-[11px] text-warn font-mono break-all"
                              >
                                {line}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="flex flex-col gap-1 shrink-0">
                          <RadioRow
                            name={key}
                            checked={choice === "overwrite"}
                            onChange={() => setChoice(key, "overwrite")}
                            label="覆盖"
                          />
                          {c.supports_rename && (
                            <RadioRow
                              name={key}
                              checked={choice === "rename"}
                              onChange={() => setChoice(key, "rename")}
                              label="改名保留"
                            />
                          )}
                          <RadioRow
                            name={key}
                            checked={choice === "skip"}
                            onChange={() => setChoice(key, "skip")}
                            label="跳过"
                          />
                        </div>
                      </div>
                      {choice === "rename" && c.supports_rename && (
                        <input
                          value={renames[key] ?? ""}
                          onChange={(e) =>
                            setRenames((prev) => ({
                              ...prev,
                              [key]: e.target.value,
                            }))
                          }
                          className="form-input text-[11px] font-mono"
                          placeholder="新名称"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border shrink-0">
          <div className="text-[11px] text-subtle">
            应用前会先在本地自动备份当前数据库。
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-7 px-3 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy}
              className="h-7 px-3 text-[12px] font-medium text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50"
            >
              {busy ? "应用中…" : "应用并 Pull"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BulkBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-6 px-2 text-[10.5px] text-ink-2 bg-panel border border-border rounded hover:bg-bg-2"
    >
      {children}
    </button>
  );
}

function RadioRow({
  name,
  checked,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer select-none">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="w-3 h-3 accent-acc cursor-pointer"
      />
      <span className="text-[11px] text-ink whitespace-nowrap">{label}</span>
    </label>
  );
}

function summarize(report: RestoreReport, device: string): string {
  const sum = (m: Record<string, number>) =>
    Object.values(m).reduce((a, b) => a + b, 0);
  const ins = sum(report.inserted);
  const ovr = sum(report.overwritten);
  const ren = sum(report.renamed);
  const skp = sum(report.skipped);
  let msg = `已从「${device}」同步：新增 ${ins} · 覆盖 ${ovr} · 改名 ${ren} · 跳过 ${skp}。`;
  if (report.warnings.length > 0) {
    msg += `\n${report.warnings.length} 条警告：\n${report.warnings.join("\n")}`;
  }
  return msg;
}
