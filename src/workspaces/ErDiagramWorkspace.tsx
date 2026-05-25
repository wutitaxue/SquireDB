import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ErDiagramResponse } from "../types";
import {
  AgentPanel,
  Card,
  ErrorPre,
  KpiCard,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from "../shell/AgentPanel";
import { MermaidView } from "../components/MermaidView";

type Props = {
  connectionId: number;
  databases: string[];
  onClose: () => void;
};

export function ErDiagramWorkspace({ connectionId, databases, onClose }: Props) {
  const [database, setDatabase] = useState<string>(databases[0] ?? "");
  const [response, setResponse] = useState<ErDiagramResponse | null>(null);
  const [svg, setSvg] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [includeAi, setIncludeAi] = useState(true);

  async function run() {
    if (!database) {
      setError("Pick a database first.");
      return;
    }
    setLoading(true);
    setError("");
    setResponse(null);
    setSvg("");
    try {
      const r = await invoke<ErDiagramResponse>("export_connection_er", {
        connectionId,
        database,
        tables: null,
        includeAi,
      });
      setResponse(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const fileSlug = useMemo(() => {
    const base = response?.snapshot.scope_label ?? database ?? "er";
    const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "er";
    const stamp = new Date().toISOString().slice(0, 10);
    return `${safe}_er_${stamp}`;
  }, [response, database]);

  function download(content: string, mime: string, ext: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileSlug}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadPng() {
    if (!svg) return;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const scale = 2;
      const w = (img.naturalWidth || 1200) * scale;
      const h = (img.naturalHeight || 800) * scale;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${fileSlug}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, "image/png");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  const snapshot = response?.snapshot;
  const subtitle = snapshot
    ? `${snapshot.scope_label} · ${snapshot.total_tables} tables · ${snapshot.total_relations} relations`
    : "Auto-generated ER diagram for this database";

  return (
    <AgentPanel
      icon="🗺"
      title="ER Diagram"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-[12px] text-muted">Database</label>
          <select
            className="h-7 px-2 bg-bg border border-border rounded text-[12px]"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
          >
            {databases.length === 0 ? (
              <option value="">— no databases —</option>
            ) : (
              databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))
            )}
          </select>
          <label className="text-[12px] text-muted flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={includeAi}
              onChange={(e) => setIncludeAi(e.target.checked)}
            />
            AI reading guide
          </label>
          <PrimaryButton onClick={() => void run()} disabled={loading || !database}>
            {loading ? "Generating…" : response ? "Re-generate" : "Generate ER"}
          </PrimaryButton>
          {response && (
            <>
              <SecondaryButton
                onClick={() =>
                  download(response.mermaid, "text/plain;charset=utf-8", "mmd")
                }
              >
                Mermaid (.mmd)
              </SecondaryButton>
              <SecondaryButton
                onClick={() =>
                  download(svg || response.mermaid, "image/svg+xml;charset=utf-8", "svg")
                }
                disabled={!svg}
              >
                SVG
              </SecondaryButton>
              <SecondaryButton onClick={downloadPng} disabled={!svg}>
                PNG
              </SecondaryButton>
            </>
          )}
        </div>
        {error && <ErrorPre>{error}</ErrorPre>}
      </Card>

      {response && snapshot && (
        <>
          {response.ai_error && !response.ai_overview && (
            <Card className="bg-warn-soft border-warn/20">
              <SectionTitle>AI overview unavailable</SectionTitle>
              <div className="text-[12px] text-warn">{response.ai_error}</div>
            </Card>
          )}
          {response.ai_overview && (
            <Card>
              <SectionTitle>Reading guide</SectionTitle>
              <div className="text-[12px] leading-relaxed whitespace-pre-line">
                {response.ai_overview}
              </div>
            </Card>
          )}

          <Card>
            <SectionTitle>Overview</SectionTitle>
            <div className="grid grid-cols-4 gap-2">
              <KpiCard label="Tables" value={snapshot.total_tables} />
              <KpiCard label="Relations" value={snapshot.total_relations} />
              <KpiCard
                label="PII columns"
                value={snapshot.tables.reduce(
                  (acc, t) => acc + t.columns.filter((c) => c.pii_type).length,
                  0,
                )}
              />
              <KpiCard label="Scan ms" value={snapshot.elapsed_ms} />
            </div>
            {snapshot.truncated && (
              <div className="mt-2 text-[11px] text-warn">
                Truncated to first {snapshot.truncated_limit} tables (alphabetical) — the database
                has more.
              </div>
            )}
          </Card>

          <Card className="overflow-auto">
            <SectionTitle>Diagram</SectionTitle>
            {response.mermaid.trim() ? (
              <div className="er-diagram-host">
                <MermaidView source={response.mermaid} onSvg={setSvg} />
              </div>
            ) : (
              <div className="text-[12px] text-muted">No tables in scope.</div>
            )}
          </Card>

          <Card>
            <details>
              <summary className="cursor-pointer text-[12px] text-muted">
                Mermaid source ({response.mermaid.length} chars)
              </summary>
              <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap max-h-[300px] overflow-auto">
                {response.mermaid}
              </pre>
            </details>
          </Card>
        </>
      )}
    </AgentPanel>
  );
}
