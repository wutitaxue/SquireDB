import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AlterPlan,
  ColumnSpec,
  DdlExecResult,
  TableStructure,
} from "../types";
import { ColumnsTab } from "../panels/designer/ColumnsTab";
import { IndexesTab } from "../panels/designer/IndexesTab";
import { ForeignKeysTab } from "../panels/designer/ForeignKeysTab";
import { DdlPreviewPane } from "../panels/designer/DdlPreviewPane";
import { AiAssistantPane } from "../panels/designer/AiAssistantPane";
import { ApplyDdlModal } from "../panels/designer/ApplyDdlModal";

type Tab = "columns" | "indexes" | "foreign-keys";

type Props = {
  connectionId: number;
  database: string;
  /** null = create-new-table mode */
  table: string | null;
  /** Called after a successful DDL execution. Parent should refresh schema and may close this tab. */
  onApplied: (result: DdlExecResult, finalStructure: TableStructure) => void;
};

function emptyStructure(database: string): TableStructure {
  const idCol: ColumnSpec = {
    name: "id",
    data_type: "BIGINT UNSIGNED",
    nullable: false,
    default_value: null,
    default_is_expression: false,
    auto_increment: true,
    on_update: null,
    comment: null,
    charset: null,
    collation: null,
  };
  const createdCol: ColumnSpec = {
    name: "created_at",
    data_type: "DATETIME",
    nullable: false,
    default_value: "CURRENT_TIMESTAMP",
    default_is_expression: true,
    auto_increment: false,
    on_update: null,
    comment: null,
    charset: null,
    collation: null,
  };
  const updatedCol: ColumnSpec = {
    name: "updated_at",
    data_type: "DATETIME",
    nullable: false,
    default_value: "CURRENT_TIMESTAMP",
    default_is_expression: true,
    auto_increment: false,
    on_update: "CURRENT_TIMESTAMP",
    comment: null,
    charset: null,
    collation: null,
  };
  return {
    database,
    table: "",
    engine: "InnoDB",
    charset: "utf8mb4",
    collation: "utf8mb4_0900_ai_ci",
    comment: null,
    columns: [idCol, createdCol, updatedCol],
    indexes: [
      {
        name: "PRIMARY",
        kind: "primary",
        columns: [{ name: "id", length: null, desc: false }],
        comment: null,
      },
    ],
    foreign_keys: [],
  };
}

