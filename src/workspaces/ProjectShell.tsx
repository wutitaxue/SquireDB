import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Connection,
  DrillContext,
  DrillNode,
  DrillResult,
  Injection,
  Project,
  ProjectRelation,
  ProjectTable,
  SavedQuery,
} from "../types";
import type {
  DrillHistoryEntry,
  ProjectAgentId,
  Tab,
} from "../shell/types";
import {
  PROJECT_AGENT_META,
  PROJECT_AGENT_ORDER,
} from "../shell/types";
import { WorkspaceSidebar } from "../shell/WorkspaceSidebar";
import { WorkspaceDock } from "../shell/WorkspaceDock";
import type { AgentItem, DockActivityItem } from "../shell/WorkspaceDock";
import { SearchBar, type FilterChipDef } from "../shell/atoms/SearchBar";
import {
  ProjectTreeView,
  type ProjectTreeFilter,
} from "../shell/views/ProjectTreeView";
import { ProjectSecondary } from "../shell/views/ProjectSecondary";
import { ProjectBriefingWorkspace } from "./ProjectBriefingWorkspace";
import { ProjectDictionaryWorkspace } from "./ProjectDictionaryWorkspace";
import { ProjectErDiagramWorkspace } from "./ProjectErDiagramWorkspace";
import { ProjectHealthWorkspace } from "./ProjectHealthWorkspace";
import { ProjectImpactWorkspace } from "./ProjectImpactWorkspace";
import { ProjectSchemaDiffWorkspace } from "./ProjectSchemaDiffWorkspace";
import { ProjectSlowQueriesWorkspace } from "./ProjectSlowQueriesWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { QueryWorkspace } from "./QueryWorkspace";
import { TableDesignerWorkspace } from "./TableDesignerWorkspace";
import { parseLookupValue } from "../utils";
import { formatTime } from "../utils";

type ProjectStats = {
  tableCount: number;
  connsOpen: number;
  connsTotal: number;
};

type Props = {
  project: Project;
  connections: Connection[];
  /** Currently active tab — drill, agent, or query. */
  activeTab: Tab | null;
  onOpenAgent: (agent: ProjectAgentId) => void;
  onCloseTab: (tabId: string) => void;
  onEditProject: () => void;
  onStatsChange?: (stats: ProjectStats) => void;
  dockOpen: boolean;

  /** Single-click on a project table — preview data in a query tab. */
  onTablePreview: (t: ProjectTable) => void;
  /** Double-click on a project table — switch to drill tab + adopt root. */
  onTableDrill: (t: ProjectTable) => void;
  /** Right-click on a project table — designer / copy actions. */
  onTableContextMenu?: (
    e: { clientX: number; clientY: number; preventDefault: () => void },
    t: ProjectTable,
  ) => void;
  /**
   * Set when App's openProjectDrill fires — ProjectShell adopts this as the
   * lookup root and then calls onAckPendingDrill to clear the slot.
   */
  pendingDrillTable: ProjectTable | null;
  /** Acknowledge that we adopted the pending drill table. */
  onAckPendingDrill: () => void;

  /** Query tab injection map keyed by tab id. */
  queryInjections: Record<string, Injection>;
  onExecuted: (connId: number) => void;
  /** Save button in QueryWorkspace → opens the SaveQueryModal owned by App. */
  onRequestSaveQuery: (connectionId: number, sql: string) => void;
  /** Click a saved query in the sidebar → opens a new query tab. */
  onOpenSavedQuery: (q: SavedQuery) => void;
  /** Right-click a saved query → caller opens the rename / delete menu. */
  onSavedQueryContextMenu?: (q: SavedQuery, e: React.MouseEvent) => void;

  /**
   * Bump from the outside to force a refresh of project tables / relations
   * (e.g. when the Edit project modal commits a change).
   */
  refreshKey?: number;
};

const PROJECT_TREE_CHIPS: FilterChipDef[] = [
  { id: "x-conn", label: "X-CONN" },
  { id: "x-db", label: "X-DB" },
  { id: "closed", label: "Closed" },
];

