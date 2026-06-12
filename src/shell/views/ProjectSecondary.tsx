import { useMemo } from "react";
import type { Connection, ProjectRelation, SavedQuery } from "../../types";
import { Section } from "../atoms/Section";
import { SavedQueriesSection } from "../atoms/SavedQueriesSection";

type Props = {
  relations: ProjectRelation[];
  connections: Connection[];
  /** All connection ids the project depends on. */
  requiredConnIds: number[];
  openConnIds: Set<number>;
  missingConnIds: number[];
  unlockingAll: boolean;
  onOpenConn: (id: number) => void;
  onOpenAllMissing: () => void;
  onRemoveRelation: (id: number) => void;
  savedQueries: SavedQuery[];
  onOpenSavedQuery: (q: SavedQuery) => void;
  onSavedQueryContextMenu?: (q: SavedQuery, e: React.MouseEvent) => void;
};

export function ProjectSecondary({
  relations,
  connections,
  requiredConnIds,
  openConnIds,
  missingConnIds,
  unlockingAll,
  onOpenConn,
  onOpenAllMissing,
  onRemoveRelation,
  savedQueries,
  onOpenSavedQuery,
  onSavedQueryContextMenu,
}: Props) {
  const connLabel = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of connections) {
      if (c.id != null) m.set(c.id, c.name);
    }
    return (id: number) => m.get(id) ?? `#${id}`;
  }, [connections]);

  if (
    relations.length === 0 &&
    requiredConnIds.length === 0 &&
    savedQueries.length === 0
  ) {
    return null;
  }

  return (
    <>
      <SavedQueriesSection
        queries={savedQueries}
        connections={connections}
        groupByConnection
        onOpen={onOpenSavedQuery}
        onContextMenu={onSavedQueryContextMenu}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
      <Section title={`Relations [${relations.length}]`} flush>
        {relations.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-subtle italic">No relations.</div>
        ) : (
          <ul>
            {relations.map((r) => {
              const crossConn = r.from_connection_id !== r.to_connection_id;
              const crossDb = !crossConn && r.from_db !== r.to_db;
              return (
                <li
                  key={r.id}
                  className="group px-2 py-1 hover:bg-bg flex items-center gap-1"
                >
                  <div className="flex-1 min-w-0 text-[10.5px] font-mono text-ink-2 truncate">
                    <span title={`${r.from_db}.${r.from_table}.${r.from_column}`}>
                      {r.from_table}.{r.from_column}
                    </span>
                    <span className="text-muted"> → </span>
                    <span title={`${r.to_db}.${r.to_table}.${r.to_column}`}>
                      {r.to_table}.{r.to_column}
                    </span>
                    <div className="text-[9.5px] text-subtle flex items-center gap-1 mt-0.5">
                      <span>{r.cardinality}</span>
                      {crossConn && (
                        <span className="px-1 bg-pii-soft text-pii rounded font-sans font-bold">
                          X-CONN
                        </span>
                      )}
                      {crossDb && (
                        <span className="px-1 bg-acc-soft text-acc-ink rounded font-sans font-bold">
                          X-DB
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => onRemoveRelation(r.id)}
                    className="opacity-0 group-hover:opacity-100 text-[10px] text-crit hover:underline px-1"
                    title="Remove relation"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      </div>

      <div className="shrink-0">
      <Section
        title={`Connections [${requiredConnIds.length - missingConnIds.length}/${requiredConnIds.length}]`}
        actions={
          missingConnIds.length > 1 && (
            <button
              onClick={onOpenAllMissing}
              disabled={unlockingAll}
              className="text-[10px] text-acc hover:text-acc-ink px-1 disabled:opacity-50"
              title="Open all closed connections"
            >
              {unlockingAll ? "Opening…" : `Open all (${missingConnIds.length})`}
            </button>
          )
        }
        bordered={false}
        flush
      >
        {requiredConnIds.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-subtle italic">
            No connections required.
          </div>
        ) : (
          <ul>
            {requiredConnIds.map((id) => {
              const open = openConnIds.has(id);
              return (
                <li
                  key={id}
                  className="px-2 py-0.5 flex items-center gap-1.5 text-[11.5px]"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${open ? "bg-ok" : "bg-subtle"}`}
                    style={
                      open ? { boxShadow: "0 0 0 2px rgba(2,122,72,0.12)" } : {}
                    }
                  />
                  <span className="flex-1 truncate text-ink-2" title={connLabel(id)}>
                    {connLabel(id)}
                  </span>
                  {!open && (
                    <button
                      onClick={() => onOpenConn(id)}
                      className="text-[10.5px] text-acc hover:text-acc-ink px-1"
                    >
                      open
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      </div>
    </>
  );
}
