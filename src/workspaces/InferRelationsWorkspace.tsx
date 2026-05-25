import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AiRelationsReport } from "../types";
import {
  AgentPanel,
  Card,
  ErrorPre,
  KpiCard,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from "../shell/AgentPanel";

type Props = {
  connectionId: number;
  onClose: () => void;
  /** Refresh annotations / relations after writes. */
  onInferred: () => void;
};

export function InferRelationsWorkspace({
  connectionId,
  onClose,
  onInferred,
}: Props) {
  const [report, setReport] = useState<AiRelationsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setLoading(true);
    setError("");
    try {
      const r = await invoke<AiRelationsReport>("generate_ai_relations", {
        connectionId,
      });
      setReport(r);
      onInferred();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const subtitle = report
    ? `${report.accepted}/${report.proposed} accepted · ${report.elapsed_ms}ms`
    : "Ask an LLM to find FK relationships heuristics missed";

  return (
    <AgentPanel
      icon="🪄"
      title="AI Infer Relations"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        {!report && (
          <Card>
            <div className="flex items-center gap-3">
              <PrimaryButton onClick={() => void run()} disabled={loading}>
                {loading ? "Asking AI…" : "Run AI inference"}
              </PrimaryButton>
              <span className="text-[12px] text-muted">
                Sends schema summary to your configured LLM (OpenAI / Claude /
                DeepSeek). All proposed endpoints are validated server-side
                before being written — hallucinated tables / columns are
                rejected.
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
              <KpiCard label="Proposed" value={report.proposed} />
              <KpiCard
                label="Accepted"
                value={report.accepted}
                tone={report.accepted > 0 ? "ok" : "neutral"}
              />
              <KpiCard
                label="Rejected (hallucination)"
                value={report.rejected_unknown_endpoint}
                tone={
                  report.rejected_unknown_endpoint > 0 ? "warn" : "neutral"
                }
              />
              <KpiCard label="Elapsed" value={`${report.elapsed_ms}ms`} />
            </div>

            {report.rejections.length > 0 && (
              <Card>
                <SectionTitle>Rejection samples</SectionTitle>
                <p className="text-[11px] text-muted mb-2">
                  These candidates pointed to tables or columns that don't
                  exist in this connection — likely AI hallucinations.
                </p>
                <ul className="font-mono text-[11px] text-ink-2 space-y-1">
                  {report.rejections.map((line, i) => (
                    <li key={i} className="break-all">
                      • {line}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {report.proposed > 0 && report.accepted === 0 && (
              <Card className="bg-warn-soft border-warn/20">
                <div className="text-[12px] text-ink-2">
                  AI proposed {report.proposed} relations but all were rejected.
                  Try running <span className="font-mono text-acc-ink">Analyze
                  Schema</span> first — the LLM needs annotated context to
                  produce valid endpoints.
                </div>
              </Card>
            )}

            <SecondaryButton onClick={() => void run()} disabled={loading}>
              {loading ? "Running…" : "Run again"}
            </SecondaryButton>
          </>
        )}
      </div>
    </AgentPanel>
  );
}
