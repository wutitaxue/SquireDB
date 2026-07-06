import { useMemo } from "react";
import {
  SYSTEM_DBS,
  type ColumnMetaForTree,
  type DbObject,
  type DbObjectKind,
  type TableMetaForTree,
} from "../../types";
import { fmtCount } from "../../utils";
import { TreeGroupRow } from "../atoms/TreeGroupRow";

export type SchemaFilter = "pii" | "fk" | "indexed";

/** Object-group definitions rendered under each db node, in display order.
 *  Views are excluded — they arrive as tables (kind="view"). */
const OBJECT_GROUPS: Array<{ kind: DbObjectKind; label: string; icon: string }> = [
  { kind: "procedure", label: "Procedures", icon: "ƒ" },
  { kind: "function", label: "Functions", icon: "λ" },
  { kind: "trigger", label: "Triggers", icon: "⚡" },
  { kind: "event", label: "Events", icon: "◷" },
];

type Props = {
  databases: string[];
  visibleDbs: string[];

  tablesByDb: Record<string, TableMetaForTree[]>;
  columnsByTableKey: Record<string, ColumnMetaForTree[]>;
  expandedDbs: Set<string>;
  expandedTables: Set<string>;

  /** Non-table objects keyed by `${db}::${kind}`. Undefined (not just empty)
   *  for non-MySQL connections, which suppresses the object groups entirely. */
  objectsByKey?: Record<string, DbObject[]>;
  expandedObjectGroups?: Set<string>;
  onToggleObjectGroup?: (db: string, kind: DbObjectKind) => void;
  onClickObject?: (db: string, kind: DbObjectKind, name: string) => void;

  piiTables: Set<string>;
  piiColumns: Set<string>;
  selectedKey: string | null;

  /** Controlled query string from the parent SearchBar. */
  query: string;
  /** Controlled filter set from the parent SearchBar. */
  filters: Set<SchemaFilter>;

  onToggleDb: (db: string) => void;
  onToggleTable: (db: string, table: string) => void;
  onClickTable: (db: string, table: string) => void;
  onDoubleClickTable?: (db: string, table: string) => void;
  onClickColumn: (db: string, table: string, column: string) => void;
  onRequestSuggestions: (db: string, table: string) => void;
  onTableContextMenu?: (
    e: { clientX: number; clientY: number; preventDefault: () => void },
    db: string,
    table: string,
  ) => void;
  onDbContextMenu?: (
    e: { clientX: number; clientY: number; preventDefault: () => void },
    db: string,
  ) => void;
};

function tableKey(db: string, table: string): string {
  return `${db}.${table}`;
}

function columnKey(db: string, table: string, column: string): string {
  return `${db}.${table}.${column}`;
}

function tableIcon(kind: string): string {
  if (kind === "view") return "◫";
  if (kind === "system") return "◌";
  return "⊞";
}

type Tag = { label: string; cls: string };

function columnTags(c: ColumnMetaForTree, isPii: boolean): Tag[] {
  const tags: Tag[] = [];
  if (c.is_primary) tags.push({ label: "PK", cls: "bg-warn-soft text-warn" });
  if (c.is_foreign_key) tags.push({ label: "FK", cls: "bg-info-soft text-info" });
  if (c.is_indexed && !c.is_primary && !c.is_foreign_key)
    tags.push({ label: "IDX", cls: "bg-bg text-muted" });
  if (isPii) tags.push({ label: "PII", cls: "bg-pii-soft text-pii" });
  return tags;
}

