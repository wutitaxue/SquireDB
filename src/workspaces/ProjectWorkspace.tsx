import type {
  DrillNode,
  DrillResult,
  ProjectTable,
} from "../types";
import { isImeComposing } from "../utils";
import { DrillCacheCard } from "../panels/drill/DrillCacheCard";
import { DrillPrimaryCard } from "../panels/drill/DrillPrimaryCard";
import { DrillSection } from "../panels/drill/DrillSection";
import { Card, ErrorPre, PrimaryButton } from "../shell/AgentPanel";

/**
 * Project drill main pane. All state is controlled by the parent
 * (typically `ProjectShell`). This component only renders the lookup
 * form, breadcrumb stack and the drill result.
 */
type Props = {
  lookupTable: ProjectTable | null;
  lookupTableClosed: boolean;
  columns: string[];
  column: string;
  onColumnChange: (c: string) => void;
  value: string;
  onValueChange: (v: string) => void;
  onLookup: () => void;
  busy: boolean;
  error: string;
  result: DrillResult | null;
  breadcrumb: { label: string; isCurrent: boolean; onClick: () => void }[];
  onDrillRow: (node: DrillNode, row: Record<string, unknown>) => void;
  onUnlockConnection: (connId: number) => Promise<void>;
};

export function ProjectWorkspace({
  lookupTable,
  lookupTableClosed,
  columns,
  column,
  onColumnChange,
  value,
  onValueChange,
  onLookup,
  busy,
  error,
  result,
  breadcrumb,
  onDrillRow,
  onUnlockConnection,
}: Props) {
  if (!lookupTable) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        <div className="text-center max-w-md px-6">
          <div className="text-[13px] text-ink-2 mb-1">
            This project has no tables yet.
          </div>
          <div className="text-[11.5px] text-muted">
            Open the title bar Projects ▾ menu and click ✎ to add tables.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-[1100px] mx-auto p-6 flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
              Lookup
            </span>
            <span
              className="font-mono text-[12px] text-ink-2 truncate max-w-[260px]"
              title={`${lookupTable.database_name}.${lookupTable.table_name}`}
            >
              {lookupTable.database_name}.{lookupTable.table_name}
              {lookupTable.is_primary === 1 ? " ★" : ""}
            </span>
            <span className="text-[12px] text-muted">where</span>
            <select
              value={column}
              onChange={(e) => onColumnChange(e.target.value)}
              disabled={columns.length === 0}
              className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md disabled:opacity-50"
            >
              {columns.length === 0 ? (
                <option>
                  {lookupTableClosed ? "(open connection first)" : "(no columns)"}
                </option>
              ) : (
                columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))
              )}
            </select>
            <span className="text-[12px] text-muted">=</span>
            <input
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  onLookup();
                }
              }}
              placeholder="value"
              className="flex-1 min-w-[120px] h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md outline-none focus:border-acc font-mono"
            />
            <PrimaryButton
              onClick={onLookup}
              disabled={busy || !value || columns.length === 0}
            >
              {busy ? "Loading…" : "Lookup ⏎"}
            </PrimaryButton>
          </div>
        </Card>

        {breadcrumb.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap text-[12px]">
            <span className="text-muted">Path:</span>
            {breadcrumb.map((c, i) => (
              <button
                key={i}
                onClick={c.onClick}
                disabled={c.isCurrent}
                className={`px-2 h-6 font-mono text-[11px] rounded-md ${
                  c.isCurrent
                    ? "bg-acc-soft text-acc-ink border border-acc/20"
                    : "bg-panel border border-border text-ink-2 hover:bg-bg-2"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {error && <ErrorPre>{error}</ErrorPre>}

        {result && (
          <>
            <DrillPrimaryCard result={result} />
            {result.cache_results.map((cv) => (
              <DrillCacheCard key={cv.mapping_id} value={cv} />
            ))}
            {result.related.length === 0 ? (
              <Card>
                <div className="text-[13px] text-muted text-center py-3">
                  {result.primary
                    ? "No related sections (this table has no relations in the project)."
                    : "No matching record."}
                </div>
              </Card>
            ) : (
              result.related.map((node) => (
                <DrillSection
                  key={node.relation_id}
                  node={node}
                  lookupConnectionId={result.connection_id}
                  onDrillRow={(row) => onDrillRow(node, row)}
                  onUnlockConnection={(connId) => void onUnlockConnection(connId)}
                />
              ))
            )}
            <div className="text-[11px] text-muted text-right tabular-nums">
              primary {result.primary_elapsed_ms}ms · total {result.total_elapsed_ms}ms
            </div>
          </>
        )}
      </div>
    </div>
  );
}
