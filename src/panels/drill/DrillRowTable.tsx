import { cellBody, cellHead, renderCell } from "../../utils";

export function DrillRowTable({
  rows,
  onDrillRow,
}: {
  rows: Record<string, unknown>[];
  onDrillRow: (row: Record<string, unknown>) => void;
}) {
  const cols = Object.keys(rows[0] ?? {});
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr style={{ background: "#fafafa" }}>
          <th style={cellHead}></th>
          {cols.map((c) => (
            <th key={c} style={cellHead}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
            <td style={cellBody}>
              <button
                onClick={() => onDrillRow(r)}
                title="Drill into this row's relations"
                style={{ fontSize: 11, padding: "1px 6px" }}
              >
                →
              </button>
            </td>
            {cols.map((c) => (
              <td
                key={c}
                style={{
                  ...cellBody,
                  fontFamily: "ui-monospace, Menlo, monospace",
                  color: r[c] === null ? "#999" : "inherit",
                }}
              >
                {renderCell(r[c])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
