import { useMemo, useState } from "react";
import type { Connection, HistoryEntry, SavedQuery } from "../../types";
import { formatTime } from "../../utils";
import { Section } from "./Section";

type Tab = "saved" | "history";

type Props = {
  /** All saved queries to render. In Connection mode this is the current
   *  connection's queries; in Project mode it's the union across all
   *  involved connections, grouped by connection. */
  queries: SavedQuery[];
  /** Look up a connection's display name. Used only when groupByConnection. */
  connections?: Connection[];
  /** When true, render a sub-header per connection in the saved tab. */
  groupByConnection?: boolean;
  /** Click a saved query — typically opens a new query tab with the SQL. */
  onOpen: (q: SavedQuery) => void;
  /** Right-click menu hook — caller renders rename / replace / delete items. */
  onContextMenu?: (q: SavedQuery, e: React.MouseEvent) => void;
  /** Optional history feed. Without it, only the Saved list is rendered (no
   *  tab toggle). With it, the section combines Saved / History under one
   *  toggle so they share vertical space. */
  history?: HistoryEntry[];
  onUseHistory?: (sql: string) => void;
};

export function SavedQueriesSection({
  queries,
  connections,
  groupByConnection = false,
  onOpen,
  onContextMenu,
  history,
  onUseHistory,
}: Props) {
  const hasHistory = !!history && !!onUseHistory;
  const savedEmpty = queries.length === 0;
  const historyEmpty = !hasHistory || history!.length === 0;

  // Default tab: saved when it has anything; else history when available;
  // else still "saved" so the empty state stays visible.
  const [tab, setTab] = useState<Tab>(() =>
    savedEmpty && hasHistory && !historyEmpty ? "history" : "saved",
  );
  const [search, setSearch] = useState("");

  if (!hasHistory && savedEmpty) {
    return (
      <div className="shrink-0">
        <Section title="⭐ Saved queries" flush>
          <div className="px-2 py-1 text-[11px] text-subtle italic">
            Run a SQL and click Save to keep it here.
          </div>
        </Section>
      </div>
    );
  }

  const needle = search.trim().toLowerCase();
  const filteredQueries = useMemo(() => {
    if (!needle) return queries;
    return queries.filter(
      (q) =>
        q.name.toLowerCase().includes(needle) ||
        q.sql.toLowerCase().includes(needle),
    );
  }, [queries, needle]);
  const filteredHistory = useMemo(() => {
    if (!hasHistory) return [] as HistoryEntry[];
    if (!needle) return history!;
    return history!.filter((h) => h.sql.toLowerCase().includes(needle));
  }, [history, needle, hasHistory]);

  const showTabs = hasHistory;
  const activeCount = tab === "saved" ? filteredQueries.length : filteredHistory.length;
  const totalForActive = tab === "saved" ? queries.length : history?.length ?? 0;

  const title = showTabs ? undefined : "⭐ Saved queries";

  const toolbar = (
    <div className="px-2 pb-1.5 flex flex-col gap-1.5 shrink-0">
      {showTabs && (
        <div className="flex items-center h-6 p-0.5 bg-bg-2 rounded-md text-[11px]">
          <TabButton
            label="⭐ Saved"
            count={queries.length}
            active={tab === "saved"}
            onClick={() => setTab("saved")}
          />
          <TabButton
            label="🕘 History"
            count={history?.length ?? 0}
            active={tab === "history"}
            onClick={() => setTab("history")}
          />
        </div>
      )}
      <div className="relative">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter…"
          className="w-full h-6 px-2 pr-6 text-[11px] bg-panel border border-border rounded-md outline-none focus:border-acc"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 text-[10px] text-muted hover:text-ink"
            title="Clear"
          >
            ×
          </button>
        )}
      </div>
      {needle && (
        <div className="text-[10px] text-subtle px-1 tabular-nums">
          {activeCount} / {totalForActive} match
        </div>
      )}
    </div>
  );

  return (
    <div className="shrink-0">
      <Section
        title={title}
        actions={
          !showTabs ? (
            <span className="text-[10px] text-subtle">{queries.length}</span>
          ) : undefined
        }
        bordered={false}
        flush
      >
        {toolbar}
        {/* Fixed-height list container — keeps the section's footprint stable
            when toggling between Saved and History so the surrounding sidebar
            doesn't jump. Content scrolls internally. */}
        <div className="h-[260px] overflow-y-auto">
          {tab === "saved" ? (
            <SavedList
              queries={filteredQueries}
              connections={connections}
              groupByConnection={groupByConnection}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              isFiltered={needle.length > 0}
            />
          ) : (
            <HistoryList
              items={filteredHistory}
              onUseHistory={onUseHistory!}
              isFiltered={needle.length > 0}
            />
          )}
        </div>
      </Section>
    </div>
  );
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 h-5 px-2 rounded font-medium transition inline-flex items-center justify-center gap-1 ${
        active ? "bg-panel text-ink" : "text-muted hover:text-ink-2"
      }`}
      style={active ? { boxShadow: "var(--sh-1)" } : undefined}
    >
      <span>{label}</span>
      <span className="text-[10px] text-subtle tabular-nums">{count}</span>
    </button>
  );
}

function SavedList({
  queries,
  connections,
  groupByConnection,
  onOpen,
  onContextMenu,
  isFiltered,
}: {
  queries: SavedQuery[];
  connections?: Connection[];
  groupByConnection: boolean;
  onOpen: (q: SavedQuery) => void;
  onContextMenu?: (q: SavedQuery, e: React.MouseEvent) => void;
  isFiltered: boolean;
}) {
  if (queries.length === 0) {
    return (
      <div className="px-2 py-2 text-[11px] text-subtle italic">
        {isFiltered ? "No matches." : "Run a SQL and click Save to keep it here."}
      </div>
    );
  }

  if (groupByConnection) {
    const byConn = new Map<number, SavedQuery[]>();
    for (const q of queries) {
      const arr = byConn.get(q.connection_id) ?? [];
      arr.push(q);
      byConn.set(q.connection_id, arr);
    }
    const connName = (id: number) =>
      connections?.find((c) => c.id === id)?.name ?? `#${id}`;

    return (
      <>
        {Array.from(byConn.entries()).map(([connId, list]) => (
          <div key={connId} className="mb-1.5 last:mb-0">
            <div className="px-2 text-[9.5px] uppercase tracking-wider text-subtle font-bold">
              {connName(connId)}
            </div>
            <ul>
              {list.map((q) => (
                <SavedQueryRow
                  key={q.id}
                  q={q}
                  onOpen={onOpen}
                  onContextMenu={onContextMenu}
                />
              ))}
            </ul>
          </div>
        ))}
      </>
    );
  }

  return (
    <ul>
      {queries.map((q) => (
        <SavedQueryRow
          key={q.id}
          q={q}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
        />
      ))}
    </ul>
  );
}