export function SchemaTreeView({
  databases,
  visibleDbs,
  tablesByDb,
  columnsByTableKey,
  expandedDbs,
  expandedTables,
  objectsByKey,
  expandedObjectGroups,
  onToggleObjectGroup,
  onClickObject,
  piiTables,
  piiColumns,
  selectedKey,
  query,
  filters,
  onToggleDb,
  onToggleTable,
  onClickTable,
  onDoubleClickTable,
  onClickColumn,
  onRequestSuggestions,
  onTableContextMenu,
  onDbContextMenu,
}: Props) {
  const q = query.trim().toLowerCase();
  const filterActive = q.length > 0 || filters.size > 0;

  function tableMatches(db: string, t: TableMetaForTree): boolean {
    if (q && !t.name.toLowerCase().includes(q)) {
      const cols = columnsByTableKey[tableKey(db, t.name)] ?? [];
      const colMatch = cols.some((c) => c.name.toLowerCase().includes(q));
      if (!colMatch) return false;
    }
    if (filters.has("pii") && !piiTables.has(tableKey(db, t.name))) {
      const cols = columnsByTableKey[tableKey(db, t.name)] ?? [];
      const colPii = cols.some((c) => piiColumns.has(columnKey(db, t.name, c.name)));
      if (!colPii) return false;
    }
    if (filters.has("fk") || filters.has("indexed")) {
      const cols = columnsByTableKey[tableKey(db, t.name)] ?? [];
      if (cols.length === 0) return false;
      const need = (c: ColumnMetaForTree) =>
        (!filters.has("fk") || c.is_foreign_key) &&
        (!filters.has("indexed") || c.is_indexed);
      if (!cols.some(need)) return false;
    }
    return true;
  }

  function columnMatches(db: string, table: string, c: ColumnMetaForTree): boolean {
    if (q) {
      const nameHit = c.name.toLowerCase().includes(q);
      const tableHit = table.toLowerCase().includes(q);
      if (!nameHit && !tableHit) return false;
    }
    const pii = piiColumns.has(columnKey(db, table, c.name));
    if (filters.has("pii") && !pii && !piiTables.has(tableKey(db, table))) return false;
    if (filters.has("fk") && !c.is_foreign_key) return false;
    if (filters.has("indexed") && !c.is_indexed) return false;
    return true;
  }

  const expandWhenFiltering = useMemo(
    () => (filterActive ? new Set(visibleDbs) : null),
    [filterActive, visibleDbs],
  );

  const expandTableWhenFiltering = useMemo(() => {
    if (!filterActive) return null;
    const s = new Set<string>();
    for (const db of visibleDbs) {
      const tables = tablesByDb[db] ?? [];
      for (const t of tables) {
        if (tableMatches(db, t)) s.add(tableKey(db, t.name));
      }
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive, visibleDbs, tablesByDb, q, filters, columnsByTableKey, piiTables, piiColumns]);

  if (databases.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] text-muted italic">
        No databases loaded.
      </div>
    );
  }

  return (
    <ul>
      {visibleDbs.map((db) => {
        const expanded = expandWhenFiltering ? expandWhenFiltering.has(db) : expandedDbs.has(db);
        const tables = tablesByDb[db];
        const isSystem = SYSTEM_DBS.has(db);
        const matchedTables = tables ? tables.filter((t) => tableMatches(db, t)) : null;
        if (filterActive && matchedTables && matchedTables.length === 0) return null;
        return (
          <li key={db}>
            <div
              onContextMenu={
                onDbContextMenu
                  ? (e) => {
                      e.stopPropagation();
                      onDbContextMenu(e, db);
                    }
                  : undefined
              }
            >
              <TreeGroupRow
                expanded={expanded}
                onClick={() => onToggleDb(db)}
                label={db}
                muted={isSystem}
              trailing={
                tables ? (
                  <span className="text-[10px] text-subtle font-mono shrink-0">
                    {fmtCount(tables.length) || tables.length}
                  </span>
                ) : undefined
              }
            />
            </div>
            {expanded && tables && (
              <ul className="ml-[12px]">
                {(matchedTables ?? tables).length === 0 && (
                  <li className="pl-7 py-0.5 text-[11px] text-subtle italic">
                    (empty)
                  </li>
                )}
                {(matchedTables ?? tables).map((t) => {
                  const tkey = tableKey(db, t.name);
                  const hasPii = piiTables.has(tkey);
                  const tableExpanded = expandTableWhenFiltering
                    ? expandTableWhenFiltering.has(tkey)
                    : expandedTables.has(tkey);
                  const cols = columnsByTableKey[tkey];
                  const selected = selectedKey === tkey;
                  const matchedCols = cols
                    ? cols.filter((c) => columnMatches(db, t.name, c))
                    : null;
                  return (
                    <li key={t.name}>
                      <div
                        className={`group flex items-center pl-2 pr-1 rounded ${
                          selected ? "bg-acc-soft" : "hover:bg-bg"
                        }`}
                        onContextMenu={
                          onTableContextMenu
                            ? (e) => {
                                e.stopPropagation();
                                onTableContextMenu(e, db, t.name);
                              }
                            : undefined
                        }
                      >
                        <button
                          onClick={() => onToggleTable(db, t.name)}
                          className="w-3 h-[26px] flex items-center justify-center text-[9px] text-subtle shrink-0"
                          title={tableExpanded ? "Collapse" : "Expand columns"}
                        >
                          {tableExpanded ? "▾" : "▸"}
                        </button>
                        <button
                          onClick={() => onClickTable(db, t.name)}
                          onDoubleClick={
                            onDoubleClickTable
                              ? () => onDoubleClickTable(db, t.name)
                              : undefined
                          }
                          className="flex-1 flex items-center gap-1.5 h-[26px] min-w-0 text-left"
                          title={t.comment || `SELECT * FROM ${db}.${t.name} LIMIT 100`}
                        >
                          <span className="text-subtle text-[10px] shrink-0">
                            {tableIcon(t.kind)}
                          </span>
                          <span
                            className={`text-[12px] truncate ${
                              selected ? "text-acc-ink font-semibold" : "text-ink-2"
                            }`}
                          >
                            {t.name}
                          </span>
                          {hasPii && (
                            <span className="w-[5px] h-[5px] rounded-full bg-pii shrink-0" />
                          )}
                          {t.estimated_rows > 0 && (
                            <span className="ml-auto text-[10px] font-mono text-subtle tabular-nums shrink-0">
                              {fmtCount(t.estimated_rows)}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => onRequestSuggestions(db, t.name)}
                          className="opacity-0 group-hover:opacity-100 text-[11px] text-muted hover:text-ink px-1 shrink-0"
                          title="AI suggest queries"
                        >
                          💡
                        </button>
                      </div>
                      {tableExpanded && cols && (
                        <ul className="ml-[28px]">
                          {(matchedCols ?? cols).length === 0 && (
                            <li className="pl-2 py-0.5 text-[11px] text-subtle italic">
                              (no columns)
                            </li>
                          )}
                          {(matchedCols ?? cols).map((c) => {
                            const ckey = columnKey(db, t.name, c.name);
                            const isPii = piiColumns.has(ckey);
                            const tags = columnTags(c, isPii);
                            const colSelected = selectedKey === ckey;
                            return (
                              <li key={c.name}>
                                <button
                                  onClick={() => onClickColumn(db, t.name, c.name)}
                                  title={c.column_type + (c.nullable ? " · NULL" : " · NOT NULL")}
                                  className={`w-full flex items-center gap-1.5 h-[22px] pl-2 pr-1 rounded font-mono text-[11px] min-w-0 ${
                                    colSelected ? "bg-acc-soft" : "hover:bg-bg"
                                  }`}
                                >
                                  <span
                                    className={`truncate ${
                                      colSelected ? "text-acc-ink font-semibold" : "text-ink-2"
                                    }`}
                                  >
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
                                </button>
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
            {expanded && objectsByKey && !isSystem && !filterActive && (
              <ul className="ml-[12px]">
                {OBJECT_GROUPS.map((g) => {
                  const gkey = `${db}::${g.kind}`;
                  const objs = objectsByKey[gkey];
                  const groupExpanded = expandedObjectGroups?.has(gkey) ?? false;
                  return (
                    <li key={g.kind}>
                      <TreeGroupRow
                        expanded={groupExpanded}
                        onClick={() => onToggleObjectGroup?.(db, g.kind)}
                        label={g.label}
                        muted
                        trailing={
                          objs ? (
                            <span className="text-[10px] text-subtle font-mono shrink-0">
                              {objs.length}
                            </span>
                          ) : undefined
                        }
                      />
                      {groupExpanded && objs && (
                        <ul className="ml-[28px]">
                          {objs.length === 0 && (
                            <li className="pl-2 py-0.5 text-[11px] text-subtle italic">
                              (none)
                            </li>
                          )}
                          {objs.map((o) => (
                            <li key={o.name}>
                              <button
                                onClick={() => onClickObject?.(db, g.kind, o.name)}
                                title={o.detail || o.name}
                                className="w-full flex items-center gap-1.5 h-[22px] pl-2 pr-1 rounded text-[11px] min-w-0 hover:bg-bg"
                              >
                                <span className="text-subtle text-[10px] shrink-0">{g.icon}</span>
                                <span className="text-ink-2 truncate">{o.name}</span>
                                {o.detail && (
                                  <span className="ml-auto text-[10px] text-subtle truncate max-w-[110px] shrink-0">
                                    {o.detail}
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
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
