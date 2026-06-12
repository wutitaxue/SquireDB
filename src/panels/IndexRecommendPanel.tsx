import type { IndexRecommendations } from "../types";
import { copyText } from "../utils";

export function IndexRecommendPanel({
  recs,
  onInjectSql,
}: {
  recs: IndexRecommendations;
  onInjectSql: (sql: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid #91caff",
        background: "#f0f7ff",
        borderRadius: 4,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>🔧 Index Recommendations</div>
      {recs.expected_benefit && (
        <div style={{ fontSize: 12, color: "#1e7e34" }}>
          <strong>Benefit: </strong>
          {recs.expected_benefit}
        </div>
      )}
      {recs.cost_warning && (
        <div style={{ fontSize: 12, color: "#ad6800" }}>
          <strong>Cost: </strong>
          {recs.cost_warning}
        </div>
      )}
      {recs.recommendations.length === 0 ? (
        <div style={{ fontSize: 12, color: "#666", fontStyle: "italic" }}>
          No new indexes recommended.
        </div>
      ) : (
        recs.recommendations.map((r, i) => (
          <div
            key={i}
            style={{
              background: "white",
              border: "1px solid #d0d7de",
              borderRadius: 4,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              {r.table} ({r.columns.join(", ")}) — {r.index_type}
            </div>
            <div style={{ fontSize: 12, color: "#444" }}>{r.reason}</div>
            <pre
              style={{
                margin: 0,
                padding: 6,
                background: "#fafafa",
                border: "1px solid #eee",
                borderRadius: 3,
                fontSize: 11,
                fontFamily: "ui-monospace, Menlo, monospace",
                whiteSpace: "pre-wrap",
              }}
            >
              {r.alter_sql}
            </pre>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => {
                  void copyText(r.alter_sql);
                }}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                Copy
              </button>
              <button
                onClick={() => onInjectSql(r.alter_sql)}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                Inject to editor
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
