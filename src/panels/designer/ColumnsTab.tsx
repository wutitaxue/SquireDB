import type { ColumnSpec, TableStructure } from "../../types";

const TYPE_HINTS = [
  "BIGINT",
  "BIGINT UNSIGNED",
  "INT",
  "INT UNSIGNED",
  "TINYINT",
  "VARCHAR(255)",
  "VARCHAR(64)",
  "TEXT",
  "DATETIME",
  "TIMESTAMP",
  "DATE",
  "DECIMAL(10,2)",
  "JSON",
  "BOOLEAN",
];

function blankColumn(): ColumnSpec {
  return {
    name: "",
    data_type: "VARCHAR(255)",
    nullable: true,
    default_value: null,
    default_is_expression: false,
    auto_increment: false,
    on_update: null,
    comment: null,
    charset: null,
    collation: null,
  };
}

type Props = {
  structure: TableStructure;
  onChange: (next: TableStructure) => void;
};

export function ColumnsTab({ structure, onChange }: Props) {
  function updateColumn(i: number, patch: Partial<ColumnSpec>) {
    const next = structure.columns.slice();
    next[i] = { ...next[i], ...patch };
    onChange({ ...structure, columns: next });
  }

  function removeColumn(i: number) {
    const next = structure.columns.slice();
    next.splice(i, 1);
    onChange({ ...structure, columns: next });
  }

  function moveColumn(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= structure.columns.length) return;
    const next = structure.columns.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...structure, columns: next });
  }

  function addColumn() {
    onChange({ ...structure, columns: [...structure.columns, blankColumn()] });
  }

  return (
    <div className="flex flex-col h-full">
      <datalist id="ddl-type-hints">
        {TYPE_HINTS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <div className="flex-1 overflow-auto">
        <table className="text-[11px] min-w-[920px] w-full table-fixed">
          <colgroup>
            <col style={{ width: 28 }} />
            <col style={{ width: 160 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 44 }} />
            <col style={{ width: 44 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 140 }} />
            <col />
            <col style={{ width: 72 }} />
          </colgroup>
          <thead className="sticky top-0 bg-bg-2 border-b border-border text-muted uppercase text-[10px]">
            <tr>
              <th className="text-left px-2 py-1"></th>
              <th className="text-left px-2 py-1">Name</th>
              <th className="text-left px-2 py-1">Type</th>
              <th className="text-center px-2 py-1">Null</th>
              <th className="text-center px-2 py-1">AI</th>
              <th className="text-left px-2 py-1">Default</th>
              <th className="text-left px-2 py-1">On update</th>
              <th className="text-left px-2 py-1">Comment</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {structure.columns.map((c, i) => (
              <tr key={i} className="border-b border-border/60 hover:bg-bg/40">
                <td className="px-1 text-center text-muted">{i + 1}</td>
                <td className="px-1">
                  <input
                    type="text"
                    value={c.name}
                    onChange={(e) => updateColumn(i, { name: e.target.value })}
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <input
                    type="text"
                    list="ddl-type-hints"
                    value={c.data_type}
                    onChange={(e) =>
                      updateColumn(i, { data_type: e.target.value })
                    }
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1 text-center">
                  <input
                    type="checkbox"
                    checked={c.nullable}
                    onChange={(e) =>
                      updateColumn(i, { nullable: e.target.checked })
                    }
                  />
                </td>
                <td className="px-1 text-center">
                  <input
                    type="checkbox"
                    checked={c.auto_increment}
                    onChange={(e) =>
                      updateColumn(i, { auto_increment: e.target.checked })
                    }
                  />
                </td>
                <td className="px-1">
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={c.default_value ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateColumn(i, {
                          default_value: v === "" ? null : v,
                        });
                      }}
                      placeholder="—"
                      className="flex-1 h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                    />
                    <label
                      title="Treat default as SQL expression (e.g. CURRENT_TIMESTAMP)"
                      className="flex items-center gap-1 text-[10px] text-muted shrink-0"
                    >
                      <input
                        type="checkbox"
                        checked={c.default_is_expression}
                        onChange={(e) =>
                          updateColumn(i, {
                            default_is_expression: e.target.checked,
                          })
                        }
                      />
                      expr
                    </label>
                  </div>
                </td>
                <td className="px-1">
                  <input
                    type="text"
                    value={c.on_update ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateColumn(i, { on_update: v === "" ? null : v });
                    }}
                    placeholder="—"
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <input
                    type="text"
                    value={c.comment ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateColumn(i, { comment: v === "" ? null : v });
                    }}
                    className="w-full h-6 px-1 bg-bg border border-border rounded text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <div className="flex items-center gap-1 justify-end">
                    <button
                      type="button"
                      onClick={() => moveColumn(i, -1)}
                      title="Move up"
                      className="text-muted hover:text-ink-2 px-1"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => moveColumn(i, 1)}
                      title="Move down"
                      className="text-muted hover:text-ink-2 px-1"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() => removeColumn(i)}
                      title="Remove"
                      className="text-danger hover:text-danger/80 px-1"
                    >
                      ✕
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {structure.columns.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center py-4 text-muted italic">
                  No columns yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={addColumn}
          className="h-7 px-3 text-[11px] bg-bg-2 hover:bg-bg border border-border rounded text-ink-2"
        >
          + Add column
        </button>
      </div>
    </div>
  );
}
