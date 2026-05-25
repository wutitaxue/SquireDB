import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ExplainSqlResponse, IndexRecommendations } from "../types";
import {
  RISK_LABELS,
  SEVERITY_COLORS,
  cellBody,
  cellHead,
  involvedTablesFromAccess,
} from "../utils";
import { IndexRecommendPanel } from "./IndexRecommendPanel";

export function ExplainPanel({
  connectionId,
  sql,
  response,
  defaultDatabase,
  onClose,
  onInjectSql,
}: {
  connectionId: number;
  sql: string;
  response: ExplainSqlResponse;
  defaultDatabase?: string;
  onClose: () => void;
  onInjectSql: (sql: string) => void;
}) {
  const { plan, explanation, ai_error } = response;
  const [showRaw, setShowRaw] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState("");
  const [indexes, setIndexes] = useState<IndexRecommendations | null>(null);

  const involved = useMemo(() => {
    const list = involvedTablesFromAccess(plan.tables);
    if (defaultDatabase) {
      for (const t of list) if (!t.database) t.database = defaultDatabase;
    }
    return list;
  }, [plan.tables, defaultDatabase]);

  const severityKey = (explanation?.severity ?? "ok").toLowerCase();
  const sev = SEVERITY_COLORS[severityKey] ?? SEVERITY_COLORS.ok;

  async function askIndexes() {
    if (indexBusy) return;
    const candidates = involved.filter((t) => t.database && t.table);
    if (candidates.length === 0) {
      setIndexError("Cannot resolve involved tables — please qualify them as db.table in the SQL.");
      return;
    }
    setIndexBusy(true);
    setIndexError("");
    setIndexes(null);
    try {
      const r = await invoke<IndexRecommendations>("recommend_indexes", {
        connectionId,
        sql,
        tables: candidates,
      });
      setIndexes(r);
    } catch (e) {
      setIndexError(String(e));
    } finally {
      setIndexBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid #d0d7de",
        borderRadius: 6,
        padding: 12,
        background: "#fafbfc",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>🔍 Explain</strong>
        <button
          onClick={() => void askIndexes()}
          disabled={indexBusy || involved.length === 0}
          style={{ marginLeft: "auto", fontSize: 12 }}
        >
          {indexBusy ? "Asking AI…" : "🔧 Recommend Indexes"}
        </button>
        <button onClick={onClose} style={{ fontSize: 12 }}>
          Close
        </button>
      </div>

      {explanation && (
        <div
          style={{
            border: `1px solid ${sev.fg}`,
            background: sev.bg,
            color: sev.fg,
            padding: 10,
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                background: sev.fg,
                color: "white",
                padding: "1px 8px",
                borderRadius: 10,
                fontSize: 10,
                fontWeight: 600,
              }}
            >
              {sev.label}
            </span>
            <strong>{explanation.summary}</strong>
          </div>
          <div>
            <strong>Bottleneck: </strong>
            {explanation.bottleneck}
          </div>
          <div>
            <strong>Advice: </strong>
            {explanation.advice}
          </div>
        </div>
      )}
      {!explanation && ai_error && (
        <div
          style={{
            fontSize: 12,
            color: "#a8071a",
            background: "#fdecea",
            padding: 6,
            borderRadius: 4,
          }}
        >
          AI explanation unavailable: {ai_error}
        </div>
      )}

      {plan.risks.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {plan.risks.map((r) => (
            <span
              key={r}
              style={{
                background: "#fff1f0",
                color: "#a8071a",
                border: "1px solid #ffa39e",
                padding: "1px 8px",
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 500,
              }}
            >
              ⚠ {RISK_LABELS[r] ?? r}
            </span>
          ))}
        </div>
      )}

      {plan.tables.length > 0 && (
        <div style={{ overflow: "auto", border: "1px solid #e0e0e0", borderRadius: 4 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={cellHead}>Table</th>
                <th style={cellHead}>Access</th>
                <th style={cellHead}>Key</th>
                <th style={cellHead}>Rows</th>
                <th style={cellHead}>Filtered</th>
                <th style={cellHead}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {plan.tables.map((t, i) => {
                const access = (t.access_type ?? "").toLowerCase();
                const accessColor =
                  access === "all"
                    ? "#a8071a"
                    : access === "index"
                      ? "#ad6800"
                      : access === "ref" || access === "eq_ref" || access === "const"
                        ? "#1e7e34"
                        : "#333";
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={cellBody}>{t.table_name}</td>
                    <td style={{ ...cellBody, color: accessColor, fontWeight: 600 }}>
                      {t.access_type ?? "-"}
                    </td>
                    <td style={cellBody}>{t.key ?? "-"}</td>
                    <td style={cellBody}>{t.rows_examined != null ? t.rows_examined.toFixed(0) : "-"}</td>
                    <td style={cellBody}>{t.filtered != null ? `${t.filtered.toFixed(1)}%` : "-"}</td>
                    <td style={cellBody}>{t.cost != null ? t.cost.toFixed(2) : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <button
        onClick={() => setShowRaw(!showRaw)}
        style={{ alignSelf: "flex-start", fontSize: 11, padding: "2px 8px" }}
      >
        {showRaw ? "▼ Hide raw EXPLAIN JSON" : "▶ Show raw EXPLAIN JSON"}
      </button>
      {showRaw && (
        <pre
          style={{
            margin: 0,
            padding: 8,
            background: "white",
            border: "1px solid #e0e0e0",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "ui-monospace, Menlo, monospace",
            whiteSpace: "pre-wrap",
            maxHeight: 300,
            overflow: "auto",
          }}
        >
          {JSON.stringify(plan.raw_json, null, 2)}
        </pre>
      )}

      {indexError && (
        <pre
          style={{
            margin: 0,
            padding: 6,
            background: "#fdecea",
            color: "#a8071a",
            borderRadius: 4,
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {indexError}
        </pre>
      )}
      {indexes && <IndexRecommendPanel recs={indexes} onInjectSql={onInjectSql} />}
    </div>
  );
}
