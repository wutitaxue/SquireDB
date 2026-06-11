import type { IndexKind, IndexSpec, TableStructure } from "../../types";

const KINDS: { value: IndexKind; label: string }[] = [
  { value: "primary", label: "PRIMARY" },
  { value: "unique", label: "UNIQUE" },
  { value: "index", label: "INDEX" },
  { value: "fulltext", label: "FULLTEXT" },
  { value: "spatial", label: "SPATIAL" },
];

function blankIndex(): IndexSpec {
  return {
    name: "",
    kind: "index",
    columns: [{ name: "", length: null, desc: false }],
    comment: null,
  };
}

type Props = {
  structure: TableStructure;
  onChange: (next: TableStructure) => void;
};

export function IndexesTab({ structure, onChange }: Props) {
  function updateIndex(i: number, patch: Partial<IndexSpec>) {
    const next = structure.indexes.slice();
    next[i] = { ...next[i], ...patch };
    onChange({ ...structure, indexes: next });
  }
  function removeIndex(i: number) {
    const next = structure.indexes.slice();
    next.splice(i, 1);
    onChange({ ...structure, indexes: next });
  }
  function addIndex() {
    onChange({ ...structure, indexes: [...structure.indexes, blankIndex()] });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <table className="text-[11px] min-w-[720px] w-full">
          <thead className="sticky top-0 bg-bg-2 border-b border-border text-muted uppercase text-[10px]">
            <tr>
              <th className="text-left px-2 py-1">Name</th>
              <th className="text-left px-2 py-1 w-28">Kind</th>
              <th className="text-left px-2 py-1">Columns</th>
              <th className="text-left px-2 py-1">Comment</th>
              <th className="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {structure.indexes.map((ix, i) => (
              <tr key={i} className="border-b border-border/60 hover:bg-bg/40">
                <td className="px-1">
                  <input
                    type="text"
                    value={ix.kind === "primary" ? "PRIMARY" : ix.name}
                    disabled={ix.kind === "primary"}
                    onChange={(e) => updateIndex(i, { name: e.target.value })}
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <select
                    value={ix.kind}
                    onChange={(e) =>
                      updateIndex(i, { kind: e.target.value as IndexKind })
                    }
                    className="w-full h-6 px-1 bg-bg border border-border rounded text-[11px]"
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-1">
                  <input
                    type="text"
                    value={ix.columns
                      .map((c) =>
                        c.length ? `${c.name}(${c.length})` : c.name,
                      )
                      .join(", ")}
                    onChange={(e) => {
                      const parts = e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      updateIndex(i, {
                        columns: parts.map((p) => {
                          const m = p.match(/^([^()]+)(?:\((\d+)\))?$/);
                          if (m) {
                            return {
                              name: m[1].trim(),
                              length: m[2] ? Number(m[2]) : null,
                              desc: false,
                            };
                          }
                          return { name: p, length: null, desc: false };
                        }),
                      });
                    }}
                    placeholder="col1, col2(10)"
                    className="w-full h-6 px-1 bg-bg border border-border rounded font-mono text-[11px]"
                  />
                </td>
                <td className="px-1">
                  <input
                    type="text"
                    value={ix.comment ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateIndex(i, { comment: v === "" ? null : v });
                    }}
                    className="w-full h-6 px-1 bg-bg border border-border rounded text-[11px]"
                  />
                </td>
                <td className="px-1 text-right">
                  <button
                    type="button"
                    onClick={() => removeIndex(i)}
                    className="text-danger hover:text-danger/80 px-1"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {structure.indexes.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-4 text-muted italic">
                  No indexes defined.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={addIndex}
          className="h-7 px-3 text-[11px] bg-bg-2 hover:bg-bg border border-border rounded text-ink-2"
        >
          + Add index
        </button>
      </div>
    </div>
  );
}
