import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnMetaForTree,
  Connection,
  ProjectTable,
} from "../../types";

export type ProjectTreeFilter = "x-conn" | "x-db" | "closed";

type Props = {
  tables: ProjectTable[];
  connections: Connection[];
  openConnIds: Set<number>;
  /** Currently active drill lookup table (highlighted). */
  lookupTable: ProjectTable | null;

  query: string;
  filters: Set<ProjectTreeFilter>;

  /** Single click on a table — preview (run `SELECT * FROM ... LIMIT 100`). */
  onTablePreview: (t: ProjectTable) => void;
  /** Double click on a table — open drill workspace with this table as root. */
  onTableDrill: (t: ProjectTable) => void;
};

function tableKey(connId: number, db: string, table: string): string {
  return `${connId}|${db}|${table}`;
}

type Tag = { label: string; cls: string };

function columnTags(c: ColumnMetaForTree): Tag[] {
  const tags: Tag[] = [];
  if (c.is_primary) tags.push({ label: "PK", cls: "bg-warn-soft text-warn" });
  if (c.is_foreign_key) tags.push({ label: "FK", cls: "bg-info-soft text-info" });
  if (c.is_indexed && !c.is_primary && !c.is_foreign_key)
    tags.push({ label: "IDX", cls: "bg-bg text-muted" });
  return tags;
}

