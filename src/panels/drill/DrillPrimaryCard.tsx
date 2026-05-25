import { Fragment } from "react";
import type { DrillResult } from "../../types";
import { renderCell } from "../../utils";

export function DrillPrimaryCard({ result }: { result: DrillResult }) {
  if (!result.primary) {
    return (
      <div style={{ padding: 10, background: "#fafafa", borderRadius: 4 }}>
        <strong style={{ fontSize: 13 }}>
          {result.db}.{result.table}
        </strong>
        <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
          No record where <code>{result.column}</code> = <code>{String(result.value)}</code>.
        </div>
      </div>
    );
  }
  const entries = Object.entries(result.primary);
  return (
    <div
      style={{
        padding: 12,
        background: "#fafafa",
        border: "1px solid #e0e0e0",
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>
          {result.db}.{result.table}
        </strong>
        <span style={{ fontSize: 11, color: "#888" }}>1 row · {result.primary_elapsed_ms}ms</span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "180px 1fr",
          gap: 4,
          marginTop: 8,
          fontSize: 12,
        }}
      >
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <div style={{ color: "#666" }}>{k}</div>
            <div style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{renderCell(v)}</div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
