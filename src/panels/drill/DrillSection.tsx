import { useState } from "react";
import type { DrillNode } from "../../types";
import { DrillRowTable } from "./DrillRowTable";

export function DrillSection({
  node,
  lookupConnectionId,
  onDrillRow,
  onUnlockConnection,
}: {
  node: DrillNode;
  /** The drill's primary lookup connection_id — used to spot cross-conn nodes */
  lookupConnectionId: number;
  onDrillRow: (row: Record<string, unknown>) => void;
  /** Called when the user clicks "Open connection N" on a missing-connection node */
  onUnlockConnection?: (connId: number) => void;
}) {
  const [expanded, setExpanded] = useState(node.rows.length > 0 && node.rows.length <= 5);
  const [unlocking, setUnlocking] = useState(false);
  const isCrossConn = node.to_connection_id !== lookupConnectionId;
  const errClass = node.missing_connection
    ? "text-warn"
    : node.error
      ? "text-crit"
      : "text-ink-2";

  return (
    <div className="border border-border rounded-md bg-panel">
      <button
        onClick={() => setExpanded((x) => !x)}
        className={`w-full text-left bg-bg-2 px-3 h-9 flex items-center gap-2 ${errClass} hover:brightness-95`}
      >
        <span className="text-[11px]">{expanded ? "▼" : "▶"}</span>
        <span className="font-mono text-[12.5px] font-semibold">
          {node.to_db}.{node.to_table}
        </span>
        {isCrossConn && (
          <span
            className="text-[9px] px-1 bg-acc-soft text-acc-ink rounded font-sans font-bold"
            title={`Cross-connection — lives on connection #${node.to_connection_id}`}
          >
            CONN #{node.to_connection_id}
          </span>
        )}
        <span className="text-[10.5px] text-muted font-mono">{node.cardinality}</span>
        <span className="text-[10.5px] text-muted">
          via <span className="font-mono">{node.from_column}</span> →{" "}
          <span className="font-mono">{node.to_column}</span>
        </span>
        <div className="flex-1" />
        <span className="text-[10.5px] text-muted tabular-nums">
          {node.missing_connection
            ? "needs unlock"
            : node.error
              ? `error · ${node.elapsed_ms}ms`
              : `${node.rows.length}${node.truncated ? "+" : ""} rows · ${node.elapsed_ms}ms`}
        </span>
      </button>
      {expanded && (
        <div className="p-2 overflow-auto">
          {node.missing_connection ? (
            <div className="flex items-center gap-3 p-3 bg-warn-soft text-warn rounded">
              <div className="flex-1 text-[12px]">
                <div className="font-semibold mb-0.5">Cross-connection target locked</div>
                <div className="text-[11.5px]">
                  This section lives on connection{" "}
                  <span className="font-mono font-semibold">
                    #{node.to_connection_id}
                  </span>{" "}
                  which is not currently open.
                </div>
              </div>
              {onUnlockConnection && (
                <button
                  onClick={async () => {
                    setUnlocking(true);
                    try {
                      await Promise.resolve(onUnlockConnection(node.to_connection_id));
                    } finally {
                      setUnlocking(false);
                    }
                  }}
                  disabled={unlocking}
                  className="h-7 px-3 text-[11px] font-semibold text-white bg-warn rounded-md hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
                >
                  {unlocking ? "Opening…" : `Open connection #${node.to_connection_id}`}
                </button>
              )}
            </div>
          ) : node.error ? (
            <pre className="m-0 px-2 py-1.5 text-[12px] text-crit bg-crit-soft rounded whitespace-pre-wrap">
              {node.error}
            </pre>
          ) : node.rows.length === 0 ? (
            <div className="text-[12px] text-muted py-2 text-center">
              No matching rows.
            </div>
          ) : (
            <DrillRowTable rows={node.rows} onDrillRow={onDrillRow} />
          )}
        </div>
      )}
    </div>
  );
}
