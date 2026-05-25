import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Annotation, TableCommentReport } from "../types";
import {
  AgentPanel,
  Card,
  ErrorPre,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SevPill,
  type SevTone,
} from "../shell/AgentPanel";

type FilterKind = "all" | "metrics" | "governance" | "caveats";

type Props = {
  connectionId: number;
  databases: string[];
  onClose: () => void;
};

function annotationTags(a: Annotation): { label: string; tone: SevTone }[] {
  const tags: { label: string; tone: SevTone }[] = [];
  if (a.pii_type) tags.push({ label: `PII: ${a.pii_type}`, tone: "pii" });
  if (a.semantic_role) tags.push({ label: a.semantic_role, tone: "info" });
  return tags;
}

function matchesFilter(a: Annotation, kind: FilterKind): boolean {
  if (kind === "all") return true;
  if (kind === "governance") return !!a.pii_type;
  if (kind === "metrics") {
    const role = (a.semantic_role ?? "").toLowerCase();
    return role.includes("metric") || role.includes("kpi") || role.includes("amount") || role.includes("count");
  }
  if (kind === "caveats") {
    const text = (a.ai_comment ?? "").toLowerCase();
    return text.includes("caveat") || text.includes("deprecated") || text.includes("note:");
  }
  return true;
}

export function DictionaryWorkspace({ connectionId, databases, onClose }: Props) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");

  const [selectedDb, setSelectedDb] = useState(databases[0] ?? "");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const cancelRef = useRef(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const list = await invoke<Annotation[]>("list_annotations", {
        connectionId,
        database: null,
      });
      setAnnotations(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  async function generateForDb() {
    if (!selectedDb || generating) return;
    setGenerating(true);
    cancelRef.current = false;
    setError("");
    setProgress(`Listing tables in ${selectedDb}…`);

    let tables: string[];
    try {
      tables = await invoke<string[]>("list_tables_for_ai", {
        connectionId,
        database: selectedDb,
      });
    } catch (e) {
      setError(String(e));
      setProgress("");
      setGenerating(false);
      return;
    }
    if (tables.length === 0) {
      setProgress(`No base tables in ${selectedDb}.`);
      setGenerating(false);
      return;
    }

    let documented = 0;
    let failed = 0;
    const startedAt = Date.now();
    for (let i = 0; i < tables.length; i++) {
      if (cancelRef.current) {
        setProgress(
          `Cancelled at ${i}/${tables.length} · ${documented} cols documented` +
            (failed > 0 ? ` · ${failed} failed` : ""),
        );
        break;
      }
      const t = tables[i];
      setProgress(`${i + 1}/${tables.length}: ${t}`);
      try {
        const r = await invoke<TableCommentReport>("generate_table_comments", {
          connectionId,
          database: selectedDb,
          table: t,
        });
        documented += r.columns_documented;
      } catch {
        failed += 1;
      }
    }

    if (!cancelRef.current) {
      const elapsed = Date.now() - startedAt;
      setProgress(
        `Done · ${tables.length} tables · ${documented} cols documented` +
          (failed > 0 ? ` · ${failed} failed` : "") +
          ` · ${elapsed}ms`,
      );
    }

    await load();
    setGenerating(false);
  }

  function cancel() {
    cancelRef.current = true;
  }

  async function exportMarkdown() {
    try {
      const md = await invoke<string>("export_data_dictionary", {
        connectionId,
        database: null,
      });
      await navigator.clipboard.writeText(md);
    } catch (e) {
      setError(String(e));
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return annotations.filter((a) => {
      if (!matchesFilter(a, filter)) return false;
      if (!q) return true;
      const hay = `${a.database_name}.${a.table_name}.${a.column_name ?? ""}\n${a.ai_comment ?? ""}\n${a.semantic_role ?? ""}\n${a.pii_type ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [annotations, query, filter]);

  const piiCount = annotations.filter((a) => !!a.pii_type).length;
  const subtitle = `${annotations.length} term${annotations.length === 1 ? "" : "s"} · ${piiCount} PII`;

  return (
    <AgentPanel
      icon="📖"
      title="Data Dictionary"
      subtitle={loading ? "Loading…" : subtitle}
      actions={
        <>
          <SecondaryButton onClick={exportMarkdown} disabled={loading || annotations.length === 0}>
            Export MD
          </SecondaryButton>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted">
              Generate AI comments
            </span>
            <select
              value={selectedDb}
              onChange={(e) => setSelectedDb(e.target.value)}
              disabled={generating}
              className="h-7 px-2 text-[12px] bg-panel-2 border border-border rounded-md"
            >
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <PrimaryButton onClick={() => void generateForDb()} disabled={generating || !selectedDb}>
              {generating ? "Generating…" : "🤖 Generate"}
            </PrimaryButton>
            {generating && <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>}
            {progress && (
              <span className="text-[12px] text-ok ml-auto truncate max-w-[40%]">{progress}</span>
            )}
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 h-7 px-2 bg-panel-2 border border-border rounded-md flex-1 min-w-[200px]">
              <span className="text-subtle text-[11px]">⌕</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search terms, comments, roles…"
                className="flex-1 bg-transparent outline-none text-[12px] text-ink placeholder:text-subtle"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="text-[11px] text-muted hover:text-ink px-1"
                >
                  ×
                </button>
              )}
            </div>
            <FilterChip value="all" active={filter === "all"} onClick={() => setFilter("all")}>
              All ({annotations.length})
            </FilterChip>
            <FilterChip
              value="metrics"
              active={filter === "metrics"}
              onClick={() => setFilter("metrics")}
            >
              Metrics
            </FilterChip>
            <FilterChip
              value="governance"
              active={filter === "governance"}
              onClick={() => setFilter("governance")}
            >
              Governance
            </FilterChip>
            <FilterChip
              value="caveats"
              active={filter === "caveats"}
              onClick={() => setFilter("caveats")}
            >
              Caveats
            </FilterChip>
          </div>
        </Card>

        {error && <ErrorPre>{error}</ErrorPre>}

        {!loading && annotations.length === 0 ? (
          <Card>
            <div className="text-center py-6">
              <SectionTitle>No annotations yet</SectionTitle>
              <div className="text-[12px] text-muted mt-2">
                Run <code className="font-mono">Analyze Schema</code> from the sidebar, or pick a database above and click{" "}
                <strong>Generate</strong> to let AI document tables.
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <SectionTitle>
              Terms {filter === "all" ? "" : `· ${filter}`} ({filtered.length})
            </SectionTitle>
            <div className="flex flex-col">
              {filtered.map((a) => (
                <TermRow key={a.id} a={a} />
              ))}
              {filtered.length === 0 && (
                <div className="px-2 py-4 text-[12px] text-muted text-center italic">
                  No terms match.
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </AgentPanel>
  );
}

function FilterChip({
  value: _value,
  active,
  onClick,
  children,
}: {
  value: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-7 px-2.5 text-[11px] font-medium rounded-md ${
        active ? "bg-acc text-white" : "bg-bg text-ink-2 hover:bg-bg-2"
      }`}
    >
      {children}
    </button>
  );
}

function TermRow({ a }: { a: Annotation }) {
  const tags = annotationTags(a);
  const term = a.column_name
    ? `${a.database_name}.${a.table_name}.${a.column_name}`
    : `${a.database_name}.${a.table_name}`;
  return (
    <div className="py-3 border-b border-border last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <code className="text-[13px] font-mono font-semibold text-ink truncate">{term}</code>
            {tags.map((t, i) => (
              <SevPill key={i} tone={t.tone}>
                {t.label}
              </SevPill>
            ))}
          </div>
          {a.ai_comment && (
            <div className="text-[12px] text-ink-2 leading-relaxed mt-1.5 whitespace-pre-wrap">
              {a.ai_comment}
            </div>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-subtle">
            <span className="font-mono">{term}</span>
            <span className="text-border-2">·</span>
            <span>analyzed {a.analyzed_at}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
