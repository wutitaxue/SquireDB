import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Connection,
  MilvusCollectionDescription,
  MilvusField,
  MilvusQueryResponse,
  MilvusSearchResponse,
  QueryResult,
} from "../types";
import { ResultsPane } from "../panels/ResultsPane";

type Mode = "vector" | "filter";
type VectorInputMode = "text" | "json";

/**
 * Build a "match everything" filter expression suitable for previewing
 * the first N rows of a collection. Milvus's `query` endpoint requires
 * a filter — it has no "scan all" form — so we synthesize a tautology
 * against the primary-key field:
 *   VARCHAR pk  → `<pk> like "%"`
 *   numeric pk  → `<pk> >= 0`
 * Returns null when no primary key can be detected.
 */
function buildScanAllFilter(desc: MilvusCollectionDescription): string | null {
  const pk = desc.fields.find((f) => f.is_primary);
  if (!pk) return null;
  const t = pk.data_type.toUpperCase();
  if (t.includes("VARCHAR") || t.includes("STRING")) {
    return `${pk.name} like "%"`;
  }
  return `${pk.name} >= 0`;
}

type Props = {
  conn: Connection;
  collection: string;
  /** Active Milvus database. */
  db: string;
  /** Optional preloaded schema; fetched on mount if absent. */
  description: MilvusCollectionDescription | null;
  onDescriptionLoaded?: (d: MilvusCollectionDescription) => void;
};

