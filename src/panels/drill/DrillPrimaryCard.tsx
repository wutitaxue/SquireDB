import { Fragment, useState } from "react";
import type { DrillResult } from "../../types";
import { renderCell } from "../../utils";
import { CellViewer, isViewerWorthy } from "../CellViewer";

export function DrillPrimaryCard({ result }: { result: DrillResult }) {
  const [viewerKey, setViewerKey] = useState<string | null>(null);

  if (!result.primary) {
    return (
      <div className="p-3 bg-bg-2 rounded border border-border">
        <strong className="text-[13px]">
          {result.db}.{result.table}
        </strong>
        <div className="text-muted text-[12px] mt-1">
          No record where <code>{result.column}</code> ={" "}
          <code>{String(result.value)}</code>.
        </div>
      </div>
    );
  }

  const entries = Object.entries(result.primary);
  const viewerEntry =
    viewerKey != null ? entries.find(([k]) => k === viewerKey) : null;

  return (
    <div className="p-3 bg-bg-2 rounded border border-border">
      <div className="flex items-center justify-between">
        <strong className="text-[13px]">
          {result.db}.{result.table}
        </strong>
        <span className="text-[11px] text-muted">
          1 row · {result.primary_elapsed_ms}ms
        </span>
      </div>
      <div
        className="grid gap-x-3 gap-y-1 mt-2 text-[12px]"
        style={{ gridTemplateColumns: "180px minmax(0,1fr)" }}
      >
        {entries.map(([k, v]) => {
          const worthy = isViewerWorthy(v);
          return (
            <Fragment key={k}>
              <div className="text-muted truncate" title={k}>
                {k}
              </div>
              <div
                onDoubleClick={() => {
                  if (worthy) setViewerKey(k);
                }}
                className={`relative group font-mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${
                  v === null ? "text-subtle italic" : "text-ink-2"
                } ${worthy ? "cursor-text" : ""}`}
                title={worthy ? "Double-click to open in viewer" : undefined}
              >
                {renderCell(v)}
                {v !== null && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewerKey(k);
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition w-5 h-5 flex items-center justify-center text-[11px] text-muted hover:text-ink bg-panel/90 border border-border rounded"
                    title="Open in viewer"
                  >
                    ⤢
                  </button>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>

      {viewerEntry && (
        <CellViewer
          rowIdx={0}
          colIdx={0}
          rowNumber={1}
          columnName={viewerEntry[0]}
          columnType=""
          schema={result.db}
          table={result.table}
          value={viewerEntry[1]}
          editable={false}
          isPending={false}
          onApply={() => {
            /* drill view is read-only */
          }}
          onClose={() => setViewerKey(null)}
        />
      )}
    </div>
  );
}
