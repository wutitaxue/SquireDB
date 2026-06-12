import type { Connection, SavedQuery } from "../../types";
import { Section } from "./Section";

type Props = {
  /** All saved queries to render. In Connection mode this is the current
   *  connection's queries; in Project mode it's the union across all
   *  involved connections, grouped by connection. */
  queries: SavedQuery[];
  /** Look up a connection's display name. Used only when groupByConnection. */
  connections?: Connection[];
  /** When true, render a sub-header per connection. */
  groupByConnection?: boolean;
  /** Click a saved query — typically opens a new query tab with the SQL. */
  onOpen: (q: SavedQuery) => void;
  /** Right-click menu hook — caller renders rename / replace / delete items. */
  onContextMenu?: (q: SavedQuery, e: React.MouseEvent) => void;
};

export function SavedQueriesSection({
  queries,
  connections,
  groupByConnection = false,
  onOpen,
  onContextMenu,
}: Props) {
  if (queries.length === 0) {
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
      <div className="shrink-0 max-h-[260px] overflow-y-auto">
        <Section
          title="⭐ Saved queries"
          actions={
            <span className="text-[10px] text-subtle">{queries.length}</span>
          }
          flush
        >
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
        </Section>
      </div>
    );
  }

  return (
    <div className="shrink-0 max-h-[260px] overflow-y-auto">
      <Section
        title="⭐ Saved queries"
        actions={<span className="text-[10px] text-subtle">{queries.length}</span>}
        flush
      >
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
      </Section>
    </div>
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
  const preview = q.sql.replace(/\s+/g, " ").trim().slice(0, 72);
  const more = q.sql.length > 72 ? "…" : "";
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
        <div className="text-[12px] text-ink-2 font-medium truncate">
          {q.name}
        </div>
        <div className="text-[10px] text-subtle font-mono truncate">
          {preview}
          {more}
        </div>
      </button>
    </li>
  );
}