export function MilvusSearchWorkspace({
  conn,
  collection,
  db,
  description,
  onDescriptionLoaded,
}: Props) {
  const [desc, setDesc] = useState<MilvusCollectionDescription | null>(description);
  const [descLoading, setDescLoading] = useState(false);
  const [descError, setDescError] = useState("");

  // Default to filter+limit-100 so opening a collection mirrors MySQL's
  // `SELECT * FROM t LIMIT 100` preview.
  const [mode, setMode] = useState<Mode>("filter");
  const [filter, setFilter] = useState("");
  const [outputFields, setOutputFields] = useState("");
  const [limit, setLimit] = useState(100);

  // Vector mode
  // `vectorInputMode === "text"`: user types natural language; on Run the
  // backend embed_text command turns it into a vector via the configured
  // embeddings provider. `"json"` keeps the raw paste-a-vector flow for
  // power users who already have a vector in hand.
  const [vectorInputMode, setVectorInputMode] = useState<VectorInputMode>("text");
  const [queryText, setQueryText] = useState("");
  const [vectorText, setVectorText] = useState("");
  const [annsField, setAnnsField] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const autoPreviewedRef = useRef(false);

  // Fetch schema if the parent didn't preload it.
  useEffect(() => {
    if (description) {
      setDesc(description);
      return;
    }
    if (conn.id == null) return;
    setDescLoading(true);
    setDescError("");
    void invoke<MilvusCollectionDescription>("milvus_describe_collection", {
      id: conn.id,
      collection,
      db,
    })
      .then((d) => {
        setDesc(d);
        onDescriptionLoaded?.(d);
      })
      .catch((e) => setDescError(String(e)))
      .finally(() => setDescLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, collection, db]);

  const vectorFields = useMemo<MilvusField[]>(
    () => (desc?.fields ?? []).filter((f) => f.data_type.toUpperCase().includes("VECTOR")),
    [desc],
  );

  // Auto-pick the first vector field once schema arrives.
  useEffect(() => {
    if (!annsField && vectorFields.length > 0) {
      setAnnsField(vectorFields[0].name);
    }
  }, [vectorFields, annsField]);

  // Auto-preview the first N rows once we know the schema — parity with
  // MySQL's `SELECT * LIMIT 100` on table click. Runs at most once per tab.
  useEffect(() => {
    if (autoPreviewedRef.current) return;
    if (!desc || conn.id == null) return;
    const f = buildScanAllFilter(desc);
    if (!f) return;
    autoPreviewedRef.current = true;
    setFilter(f);
    void runQuery(f, 100, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desc, conn.id]);

  async function runQuery(
    filterExpr: string,
    lim: number,
    outFields: string[] | null,
  ) {
    if (conn.id == null) return;
    setBusy(true);
    setError("");
    setResult(null);
    const started = performance.now();
    try {
      const res = await invoke<MilvusQueryResponse>("milvus_query", {
        id: conn.id,
        collection,
        filter: filterExpr,
        outputFields: outFields,
        limit: lim,
        db,
      });
      setResult(queryResponseToResult(res, desc, performance.now() - started));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(
    vec: number[],
    anns: string | null,
    lim: number,
    filterExpr: string | null,
    outFields: string[] | null,
  ) {
    if (conn.id == null) return;
    setBusy(true);
    setError("");
    setResult(null);
    const started = performance.now();
    try {
      const res = await invoke<MilvusSearchResponse>("milvus_search", {
        id: conn.id,
        collection,
        vector: vec,
        annsField: anns,
        limit: lim,
        filter: filterExpr,
        outputFields: outFields,
        db,
      });
      setResult(searchResponseToResult(res, performance.now() - started));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (conn.id == null) return;
    setError("");
    const ofRaw = outputFields
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const of: string[] | null = ofRaw.length > 0 ? ofRaw : null;

    if (mode === "vector") {
      let vec: number[];
      if (vectorInputMode === "text") {
        const t = queryText.trim();
        if (!t) {
          setError("Query text is required.");
          return;
        }
        setBusy(true);
        setResult(null);
        try {
          vec = await invoke<number[]>("embed_text", { text: t });
        } catch (e) {
          setBusy(false);
          setError(String(e));
          return;
        }
        // busy stays true; runSearch flips it false when search completes
      } else {
        try {
          vec = parseVector(vectorText);
        } catch (e) {
          setError(String(e));
          return;
        }
      }
      await runSearch(vec, annsField || null, limit, filter.trim() || null, of);
    } else {
      if (!filter.trim()) {
        setError("Filter expression is required.");
        return;
      }
      await runQuery(filter.trim(), limit, of);
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-4 py-2 flex items-center gap-3 bg-bg-2">
        <div className="text-[13px] font-semibold text-ink">{collection}</div>
        {desc?.row_count != null && (
          <div className="text-[11px] text-muted">
            {desc.row_count.toLocaleString()} rows
          </div>
        )}
        {descLoading && <div className="text-[11px] text-muted">loading schema…</div>}
        {descError && <div className="text-[11px] text-crit">{descError}</div>}
      </div>

      {/* Mode tabs + Run */}
      <div className="shrink-0 border-b border-border px-4 py-2 flex items-center gap-2">
        <ModeTab
          label="Filter Query"
          sub="scalar only"
          active={mode === "filter"}
          onClick={() => setMode("filter")}
        />
        <ModeTab
          label="Vector Search"
          sub="ANN top-K"
          active={mode === "vector"}
          onClick={() => setMode("vector")}
        />
        <div className="flex-1" />
        <button
          onClick={run}
          disabled={busy || conn.id == null}
          className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Running…" : "▶ Run"}
        </button>
      </div>

      {/* Form */}
      <div className="shrink-0 border-b border-border px-4 py-3 flex flex-col gap-3 bg-panel">
        {mode === "vector" && (
          <>
            <FormRow label="Vector field" hint="ANN target column">
              <select
                value={annsField}
                onChange={(e) => setAnnsField(e.target.value)}
                className="form-input"
              >
                <option value="">(auto-detect)</option>
                {vectorFields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name} · {f.data_type}
                    {f.dim != null ? `(${f.dim})` : ""}
                  </option>
                ))}
              </select>
            </FormRow>

            <div className="flex items-center gap-1.5">
              <InputModePill
                label="Text"
                active={vectorInputMode === "text"}
                onClick={() => setVectorInputMode("text")}
              />
              <InputModePill
                label="Raw JSON"
                active={vectorInputMode === "json"}
                onClick={() => setVectorInputMode("json")}
              />
              <span className="text-[10.5px] text-subtle ml-1">
                {vectorInputMode === "text"
                  ? "embed via the configured embeddings provider"
                  : "paste a pre-computed vector"}
              </span>
            </div>

            {vectorInputMode === "text" ? (
              <FormRow label="Query text" hint="natural language">
                <textarea
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  placeholder="e.g. red running shoes with cushioned sole"
                  rows={3}
                  className="form-input text-[12px] resize-y"
                />
              </FormRow>
            ) : (
              <FormRow label="Query vector" hint="JSON array of numbers">
                <textarea
                  value={vectorText}
                  onChange={(e) => setVectorText(e.target.value)}
                  placeholder="[0.1, -0.2, 0.3, ...]"
                  rows={3}
                  className="form-input font-mono text-[11px] resize-y"
                />
              </FormRow>
            )}
          </>
        )}

        <FormRow
          label="Filter expression"
          hint={
            mode === "vector" ? "scalar filter, optional" : "required, e.g. id > 1000"
          }
        >
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder='e.g. category == "books" and price < 100'
            className="form-input font-mono text-[11.5px]"
          />
        </FormRow>

        <div className="flex gap-3">
          <div className="flex-1">
            <FormRow label="Output fields" hint="comma-separated, blank = all">
              <input
                value={outputFields}
                onChange={(e) => setOutputFields(e.target.value)}
                placeholder="id, title, category"
                className="form-input font-mono text-[11.5px]"
              />
            </FormRow>
          </div>
          <div className="w-[120px]">
            <FormRow label={mode === "vector" ? "Top K" : "Limit"}>
              <input
                type="number"
                min={1}
                max={10000}
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value || "10", 10))}
                className="form-input no-spin"
              />
            </FormRow>
          </div>
        </div>
      </div>

      {/* Results — reuses the SQL ResultsPane shell (Table / JSON only). */}
      <div className="flex-1 min-h-0 flex flex-col">
        {error && (
          <pre className="m-3 p-3 bg-crit-soft text-crit text-[11.5px] rounded whitespace-pre-wrap font-mono">
            {error}
          </pre>
        )}
        {!error && result && (
          <ResultsPane
            connectionId={conn.id}
            result={result}
            onResultUpdate={setResult}
            onRerun={() => void run()}
            chartConfig={null}
            chartBusy={false}
            chartError=""
            onAskChart={() => {}}
            onChartChange={() => {}}
            onChartClose={() => {}}
            explain={null}
            explainBusy={false}
            explainError=""
            onAskExplain={() => {}}
            availableViews={["table", "json"]}
          />
        )}
        {!error && !result && !busy && (
          <div className="p-6 text-center text-muted text-[12px]">
            {mode === "filter"
              ? "Enter a filter and click Run."
              : vectorInputMode === "text"
                ? "Enter a search phrase and click Run."
                : "Paste a query vector and click Run."}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Response → QueryResult conversion
// ============================================================================

function queryResponseToResult(
  res: MilvusQueryResponse,
  desc: MilvusCollectionDescription | null,
  fallbackElapsed: number,
): QueryResult {
  const columnNames = collectColumns(res.rows, desc);
  const columns = columnNames.map((name) => ({
    name,
    type_name: typeOfField(name, desc),
  }));
  const rows: unknown[][] = res.rows.map((r) => columnNames.map((c) => r[c] ?? null));
  return {
    columns,
    rows,
    elapsed_ms: res.elapsed_ms ?? Math.round(fallbackElapsed),
    rows_affected: null,
    editable: null,
  };
}

function searchResponseToResult(
  res: MilvusSearchResponse,
  fallbackElapsed: number,
): QueryResult {
  // Collect field keys across all hits; prepend "distance".
  const fieldRecords = res.hits.map((h) => h.fields);
  const fieldCols = collectColumns(fieldRecords, null);
  const columns = [
    { name: "distance", type_name: "float" },
    ...fieldCols.map((name) => ({ name, type_name: "auto" })),
  ];
  const rows: unknown[][] = res.hits.map((h) => [
    h.distance,
    ...fieldCols.map((c) => h.fields[c] ?? null),
  ]);
  return {
    columns,
    rows,
    elapsed_ms: res.elapsed_ms ?? Math.round(fallbackElapsed),
    rows_affected: null,
    editable: null,
  };
}

function collectColumns(
  records: Record<string, unknown>[],
  desc: MilvusCollectionDescription | null,
): string[] {
  // Prefer the canonical field order from the schema; append any extra
  // dynamic-field keys we see in the rows.
  const seen = new Set<string>();
  const out: string[] = [];
  if (desc) {
    for (const f of desc.fields) {
      if (!seen.has(f.name)) {
        seen.add(f.name);
        out.push(f.name);
      }
    }
  }
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

function typeOfField(
  name: string,
  desc: MilvusCollectionDescription | null,
): string {
  if (!desc) return "auto";
  const f = desc.fields.find((x) => x.name === name);
  if (!f) return "auto";
  return f.dim != null ? `${f.data_type}(${f.dim})` : f.data_type;
}

// ============================================================================
// Small bits
// ============================================================================

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted">
        {label}
        {hint && (
          <span className="text-subtle normal-case tracking-normal font-normal">
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

function InputModePill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-5 px-2 text-[10.5px] font-semibold rounded-full border transition-colors ${
        active
          ? "bg-acc text-white border-acc"
          : "bg-panel text-muted border-border hover:text-ink hover:bg-bg-2"
      }`}
    >
      {label}
    </button>
  );
}

function ModeTab({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-md border text-left ${
        active
          ? "border-acc bg-acc-soft text-acc-ink"
          : "border-border bg-panel hover:bg-bg-2 text-ink-2"
      }`}
    >
      <div className="text-[12px] font-semibold leading-tight">{label}</div>
      <div className="text-[10px] text-muted leading-tight">{sub}</div>
    </button>
  );
}

function parseVector(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Query vector is required.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Vector must be a valid JSON array of numbers.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Vector must be a JSON array.");
  }
  const out: number[] = [];
  for (const v of parsed) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error("Vector elements must be finite numbers.");
    }
    out.push(v);
  }
  if (out.length === 0) {
    throw new Error("Vector cannot be empty.");
  }
  return out;
}
