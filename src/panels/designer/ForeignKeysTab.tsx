import type { FkAction, ForeignKeySpec, TableStructure } from "../../types";

const ACTIONS: { value: FkAction; label: string }[] = [
  { value: "no_action", label: "NO ACTION" },
  { value: "restrict", label: "RESTRICT" },
  { value: "cascade", label: "CASCADE" },
  { value: "set_null", label: "SET NULL" },
  { value: "set_default", label: "SET DEFAULT" },
];

function blankFk(): ForeignKeySpec {
  return {
    name: "",
    columns: [""],
    ref_database: null,
    ref_table: "",
    ref_columns: [""],
    on_delete: "no_action",
    on_update: "no_action",
  };
}

type Props = {
  structure: TableStructure;
  onChange: (next: TableStructure) => void;
};

export function ForeignKeysTab({ structure, onChange }: Props) {
  function updateFk(i: number, patch: Partial<ForeignKeySpec>) {
    const next = structure.foreign_keys.slice();
    next[i] = { ...next[i], ...patch };
    onChange({ ...structure, foreign_keys: next });
  }
  function removeFk(i: number) {
    const next = structure.foreign_keys.slice();
    next.splice(i, 1);
    onChange({ ...structure, foreign_keys: next });
  }
  function addFk() {
    onChange({
      ...structure,
      foreign_keys: [...structure.foreign_keys, blankFk()],
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <table className="text-[11px] min-w-[900px] w-full">
          <thead className="sticky top-0 bg-bg-2 border-b border-border text-muted uppercase text-[10px]">
            <tr>
              <th className="text-left px-2 py-1">Name</th>
              <th className="text-left px-2 py-1">Columns</th>
              <th className="text-left px-2 py-1">References</th>
              <th className="text-left px-2 py-1">Ref columns</th>
              <th className="text-left px-2 py-1 w-28">On delete</th>
              <th className="text-left px-2 py-1 w-28">On update</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {structure.foreign_keys.map((f, i) => (
              <tr key={i} className="border-b border-border/60 hover:bg-bg/40">
                <td className="px-1">
                  <input
                    type="text"
                    value={f.name}
                    onChange={(e) => updateFk(i, { name: e.target.value })}
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <input
                    type="text"
                    value={f.columns.join(", ")}
                    onChange={(e) =>
                      updateFk(i, {
                        columns: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="col1, col2"
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={f.ref_database ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateFk(i, { ref_database: v === "" ? null : v });
                      }}
                      placeholder="db"
                      className="w-20 h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                    />
                    <span className="text-muted">.</span>
                    <input
                      type="text"
                      value={f.ref_table}
                      onChange={(e) =>
                        updateFk(i, { ref_table: e.target.value })
                      }
                      placeholder="table"
                      className="flex-1 h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                    />
                  </div>
                </td>
                <td className="px-1">
                  <input
                    type="text"
                    value={f.ref_columns.join(", ")}
                    onChange={(e) =>
                      updateFk(i, {
                        ref_columns: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="id"
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <select
                    value={f.on_delete}
                    onChange={(e) =>
                      updateFk(i, { on_delete: e.target.value as FkAction })
                    }
                    className="w-full h-6 px-1 bg-bg border border-border rounded text-[11px]"
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-1">
                  <select
                    value={f.on_update}
                    onChange={(e) =>
                      updateFk(i, { on_update: e.target.value as FkAction })
                    }
                    className="w-full h-6 px-1 bg-bg border border-border rounded text-[11px]"
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-1 text-right">
                  <button
                    type="button"
                    onClick={() => removeFk(i)}
                    className="text-danger hover:text-danger/80 px-1"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {structure.foreign_keys.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-4 text-muted italic">
                  No foreign keys.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={addFk}
          className="h-7 px-3 text-[11px] bg-bg-2 hover:bg-bg border border-border rounded text-ink-2"
        >
          + Add foreign key
        </button>
      </div>
    </div>
  );
}
