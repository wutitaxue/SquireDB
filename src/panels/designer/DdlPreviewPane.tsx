import type { AlterPlan, Risk } from "../../types";
import { copyText } from "../../utils";

type Mode = "edit" | "create";

type Props = {
  mode: Mode;
  /** edit mode: ALTER plan with statements + risks. */
  alterPlan: AlterPlan | null;
  /** create mode: a single CREATE TABLE statement. */
  createSql: string | null;
  /** Validation / generation error to render in place of SQL. */
  error: string | null;
  /** True while regenerating SQL after a structure change. */
  busy: boolean;
  /** Trigger the Apply flow — parent owns the modal. */
  onApply: () => void;
};

function riskBadge(level: Risk["level"]): string {
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

export function DdlPreviewPane({
  mode,
  alterPlan,
  createSql,
  error,
  busy,
  onApply,
}: Props) {
  const sql = mode === "edit" ? alterPlan?.sql ?? "" : createSql ?? "";
  const risks = mode === "edit" ? alterPlan?.risks ?? [] : [];
  const hasSomething = sql.trim().length > 0;

  async function copySql() {
    await copyText(sql);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between h-8 px-3 border-b border-border shrink-0">
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
          DDL preview
        </span>
        <div className="flex items-center gap-2">
          {busy && <span className="text-[10px] text-muted">generating…</span>}
          <button
            type="button"
            onClick={() => void copySql()}
            disabled={!hasSomething}
            className="h-6 px-2 text-[10px] bg-bg-2 hover:bg-bg border border-border rounded text-ink-2 disabled:opacity-50"
            title="Copy SQL"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={!hasSomething || !!error}
            className="h-6 px-3 text-[10px] bg-acc text-white hover:bg-acc/90 border border-acc rounded disabled:opacity-50"
          >
            Apply…
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {risks.length > 0 && (
          <div className="px-3 py-2 border-b border-border space-y-1">
            {risks.map((r, i) => (
              <div
                key={i}
                className={`text-[11px] px-2 py-1 rounded border ${riskBadge(r.level)}`}
              >
                <span className="uppercase font-bold text-[9px] mr-2">
                  {r.level}
                </span>
                {r.message}
              </div>
            ))}
          </div>
        )}
        {error ? (
          <div className="px-3 py-2 text-[11px] text-muted italic">{error}</div>
        ) : (
          <pre className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap text-ink-2">
            {sql || "(no changes)"}
          </pre>
        )}
      </div>
    </div>
  );
}
