import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DictTable,
  ProjectDictionaryResponse,
} from "../types";
import {
  AgentPanel,
  Card,
  ErrorPre,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SevPill,
} from "../shell/AgentPanel";

type Props = {
  projectId: number;
  projectName: string;
  onClose: () => void;
};

export function ProjectDictionaryWorkspace({
  projectId,
  projectName,
  onClose,
}: Props) {
  const [response, setResponse] = useState<ProjectDictionaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      const r = await invoke<ProjectDictionaryResponse>(
        "export_project_dictionary",
        { projectId, includeAi: true },
      );
      setResponse(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const fileSlug = useMemo(() => {
    const base = (response?.snapshot.project_name ?? projectName).trim();
    const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "project";
    const stamp = new Date().toISOString().slice(0, 10);
    return `${safe}_dictionary_${stamp}`;
  }, [response, projectName]);

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

  function openPrintWindow(html: string) {
    const w = window.open("", "_blank", "width=1024,height=768");
    if (!w) {
      setError("Popup blocked. Allow popups to use Print → PDF.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => {
      w.focus();
      w.print();
    }, 250);
  }

  const subtitle = response
    ? `${response.snapshot.total_tables} tables · ${response.snapshot.total_relations} relations · ${response.snapshot.annotated_columns_count} annotated`
    : `Export the data dictionary for ${projectName}`;

  return (
    <AgentPanel
      icon="📚"
      title="Project Dictionary"
      subtitle={subtitle}
      actions={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <PrimaryButton onClick={() => void run()} disabled={loading}>
              {loading ? "Generating…" : response ? "Regenerate" : "Generate dictionary"}
            </PrimaryButton>
            {response && (
              <>
                <SecondaryButton onClick={() => download(response.markdown, "text/markdown;charset=utf-8", "md")}>
                  ⬇ Markdown
                </SecondaryButton>
                <SecondaryButton onClick={() => download(response.html, "text/html;charset=utf-8", "html")}>
                  ⬇ HTML
                </SecondaryButton>
                <SecondaryButton onClick={() => openPrintWindow(response.html)}>
                  🖨 Print / PDF
                </SecondaryButton>
              </>
            )}
            <span className="text-[11px] text-muted ml-auto">
              Curated tables · columns · annotations · PII · relations.
            </span>
          </div>
        </Card>

        {error && <ErrorPre>{error}</ErrorPre>}

        {response?.ai_error && (
          <Card className="bg-warn-soft border-warn/20">
            <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
              AI warning
            </div>
            <div className="text-[12px] text-ink-2">{response.ai_error}</div>
          </Card>
        )}

        {response && (
          <>
            {response.ai_summary && (
              <Card>
                <SectionTitle>Executive summary</SectionTitle>
                <div className="text-[13px] text-ink-2 leading-relaxed whitespace-pre-wrap">
                  {response.ai_summary}
                </div>
              </Card>
            )}

            <OverviewCard snapshot={response.snapshot} />

            {response.snapshot.missing_connection_names.length > 0 && (
              <Card className="bg-warn-soft border-warn/20">
                <div className="text-[11px] uppercase tracking-wider font-bold text-warn mb-1">
                  Partial scan
                </div>
                <div className="text-[12px] text-ink-2">
                  {response.snapshot.missing_connection_names.length} connection(s) closed
                  during export — column metadata may be missing for tables on:{" "}
                  <span className="font-mono">
                    {response.snapshot.missing_connection_names.join(", ")}
                  </span>
                </div>
              </Card>
            )}

            <TablesCard tables={response.snapshot.tables} />

            {response.snapshot.relations.length > 0 && (
              <RelationsCard relations={response.snapshot.relations} />
            )}

            <div className="text-[11px] text-muted text-right tabular-nums">
              generated {response.snapshot.generated_at} · scan{" "}
              {response.snapshot.elapsed_ms}ms
            </div>
          </>
        )}
      </div>
    </AgentPanel>
  );
}

function OverviewCard({
  snapshot,
}: {
  snapshot: ProjectDictionaryResponse["snapshot"];
}) {
  const items = [
    { label: "Tables", value: snapshot.total_tables },
    { label: "Relations", value: snapshot.total_relations },
    { label: "Annotated", value: snapshot.annotated_columns_count },
    { label: "PII columns", value: snapshot.pii_columns_count },
  ];
  return (
    <Card>
      <SectionTitle>Overview</SectionTitle>
      <div className="grid grid-cols-4 gap-2">
        {items.map((it) => (
          <div
            key={it.label}
            className="rounded-md bg-panel-2 px-3 py-2 flex flex-col gap-0.5"
          >
            <span className="text-[10.5px] uppercase tracking-wider font-bold text-muted">
              {it.label}
            </span>
            <span className="text-[18px] font-bold text-ink tabular-nums">
              {it.value}
            </span>
          </div>
        ))}
      </div>
      {snapshot.project_description && (
        <div className="mt-3 text-[12px] text-ink-2 italic">
          {snapshot.project_description}
        </div>
      )}
    </Card>
  );
}

function TablesCard({ tables }: { tables: DictTable[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, DictTable[]>();
    for (const t of tables) {
      const key = `${t.connection_id}::${t.database}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries()).map(([key, list]) => ({
      key,
      connectionName: list[0].connection_name,
      database: list[0].database,
      tables: list,
    }));
  }, [tables]);

  return (
    <Card>
      <SectionTitle>Tables ({tables.length})</SectionTitle>
      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted">
              {g.connectionName} · <span className="font-mono">{g.database}</span>
            </div>
            {g.tables.map((t) => (
              <TableRow key={`${t.connection_id}.${t.database}.${t.table}`} t={t} />
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

function TableRow({ t }: { t: DictTable }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-panel-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-panel"
      >
        <span className="text-[11px] text-subtle">{open ? "▾" : "▸"}</span>
        <code className="text-[13px] font-mono font-semibold text-ink">
          {t.table}
        </code>
        {t.is_primary && <SevPill tone="warn">PRIMARY</SevPill>}
        {t.closed && <SevPill tone="crit">closed</SevPill>}
        <span className="text-[11px] text-muted ml-auto tabular-nums">
          {t.columns.length} cols · ~{t.estimated_rows.toLocaleString()} rows ·{" "}
          {t.data_mb.toFixed(2)} MB
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {t.comment && (
            <div className="text-[12px] text-warn italic mb-2">// {t.comment}</div>
          )}
          {t.columns.length === 0 ? (
            <div className="text-[12px] text-subtle italic">
              No column metadata (connection may be closed).
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px] font-mono min-w-[780px]">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-3 font-normal">Column</th>
                    <th className="py-1 pr-3 font-normal">Type</th>
                    <th className="py-1 pr-3 font-normal">Null</th>
                    <th className="py-1 pr-3 font-normal">Key</th>
                    <th className="py-1 pr-3 font-normal">Default</th>
                    <th className="py-1 pr-3 font-normal">PII</th>
                    <th className="py-1 font-normal">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {t.columns.map((c) => (
                    <tr
                      key={c.name}
                      className="border-t border-border/60 align-top"
                    >
                      <td className="py-1 pr-3 text-ink font-semibold">{c.name}</td>
                      <td className="py-1 pr-3 text-ink-2">{c.column_type}</td>
                      <td className="py-1 pr-3 text-muted">
                        {c.nullable ? "Y" : "N"}
                      </td>
                      <td className="py-1 pr-3 text-muted">
                        {c.column_key || "—"}
                      </td>
                      <td className="py-1 pr-3 text-muted">
                        {c.default ?? "—"}
                      </td>
                      <td className="py-1 pr-3">
                        {c.pii_type ? (
                          <SevPill tone="pii">{c.pii_type}</SevPill>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                      </td>
                      <td className="py-1 text-ink-2 font-sans">
                        <ColumnNotes c={c} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnNotes({ c }: { c: DictTable["columns"][number] }) {
  const parts: string[] = [];
  if (c.semantic_role) parts.push(c.semantic_role);
  if (c.ai_comment) parts.push(c.ai_comment);
  else if (c.comment) parts.push(c.comment);
  if (parts.length === 0) return <span className="text-subtle">—</span>;
  return <span>{parts.join(" · ")}</span>;
}

function RelationsCard({
  relations,
}: {
  relations: ProjectDictionaryResponse["snapshot"]["relations"];
}) {
  return (
    <Card>
      <SectionTitle>Relations ({relations.length})</SectionTitle>
      <div className="flex flex-col gap-1">
        {relations.map((r, i) => (
          <div
            key={i}
            className="px-2.5 py-1.5 bg-panel-2 rounded font-mono text-[11.5px] text-ink-2 flex items-center gap-2 flex-wrap"
          >
            <code>
              {r.from_connection_name}·{r.from_db}.{r.from_table}.{r.from_column}
            </code>
            <span className="text-subtle">→</span>
            <SevPill tone={r.cross_conn ? "pii" : r.cross_db ? "warn" : "neutral"}>
              {r.cross_conn ? "X-CONN" : r.cross_db ? "X-DB" : "local"}
            </SevPill>
            <span className="text-[10.5px] text-subtle">
              {r.cardinality} · {r.source}
            </span>
            <code>
              {r.to_connection_name}·{r.to_db}.{r.to_table}.{r.to_column}
            </code>
          </div>
        ))}
      </div>
    </Card>
  );
}