export function ProjectShell({
  project,
  connections,
  activeTab,
  onOpenAgent,
  onCloseTab,
  onEditProject,
  onStatsChange,
  dockOpen,
  onTablePreview,
  onTableDrill,
  onTableContextMenu,
  pendingDrillTable,
  onAckPendingDrill,
  queryInjections,
  onExecuted,
  onRequestSaveQuery,
  onOpenSavedQuery,
  onSavedQueryContextMenu,
  refreshKey,
}: Props) {
  const [tables, setTables] = useState<ProjectTable[]>([]);
  const [relations, setRelations] = useState<ProjectRelation[]>([]);
  const [openConnIds, setOpenConnIds] = useState<Set<number>>(new Set());
  const [unlockingAll, setUnlockingAll] = useState(false);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  const [lookupTable, setLookupTable] = useState<ProjectTable | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [column, setColumn] = useState("");
  const [valueInput, setValueInput] = useState("");

  const [stack, setStack] = useState<DrillContext[]>([]);
  const [result, setResult] = useState<DrillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [recent, setRecent] = useState<DrillHistoryEntry[]>([]);
  const [treeQuery, setTreeQuery] = useState("");
  const [treeFilters, setTreeFilters] = useState<Set<ProjectTreeFilter>>(new Set());

  async function refreshOpenConns() {
    try {
      const ids = await invoke<number[]>("list_open_connection_ids");
      setOpenConnIds(new Set(ids));
    } catch {
      // best-effort
    }
  }

  async function refreshRecent() {
    if (!project.id) return;
    try {
      const list = await invoke<DrillHistoryEntry[]>("list_drill_history", {
        projectId: project.id,
        limit: 8,
      });
      setRecent(list);
    } catch {
      // ignore
    }
  }

  async function refreshTables(projectId: number) {
    try {
      const [tableList, relList] = await Promise.all([
        invoke<ProjectTable[]>("list_project_tables", { projectId }),
        invoke<ProjectRelation[]>("list_project_relations", { projectId }),
      ]);
      setTables(tableList);
      setRelations(relList);
      setLookupTable((prev) => {
        if (prev) {
          const match = tableList.find(
            (t) =>
              t.connection_id === prev.connection_id &&
              t.database_name === prev.database_name &&
              t.table_name === prev.table_name,
          );
          if (match) return match;
        }
        return tableList.find((t) => t.is_primary === 1) ?? tableList[0] ?? null;
      });
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!project.id) return;
    let cancelled = false;
    (async () => {
      await refreshTables(project.id!);
      if (cancelled) return;
      await refreshOpenConns();
      if (cancelled) return;
      await refreshRecent();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, refreshKey]);

  // Adopt a drill table dispatched from App (double-click in sidebar).
  useEffect(() => {
    if (!pendingDrillTable) return;
    const match =
      tables.find(
        (t) =>
          t.connection_id === pendingDrillTable.connection_id &&
          t.database_name === pendingDrillTable.database_name &&
          t.table_name === pendingDrillTable.table_name,
      ) ?? pendingDrillTable;
    setLookupTable(match);
    onAckPendingDrill();
  }, [pendingDrillTable, tables, onAckPendingDrill]);

  const requiredConnIds = useMemo(() => {
    const s = new Set<number>();
    for (const t of tables) s.add(t.connection_id);
    for (const r of relations) {
      s.add(r.from_connection_id);
      s.add(r.to_connection_id);
    }
    return s;
  }, [tables, relations]);

  const requiredConnIdsArr = useMemo(
    () => Array.from(requiredConnIds).sort((a, b) => a - b),
    [requiredConnIds],
  );

  const missingConnIds = useMemo(
    () => requiredConnIdsArr.filter((id) => !openConnIds.has(id)),
    [requiredConnIdsArr, openConnIds],
  );

  useEffect(() => {
    if (!onStatsChange) return;
    onStatsChange({
      tableCount: tables.length,
      connsOpen: requiredConnIds.size - missingConnIds.length,
      connsTotal: requiredConnIds.size,
    });
  }, [tables.length, requiredConnIds, missingConnIds, onStatsChange]);

  useEffect(() => {
    if (requiredConnIdsArr.length === 0) {
      setSavedQueries([]);
      return;
    }
    let cancelled = false;
    invoke<SavedQuery[]>("list_saved_queries_for_connections", {
      connectionIds: requiredConnIdsArr,
    })
      .then((list) => {
        if (!cancelled) setSavedQueries(list);
      })
      .catch(() => {
        if (!cancelled) setSavedQueries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [requiredConnIdsArr, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    if (!lookupTable) {
      setColumns([]);
      setColumn("");
      return;
    }
    if (!openConnIds.has(lookupTable.connection_id)) {
      setColumns([]);
      return;
    }
    (async () => {
      try {
        const cols = await invoke<string[]>("list_columns", {
          connectionId: lookupTable.connection_id,
          database: lookupTable.database_name,
          table: lookupTable.table_name,
        });
        if (cancelled) return;
        setColumns(cols);
        setColumn((prev) => {
          if (prev && cols.includes(prev)) return prev;
          const pkLike = cols.find((c) => c.toLowerCase() === "id") ?? cols[0] ?? "";
          return pkLike;
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lookupTable, openConnIds]);

  async function drillTo(ctx: DrillContext, pushOnly: boolean) {
    if (!project.id) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const r = await invoke<DrillResult>("drill_project", {
        connectionId: ctx.connectionId,
        projectId: project.id,
        database: ctx.db,
        table: ctx.table,
        column: ctx.column,
        value: ctx.value,
      });
      setResult(r);
      if (pushOnly) {
        setStack((s) => [...s, ctx]);
      } else {
        setStack([ctx]);
      }
      void refreshRecent();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function lookup() {
    if (!lookupTable || !column) return;
    const parsed = parseLookupValue(valueInput);
    await drillTo(
      {
        connectionId: lookupTable.connection_id,
        db: lookupTable.database_name,
        table: lookupTable.table_name,
        column,
        value: parsed,
        label: `${lookupTable.table_name}#${valueInput}`,
      },
      false,
    );
  }

  async function jumpTo(idx: number) {
    const ctx = stack[idx];
    if (!ctx) return;
    setStack((s) => s.slice(0, idx + 1));
    await drillTo(ctx, false);
    setStack(stack.slice(0, idx + 1));
  }

  async function drillIntoRow(node: DrillNode, row: Record<string, unknown>) {
    const v = row[node.to_column];
    if (v === undefined || v === null) return;
    const label = `${node.to_table}#${String(v)}`;
    await drillTo(
      {
        connectionId: node.to_connection_id,
        db: node.to_db,
        table: node.to_table,
        column: node.to_column,
        value: v,
        label,
      },
      true,
    );
  }

  async function openConn(connId: number) {
    setError("");
    try {
      await invoke("open_connection", { id: connId });
      await refreshOpenConns();
    } catch (e) {
      setError(String(e));
    }
  }

  async function openAllMissing() {
    if (missingConnIds.length === 0) return;
    setUnlockingAll(true);
    setError("");
    try {
      const results = await Promise.allSettled(
        missingConnIds.map((id) => invoke("open_connection", { id })),
      );
      const failures = results
        .map((r, i) =>
          r.status === "rejected" ? { id: missingConnIds[i], err: r.reason } : null,
        )
        .filter((x): x is { id: number; err: unknown } => x !== null);
      await refreshOpenConns();
      if (failures.length > 0) {
        const lines = failures.map((f) => `  • #${f.id}: ${f.err}`).join("\n");
        setError(`Failed to open ${failures.length} connection(s):\n${lines}`);
      }
    } finally {
      setUnlockingAll(false);
    }
  }

  async function removeRelation(id: number) {
    if (!project.id) return;
    setError("");
    try {
      await invoke("remove_project_relation", { relationId: id });
      await refreshTables(project.id);
    } catch (e) {
      setError(String(e));
    }
  }

  function pickRecent(e: DrillHistoryEntry) {
    const match = tables.find(
      (t) =>
        t.connection_id === e.connection_id &&
        t.database_name === e.database_name &&
        t.table_name === e.table_name,
    );
    if (match) setLookupTable(match);
    setColumn(e.column_name);
    let display = e.value_json;
    try {
      const v = JSON.parse(e.value_json);
      if (typeof v === "string") display = v;
      else display = String(v);
    } catch {
      // keep raw
    }
    setValueInput(display);
  }

  function toggleTreeFilter(id: string) {
    setTreeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id as ProjectTreeFilter)) next.delete(id as ProjectTreeFilter);
      else next.add(id as ProjectTreeFilter);
      return next;
    });
  }

  const breadcrumb = stack.map((c, i) => ({
    label: c.label,
    isCurrent: i === stack.length - 1,
    onClick: () => void jumpTo(i),
  }));

  const lookupTableClosed = lookupTable
    ? !openConnIds.has(lookupTable.connection_id)
    : false;

  const activeAgent: ProjectAgentId | null =
    activeTab?.kind === "project-agent" ? activeTab.agent : null;

  const projectAgents: AgentItem[] = PROJECT_AGENT_ORDER.map((id) => ({
    id,
    name: PROJECT_AGENT_META[id].name,
    sub: PROJECT_AGENT_META[id].sub,
    icon: PROJECT_AGENT_META[id].icon,
    ...(id === "briefing" ||
    id === "health" ||
    id === "impact" ||
    id === "dictionary" ||
    id === "slow-query" ||
    id === "schema-diff" ||
    id === "er-diagram"
      ? {}
      : { badge: { text: "soon", tone: "info" as const } }),
  }));

  const activity: DockActivityItem[] = recent.map((e) => {
    const value = formatRecentValue(e.value_json);
    return {
      icon: "🔍",
      text: (
        <span className="font-mono">
          {e.table_name}.{e.column_name} = {value}
        </span>
      ),
      when: formatTime(e.executed_at),
      onClick: () => pickRecent(e),
    };
  });

  const queryTabConn =
    activeTab?.kind === "query"
      ? connections.find((c) => c.id === activeTab.connectionId) ?? null
      : null;

  return (
    <>
      <WorkspaceSidebar
        toolbar={
          <SearchBar
            query={treeQuery}
            onQueryChange={setTreeQuery}
            placeholder="Search project…"
            chips={PROJECT_TREE_CHIPS}
            active={treeFilters as Set<string>}
            onToggleChip={toggleTreeFilter}
            trailing={
              <button
                onClick={onEditProject}
                className="text-[10px] text-acc hover:text-acc-ink shrink-0"
                title="Edit project"
              >
                ✎ edit
              </button>
            }
          />
        }
        tree={
          <ProjectTreeView
            tables={tables}
            connections={connections}
            openConnIds={openConnIds}
            lookupTable={lookupTable}
            query={treeQuery}
            filters={treeFilters}
            onTablePreview={onTablePreview}
            onTableDrill={onTableDrill}
            onTableContextMenu={onTableContextMenu}
          />
        }
        secondary={
          <ProjectSecondary
            relations={relations}
            connections={connections}
            requiredConnIds={requiredConnIdsArr}
            openConnIds={openConnIds}
            missingConnIds={missingConnIds}
            unlockingAll={unlockingAll}
            onOpenConn={(id) => void openConn(id)}
            onOpenAllMissing={() => void openAllMissing()}
            onRemoveRelation={(id) => void removeRelation(id)}
            savedQueries={savedQueries}
            onOpenSavedQuery={onOpenSavedQuery}
            onSavedQueryContextMenu={onSavedQueryContextMenu}
          />
        }
      />

      <main className="flex-1 min-w-0 flex flex-col bg-bg overflow-hidden relative">
        {activeTab?.kind === "project-agent" ? (
          activeTab.agent === "briefing" ? (
            <ProjectBriefingWorkspace
              projectId={project.id!}
              projectName={project.name}
              onClose={() => onCloseTab(activeTab.id)}
            />
          ) : activeTab.agent === "health" ? (
            <ProjectHealthWorkspace
              projectId={project.id!}
              projectName={project.name}
              onClose={() => onCloseTab(activeTab.id)}
            />
          ) : activeTab.agent === "impact" ? (
            <ProjectImpactWorkspace
              projectId={project.id!}
              projectName={project.name}
              onClose={() => onCloseTab(activeTab.id)}
            />
          ) : activeTab.agent === "dictionary" ? (
            <ProjectDictionaryWorkspace
              projectId={project.id!}
              projectName={project.name}
              onClose={() => onCloseTab(activeTab.id)}
            />
          ) : activeTab.agent === "slow-query" ? (
            <ProjectSlowQueriesWorkspace
              projectId={project.id!}
              projectName={project.name}
              onClose={() => onCloseTab(activeTab.id)}
            />
          ) : activeTab.agent === "schema-diff" ? (
            <ProjectSchemaDiffWorkspace
              projectId={project.id!}
              projectName={project.name}
              onClose={() => onCloseTab(activeTab.id)}
            />
          ) : activeTab.agent === "er-diagram" ? (
            <ProjectErDiagramWorkspace
              projectId={project.id!}
              projectName={project.name}
              onClose={() => onCloseTab(activeTab.id)}
            />
          ) : (
            <ProjectAgentComingSoon agent={activeTab.agent} />
          )
        ) : activeTab?.kind === "query" && queryTabConn ? (
          <QueryWorkspace
            conn={queryTabConn}
            injection={queryInjections[activeTab.id] ?? { sql: "SELECT 1", autorun: false, nonce: 0 }}
            onAiInject={() => {}}
            onExecuted={onExecuted}
            onRequestSaveQuery={onRequestSaveQuery}
          />
        ) : activeTab?.kind === "table-designer" ? (
          <TableDesignerWorkspace
            connectionId={activeTab.connectionId}
            database={activeTab.database}
            table={activeTab.table}
            onApplied={() => onCloseTab(activeTab.id)}
          />
        ) : (
          <ProjectWorkspace
            lookupTable={lookupTable}
            lookupTableClosed={lookupTableClosed}
            columns={columns}
            column={column}
            onColumnChange={setColumn}
            value={valueInput}
            onValueChange={setValueInput}
            onLookup={() => void lookup()}
            busy={busy}
            error={error}
            result={result}
            breadcrumb={breadcrumb}
            onDrillRow={(node, row) => void drillIntoRow(node, row)}
            onUnlockConnection={async (connId) => {
              await openConn(connId);
              if (stack.length > 0) {
                await drillTo(stack[stack.length - 1], false);
              }
            }}
          />
        )}
      </main>

      {dockOpen && (
        <WorkspaceDock
          title="Project Agents"
          agents={projectAgents}
          activeAgentId={activeAgent}
          onOpenAgent={(id) => onOpenAgent(id as ProjectAgentId)}
          activity={activity}
          activityEmptyLabel="No recent drills."
        />
      )}
    </>
  );
}

function ProjectAgentComingSoon({ agent }: { agent: ProjectAgentId }) {
  const meta = PROJECT_AGENT_META[agent];
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <div className="text-[40px] mb-3 opacity-60">{meta.icon}</div>
        <h2 className="text-[16px] font-bold text-ink mb-2">{meta.name}</h2>
        <p className="text-[12px] text-muted mb-4">{meta.sub}</p>
        <div className="inline-block px-3 py-1.5 rounded-md bg-acc-soft text-acc-ink text-[11px] font-semibold">
          Coming soon
        </div>
      </div>
    </div>
  );
}

function formatRecentValue(json: string): string {
  try {
    const v = JSON.parse(json);
    if (v === null) return "null";
    if (typeof v === "string") return v.length > 24 ? v.slice(0, 24) + "…" : v;
    return String(v);
  } catch {
    return json;
  }
}
