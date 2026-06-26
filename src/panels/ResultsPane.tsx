import { forwardRef, memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type {
  ChartConfig,
  ColumnMetaForTree,
  ColumnValue,
  EditTarget,
  ExplainSqlResponse,
  MutationResult,
  QueryResult,
} from "../types";
import { copyText, isImeComposing, parseLookupValue, renderCell } from "../utils";
import {
  EXPORT_FORMAT_META,
  backtick,
  defaultFilename,
  formatResult,
  sqlLiteral,
  type ExportFormat,
} from "../exportResult";
import { ChartPanel } from "./ChartPanel";
import { CellViewer, isViewerWorthy } from "./CellViewer";

const EXPORT_FORMATS: ExportFormat[] = ["csv", "json", "markdown", "sql"];

type ViewKind = "table" | "chart" | "json" | "plan";

type Props = {
  connectionId: number | null;
  result: QueryResult;
  onResultUpdate: (result: QueryResult) => void;
  onRerun: () => void;

  chartConfig: ChartConfig | null;
  chartBusy: boolean;
  chartError: string;
  onAskChart: () => void;
  onChartChange: (cfg: ChartConfig) => void;
  onChartClose: () => void;

  explain: ExplainSqlResponse | null;
  explainBusy: boolean;
  explainError: string;
  onAskExplain: () => void;

  rowLimitNotice?: string;
  /** Subset of view tabs to expose. Defaults to all four. */
  availableViews?: ViewKind[];
  /**
   * If provided, column headers become clickable to inject ORDER BY into the
   * source SQL and rerun. Without this, headers are non-interactive (e.g. for
   * Milvus / Redis where the result isn't backed by a single SQL).
   */
  onSort?: (columnName: string, dir: "asc" | "desc") => void;
  /** Strip any injected ORDER BY and rerun. Powers the third state of the
   * header sort tri-state (none → asc → desc → none). */
  onClearSort?: () => void;
  /** Currently-injected sort, used to render the ▲/▼ indicator. */
  sort?: { column: string; dir: "asc" | "desc" } | null;

  /** Hidden column names (keyed by name, not index, so the set survives
   *  Run wiping the batch). Owned by QueryWorkspace per-tab. */
  hiddenCols?: Set<string>;
  onHiddenColsChange?: (next: Set<string>) => void;

  /** User-dragged column widths, keyed by column name → px. Same lifetime
   *  reasoning as hiddenCols. */
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (next: Record<string, number>) => void;
};

const DEFAULT_VIEWS: ViewKind[] = ["table", "chart", "json", "plan"];

function isNumeric(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "number" && Number.isFinite(v)) return true;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return true;
  return false;
}

function inferColumnTypes(result: QueryResult): boolean[] {
  return result.columns.map((_c, i) => {
    let n = 0;
    let total = 0;
    for (const row of result.rows.slice(0, 50)) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      total += 1;
      if (isNumeric(v)) n += 1;
    }
    return total > 0 && n / total >= 0.8;
  });
}

/** Canonical key for a cell value used by the IDEA-style filter popover and
 *  visibility check. NULL and undefined collapse to the same `__null__` token. */