export function TableDesignerWorkspace({
  connectionId,
  database,
  table,
  onApplied,
}: Props) {
  const mode: "edit" | "create" = table === null ? "create" : "edit";
  const [loading, setLoading] = useState(mode === "edit");
  const [loadError, setLoadError] = useState("");
  const [original, setOriginal] = useState<TableStructure | null>(null);
  const [structure, setStructure] = useState<TableStructure>(() =>
    emptyStructure(database),
  );
  const [activeTab, setActiveTab] = useState<Tab>("columns");

  const [alterPlan, setAlterPlan] = useState<AlterPlan | null>(null);
  const [createSql, setCreateSql] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewSeq = useRef(0);
  const [showApply, setShowApply] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Load on mount (edit mode).
  useEffect(() => {
    if (mode !== "edit" || !table) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    (async () => {
      try {
        const t = await invoke<TableStructure>("get_table_structure", {
          connectionId,
          database,
          table,
        });
        if (cancelled) return;
        setOriginal(t);
        setStructure(t);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, database, table, mode]);

  // Debounced regenerate of preview SQL on structure change.
  useEffect(() => {
    if (loading) return;
    const seq = ++previewSeq.current;
    setPreviewBusy(true);
    const handle = window.setTimeout(async () => {
      try {
        if (mode === "edit" && original) {
          const edit = {
            original,
            modified: structure,
            rename_to:
              structure.table !== original.table ? structure.table : null,
          };
          try {
            const plan = await invoke<AlterPlan>("generate_alter_sql", {
              edit,
            });
            if (seq !== previewSeq.current) return;
            setAlterPlan(plan);
            setCreateSql(null);
            setPreviewError(null);
          } catch (e) {
            const msg = String(e);
            if (seq !== previewSeq.current) return;
            // "No changes" is the typical state, not an error.
            if (msg.toLowerCase().includes("no changes")) {
              setAlterPlan({ statements: [], sql: "", risks: [] });
              setPreviewError("No changes to apply yet.");
            } else {
              setAlterPlan(null);
              setPreviewError(msg);
            }
            setCreateSql(null);
          }
        } else if (mode === "create") {
          try {
            const sql = await invoke<string>("generate_create_sql", {
              spec: structure,
            });
            if (seq !== previewSeq.current) return;
            setCreateSql(sql);
            setAlterPlan(null);
            setPreviewError(null);
          } catch (e) {
            if (seq !== previewSeq.current) return;
            setCreateSql(null);
            setPreviewError(String(e));
          }
        }
      } finally {
        if (seq === previewSeq.current) setPreviewBusy(false);
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [structure, original, mode, loading]);

  const handleApplied = useCallback(
    (result: DdlExecResult) => {
      setShowApply(false);
      onApplied(result, structure);
    },
    [onApplied, structure],
  );

  const sqlForApply =
    mode === "edit" ? alterPlan?.sql ?? "" : createSql ?? "";
  const risksForApply = mode === "edit" ? alterPlan?.risks ?? [] : [];
  const canSave =
    !loading &&
    !previewBusy &&
    !previewError &&
    sqlForApply.trim().length > 0;

  const dirty = useMemo(() => {
    if (mode === "create") return structure.table.length > 0;
    if (!original) return false;
    return JSON.stringify(structure) !== JSON.stringify(original);
  }, [structure, original, mode]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-[12px]">
        Loading table structure…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex-1 flex items-center justify-center text-danger text-[12px] px-6 text-center">
        Failed to load: {loadError}
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: tabs + grid editor */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Primary toolbar: name + dirty + Save */}
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted shrink-0">
            {mode === "create" ? "New" : "Edit"}
          </span>
          <span className="text-[11px] text-muted shrink-0 truncate max-w-[180px]">
            {database}
            {mode === "edit" && original ? ` · ${original.table}` : ""}
          </span>
          <input
            type="text"
            value={structure.table}
            onChange={(e) =>
              setStructure((s) => ({ ...s, table: e.target.value }))
            }
            placeholder={mode === "create" ? "table_name" : "rename to…"}
            className="h-7 px-2 bg-bg border border-border rounded font-mono text-[12px] flex-1 min-w-[160px]"
          />
          <button
            type="button"
            onClick={() => setOptionsOpen((v) => !v)}
            className="h-7 px-2 text-[11px] text-muted hover:text-ink-2 hover:bg-bg-2 rounded shrink-0"
            title="Engine / charset / comment"
          >
            Options {optionsOpen ? "▴" : "▾"}
          </button>
          {dirty && (
            <span className="text-[10px] text-warn shrink-0">● unsaved</span>
          )}
          <button
            type="button"
            onClick={() => setShowApply(true)}
            disabled={!canSave}
            title={
              !canSave
                ? previewError ?? "No changes to save"
                : mode === "create"
                  ? "Create table…"
                  : "Save changes…"
            }
            className={[
              "h-7 px-4 text-[12px] rounded font-semibold shrink-0",
              canSave
                ? "bg-acc text-white hover:bg-acc/90"
                : "bg-bg-2 text-muted cursor-not-allowed",
            ].join(" ")}
          >
            {mode === "create" ? "Create…" : "Save…"}
          </button>
          {!rightOpen && (
            <button
              type="button"
              onClick={() => setRightOpen(true)}
              className="h-7 px-2 text-[11px] text-muted hover:text-ink-2 hover:bg-bg-2 rounded shrink-0"
              title="Show AI assistant + DDL preview"
            >
              ◧ Preview
            </button>
          )}
        </div>

        {optionsOpen && (
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0 flex-wrap bg-bg-2/40">
            <label className="text-[10px] text-muted shrink-0">ENGINE</label>
            <input
              type="text"
              value={structure.engine}
              onChange={(e) =>
                setStructure((s) => ({ ...s, engine: e.target.value }))
              }
              className="h-7 px-2 bg-bg border border-border rounded text-[11px] w-24 shrink-0"
            />
            <label className="text-[10px] text-muted shrink-0 ml-2">CHARSET</label>
            <input
              type="text"
              value={structure.charset}
              onChange={(e) =>
                setStructure((s) => ({ ...s, charset: e.target.value }))
              }
              className="h-7 px-2 bg-bg border border-border rounded text-[11px] w-28 shrink-0"
            />
            <label className="text-[10px] text-muted shrink-0 ml-2">COMMENT</label>
            <input
              type="text"
              value={structure.comment ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setStructure((s) => ({ ...s, comment: v === "" ? null : v }));
              }}
              placeholder="Table comment"
              className="flex-1 min-w-[200px] h-7 px-2 bg-bg border border-border rounded text-[11px]"
            />
          </div>
        )}

        {/* Tab strip */}
        <div className="px-2 border-b border-border shrink-0 flex items-center gap-1 h-9">
          {(
            [
              { id: "columns", label: `Columns (${structure.columns.length})` },
              { id: "indexes", label: `Indexes (${structure.indexes.length})` },
              {
                id: "foreign-keys",
                label: `FKs (${structure.foreign_keys.length})`,
              },
            ] as { id: Tab; label: string }[]
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={[
                "h-7 px-3 text-[11px] rounded",
                activeTab === t.id
                  ? "bg-bg text-ink-2 font-semibold"
                  : "text-muted hover:bg-bg",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0">
          {activeTab === "columns" && (
            <ColumnsTab structure={structure} onChange={setStructure} />
          )}
          {activeTab === "indexes" && (
            <IndexesTab structure={structure} onChange={setStructure} />
          )}
          {activeTab === "foreign-keys" && (
            <ForeignKeysTab structure={structure} onChange={setStructure} />
          )}
        </div>
      </div>

      {/* Right: AI assistant (top) + DDL preview (bottom). Collapsible. */}
      {rightOpen && (
        <div className="w-[340px] shrink-0 flex flex-col border-l border-border relative">
          <button
            type="button"
            onClick={() => setRightOpen(false)}
            title="Hide preview"
            className="absolute top-1 right-1 z-10 w-5 h-5 flex items-center justify-center text-[12px] text-muted hover:text-ink-2 hover:bg-bg-2 rounded"
          >
            ▸
          </button>
          <div className="flex-1 min-h-0 border-b border-border">
            <AiAssistantPane
              mode={mode}
              current={structure}
              database={database}
              onApply={setStructure}
            />
          </div>
          <div className="flex-1 min-h-0">
            <DdlPreviewPane
              mode={mode}
              alterPlan={alterPlan}
              createSql={createSql}
              error={previewError}
              busy={previewBusy}
              onApply={() => setShowApply(true)}
            />
          </div>
        </div>
      )}

      {showApply && canSave && (
        <ApplyDdlModal
          connectionId={connectionId}
          sql={sqlForApply}
          risks={risksForApply}
          title={mode === "create" ? "Create table" : "Apply changes"}
          onClose={() => setShowApply(false)}
          onApplied={handleApplied}
        />
      )}
    </div>
  );
}