export function ProjectTreeView({
  tables,
  connections,
  openConnIds,
  lookupTable,
  query,
  filters,
  onTablePreview,
  onTableDrill,
}: Props) {
  const connLabel = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of connections) {
      if (c.id != null) m.set(c.id, c.name);
    }
    return (id: number) => m.get(id) ?? `#${id}`;
  }, [connections]);

  // Detect tables that participate in cross-conn / cross-db relations.
  // We don't have relations here directly; instead the parent can pass a
  // pre-built set if it wants. For now we apply the connection state filter only.
  const q = query.trim().toLowerCase();
  const filterActive = q.length > 0 || filters.size > 0;

  function tableMatches(t: ProjectTable): boolean {
    if (q) {
      const hit =
        t.table_name.toLowerCase().includes(q) ||
        t.database_name.toLowerCase().includes(q);
      if (!hit) return false;
    }
    if (filters.has("closed") && openConnIds.has(t.connection_id)) return false;
    // x-conn / x-db filters require relations context; if parent didn't filter `tables`,
    // those filter chips behave as no-op here.
    return true;
  }

  const tablesByConnDb = useMemo(() => {
    const filtered = filterActive ? tables.filter(tableMatches) : tables;
    const m = new Map<string, { connId: number; db: string; items: ProjectTable[] }>();
    for (const t of filtered) {
      const key = `${t.connection_id}|${t.database_name}`;
      const entry = m.get(key) ?? {
        connId: t.connection_id,
        db: t.database_name,
        items: [],
      };
      entry.items.push(t);
      m.set(key, entry);
    }
    return Array.from(m.values()).sort((a, b) =>
      a.connId !== b.connId ? a.connId - b.connId : a.db.localeCompare(b.db),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, q, filters, openConnIds]);

  const [collapsedDbs, setCollapsedDbs] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [columnsByKey, setColumnsByKey] = useState<Record<string, ColumnMetaForTree[]>>({});
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());

  function toggleDb(connId: number, db: string) {
    const k = `${connId}|${db}`;
    setCollapsedDbs((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  async function toggleTable(t: ProjectTable) {
    const k = tableKey(t.connection_id, t.database_name, t.table_name);
    if (expandedTables.has(k)) {
      setExpandedTables((prev) => {
        const next = new Set(prev);
        next.delete(k);
        return next;
      });
      return;
    }
    setExpandedTables((prev) => new Set(prev).add(k));
    if (columnsByKey[k] || loadingColumns.has(k)) return;
    if (!openConnIds.has(t.connection_id)) return;
    setLoadingColumns((prev) => new Set(prev).add(k));
    try {
      const cols = await invoke<ColumnMetaForTree[]>("list_columns_meta", {
        connectionId: t.connection_id,
        database: t.database_name,
        table: t.table_name,
      });
      setColumnsByKey((prev) => ({ ...prev, [k]: cols }));
    } catch {
      setColumnsByKey((prev) => ({ ...prev, [k]: [] }));
    } finally {
      setLoadingColumns((prev) => {
        const next = new Set(prev);
        next.delete(k);
        return next;
      });
    }
  }

  if (tables.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] text-muted italic">
        No tables yet. Edit project to add tables.
      </div>
    );
  }

  return (
    <ul>
      {tablesByConnDb.map(({ connId, db, items }) => {
        const connOpen = openConnIds.has(connId);
        const dbKey = `${connId}|${db}`;
        const dbCollapsed = collapsedDbs.has(dbKey);
        return (
          <li key={dbKey}>
            <button
              onClick={() => toggleDb(connId, db)}
              className="w-full flex items-center gap-1.5 h-6 px-2 text-[12px] rounded hover:bg-bg"
              title={`${db} · ${connLabel(connId)}${connOpen ? "" : " (closed)"}`}
            >
              <span className="text-[9px] text-subtle w-2 shrink-0">
                {dbCollapsed ? "▸" : "▾"}
              </span>
              <span
                className="font-medium text-ink-2 truncate text-left"
              >
                {db}
              </span>
              <span
                className={`shrink-0 h-[14px] px-1 rounded text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 ${
                  connOpen
                    ? "bg-bg text-muted"
                    : "bg-warn-soft text-warn"
                }`}
                title={`Connection: ${connLabel(connId)}`}
              >
                <span
                  className={`w-1 h-1 rounded-full ${connOpen ? "bg-ok" : "bg-warn"}`}
                />
                {connLabel(connId)}
              </span>
              <span className="ml-auto text-[10px] text-subtle font-mono shrink-0">
                {items.length}
              </span>
            </button>
            {!dbCollapsed && (
              <ul className="ml-[12px]">
                {items.map((t) => {
                      const tkey = tableKey(t.connection_id, t.database_name, t.table_name);
                      const isActive =
                        !!lookupTable &&
                        lookupTable.connection_id === t.connection_id &&
                        lookupTable.database_name === t.database_name &&
                        lookupTable.table_name === t.table_name;
                      const tableExpanded = expandedTables.has(tkey);
                      const cols = columnsByKey[tkey];
                      const loading = loadingColumns.has(tkey);
                      const closed = !openConnIds.has(t.connection_id);
                      return (
                        <li key={t.id}>
                          <div
                            className={`group flex items-center pl-2 pr-1 rounded ${
                              isActive ? "bg-acc-soft" : "hover:bg-bg"
                            }`}
                          >
                            <button
                              onClick={() => void toggleTable(t)}
                              className="w-3 h-[26px] flex items-center justify-center text-[9px] text-subtle shrink-0"
                              title={tableExpanded ? "Collapse" : "Expand columns"}
                            >
                              {tableExpanded ? "▾" : "▸"}
                            </button>
                            <button
                              onClick={() => onTablePreview(t)}
                              onDoubleClick={() => onTableDrill(t)}
                              className="flex-1 flex items-center gap-1.5 h-[26px] min-w-0 text-left"
                              title={
                                closed
                                  ? `${db}.${t.table_name} (connection closed)`
                                  : `Click: preview · Double-click: drill from ${db}.${t.table_name}`
                              }
                            >
                              <span className="text-subtle text-[10px] shrink-0">⊞</span>
                              <span
                                className={`text-[12px] truncate ${
                                  isActive
                                    ? "text-acc-ink font-semibold"
                                    : closed
                                      ? "text-subtle"
                                      : "text-ink-2"
                                }`}
                              >
                                {t.table_name}
                              </span>
                              {t.is_primary === 1 && (
                                <span className="text-[10px] text-acc shrink-0">★</span>
                              )}
                              {closed && (
                                <span className="text-[9px] text-subtle italic shrink-0 ml-auto">
                                  closed
                                </span>
                              )}
                            </button>
                          </div>
                          {tableExpanded && (
                            <ul className="ml-[28px]">
                              {loading && (
                                <li className="pl-2 py-0.5 text-[11px] text-subtle italic">
                                  Loading…
                                </li>
                              )}
                              {!loading && closed && !cols && (
                                <li className="pl-2 py-0.5 text-[11px] text-subtle italic">
                                  (open connection to load)
                                </li>
                              )}
                              {!loading && cols && cols.length === 0 && (
                                <li className="pl-2 py-0.5 text-[11px] text-subtle italic">
                                  (no columns)
                                </li>
                              )}
                              {!loading &&
                                cols &&
                                cols.map((c) => {
                                  const tags = columnTags(c);
                                  return (
                                    <li key={c.name}>
                                      <div
                                        className="w-full flex items-center gap-1.5 h-[22px] pl-2 pr-1 rounded font-mono text-[11px] min-w-0 hover:bg-bg"
                                        title={
                                          c.column_type +
                                          (c.nullable ? " · NULL" : " · NOT NULL")
                                        }
                                      >
                                        <span className="truncate text-ink-2">
                                          {c.name}
                                        </span>
                                        {tags.map((tag) => (
                                          <span
                                            key={tag.label}
                                            className={`shrink-0 h-[13px] px-1 rounded-[2px] text-[9px] font-bold uppercase tracking-wider flex items-center ${tag.cls}`}
                                          >
                                            {tag.label}
                                          </span>
                                        ))}
                                        <span className="ml-auto text-[10px] text-subtle truncate max-w-[80px] shrink-0">
                                          {c.data_type}
                                        </span>
                                      </div>
                                    </li>
                                  );
                                })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