function cellKey(v: unknown): string {
  if (v === null || v === undefined) return "__null__";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Human display for the filter popover. NULL renders as `(null)`. */
function cellDisplay(v: unknown): string {
  if (v === null || v === undefined) return "(null)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function pkSignature(row: unknown[], pkIndices: number[]): string {
  return pkIndices.map((i) => JSON.stringify(row[i] ?? null)).join("");
}

function pkColumnValues(
  row: unknown[],
  pkIndices: number[],
  columns: { name: string }[],
): ColumnValue[] {
  return pkIndices.map((i) => ({ column: columns[i].name, value: row[i] ?? null }));
}

function ResultsPaneImpl(props: Props) {
  const {
    connectionId,
    result,
    onResultUpdate,
    onRerun,
    chartConfig,
    chartBusy,
    chartError,
    onAskChart,
    onChartChange,
    onChartClose,
    explain,
    explainBusy,
    explainError,
    onAskExplain,
    rowLimitNotice,
    availableViews = DEFAULT_VIEWS,
    onSort,
    onClearSort,
    sort,
  } = props;

  const [view, setView] = useState<ViewKind>("table");

  // If the currently-selected view is not exposed for this result-set
  // (e.g. parent narrowed availableViews from a wider set), fall back to
  // the first available one so the body doesn't render an empty pane.
  useEffect(() => {
    if (!availableViews.includes(view)) {
      setView(availableViews[0] ?? "table");
    }
  }, [availableViews, view]);
  const numericMask = useMemo(() => inferColumnTypes(result), [result]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [insertOpen, setInsertOpen] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [mutationStatus, setMutationStatus] = useState("");
  // Cell edits are buffered locally until the user clicks Save. Key is
  // `${rowIdx}-${colIdx}`, value is the proposed new cell value. The dirty
  // cells are highlighted in the grid; Save batches them into sequential
  // UPDATE calls, Discard drops them all.
  const [pendingEdits, setPendingEdits] = useState<
    Map<string, { rowIdx: number; colIdx: number; value: unknown }>
  >(new Map());
  const [savingEdits, setSavingEdits] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState("");
  const [copyFlash, setCopyFlash] = useState<"insert" | "update" | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  // Column visibility is owned by the parent (QueryWorkspace) per-tab so it
  // survives a Run wiping the previous batch (which momentarily unmounts this
  // component). Fall back to an empty uncontrolled state if the caller doesn't
  // pass it — e.g. drill / agent panes that don't need persistence.
  const [uncontrolledHiddenCols, setUncontrolledHiddenCols] = useState<Set<string>>(new Set());
  const hiddenCols = props.hiddenCols ?? uncontrolledHiddenCols;
  const setHiddenCols = (next: Set<string>) => {
    if (props.onHiddenColsChange) props.onHiddenColsChange(next);
    else setUncontrolledHiddenCols(next);
  };
  // Column widths — same uncontrolled-fallback pattern as hiddenCols.
  const [uncontrolledColumnWidths, setUncontrolledColumnWidths] = useState<Record<string, number>>({});
  const columnWidths = props.columnWidths ?? uncontrolledColumnWidths;
  const setColumnWidths = (next: Record<string, number>) => {
    if (props.onColumnWidthsChange) props.onColumnWidthsChange(next);
    else setUncontrolledColumnWidths(next);
  };
  const [colsOpen, setColsOpen] = useState(false);
  const [colsQuery, setColsQuery] = useState("");
  const colsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!copyFlash) return;
    const t = window.setTimeout(() => setCopyFlash(null), 2000);
    return () => window.clearTimeout(t);
  }, [copyFlash]);

  // Close the export menu on outside click / Escape.
  useEffect(() => {
    if (!exportOpen) return;
    function onDocPointer(e: PointerEvent) {
      if (!exportMenuRef.current) return;
      if (!exportMenuRef.current.contains(e.target as Node)) setExportOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExportOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [exportOpen]);

  useEffect(() => {
    if (!copyOpen) return;
    function onDocPointer(e: PointerEvent) {
      if (!copyMenuRef.current) return;
      if (!copyMenuRef.current.contains(e.target as Node)) setCopyOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCopyOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [copyOpen]);

  useEffect(() => {
    if (!colsOpen) return;
    function onDocPointer(e: PointerEvent) {
      if (!colsMenuRef.current) return;
      if (!colsMenuRef.current.contains(e.target as Node)) setColsOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setColsOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [colsOpen]);

  async function runExport(fmt: ExportFormat) {
    setExportOpen(false);
    setExportError("");
    const meta = EXPORT_FORMAT_META[fmt];
    const hint = result.editable
      ? `${result.editable.schema}.${result.editable.table}`
      : null;
    const path = await saveDialog({
      defaultPath: defaultFilename(fmt, hint),
      filters: [{ name: meta.label, extensions: [meta.ext] }],
    }).catch(() => null);
    if (!path) return;
    setExportBusy(fmt);
    try {
      const text = formatResult(result, fmt);
      await writeTextFile(path, text);
      setMutationStatus(`Exported ${result.rows.length} row(s) as ${meta.label}.`);
      setMutationError("");
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExportBusy(null);
    }
  }

  useEffect(() => {
    setSelected(new Set());
    setMutationError("");
    setMutationStatus("");
    setPendingEdits(new Map());
    // Note: hiddenCols intentionally NOT reset here — column visibility is a
    // user preference that persists across re-runs within the same tab. Stale
    // names from old result schemas are harmless (they just don't match).
  }, [result]);

  function selectView(v: ViewKind) {
    setView(v);
    if (v === "chart" && !chartConfig && !chartBusy && result.rows.length > 0) {
      onAskChart();
    }
    if (v === "plan" && !explain && !explainBusy) {
      onAskExplain();
    }
  }

  const editable = result.editable;
  const pkIndices = useMemo(() => {
    if (!editable) return [] as number[];
    return editable.pk_columns.map((name) =>
      result.columns.findIndex((c) => c.name === name),
    );
  }, [editable, result.columns]);

  function recordEdit(rowIdx: number, colIdx: number, newValue: unknown) {
    if (!editable) return;
    const key = `${rowIdx}-${colIdx}`;
    const original = result.rows[rowIdx][colIdx];
    setPendingEdits((prev) => {
      const next = new Map(prev);
      // Reverting to original removes the pending edit so the cell is no
      // longer highlighted; otherwise it's recorded / overwritten.
      if (JSON.stringify(newValue) === JSON.stringify(original)) {
        next.delete(key);
      } else {
        next.set(key, { rowIdx, colIdx, value: newValue });
      }
      return next;
    });
  }

  function discardEdits() {
    setPendingEdits(new Map());
    setMutationError("");
    setMutationStatus("");
  }

  function revertEdit(rowIdx: number, colIdx: number) {
    const key = `${rowIdx}-${colIdx}`;
    setPendingEdits((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  async function saveEdits() {
    if (!editable || connectionId == null || pendingEdits.size === 0) return;
    setSavingEdits(true);
    setMutationError("");
    const total = pendingEdits.size;
    setMutationStatus(`Saving ${total} change${total > 1 ? "s" : ""}…`);

    const successful: Array<{ rowIdx: number; colIdx: number; value: unknown }> = [];
    const errors: string[] = [];

    // Run UPDATEs sequentially — same connection pool, easier rollback story
    // than fan-out, and the volume is bounded by manual edits.
    for (const edit of pendingEdits.values()) {
      const column = result.columns[edit.colIdx].name;
      const pk = pkColumnValues(result.rows[edit.rowIdx], pkIndices, result.columns);
      try {
        const res = await invoke<MutationResult>("update_cell", {
          connectionId,
          schema: editable.schema,
          table: editable.table,
          pk,
          column,
          value: edit.value,
        });
        if (res.rows_affected === 0) {
          errors.push(`row ${edit.rowIdx + 1} ${column}: 0 rows affected (concurrent edit?)`);
        } else {
          successful.push(edit);
        }
      } catch (e) {
        errors.push(`row ${edit.rowIdx + 1} ${column}: ${e}`);
      }
    }

    if (successful.length > 0) {
      const indexedSuccesses = new Map<number, typeof successful>();
      for (const e of successful) {
        const arr = indexedSuccesses.get(e.rowIdx) ?? [];
        arr.push(e);
        indexedSuccesses.set(e.rowIdx, arr);
      }
      const newRows = result.rows.map((r, i) => {
        const edits = indexedSuccesses.get(i);
        if (!edits) return r;
        const copy = [...r];
        for (const e of edits) copy[e.colIdx] = e.value;
        return copy;
      });
      onResultUpdate({ ...result, rows: newRows });
    }

    setPendingEdits((prev) => {
      const next = new Map(prev);
      for (const e of successful) next.delete(`${e.rowIdx}-${e.colIdx}`);
      return next;
    });

    if (errors.length === 0) {
      setMutationStatus(`Saved ${successful.length} change${successful.length > 1 ? "s" : ""}`);
    } else {
      setMutationError(errors.join("\n"));
      setMutationStatus(
        successful.length > 0
          ? `Saved ${successful.length}, ${errors.length} failed`
          : "",
      );
    }
    setSavingEdits(false);
  }

  async function handleDelete() {
    if (!editable || connectionId == null || selected.size === 0) return;
    const sigToRow = new Map<string, unknown[]>();
    for (const row of result.rows) {
      sigToRow.set(pkSignature(row, pkIndices), row);
    }
    const pks: ColumnValue[][] = [];
    for (const sig of selected) {
      const row = sigToRow.get(sig);
      if (row) pks.push(pkColumnValues(row, pkIndices, result.columns));
    }
    if (pks.length === 0) return;
    const ok = window.confirm(
      `Delete ${pks.length} row${pks.length > 1 ? "s" : ""} from ${editable.schema}.${editable.table}?\n\nThis is permanent.`,
    );
    if (!ok) return;
    setMutationError("");
    setMutationStatus("Deleting…");
    try {
      const res = await invoke<MutationResult>("delete_rows", {
        connectionId,
        schema: editable.schema,
        table: editable.table,
        pks,
      });
      const newRows = result.rows.filter(
        (r) => !selected.has(pkSignature(r, pkIndices)),
      );
      onResultUpdate({ ...result, rows: newRows });
      setSelected(new Set());
      setMutationStatus(`Deleted ${res.rows_affected} row(s)`);
    } catch (e) {
      setMutationError(String(e));
      setMutationStatus("");
    }
  }

  function selectedRowsInOrder(): unknown[][] {
    if (!editable || selected.size === 0) return [];
    return result.rows.filter((r) => selected.has(pkSignature(r, pkIndices)));
  }

  async function handleCopyInsert() {
    if (!editable) return;
    const rows = selectedRowsInOrder();
    if (rows.length === 0) return;
    const tableRef = `${backtick(editable.schema)}.${backtick(editable.table)}`;
    const cols = result.columns.map((c) => backtick(c.name)).join(", ");
    const lines = rows.map((row) => {
      const vals = row.map((cell) => sqlLiteral(cell)).join(", ");
      return `INSERT INTO ${tableRef} (${cols}) VALUES (${vals});`;
    });
    const ok = await copyText(lines.join("\n") + "\n");
    if (ok) {
      setMutationError("");
      setMutationStatus(`✓ Copied ${rows.length} INSERT statement${rows.length > 1 ? "s" : ""} to clipboard`);
      setCopyFlash("insert");
    } else {
      setMutationError("Copy failed: clipboard write was rejected");
    }
  }

  async function handleCopyUpdate() {
    if (!editable) return;
    const rows = selectedRowsInOrder();
    if (rows.length === 0) return;
    if (pkIndices.length === 0 || pkIndices.some((i) => i < 0)) {
      setMutationError("Cannot build UPDATE: primary key columns missing from result set.");
      return;
    }
    const tableRef = `${backtick(editable.schema)}.${backtick(editable.table)}`;
    const pkSet = new Set(pkIndices);
    const setCols = result.columns
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !pkSet.has(i));
    if (setCols.length === 0) {
      setMutationError("Cannot build UPDATE: every column is part of the primary key.");
      return;
    }
    const lines = rows.map((row) => {
      const setClause = setCols
        .map(({ c, i }) => `${backtick(c.name)} = ${sqlLiteral(row[i])}`)
        .join(", ");
      const whereClause = pkIndices
        .map((i) => `${backtick(result.columns[i].name)} = ${sqlLiteral(row[i])}`)
        .join(" AND ");
      return `UPDATE ${tableRef} SET ${setClause} WHERE ${whereClause};`;
    });
    const ok = await copyText(lines.join("\n") + "\n");
    if (ok) {
      setMutationError("");
      setMutationStatus(`✓ Copied ${rows.length} UPDATE statement${rows.length > 1 ? "s" : ""} to clipboard`);
      setCopyFlash("update");
    } else {
      setMutationError("Copy failed: clipboard write was rejected");
    }
  }

  function toggleRowSelection(sig: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sig)) next.delete(sig);
      else next.add(sig);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === result.rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(result.rows.map((r) => pkSignature(r, pkIndices))));
    }
  }

  const totalRows = result.rows_affected ?? result.rows.length;
  const elapsed = result.elapsed_ms;
  const okPip = (
    <span
      className="w-[6px] h-[6px] rounded-full bg-ok shrink-0"
      style={{ boxShadow: "0 0 0 2px rgba(2,122,72,0.12)" }}
    />
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-panel border-t border-border">
      <div className="flex items-center h-9 px-3 gap-3 border-b border-border bg-panel shrink-0 text-[12px]">
        <SegmentedControl
          value={view}
          onChange={selectView}
          options={(
            [
              { value: "table" as ViewKind, label: "Table" },
              {
                value: "chart" as ViewKind,
                label: "Chart",
                disabled: result.rows.length === 0,
              },
              {
                value: "json" as ViewKind,
                label: "JSON",
                disabled: result.rows.length === 0,
              },
              { value: "plan" as ViewKind, label: "Plan" },
            ] as SegOption<ViewKind>[]
          ).filter((o) => availableViews.includes(o.value))}
        />

        <span className="flex items-center gap-2 text-muted">
          {okPip}
          <span className="text-ink-2 font-medium tabular-nums">
            {result.rows.length}
          </span>
          <span>rows</span>
          {result.rows_affected != null && (
            <>
              <span className="text-border-2">·</span>
              <span className="tabular-nums">{result.rows_affected} affected</span>
            </>
          )}
          <span className="text-border-2">·</span>
          <span className="tabular-nums">{elapsed} ms</span>
          {rowLimitNotice && (
            <>
              <span className="text-border-2">·</span>
              <span className="text-warn">{rowLimitNotice}</span>
            </>
          )}
          {editable && (
            <>
              <span className="text-border-2">·</span>
              <span
                className="text-acc font-semibold"
                title={`Editable — single-table SELECT on ${editable.schema}.${editable.table} with PK [${editable.pk_columns.join(", ")}]`}
              >
                editable
              </span>
            </>
          )}
          {(() => {
            // Count only names that exist in current result.columns; stale
            // names from a prior result schema shouldn't inflate the badge.
            const effectiveHidden = result.columns.reduce(
              (n, c) => (hiddenCols.has(c.name) ? n + 1 : n),
              0,
            );
            return (
              effectiveHidden > 0 && (
                <>
                  <span className="text-border-2">·</span>
                  <button
                    onClick={() => setHiddenCols(new Set())}
                    className="text-warn hover:underline"
                    title="Click to show all columns"
                  >
                    {effectiveHidden} column{effectiveHidden > 1 ? "s" : ""} hidden
                  </button>
                </>
              )
            );
          })()}
        </span>

        <div className="flex-1" />

        {editable && view === "table" && (
          <>
            {pendingEdits.size > 0 && (
              <>
                <button
                  onClick={discardEdits}
                  disabled={savingEdits}
                  className="h-6 px-2 text-[11px] font-medium text-ink-2 bg-bg border border-border rounded-md hover:bg-bg-2 disabled:opacity-50 whitespace-nowrap shrink-0"
                  title="Discard all pending edits"
                >
                  Discard
                </button>
                <button
                  onClick={() => void saveEdits()}
                  disabled={savingEdits}
                  className="h-6 px-2.5 text-[11px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                  title="Commit all pending edits to the database"
                >
                  {savingEdits
                    ? "Saving…"
                    : `Save ${pendingEdits.size} change${pendingEdits.size > 1 ? "s" : ""}`}
                </button>
              </>
            )}
            {selected.size > 0 && (
              <>
                <div className="relative shrink-0" ref={copyMenuRef}>
                  <button
                    onClick={() => setCopyOpen((v) => !v)}
                    title="Copy selected rows as SQL"
                    className={`h-6 px-2 text-[11px] font-medium rounded-md border inline-flex items-center gap-1 whitespace-nowrap transition-colors ${
                      copyFlash
                        ? "bg-ok text-white border-ok"
                        : "text-ink-2 bg-bg border-border hover:bg-bg-2"
                    }`}
                  >
                    {copyFlash ? `✓ Copied ${copyFlash === "insert" ? "INSERT" : "UPDATE"}` : "Copy"}
                    {!copyFlash && <span className="text-muted text-[9px]">▾</span>}
                  </button>
                  {copyOpen && (
                    <div className="absolute right-0 top-7 z-20 min-w-[180px] bg-panel border border-border rounded-md shadow-lg py-1">
                      <button
                        onClick={() => {
                          setCopyOpen(false);
                          void handleCopyInsert();
                        }}
                        className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-bg-2 whitespace-nowrap"
                      >
                        Copy as INSERT
                      </button>
                      <button
                        onClick={() => {
                          setCopyOpen(false);
                          void handleCopyUpdate();
                        }}
                        className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-bg-2 whitespace-nowrap"
                        title="SET excludes primary key; WHERE uses primary key"
                      >
                        Copy as UPDATE
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => void handleDelete()}
                  className="h-6 px-2.5 text-[11px] font-semibold text-white bg-crit rounded-md hover:opacity-90 whitespace-nowrap shrink-0"
                >
                  Delete {selected.size} row{selected.size > 1 ? "s" : ""}
                </button>
              </>
            )}
            <button
              onClick={() => setInsertOpen(true)}
              className="h-6 px-2.5 text-[11px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 whitespace-nowrap shrink-0"
            >
              + Insert row
            </button>
          </>
        )}

        {view === "table" && result.columns.length > 0 && (() => {
          const visibleCount = result.columns.reduce(
            (n, c) => (hiddenCols.has(c.name) ? n : n + 1),
            0,
          );
          const someHidden = visibleCount < result.columns.length;
          return (
            <div className="relative" ref={colsMenuRef}>
              <button
                onClick={() => {
                  setColsOpen((v) => !v);
                  setColsQuery("");
                }}
                title="Show / hide columns"
                className={`h-6 px-2 text-[11px] font-medium rounded-md border inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
                  someHidden
                    ? "text-acc bg-acc-soft/40 border-acc/40"
                    : "text-ink-2 bg-bg border-border hover:bg-bg-2"
                }`}
              >
                Columns
                {someHidden && (
                  <span className="tabular-nums">
                    ({visibleCount}/{result.columns.length})
                  </span>
                )}
                <span className="text-muted text-[9px]">▾</span>
              </button>
              {colsOpen && (
                <div className="absolute right-0 top-7 z-30 w-[280px] max-h-[420px] bg-panel border border-border rounded-md shadow-lg flex flex-col">
                  <div className="p-2 border-b border-border shrink-0">
                    <input
                      autoFocus
                      type="text"
                      value={colsQuery}
                      onChange={(e) => setColsQuery(e.target.value)}
                      placeholder="Filter columns…"
                      className="w-full px-2 h-7 text-[11px] bg-bg border border-border rounded outline-none focus:border-acc"
                    />
                    <div className="flex items-center gap-1 mt-1.5">
                      <button
                        onClick={() => setHiddenCols(new Set())}
                        className="flex-1 h-6 px-2 text-[10px] text-ink-2 bg-bg border border-border rounded hover:bg-bg-2"
                      >
                        Show all
                      </button>
                      <button
                        onClick={() => {
                          // Leave the first column visible to avoid an empty grid.
                          const all = new Set<string>();
                          for (let j = 1; j < result.columns.length; j++) {
                            all.add(result.columns[j].name);
                          }
                          setHiddenCols(all);
                        }}
                        className="flex-1 h-6 px-2 text-[10px] text-ink-2 bg-bg border border-border rounded hover:bg-bg-2"
                        title="Hides all except the first column"
                      >
                        Hide all
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto py-1">
                    {result.columns.map((c, j) => {
                      const q = colsQuery.trim().toLowerCase();
                      if (q && !c.name.toLowerCase().includes(q)) return null;
                      const visible = !hiddenCols.has(c.name);
                      const isLastVisible = visible && visibleCount === 1;
                      return (
                        <label
                          key={j}
                          className={`flex items-center gap-2 px-2.5 py-1 text-[11px] hover:bg-bg-2 ${
                            isLastVisible ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
                          }`}
                          title={isLastVisible ? "At least one column must stay visible" : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={visible}
                            disabled={isLastVisible}
                            onChange={(e) => {
                              const next = new Set(hiddenCols);
                              if (e.target.checked) next.delete(c.name);
                              else next.add(c.name);
                              setHiddenCols(next);
                            }}
                            className="cursor-pointer"
                          />
                          <span className="text-ink-2 truncate flex-1">{c.name}</span>
                          <span className="text-subtle font-mono text-[10px] shrink-0">
                            {c.type_name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        <div className="relative" ref={exportMenuRef}>
          <button
            onClick={() => setExportOpen((v) => !v)}
            disabled={result.rows.length === 0 || exportBusy != null}
            title={
              result.rows.length === 0
                ? "Nothing to export"
                : "Export current result set"
            }
            className="h-6 px-2 text-[11px] text-ink-2 bg-bg border border-border rounded-md hover:bg-bg-2 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            {exportBusy ? "Exporting…" : "Export"}
            <span className="text-muted text-[9px]">▾</span>
          </button>
          {exportOpen && (
            <div className="absolute right-0 top-7 z-20 min-w-[160px] bg-panel border border-border rounded-md shadow-lg py-1">
              {EXPORT_FORMATS.map((fmt) => {
                const meta = EXPORT_FORMAT_META[fmt];
                return (
                  <button
                    key={fmt}
                    onClick={() => void runExport(fmt)}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-bg-2 flex items-center justify-between gap-3"
                  >
                    <span>{meta.label}</span>
                    <span className="text-muted text-[10px] font-mono">.{meta.ext}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {(mutationError || mutationStatus || exportError) && (
        <div
          className={`px-3 py-1.5 border-b border-border text-[11px] shrink-0 ${mutationError || exportError ? "bg-crit-soft text-crit" : "bg-acc-soft/40 text-acc-ink"}`}
        >
          {mutationError || exportError || mutationStatus}
        </div>
      )}

      {view === "table" ? (
        // TableView owns its own scroll container so it can virtualize rows
        // against it. Don't wrap it in another overflow-auto — that breaks
        // the virtualizer.
        <TableView
          result={result}
          numericMask={numericMask}
          totalRows={totalRows}
          editable={editable}
          pkIndices={pkIndices}
          selected={selected}
          onToggleRow={toggleRowSelection}
          onToggleAll={toggleAll}
          pendingEdits={pendingEdits}
          onRecordEdit={recordEdit}
          onRevertEdit={revertEdit}
          onSort={onSort}
          onClearSort={onClearSort}
          sort={sort ?? null}
          hiddenCols={hiddenCols}
          columnWidths={columnWidths}
          onColumnWidthsChange={setColumnWidths}
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          {view === "chart" && (
            <ChartView
              result={result}
              chartConfig={chartConfig}
              chartBusy={chartBusy}
              chartError={chartError}
              onChartChange={onChartChange}
              onChartClose={onChartClose}
              onAskChart={onAskChart}
            />
          )}
          {view === "json" && <JsonView result={result} />}
          {view === "plan" && (
            <PlanView
              explain={explain}
              explainBusy={explainBusy}
              explainError={explainError}
              onAskExplain={onAskExplain}
            />
          )}
        </div>
      )}

      {editable && insertOpen && connectionId != null && (
        <InsertRowDialog
          connectionId={connectionId}
          target={editable}
          onClose={() => setInsertOpen(false)}
          onInserted={(msg) => {
            setMutationStatus(msg);
            setMutationError("");
            setInsertOpen(false);
            onRerun();
          }}
          onError={(msg) => {
            setMutationError(msg);
            setMutationStatus("");
          }}
        />
      )}
    </div>
  );
}

/**
 * memo-wrapped: ResultsPane is mounted as soon as a query produces a result
 * and stays mounted while the user edits the SQL above it. Every keystroke
 * in the editor triggers a QueryWorkspace re-render — without memo, this
 * 1200-line component re-renders on every character, which is the typing-lag
 * source. Callers MUST pass stable callback identities (see
 * hooks/useStableCallback) or memo is a no-op.
 */
export const ResultsPane = memo(ResultsPaneImpl);

type SegOption<T> = { value: T; label: string; disabled?: boolean };

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
}) {
  return (
    <div className="flex items-center h-6 p-0.5 bg-bg-2 rounded-md">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            disabled={opt.disabled}
            className={`h-5 px-2.5 text-[11px] font-medium rounded transition ${
              active
                ? "bg-panel text-ink"
                : "text-muted hover:text-ink-2 disabled:text-subtle disabled:cursor-not-allowed disabled:hover:text-subtle"
            }`}
            style={active ? { boxShadow: "var(--sh-1)" } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function TableView({
  result,
  numericMask,
  totalRows,
  editable,
  pkIndices,
  selected,
  onToggleRow,
  onToggleAll,
  pendingEdits,
  onRecordEdit,
  onRevertEdit,
  onSort,
  onClearSort,
  sort,
  hiddenCols,
  columnWidths,
  onColumnWidthsChange,
}: {
  result: QueryResult;
  numericMask: boolean[];
  totalRows: number;
  editable: EditTarget | null;
  pkIndices: number[];
  selected: Set<string>;
  onToggleRow: (sig: string) => void;
  onToggleAll: () => void;
  pendingEdits: Map<string, { rowIdx: number; colIdx: number; value: unknown }>;
  onRecordEdit: (rowIdx: number, colIdx: number, value: unknown) => void;
  onRevertEdit: (rowIdx: number, colIdx: number) => void;
  onSort?: (columnName: string, dir: "asc" | "desc") => void;
  onClearSort?: () => void;
  sort: { column: string; dir: "asc" | "desc" } | null;
  hiddenCols: Set<string>;
  columnWidths: Record<string, number>;
  onColumnWidthsChange: (next: Record<string, number>) => void;
}) {
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [viewer, setViewer] = useState<{ row: number; col: number } | null>(null);
  const [activeCol, setActiveCol] = useState<number | null>(null);
  // Filter is a whitelist of cell value keys per column. Empty set = no filter
  // (show all). Key is the same stringified form used in the popover list, so
  // membership check is O(1).
  const [filters, setFilters] = useState<Record<number, Set<string>>>({});
  const [openFilter, setOpenFilter] = useState<{
    col: number;
    anchorRight: number;
    anchorBottom: number;
  } | null>(null);
  const filterPopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFilters({});
    setActiveCol(null);
    setOpenFilter(null);
  }, [result]);

  useEffect(() => {
    if (openFilter == null) return;
    function onDocPointer(e: PointerEvent) {
      if (!filterPopRef.current) return;
      if (!filterPopRef.current.contains(e.target as Node)) setOpenFilter(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenFilter(null);
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [openFilter]);

  function cycleSort(columnName: string) {
    if (!onSort) return;
    const current = sort?.column === columnName ? sort.dir : null;
    if (current == null) onSort(columnName, "asc");
    else if (current === "asc") onSort(columnName, "desc");
    else onClearSort?.();
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const pkSet = useMemo(() => new Set(pkIndices), [pkIndices]);

  function startEdit(rowIdx: number, colIdx: number) {
    if (!editable) return;
    // If a pending edit exists for this cell, edit on top of that value so
    // re-editing a dirty cell shows the pending text instead of the original.
    const pending = pendingEdits.get(`${rowIdx}-${colIdx}`);
    const cell = pending ? pending.value : result.rows[rowIdx][colIdx];
    setEditing({ row: rowIdx, col: colIdx });
    // Objects / arrays (MySQL JSON columns) must be stringified, not
    // String()-coerced — otherwise the input shows "[object Object]".
    const draftText =
      cell === null
        ? "null"
        : typeof cell === "string"
          ? cell
          : typeof cell === "object"
            ? JSON.stringify(cell)
            : String(cell);
    setDraft(draftText);
  }

  function commitEdit() {
    if (!editing) return;
    const { row, col } = editing;
    const next = parseLookupValue(draft);
    setEditing(null);
    onRecordEdit(row, col, next);
  }

  function cancelEdit() {
    setEditing(null);
  }

  if (result.columns.length === 0) {
    return (
      <div className="px-4 py-3 text-[12px] text-ok flex items-center gap-2">
        <span className="w-[6px] h-[6px] rounded-full bg-ok" />
        OK — query completed with no result set.
      </div>
    );
  }
  if (result.rows.length === 0) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted text-center">
        Empty result set.
      </div>
    );
  }

  // Local view filter: per-column whitelist of cell value keys (IDEA "Local
  // Filter" model). Empty set = no filter on that column. Applies to rendered
  // rows only; result.rows is untouched so selection sigs / pendingEdits keys
  // keep referencing original indices.
  const visibleRows = useMemo(() => {
    const active = Object.entries(filters)
      .map(([k, set]) => [Number(k), set] as const)
      .filter(([, set]) => set.size > 0);
    if (active.length === 0) {
      return result.rows.map((row, originalIdx) => ({ row, originalIdx }));
    }
    const out: Array<{ row: unknown[]; originalIdx: number }> = [];
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      let match = true;
      for (const [col, allowed] of active) {
        if (!allowed.has(cellKey(row[col]))) {
          match = false;
          break;
        }
      }
      if (match) out.push({ row, originalIdx: i });
    }
    return out;
  }, [result.rows, filters]);

  const allSelected = editable && selected.size === result.rows.length;

  // CSS Grid is the single source of truth for column widths — header and
  // every virtualized row use the same template so they line up without any
  // JS measurement. Numeric columns are content-sized; string columns are
  // bounded so a single wide cell doesn't blow out the layout.
  const ROW_H = 32;
  const HEADER_H = 32;
  // IMPORTANT: avoid `auto` / `max-content` / `min-content` track sizes here.
  // The sticky header grid and each virtualized row grid are independent grid
  // instances — any content-dependent track size will be computed locally to
  // each, so a header cell wider than its row data would produce different
  // column widths and visibly misalign the header from the body. Use pure
  // <length> minmax bounds so identical templates render identical tracks.
  const visibleColIndices = useMemo(() => {
    const out: number[] = [];
    for (let j = 0; j < result.columns.length; j++) {
      if (!hiddenCols.has(result.columns[j].name)) out.push(j);
    }
    // Defensive: if a stale `hiddenCols` (e.g. from a previous result schema)
    // would hide every column in the current result, fall back to showing all
    // so the grid isn't empty. The UI checkbox disable already prevents this
    // for in-session toggling, but a result schema change could still trip it.
    if (out.length === 0 && result.columns.length > 0) {
      for (let j = 0; j < result.columns.length; j++) out.push(j);
    }
    return out;
  }, [result.columns, hiddenCols]);

  const gridTemplate = useMemo(() => {
    const cols: string[] = [];
    if (editable) cols.push("36px");
    cols.push("48px"); // row number
    for (const j of visibleColIndices) {
      const name = result.columns[j].name;
      const custom = columnWidths[name];
      if (custom != null) {
        cols.push(`${custom}px`);
      } else {
        cols.push(numericMask[j] ? "minmax(100px, 180px)" : "minmax(140px, 320px)");
      }
    }
    return cols.join(" ");
  }, [editable, numericMask, visibleColIndices, result.columns, columnWidths]);

  // Resize handle drag — captures the header cell's current width at
  // pointerdown so subsequent moves are relative to that, then updates the
  // controlled width map on each move. We bind to window so the drag continues
  // even if the pointer leaves the handle / cell.
  function startResize(e: React.PointerEvent<HTMLDivElement>, colName: string) {
    e.preventDefault();
    e.stopPropagation();
    const headerCell = (e.currentTarget as HTMLElement).parentElement;
    if (!headerCell) return;
    const startX = e.clientX;
    const startWidth = headerCell.getBoundingClientRect().width;
    const baseWidths = columnWidths;
    function onMove(ev: PointerEvent) {
      const next = Math.max(60, Math.min(1200, startWidth + (ev.clientX - startX)));
      onColumnWidthsChange({ ...baseWidths, [colName]: next });
    }
    function onEnd() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    // Lock cursor + suppress text selection during the drag so it feels native.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function resetColumnWidth(colName: string) {
    if (columnWidths[colName] == null) return;
    const next = { ...columnWidths };
    delete next[colName];
    onColumnWidthsChange(next);
  }

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    // Rows live below the sticky header inside the same scroll container.
    // scrollMargin tells the virtualizer to subtract the header height from
    // its position calculations so the first row sits flush under the header.
    scrollMargin: HEADER_H,
  });

  const viewerCell =
    viewer && viewer.row < result.rows.length && viewer.col < result.columns.length
      ? {
          rowIdx: viewer.row,
          colIdx: viewer.col,
          column: result.columns[viewer.col],
          pending: pendingEdits.get(`${viewer.row}-${viewer.col}`),
          original: result.rows[viewer.row][viewer.col],
        }
      : null;

  return (
    <div className="flex-1 min-h-0 relative">
    <div ref={scrollRef} className="absolute inset-0 overflow-auto text-[12px]">
      {/* Width wrapper — without this the sticky header and the absolutely-
          positioned virtual rows both get clipped to the scroll viewport
          width, so any column past the visible area renders with no
          background and broken borders. `min-width: max-content` lets the
          inner block grow as wide as the grid template demands; the scroll
          container then handles horizontal overflow. */}
      <div style={{ minWidth: "max-content", position: "relative" }}>
        {/* Header — sticky inside the scroll container so it scrolls
            horizontally with rows but stays pinned at the top vertically. */}
        <div
          className="sticky top-0 z-10 bg-bg-2 border-b border-border"
          style={{ display: "grid", gridTemplateColumns: gridTemplate, height: HEADER_H }}
        >
          {editable && (
            <div className="flex items-center justify-center px-2 border-r border-border/40">
              <input
                type="checkbox"
                checked={!!allSelected}
                onChange={onToggleAll}
                className="cursor-pointer"
              />
            </div>
          )}
          <div className="flex items-center justify-end px-2 text-[11px] font-semibold text-muted border-r border-border/40 select-none">
            #
          </div>
          {visibleColIndices.map((j) => {
            const c = result.columns[j];
            const sorted = sort?.column === c.name ? sort.dir : null;
            const sortable = !!onSort;
            const filterSet = filters[j];
            const hasFilter = !!filterSet && filterSet.size > 0;
            const isActive = activeCol === j;
            return (
              <div
                key={c.name}
                onClick={() => setActiveCol(j)}
                className={`relative flex items-center px-2 text-[11px] font-semibold text-ink-2 whitespace-nowrap overflow-hidden border-r border-border/40 select-none cursor-pointer ${
                  numericMask[j] ? "justify-end" : "justify-start"
                } ${isActive ? "bg-acc-soft/60" : sorted ? "bg-acc-soft/40" : ""}`}
              >
                <span className="truncate">
                  {pkSet.has(j) && <span className="text-acc mr-1" title="Primary key">🔑</span>}
                  {c.name}
                </span>
                <span className="text-subtle font-mono font-normal ml-1.5 text-[10px] shrink-0">
                  {c.type_name}
                </span>
                <span className="flex-1" />
                {sortable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      cycleSort(c.name);
                    }}
                    title={
                      sorted === "asc"
                        ? "Sorted ascending — click for descending"
                        : sorted === "desc"
                          ? "Sorted descending — click to clear"
                          : "Click to sort ascending (rewrites SQL)"
                    }
                    className={`shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-bg ${
                      sorted ? "text-acc" : "text-subtle hover:text-ink-2"
                    }`}
                  >
                    <svg
                      width="8"
                      height="10"
                      viewBox="0 0 8 10"
                      fill="currentColor"
                      stroke="none"
                    >
                      {sorted === "asc" ? (
                        <path d="M4 1 L7.2 6 H0.8 Z" />
                      ) : sorted === "desc" ? (
                        <path d="M4 9 L0.8 4 H7.2 Z" />
                      ) : (
                        <>
                          <path d="M4 0.6 L7 4 H1 Z" opacity="0.55" />
                          <path d="M4 9.4 L1 6 H7 Z" opacity="0.55" />
                        </>
                      )}
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openFilter?.col === j) {
                      setOpenFilter(null);
                    } else {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setOpenFilter({
                        col: j,
                        anchorRight: rect.right,
                        anchorBottom: rect.bottom,
                      });
                    }
                  }}
                  title={hasFilter ? `Filter: ${filterSet!.size} value(s) selected` : "Filter this column"}
                  className={`w-5 h-5 flex items-center justify-center rounded hover:bg-bg shrink-0 ${
                    hasFilter ? "text-acc" : "text-subtle hover:text-ink-2"
                  }`}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill={hasFilter ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinejoin="round"
                  >
                    <path d="M1 1.5 H9 L6 5.2 V8.5 L4 9.2 V5.2 Z" />
                  </svg>
                </button>
                <div
                  onPointerDown={(e) => startResize(e, c.name)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    resetColumnWidth(c.name);
                  }}
                  title="Drag to resize · double-click to reset"
                  className="group absolute top-0 right-0 h-full w-1.5 cursor-col-resize z-10"
                >
                  <div className="absolute right-0 top-1 bottom-1 w-px bg-transparent group-hover:bg-acc transition-colors" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Virtualized body — only rows inside the viewport (plus overscan)
            are mounted. Total height is reserved so the scroll bar still
            reflects the full dataset. */}
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
        {rowVirtualizer.getVirtualItems().map((virtual) => {
          const visIdx = virtual.index;
          const { row, originalIdx } = visibleRows[visIdx];
          const sig = editable ? pkSignature(row, pkIndices) : "";
          const isSelected = editable && selected.has(sig);
          return (
            <div
              key={originalIdx}
              data-row-index={originalIdx}
              className={`border-b border-border ${
                isSelected ? "bg-acc-soft/30" : "hover:bg-[rgba(0,109,104,0.04)]"
              }`}
              style={{
                position: "absolute",
                top: virtual.start - HEADER_H,
                left: 0,
                right: 0,
                height: virtual.size,
                display: "grid",
                gridTemplateColumns: gridTemplate,
              }}
            >
              {editable && (
                <div className="flex items-center justify-center px-2 border-r border-border/30">
                  <input
                    type="checkbox"
                    checked={!!isSelected}
                    onChange={() => onToggleRow(sig)}
                    className="cursor-pointer"
                  />
                </div>
              )}
              <div className="flex items-center justify-end px-2 text-[11px] text-subtle font-mono tabular-nums select-none border-r border-border/30">
                {visIdx + 1}
              </div>
              {visibleColIndices.map((j) => {
                const cell = row[j];
                const pending = pendingEdits.get(`${originalIdx}-${j}`);
                const displayCell = pending ? pending.value : cell;
                const rendered = renderCell(displayCell);
                const isStringCol = !numericMask[j];
                const isEditing = editing?.row === originalIdx && editing.col === j;
                const isDirty = !!pending;
                const isActiveColCell = activeCol === j;

                if (isEditing) {
                  return (
                    <div key={j} className="px-1 flex items-center bg-acc-soft/40 border-r border-border/30">
                      <input
                        ref={inputRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (isImeComposing(e)) return;
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        className="w-full px-2 h-7 text-[12px] font-mono bg-panel border border-acc rounded outline-none"
                      />
                    </div>
                  );
                }

                const worthy = isViewerWorthy(displayCell);
                return (
                  <div
                    key={j}
                    onClick={() => setActiveCol(j)}
                    onDoubleClick={() => {
                      if (worthy) {
                        setViewer({ row: originalIdx, col: j });
                      } else if (editable) {
                        startEdit(originalIdx, j);
                      }
                    }}
                    className={`relative group flex items-center px-3 font-mono whitespace-nowrap text-[12px] overflow-hidden border-r border-border/30 ${
                      numericMask[j] ? "justify-end tabular-nums" : "justify-start"
                    } ${
                      displayCell === null ? "text-subtle italic" : "text-ink-2"
                    } ${editable || worthy ? "cursor-text" : ""} ${
                      isDirty
                        ? "bg-warn-soft/60 ring-1 ring-warn/40 ring-inset"
                        : isActiveColCell
                          ? "bg-acc-soft/25"
                          : ""
                    }`}
                    title={
                      isDirty
                        ? "Pending change — Save to commit, Discard to revert"
                        : worthy
                          ? "Double-click to open in viewer"
                          : editable
                            ? "Double-click to edit"
                            : undefined
                    }
                  >
                    {isStringCol ? (
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                        {rendered}
                      </span>
                    ) : (
                      rendered
                    )}
                    {displayCell !== null && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewer({ row: originalIdx, col: j });
                        }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition w-5 h-5 flex items-center justify-center text-[11px] text-muted hover:text-ink bg-panel/90 border border-border rounded shadow-1"
                        title="Open in viewer"
                      >
                        ⤢
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        </div>
      </div>

      {(totalRows > result.rows.length || visibleRows.length < result.rows.length) && (
        <div className="px-4 py-2 text-[11px] text-muted italic text-center border-t border-border">
          {visibleRows.length < result.rows.length
            ? `Showing ${visibleRows.length} of ${result.rows.length} rows (filtered${totalRows > result.rows.length ? `, ${totalRows} server-side` : ""})`
            : `Showing ${result.rows.length} of ${totalRows} rows`}
        </div>
      )}
    </div>
      {viewerCell && (
        <CellViewer
          rowIdx={viewerCell.rowIdx}
          colIdx={viewerCell.colIdx}
          rowNumber={viewerCell.rowIdx + 1}
          columnName={viewerCell.column.name}
          columnType={viewerCell.column.type_name}
          schema={editable?.schema}
          table={editable?.table}
          value={viewerCell.pending ? viewerCell.pending.value : viewerCell.original}
          editable={!!editable}
          isPending={!!viewerCell.pending}
          onApply={(r, c, v) => onRecordEdit(r, c, v)}
          onRevert={(r, c) => onRevertEdit(r, c)}
          onClose={() => setViewer(null)}
        />
      )}
      {openFilter &&
        createPortal(
          <FilterPopover
            ref={filterPopRef}
            anchorRight={openFilter.anchorRight}
            anchorBottom={openFilter.anchorBottom}
            columnName={result.columns[openFilter.col].name}
            rows={result.rows}
            colIdx={openFilter.col}
            selected={filters[openFilter.col] ?? null}
            onChange={(next) =>
              setFilters((prev) => {
                const copy = { ...prev };
                // null = "no filter" (back to unfiltered state, Clear button).
                // An empty Set is a legitimate "nothing selected" state — it
                // hides every row and must persist so the user can re-tick
                // values; collapsing it to null would resurrect implicit
                // all-selected and the unchecking would appear to do nothing.
                if (next === null) delete copy[openFilter.col];
                else copy[openFilter.col] = next;
                return copy;
              })
            }
            onClose={() => setOpenFilter(null)}
          />,
          document.body,
        )}
    </div>
  );
}

const FILTER_DISTINCT_CAP = 500;

type FilterPopoverProps = {
  columnName: string;
  rows: unknown[][];
  colIdx: number;
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  onClose: () => void;
  anchorRight: number;
  anchorBottom: number;
};

const FilterPopover = forwardRef<HTMLDivElement, FilterPopoverProps>(
  function FilterPopover(
    { columnName, rows, colIdx, selected, onChange, onClose, anchorRight, anchorBottom },
    ref,
  ) {
    const [search, setSearch] = useState("");

    // Per-column distinct values + frequencies. Capped at FILTER_DISTINCT_CAP;
    // beyond that the popover degrades to a notice (filtering still works on
    // whatever's already selected, the picker just won't enumerate everything).
    const { values, truncated } = useMemo(() => {
      const counts = new Map<string, { display: string; count: number }>();
      let truncatedFlag = false;
      for (const row of rows) {
        const v = row[colIdx];
        const key = cellKey(v);
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          if (counts.size >= FILTER_DISTINCT_CAP) {
            truncatedFlag = true;
            continue;
          }
          counts.set(key, { display: cellDisplay(v), count: 1 });
        }
      }
      const arr = Array.from(counts.entries()).map(([key, v]) => ({
        key,
        display: v.display,
        count: v.count,
      }));
      arr.sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
      return { values: arr, truncated: truncatedFlag };
    }, [rows, colIdx]);

    const filtered = useMemo(() => {
      const q = search.trim().toLowerCase();
      if (!q) return values;
      return values.filter((v) => v.display.toLowerCase().includes(q));
    }, [values, search]);

    // null = "everything checked" implicitly (no filter). Once the user
    // unticks anything we materialize into an explicit Set.
    const checked = selected;

    function isChecked(key: string): boolean {
      return checked === null ? true : checked.has(key);
    }

    function toggle(key: string) {
      const current = checked === null ? new Set(values.map((v) => v.key)) : new Set(checked);
      if (current.has(key)) current.delete(key);
      else current.add(key);
      // Materialize as a Set even if it would equal "all" — explicit state.
      // visibleRows treats size===0 as "match nothing" which is correct here.
      onChange(current);
    }

    const allVisibleChecked = filtered.every((v) => isChecked(v.key));
    function toggleAllVisible() {
      const current = checked === null ? new Set(values.map((v) => v.key)) : new Set(checked);
      if (allVisibleChecked) {
        for (const v of filtered) current.delete(v.key);
      } else {
        for (const v of filtered) current.add(v.key);
      }
      onChange(current);
    }

    const W = 280;
    const H = 360;
    const PAD = 8;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const left = Math.max(PAD, Math.min(anchorRight - W, vw - W - PAD));
    const top = Math.min(anchorBottom + 2, vh - H - PAD);
    return (
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        className="fixed z-50 bg-panel border border-border rounded-md shadow-3 overflow-hidden flex flex-col"
        style={{ left, top, width: W, maxHeight: H }}
      >
        <div className="px-3 py-2 border-b border-border text-[11px] text-ink-2 shrink-0">
          Local Filter For{" "}
          <span className="font-mono text-acc-ink">'{columnName}'</span>
        </div>

        <div className="p-2 border-b border-border shrink-0">
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-subtle text-[11px]">
              🔍
            </span>
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              placeholder="Search…"
              className="w-full h-7 pl-7 pr-2 text-[12px] bg-panel-2 border border-border rounded outline-none focus:border-acc"
            />
          </div>
        </div>

        <div className="grid grid-cols-[20px_1fr_auto] items-center gap-2 px-3 h-7 text-[10px] uppercase tracking-wider font-bold text-muted border-b border-border shrink-0">
          <input
            type="checkbox"
            checked={filtered.length > 0 && allVisibleChecked}
            onChange={toggleAllVisible}
            disabled={filtered.length === 0}
            className="cursor-pointer"
            title="Toggle all visible"
          />
          <span>Value</span>
          <span className="text-right">Count</span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {truncated && (
            <div className="px-3 py-2 text-[11px] text-warn bg-warn-soft/40 border-b border-border">
              Too many distinct values — showing first {FILTER_DISTINCT_CAP}.
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-muted italic text-center">
              No matches.
            </div>
          ) : (
            filtered.map((v) => {
              const isNull = v.key === "__null__";
              return (
                <label
                  key={v.key}
                  className="grid grid-cols-[20px_1fr_auto] items-center gap-2 px-3 h-6 text-[12px] cursor-pointer hover:bg-bg-2"
                >
                  <input
                    type="checkbox"
                    checked={isChecked(v.key)}
                    onChange={() => toggle(v.key)}
                    className="cursor-pointer"
                  />
                  <span
                    className={`font-mono truncate ${isNull ? "italic text-subtle" : "text-ink-2"}`}
                    title={v.display}
                  >
                    {v.display}
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted text-[11px]">
                    {v.count}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-2 px-2 py-2 border-t border-border shrink-0">
          <button
            onClick={() => {
              onChange(null);
              onClose();
            }}
            className="h-6 px-2 text-[11px] text-ink-2 bg-bg border border-border rounded hover:bg-bg-2"
          >
            Clear
          </button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="h-6 px-2.5 text-[11px] font-semibold text-white bg-acc rounded hover:bg-acc-2"
          >
            Done
          </button>
        </div>
      </div>
    );
  },
);

function InsertRowDialog({
  connectionId,
  target,
  onClose,
  onInserted,
  onError,
}: {
  connectionId: number;
  target: EditTarget;
  onClose: () => void;
  onInserted: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [columns, setColumns] = useState<ColumnMetaForTree[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [values, setValues] = useState<Record<string, { use: boolean; text: string }>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    invoke<ColumnMetaForTree[]>("list_columns_meta", {
      connectionId,
      database: target.schema,
      table: target.table,
    })
      .then((cols) => {
        if (cancelled) return;
        setColumns(cols);
        const init: Record<string, { use: boolean; text: string }> = {};
        for (const c of cols) {
          // Skip auto-generated columns by default (PK that's likely auto_increment).
          // Heuristic: integer PK with single PK column → likely auto-increment.
          const autoLikely =
            c.is_primary &&
            target.pk_columns.length === 1 &&
            target.pk_columns[0] === c.name &&
            /int/.test(c.data_type);
          init[c.name] = { use: !autoLikely, text: "" };
        }
        setValues(init);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, target.schema, target.table, target.pk_columns]);

  async function submit() {
    setBusy(true);
    try {
      const payload: ColumnValue[] = [];
      for (const c of columns) {
        const entry = values[c.name];
        if (!entry || !entry.use) continue;
        payload.push({ column: c.name, value: parseLookupValue(entry.text) });
      }
      if (payload.length === 0) {
        onError("At least one column must be provided");
        setBusy(false);
        return;
      }
      const res = await invoke<MutationResult>("insert_row", {
        connectionId,
        schema: target.schema,
        table: target.table,
        values: payload,
      });
      onInserted(
        `Inserted 1 row${res.last_insert_id != null ? ` (id ${res.last_insert_id})` : ""}`,
      );
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-panel border border-border rounded-lg shadow-3 w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center">
          <div className="font-semibold text-ink text-[13px]">
            Insert row into{" "}
            <span className="font-mono text-acc-ink">
              {target.schema}.{target.table}
            </span>
          </div>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="h-6 w-6 text-muted hover:text-ink text-[14px]"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          {loading && (
            <div className="text-[12px] text-muted py-4 text-center">
              Loading columns…
            </div>
          )}
          {loadError && (
            <div className="text-[12px] text-crit bg-crit-soft p-2 rounded">
              {loadError}
            </div>
          )}
          {!loading && !loadError && (
            <div className="space-y-2">
              {columns.map((c) => {
                const entry = values[c.name] ?? { use: true, text: "" };
                return (
                  <div key={c.name} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={entry.use}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [c.name]: { ...entry, use: e.target.checked },
                        }))
                      }
                      className="mt-1.5 cursor-pointer"
                      title="Include this column in INSERT"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 text-[11px]">
                        <span className="font-semibold text-ink-2">
                          {c.is_primary && <span className="text-acc">🔑 </span>}
                          {c.name}
                        </span>
                        <span className="font-mono text-subtle">
                          {c.column_type}
                          {!c.nullable ? " NOT NULL" : ""}
                        </span>
                      </div>
                      <input
                        type="text"
                        value={entry.text}
                        onChange={(e) =>
                          setValues((prev) => ({
                            ...prev,
                            [c.name]: { ...entry, text: e.target.value },
                          }))
                        }
                        disabled={!entry.use}
                        placeholder={
                          c.nullable
                            ? "value (or 'null')"
                            : "value (required)"
                        }
                        className="mt-1 w-full px-2 h-7 text-[12px] font-mono bg-panel-2 border border-border rounded outline-none focus:border-acc disabled:opacity-50"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border flex items-center gap-2">
          <span className="text-[11px] text-muted flex-1">
            Empty text is treated as the literal empty string. Type{" "}
            <code className="font-mono bg-bg-2 px-1 rounded">null</code> for SQL
            NULL.
          </span>
          <button
            onClick={onClose}
            className="h-7 px-3 text-[12px] text-ink-2 bg-bg border border-border rounded-md hover:bg-bg-2"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || loading || !!loadError}
            className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50"
          >
            {busy ? "Inserting…" : "Insert"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChartView({
  result,
  chartConfig,
  chartBusy,
  chartError,
  onChartChange,
  onChartClose,
  onAskChart,
}: {
  result: QueryResult;
  chartConfig: ChartConfig | null;
  chartBusy: boolean;
  chartError: string;
  onChartChange: (cfg: ChartConfig) => void;
  onChartClose: () => void;
  onAskChart: () => void;
}) {
  if (chartBusy) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted text-center">
        AI is recommending a chart…
      </div>
    );
  }
  if (chartError) {
    return (
      <div className="px-4 py-4">
        <pre className="bg-crit-soft text-crit text-[12px] p-3 rounded whitespace-pre-wrap">
          {chartError}
        </pre>
        <button
          onClick={onAskChart}
          className="mt-3 px-3 h-7 text-[12px] bg-acc text-white rounded-md hover:bg-acc-2"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!chartConfig) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted text-center">
        <button
          onClick={onAskChart}
          className="px-3 h-7 text-[12px] bg-acc text-white rounded-md hover:bg-acc-2"
        >
          📊 Suggest a chart
        </button>
      </div>
    );
  }
  return (
    <div className="p-3">
      <ChartPanel
        config={chartConfig}
        result={result}
        onChange={onChartChange}
        onClose={onChartClose}
      />
    </div>
  );
}

function JsonView({ result }: { result: QueryResult }) {
  const objects = result.rows.slice(0, 100).map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((c, j) => {
      obj[c.name] = row[j];
    });
    return obj;
  });
  return (
    <pre className="p-3 text-[11.5px] font-mono text-ink-2 whitespace-pre-wrap">
      {JSON.stringify(objects, null, 2)}
    </pre>
  );
}

function PlanView({
  explain,
  explainBusy,
  explainError,
  onAskExplain,
}: {
  explain: ExplainSqlResponse | null;
  explainBusy: boolean;
  explainError: string;
  onAskExplain: () => void;
}) {
  if (explainBusy) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted text-center">
        Asking MySQL for an execution plan…
      </div>
    );
  }
  if (explainError) {
    return (
      <div className="px-4 py-4">
        <pre className="bg-crit-soft text-crit text-[12px] p-3 rounded whitespace-pre-wrap">
          {explainError}
        </pre>
        <button
          onClick={onAskExplain}
          className="mt-3 px-3 h-7 text-[12px] bg-acc text-white rounded-md hover:bg-acc-2"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!explain) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted text-center">
        <button
          onClick={onAskExplain}
          className="px-3 h-7 text-[12px] bg-acc text-white rounded-md hover:bg-acc-2"
        >
          🔍 Run EXPLAIN
        </button>
      </div>
    );
  }

  const sev = explain.explanation?.severity ?? "ok";
  const sevClass: Record<string, string> = {
    good: "bg-ok-soft text-ok",
    ok: "bg-bg-2 text-ink-2",
    slow: "bg-warn-soft text-warn",
    critical: "bg-crit-soft text-crit",
  };
  return (
    <div className="p-3 space-y-3">
      {explain.explanation && (
        <div className={`p-3 rounded-lg ${sevClass[sev] ?? sevClass.ok}`}>
          <div className="text-[10px] uppercase tracking-wider font-bold mb-1">
            {sev}
          </div>
          <div className="text-[13px] font-semibold mb-1">{explain.explanation.summary}</div>
          <div className="text-[12px] mb-2">
            <span className="font-semibold">Bottleneck:</span>{" "}
            {explain.explanation.bottleneck}
          </div>
          <div className="text-[12px] whitespace-pre-wrap">{explain.explanation.advice}</div>
        </div>
      )}
      {explain.plan.tables.length > 0 && (
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="bg-bg-2">
              <th className="text-left px-2 h-7 text-[11px] font-semibold text-muted border-b border-border">
                Table
              </th>
              <th className="text-left px-2 h-7 text-[11px] font-semibold text-muted border-b border-border">
                Access
              </th>
              <th className="text-left px-2 h-7 text-[11px] font-semibold text-muted border-b border-border">
                Key
              </th>
              <th className="text-right px-2 h-7 text-[11px] font-semibold text-muted border-b border-border">
                Rows
              </th>
              <th className="text-right px-2 h-7 text-[11px] font-semibold text-muted border-b border-border">
                Filtered
              </th>
            </tr>
          </thead>
          <tbody>
            {explain.plan.tables.map((tbl, i) => {
              const isFull = tbl.access_type === "ALL";
              return (
                <tr key={i} className="border-b border-border">
                  <td className="px-2 h-8 font-mono text-ink-2">{tbl.table_name}</td>
                  <td
                    className={`px-2 h-8 font-mono ${isFull ? "text-crit font-semibold" : "text-ink-2"}`}
                  >
                    {tbl.access_type ?? "—"}
                  </td>
                  <td className="px-2 h-8 font-mono text-ink-2">{tbl.key ?? "—"}</td>
                  <td className="px-2 h-8 font-mono text-right tabular-nums text-ink-2">
                    {tbl.rows_examined ?? "—"}
                  </td>
                  <td className="px-2 h-8 font-mono text-right tabular-nums text-ink-2">
                    {tbl.filtered != null ? `${tbl.filtered}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {explain.ai_error && (
        <div className="text-[11px] text-warn">AI note: {explain.ai_error}</div>
      )}
    </div>
  );
}
