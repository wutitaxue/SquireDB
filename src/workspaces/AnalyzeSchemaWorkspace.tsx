import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AnalyzeReport } from "../types";
import {
  AgentPanel,
  Card,
  ErrorPre,
  KpiCard,
  PrimaryButton,
  SecondaryButton,
} from "../shell/AgentPanel";

type Props = {
  connectionId: number;
  onClose: () => void;
  /** Refresh annotations / relations after analysis writes them. */
  onAnalyzed: () => void;
};

export function AnalyzeSchemaWorkspace({
  connectionId,
  onClose,
  onAnalyzed,
}: Props) {
  const [report, setReport] = useState<AnalyzeReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setLoading(true);
    setError("");
    try {
      const r = await invoke<AnalyzeReport>("analyze_schema", { connectionId });
      setReport(r);
      onAnalyzed();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const subtitle = report
    ? `${report.tables_analyzed} tables · ${report.elapsed_ms}ms`
    : "Heuristic schema scan — PII · FK candidates · column semantics";

  return (
    <AgentPanel
      icon="🔍"
      title="Analyze Schema"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        {!report && (
          <Card>
            <div className="flex items-center gap-3">
              <PrimaryButton onClick={() => void run()} disabled={loading}>
                {loading ? "Analyzing…" : "Run analyze"}
              </PrimaryButton>
              <span className="text-[12px] text-muted">
                Scans every table & column, writes PII tags and FK candidates to
                local storage. No LLM call. Takes seconds to a few minutes for
                large databases.
              </span>
            </div>
          </Card>
        )}

        {error && <ErrorPre>{error}</ErrorPre>}

        {report && (
          <>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
            >
              <KpiCard label="Tables analyzed" value={report.tables_analyzed} />
              <KpiCard label="Columns analyzed" value={report.columns_analyzed} />
              <KpiCard
                label="Annotations written"
                value={report.annotations_written}
              />
              <KpiCard label="Relations found" value={report.relations_written} />
              <KpiCard
                label="PII columns"
                value={report.pii_columns}
                tone={report.pii_columns > 0 ? "pii" : "neutral"}
              />
              <KpiCard label="Elapsed" value={`${report.elapsed_ms}ms`} />
            </div>

            <Card>
              <div className="text-[12px] text-ink-2 leading-relaxed">
                Annotations and relation candidates have been written to local
                storage. Open <span className="font-mono text-acc-ink">Data
                Dictionary</span> to browse, or run <span className="font-mono text-acc-ink">AI
                Infer Relations</span> to fill in cross-table FKs the heuristic
                pass missed.
              </div>
            </Card>

            <SecondaryButton onClick={() => void run()} disabled={loading}>
              {loading ? "Re-analyzing…" : "Run again"}
            </SecondaryButton>
          </>
        )}
      </div>
    </AgentPanel>
  );
}