function SavedQueryRow({
  q,
  onOpen,
  onContextMenu,
}: {
  q: SavedQuery;
  onOpen: (q: SavedQuery) => void;
  onContextMenu?: (q: SavedQuery, e: React.MouseEvent) => void;
}) {
  const preview = q.sql.replace(/\s+/g, " ").slice(0, 60);
  const more = q.sql.length > 60 ? "…" : "";
  return (
    <li>
      <button
        onClick={() => onOpen(q)}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                onContextMenu(q, e);
              }
            : undefined
        }
        title={q.sql}
        className="w-full text-left px-2 py-1 hover:bg-bg rounded"
      >
        <div className="text-[11px] font-mono truncate text-ink-2">
          ⭐ {preview}
          {more}
        </div>
        <div className="text-[10px] text-subtle truncate">{q.name}</div>
      </button>
    </li>
  );
}

function HistoryList({
  items,
  onUseHistory,
  isFiltered,
}: {
  items: HistoryEntry[];
  onUseHistory: (sql: string) => void;
  isFiltered: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="px-2 py-2 text-[11px] text-subtle italic">
        {isFiltered ? "No matches." : "No queries yet."}
      </div>
    );
  }
  return (
    <ul>
      {items.map((h) => {
        const truncated = h.sql.replace(/\s+/g, " ").slice(0, 60);
        const more = h.sql.length > 60 ? "…" : "";
        const ok = h.error === null;
        const meta = ok
          ? `${h.rows_returned ?? h.rows_affected ?? 0}r · ${h.elapsed_ms ?? "?"}ms`
          : "error";
        return (
          <li key={h.id}>
            <button
              onClick={() => onUseHistory(h.sql)}
              title={h.sql}
              className="w-full text-left px-2 py-1 hover:bg-bg rounded"
            >
              <div
                className={`text-[11px] font-mono truncate ${ok ? "text-ink-2" : "text-crit"}`}
              >
                {ok ? "⚡" : "✗"} {truncated}
                {more}
              </div>
              <div className="text-[10px] text-subtle">
                {meta} · {formatTime(h.executed_at)}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
