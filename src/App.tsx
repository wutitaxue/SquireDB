import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  emptyConnection,
  SYSTEM_DBS,
  type Annotation,
  type ColumnMetaForTree,
  type Connection,
  type HistoryEntry,
  type Injection,
  type Project,
  type ProjectTable,
  type QuerySuggestion,
  type Relation,
  type RuntimeStatus,
  type TableMetaForTree,
} from "./types";
import { EditForm } from "./components/EditForm";
import { SettingsModal } from "./components/SettingsModal";
import { ProjectEditorModal } from "./components/ProjectEditorModal";
import { QueryWorkspace } from "./workspaces/QueryWorkspace";
import { useStableCallback } from "./hooks/useStableCallback";
import { ProjectShell } from "./workspaces/ProjectShell";
import { PerformanceWorkspace } from "./workspaces/PerformanceWorkspace";
import { SchemaDiffWorkspace } from "./workspaces/SchemaDiffWorkspace";
import { HealthCheckWorkspace } from "./workspaces/HealthCheckWorkspace";
import { OnboardingWorkspace } from "./workspaces/OnboardingWorkspace";
import { ImpactWorkspace } from "./workspaces/ImpactWorkspace";
import { DictionaryWorkspace } from "./workspaces/DictionaryWorkspace";
import { AnalyzeSchemaWorkspace } from "./workspaces/AnalyzeSchemaWorkspace";
import { InferRelationsWorkspace } from "./workspaces/InferRelationsWorkspace";
import { RepairWorkspace } from "./workspaces/RepairWorkspace";
import { ErDiagramWorkspace } from "./workspaces/ErDiagramWorkspace";
import { DeadlockWorkspace } from "./workspaces/DeadlockWorkspace";
import { MilvusSearchWorkspace } from "./workspaces/MilvusSearchWorkspace";
import { RedisExplorerShell } from "./workspaces/RedisExplorerShell";
import { Titlebar } from "./shell/Titlebar";
import { Tabbar } from "./shell/Tabbar";
import { WorkspaceSidebar } from "./shell/WorkspaceSidebar";
import { WorkspaceDock } from "./shell/WorkspaceDock";
import type {
  AgentBadge,
  AgentItem,
  DockActivityItem,
  DockInsight,
} from "./shell/WorkspaceDock";
import { SearchBar, type FilterChipDef } from "./shell/atoms/SearchBar";
import { SchemaTreeView, type SchemaFilter } from "./shell/views/SchemaTreeView";
import { ConnSecondary } from "./shell/views/ConnSecondary";
import { Statusbar } from "./shell/Statusbar";
import {
  AGENT_META,
  agentTabId,
  PROJECT_AGENT_META,
  PROJECT_DRILL_TAB_ID,
  projectAgentTabId,
  queryTabId,
  workspaceKey,
  milvusSearchTabId,
  redisKeyTabId,
  redisConsoleTabId,
  type AgentId,
  type AppMode,
  type ProjectAgentId,
  type Tab,
} from "./shell/types";
import { connectionKindMeta, formatTime } from "./utils";

/**
 * Reused as the fallback injection for any query tab that hasn't been seeded
 * yet. MUST live at module scope — making it a fresh object inside App() each
 * render would give every memoized QueryWorkspace a new `injection` prop
 * reference on every parent state change, defeating React.memo.
 */
const INITIAL_INJECTION: Injection = Object.freeze({
  sql: "SELECT 1",
  autorun: false,
  nonce: 0,
}) as Injection;

function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [mode, setMode] = useState<AppMode>({ kind: "home" });
  const [editing, setEditing] = useState<Connection | null>(null);
  const [password, setPassword] = useState("");
  const [result, setResult] = useState("");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  const [databases, setDatabases] = useState<string[]>([]);
  const [tablesByDb, setTablesByDb] = useState<Record<string, TableMetaForTree[]>>({});
  const [columnsByTableKey, setColumnsByTableKey] = useState<
    Record<string, ColumnMetaForTree[]>
  >({});
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showSystemDbs, setShowSystemDbs] = useState(false);
  const [schemaQuery, setSchemaQuery] = useState("");
  const [schemaFilters, setSchemaFilters] = useState<Set<SchemaFilter>>(new Set());

  const [queryInjections, setQueryInjections] = useState<Record<string, Injection>>({});
  const [lastFocusedQueryTabId, setLastFocusedQueryTabId] = useState<string | null>(null);

  // Stable reference — see INITIAL_INJECTION module constant below.
  const initialInjection = INITIAL_INJECTION;

  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  const [suggestions, setSuggestions] = useState<QuerySuggestion[]>([]);
  const [suggestionsTable, setSuggestionsTable] = useState("");
  const [suggestionsBusy, setSuggestionsBusy] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState("");

  // Per-workspace tabs. Key = workspaceKey(mode). Home has no tabs.
  const [tabsByMode, setTabsByMode] = useState<
    Record<string, { tabs: Tab[]; activeTabId: string | null }>
  >({});
  const [dockOpen, setDockOpen] = useState(true);

  const workingId = mode.kind === "connection" ? mode.connectionId : null;
  const activeProjectId = mode.kind === "project" ? mode.projectId : null;
  const wsKey = workspaceKey(mode);
  const wsEntry = tabsByMode[wsKey] ?? { tabs: [], activeTabId: null };
  const tabs = wsEntry.tabs;
  const activeTabId = wsEntry.activeTabId;
  function setTabs(updater: (prev: Tab[]) => Tab[]) {
    setTabsByMode((m) => {
      const entry = m[wsKey] ?? { tabs: [], activeTabId: null };
      return { ...m, [wsKey]: { ...entry, tabs: updater(entry.tabs) } };
    });
  }
  function setActiveTabId(id: string | null) {
    setTabsByMode((m) => {
      const entry = m[wsKey] ?? { tabs: [], activeTabId: null };
      return { ...m, [wsKey]: { ...entry, activeTabId: id } };
    });
  }

  const [serverStatus, setServerStatus] = useState<RuntimeStatus | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  const working = connections.find((c) => c.id === workingId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const [projectStats, setProjectStats] = useState({
    tableCount: 0,
    connsOpen: 0,
    connsTotal: 0,
  });
  // Bumped whenever the Edit project modal commits a change so ProjectShell
  // re-reads tables / relations without remounting.
  const [projectRefreshKey, setProjectRefreshKey] = useState(0);

  useEffect(() => {
    void refresh();
    void refreshProjects();
  }, []);

  useEffect(() => {
    if (workingId === null) {
      setDatabases([]);
      setTablesByDb({});
      setColumnsByTableKey({});
      setExpandedDbs(new Set());
      setExpandedTables(new Set());
      setSelectedKey(null);
      setHistory([]);
      setAnnotations([]);
      setRelations([]);
      setLastFocusedQueryTabId(null);
      setServerStatus(null);
      setServerVersion(null);
      return;
    }
    const wConn = connections.find((c) => c.id === workingId);
    const isMilvus = wConn?.kind === "milvus";
    const isRedis = wConn?.kind === "redis";

    // Redis has its own explorer shell and doesn't use the SQL schema-tree
    // pipeline. Skip list_databases / history / annotations / relations.
    if (isRedis) {
      setHistory([]);
      setAnnotations([]);
      setRelations([]);
      setDatabases([]);
      return;
    }

    // Schema tree (databases / tables / columns) works for both kinds —
    // backend dispatches by connection.kind. Load for everyone.
    invoke<string[]>("list_databases", { id: workingId })
      .then(setDatabases)
      .catch((err) => {
        setResult(String(err));
        setIsError(true);
      });

    if (isMilvus) {
      // MySQL-only signals stay empty for Milvus. Skip server_status /
      // perf_status / history / annotations / relations. No default tab
      // is created — search tabs open on demand via double-click.
      setHistory([]);
      setAnnotations([]);
      setRelations([]);
      setServerStatus(null);
      setServerVersion(null);
      return;
    }

    invoke<RuntimeStatus>("server_status", { connectionId: workingId })
      .then(setServerStatus)
      .catch(() => {});
    invoke<{ mysql_version: string }>("get_perf_status", { connectionId: workingId })
      .then((s) => setServerVersion(s.mysql_version))
      .catch(() => {});
    void refreshHistory(workingId);
    void refreshInsights(workingId);

    // Ensure this connection workspace has at least one query tab.
    setTabsByMode((m) => {
      const key = `conn:${workingId}`;
      const entry = m[key] ?? { tabs: [], activeTabId: null };
      if (entry.tabs.some((t) => t.kind === "query")) return m;
      const t: Tab = {
        id: queryTabId(workingId),
        kind: "query",
        name: "query.sql",
        connectionId: workingId,
      };
      return {
        ...m,
        [key]: { tabs: [t, ...entry.tabs], activeTabId: t.id },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingId]);

  // Ensure each project workspace has a default drill tab on entry.
  useEffect(() => {
    if (activeProjectId === null) return;
    const key = `proj:${activeProjectId}`;
    setTabsByMode((m) => {
      const entry = m[key] ?? { tabs: [], activeTabId: null };
      if (entry.tabs.some((t) => t.kind === "project-drill")) return m;
      const t: Tab = {
        id: PROJECT_DRILL_TAB_ID,
        kind: "project-drill",
        name: "Drill",
      };
      return {
        ...m,
        [key]: { tabs: [t, ...entry.tabs], activeTabId: t.id },
      };
    });
  }, [activeProjectId]);

  useEffect(() => {
    if (workingId === null) return;
    const wConn = connections.find((c) => c.id === workingId);
    if (wConn?.kind !== "mysql") return; // server_status polling is MySQL-only
    const id = workingId;
    const t = setInterval(() => {
      invoke<RuntimeStatus>("server_status", { connectionId: id })
        .then(setServerStatus)
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingId]);

  useEffect(() => {
    if (!activeTabId) return;
    const t = tabs.find((x) => x.id === activeTabId);
    if (t?.kind === "query") setLastFocusedQueryTabId(activeTabId);
  }, [activeTabId, tabs]);

  async function refreshProjects() {
    try {
      const list = await invoke<Project[]>("list_projects");
      setProjects(list);
    } catch {
      // ignore
    }
  }

  async function refreshInsights(connId: number) {
    try {
      const [anns, rels] = await Promise.all([
        invoke<Annotation[]>("list_annotations", { connectionId: connId, database: null }),
        invoke<Relation[]>("list_relations", { connectionId: connId, database: null }),
      ]);
      setAnnotations(anns);
      setRelations(rels);
    } catch {
      // ignore
    }
  }

  async function refreshHistory(connId: number) {
    try {
      const list = await invoke<HistoryEntry[]>("list_history", {
        connectionId: connId,
        limit: 20,
      });
      setHistory(list);
    } catch {
      // ignore
    }
  }

  async function refresh() {
    try {
      const list = await invoke<Connection[]>("list_connections");
      setConnections(list);
    } catch (err) {
      setResult(String(err));
      setIsError(true);
    }
  }

  function startNew() {
    setEditing({ ...emptyConnection });
    setPassword("");
    setResult("");
    setIsError(false);
  }

  async function startEdit(conn: Connection) {
    setEditing({ ...conn });
    try {
      const pw = await invoke<string>("get_connection_password", { id: conn.id });
      setPassword(pw);
    } catch {
      setPassword("");
    }
    setResult("");
    setIsError(false);
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const saved = await invoke<Connection>("save_connection", {
        conn: editing,
        password,
      });
      await refresh();
      setEditing(null);
      setResult(`Saved "${saved.name}"`);
      setIsError(false);
    } catch (err) {
      setResult(String(err));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection(conn: Connection) {
    if (!conn.id) return;
    if (!confirm(`Delete connection "${conn.name}"?`)) return;
    setBusy(true);
    try {
      await invoke("delete_connection", { id: conn.id });
      if (workingId === conn.id) setMode({ kind: "home" });
      await refresh();
      setResult(`Deleted "${conn.name}"`);
      setIsError(false);
    } catch (err) {
      setResult(String(err));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!editing) return;
    setBusy(true);
    try {
      let msg: string;
      if (editing.kind === "sqlite") {
        msg = await invoke<string>("sqlite_ping", {
          path: editing.database || "",
        });
      } else if (editing.kind === "redis") {
        msg = await invoke<string>("redis_ping", {
          host: editing.host,
          port: editing.port,
          user: editing.username,
          password,
          db: parseInt(editing.database || "0", 10) || 0,
        });
      } else {
        const cmd = editing.kind === "milvus" ? "milvus_ping" : "mysql_ping";
        msg = await invoke<string>(cmd, {
          host: editing.host,
          port: editing.port,
          user: editing.username,
          password,
          database: editing.database || null,
        });
      }
      setResult(msg);
      setIsError(false);
    } catch (err) {
      setResult(String(err));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function openConnection(conn: Connection) {
    if (!conn.id) return;
    if (workingId === conn.id) return;
    setBusy(true);
    setResult("");
    setIsError(false);
    try {
      await invoke("open_connection", { id: conn.id });
      setMode({ kind: "connection", connectionId: conn.id });
    } catch (err) {
      setResult(String(err));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function closeWorkspace() {
    if (workingId === null) return;
    try {
      await invoke("close_connection", { id: workingId });
    } catch {
      // ignore
    }
    setMode({ kind: "home" });
  }

  function goHome() {
    setMode({ kind: "home" });
  }

  async function toggleDb(db: string) {
    if (workingId === null) return;
    if (expandedDbs.has(db)) {
      const next = new Set(expandedDbs);
      next.delete(db);
      setExpandedDbs(next);
      return;
    }
    if (!tablesByDb[db]) {
      try {
        const tables = await invoke<TableMetaForTree[]>("list_table_meta", {
          connectionId: workingId,
          database: db,
        });
        setTablesByDb({ ...tablesByDb, [db]: tables });
      } catch (err) {
        setResult(String(err));
        setIsError(true);
        return;
      }
    }
    setExpandedDbs(new Set([...expandedDbs, db]));
  }

  async function toggleTable(db: string, table: string) {
    if (workingId === null) return;
    const key = `${db}.${table}`;
    if (expandedTables.has(key)) {
      const next = new Set(expandedTables);
      next.delete(key);
      setExpandedTables(next);
      return;
    }
    if (!columnsByTableKey[key]) {
      try {
        const cols = await invoke<ColumnMetaForTree[]>("list_columns_meta", {
          connectionId: workingId,
          database: db,
          table,
        });
        setColumnsByTableKey({ ...columnsByTableKey, [key]: cols });
      } catch (err) {
        setResult(String(err));
        setIsError(true);
        return;
      }
    }
    setExpandedTables(new Set([...expandedTables, key]));
  }

  /**
   * Open / activate a preview query tab for a single table. Shared by both
   * connection mode (clickTable) and project mode (openProjectPreview) — they
   * differ only in (a) whether the connection needs to be opened first and
   * (b) whether to update the schema-tree selection. Tab identity is keyed by
   * (workspace, connection, db, table) so each table gets its own tab and
   * re-clicking the same table re-injects + re-runs.
   */
  async function openTablePreview(opts: {
    connectionId: number;
    db: string;
    table: string;
    /** Tracks schema-tree highlight in connection mode; omit in project mode. */
    selectedKey?: string;
    /** True when the connection pool may not be open yet (project mode). */
    ensureOpen?: boolean;
  }) {
    if (opts.ensureOpen) {
      try {
        await invoke("open_connection", { id: opts.connectionId });
      } catch (e) {
        setResult(String(e));
        setIsError(true);
        return;
      }
    }
    if (opts.selectedKey != null) setSelectedKey(opts.selectedKey);

    const sql = `SELECT * FROM \`${opts.db}\`.\`${opts.table}\` LIMIT 100`;
    const stableId = `query:${wsKey}:${opts.connectionId}:${opts.db}:${opts.table}`;
    // Only inject + auto-run the first time this table tab is created. A
    // subsequent click on the same row just re-activates the existing tab so
    // we don't waste a round-trip re-running an unchanged SELECT *.
    const alreadyOpen = tabs.some((x) => x.id === stableId);
    if (!alreadyOpen) {
      setTabs((prev) => {
        if (prev.some((x) => x.id === stableId)) return prev;
        return [
          ...prev,
          {
            id: stableId,
            kind: "query",
            name: opts.table,
            connectionId: opts.connectionId,
          },
        ];
      });
      setQueryInjections((prev) => {
        const current = prev[stableId] ?? initialInjection;
        return {
          ...prev,
          [stableId]: { sql, autorun: true, nonce: current.nonce + 1 },
        };
      });
    }
    setActiveTabId(stableId);
  }

  function clickTable(db: string, table: string) {
    if (workingId === null) return;
    // Milvus: single-click only highlights the collection in the tree. There
    // is no implicit "preview SELECT" — vector collections have no canonical
    // SELECT shape. Double-click opens a search tab instead.
    if (working?.kind === "milvus") {
      setSelectedKey(`${db}.${table}`);
      return;
    }
    void openTablePreview({
      connectionId: workingId,
      db,
      table,
      selectedKey: `${db}.${table}`,
    });
  }

  function doubleClickTable(db: string, table: string) {
    if (workingId === null) return;
    if (working?.kind === "milvus") {
      openMilvusSearch(workingId, db, table);
    }
    // For MySQL, double-click is a no-op (single-click already previews).
  }

  function clickColumn(db: string, table: string, column: string) {
    setSelectedKey(`${db}.${table}.${column}`);
  }

  function pickTargetQueryTab(): string | null {
    if (activeTabId) {
      const t = tabs.find((x) => x.id === activeTabId);
      if (t?.kind === "query") return t.id;
    }
    if (lastFocusedQueryTabId) {
      const t = tabs.find((x) => x.id === lastFocusedQueryTabId);
      if (t?.kind === "query") return t.id;
    }
    const q = tabs.find((x) => x.kind === "query");
    return q?.id ?? null;
  }

  function injectIntoQueryTab(sql: string, autorun: boolean) {
    const targetId = pickTargetQueryTab();
    if (!targetId) return;
    setQueryInjections((prev) => {
      const current = prev[targetId] ?? initialInjection;
      return {
        ...prev,
        [targetId]: { sql, autorun, nonce: current.nonce + 1 },
      };
    });
    setActiveTabId(targetId);
  }

  async function requestSuggestions(db: string, table: string) {
    if (workingId === null || suggestionsBusy) return;
    setSuggestionsBusy(true);
    setSuggestionsError("");
    setSuggestions([]);
    setSuggestionsTable(`${db}.${table}`);
    try {
      const list = await invoke<QuerySuggestion[]>("suggest_queries", {
        connectionId: workingId,
        database: db,
        table,
      });
      setSuggestions(list);
    } catch (e) {
      setSuggestionsError(String(e));
    } finally {
      setSuggestionsBusy(false);
    }
  }

  function injectFromAi(sql: string) {
    injectIntoQueryTab(sql, false);
  }

  // Stable identities for callbacks passed into memoized QueryWorkspace. Without
  // these every setActiveTabId re-renders all mounted query tabs, since prop
  // identity changes defeat React.memo.
  const stableInjectFromAi = useStableCallback(injectFromAi);
  const stableOnQueryExecuted = useStableCallback((connId: number) => {
    void refreshHistory(connId);
  });

  function openAgent(agent: AgentId) {
    if (workingId === null) return;
    const id = agentTabId(agent);
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [...prev, { id, kind: "agent", agent, name: AGENT_META[agent].name }];
    });
    setActiveTabId(id);
  }

  function openMilvusSearch(
    connectionId: number,
    database: string,
    collection: string,
  ) {
    const id = milvusSearchTabId(connectionId, database, collection);
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          kind: "milvus-search",
          name: collection,
          connectionId,
          database,
          collection,
        },
      ];
    });
    setActiveTabId(id);
  }

  function openRedisKey(db: number, rkey: string) {
    if (workingId === null) return;
    const id = redisKeyTabId(workingId, db, rkey);
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          kind: "redis-key",
          name: rkey,
          connectionId: workingId,
          db,
          rkey,
        },
      ];
    });
    setActiveTabId(id);
  }

  function openRedisConsole(db: number) {
    if (workingId === null) return;
    const id = redisConsoleTabId(workingId, db);
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          kind: "redis-console",
          name: `console · database ${db}`,
          connectionId: workingId,
          db,
        },
      ];
    });
    setActiveTabId(id);
  }

  function openProjectAgent(agent: ProjectAgentId) {
    if (activeProjectId === null) return;
    const id = projectAgentTabId(agent);
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [
        ...prev,
        { id, kind: "project-agent", agent, name: PROJECT_AGENT_META[agent].name },
      ];
    });
    setActiveTabId(id);
  }

  function openProjectPreview(t: ProjectTable) {
    if (activeProjectId === null) return;
    void openTablePreview({
      connectionId: t.connection_id,
      db: t.database_name,
      table: t.table_name,
      ensureOpen: true,
    });
  }

  /**
   * Project mode: user double-clicked a project table — switch to the drill
   * tab and let ProjectShell adopt this as the new lookup root. We just
   * activate the drill tab here; ProjectShell receives the table via a
   * `pendingDrillTable` prop and handles the rest.
   */
  function openProjectDrill(t: ProjectTable) {
    if (activeProjectId === null) return;
    const key = `proj:${activeProjectId}`;
    setTabsByMode((m) => {
      const entry = m[key] ?? { tabs: [], activeTabId: null };
      const drill = entry.tabs.find((x) => x.kind === "project-drill");
      if (drill) {
        return { ...m, [key]: { ...entry, activeTabId: drill.id } };
      }
      const tab: Tab = {
        id: PROJECT_DRILL_TAB_ID,
        kind: "project-drill",
        name: "Drill",
      };
      return {
        ...m,
        [key]: { tabs: [tab, ...entry.tabs], activeTabId: tab.id },
      };
    });
    setPendingDrillTable(t);
  }

  const [pendingDrillTable, setPendingDrillTable] = useState<ProjectTable | null>(null);

  async function openProject(p: Project) {
    if (!p.id) return;
    // Auto-open all required connections for this project (best effort).
    try {
      const [tableList, relList] = await Promise.all([
        invoke<{ connection_id: number }[]>("list_project_tables", {
          projectId: p.id,
        }),
        invoke<
          { from_connection_id: number; to_connection_id: number }[]
        >("list_project_relations", { projectId: p.id }),
      ]);
      const needed = new Set<number>();
      tableList.forEach((t) => needed.add(t.connection_id));
      relList.forEach((r) => {
        needed.add(r.from_connection_id);
        needed.add(r.to_connection_id);
      });
      const openIds = await invoke<number[]>("list_open_connection_ids");
      const openSet = new Set(openIds);
      const missing = Array.from(needed).filter((id) => !openSet.has(id));
      // Don't block on failures — ProjectShell shows missing-conn warnings.
      await Promise.allSettled(
        missing.map((id) => invoke("open_connection", { id })),
      );
    } catch {
      // best effort
    }
    setMode({ kind: "project", projectId: p.id });
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        const newActive = next[idx] ?? next[idx - 1] ?? null;
        setActiveTabId(newActive ? newActive.id : null);
      }
      return next;
    });
    setQueryInjections((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    if (lastFocusedQueryTabId === id) setLastFocusedQueryTabId(null);
  }

  function newQueryTab() {
    if (workingId === null) return;
    const id = `query:${Date.now()}`;
    const n = tabs.filter((t) => t.kind === "query").length + 1;
    setTabs((prev) => [
      ...prev,
      { id, kind: "query", name: `query-${n}.sql`, connectionId: workingId },
    ]);
    setActiveTabId(id);
  }

  const visibleDbs = showSystemDbs ? databases : databases.filter((d) => !SYSTEM_DBS.has(d));

  const piiTables = new Set<string>();
  const piiColumns = new Set<string>();
  for (const a of annotations) {
    if (a.pii_type) {
      piiTables.add(`${a.database_name}.${a.table_name}`);
      if (a.column_name) {
        piiColumns.add(`${a.database_name}.${a.table_name}.${a.column_name}`);
      }
    }
  }

  const tablesCount = Object.values(tablesByDb).reduce((sum, list) => sum + list.length, 0);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeAgent: AgentId | null =
    activeTab?.kind === "agent" ? activeTab.agent : null;

  const activeTabLabel = activeTab
    ? activeTab.kind === "query"
      ? activeTab.name
      : activeTab.kind === "agent"
        ? AGENT_META[activeTab.agent].name
        : activeTab.kind === "project-agent"
          ? PROJECT_AGENT_META[activeTab.agent].name
          : activeTab.name
    : null;

  const connAgentBadges: Partial<Record<AgentId, AgentBadge>> = {};
  if (piiTables.size > 0) {
    connAgentBadges.dictionary = { text: String(piiTables.size), tone: "warn" };
  }
  if (relations.length > 0 && connAgentBadges.dictionary === undefined) {
    connAgentBadges.dictionary = { text: String(relations.length), tone: "info" };
  }

  const CONN_AGENT_ORDER: AgentId[] = [
    "analyze",
    "infer-relations",
    "dictionary",
    "er-diagram",
    "onboarding",
    "health",
    "performance",
    "schema-diff",
    "impact",
    "deadlock",
    "repair",
  ];

  if (annotations.length > 0) {
    connAgentBadges.analyze = { text: String(annotations.length), tone: "info" };
  }
  if (relations.length > 0) {
    connAgentBadges["infer-relations"] = {
      text: String(relations.length),
      tone: "info",
    };
  }

  const connAgents: AgentItem[] = CONN_AGENT_ORDER.map((id) => ({
    id,
    name: AGENT_META[id].name,
    sub: AGENT_META[id].sub,
    icon: AGENT_META[id].icon,
    badge: connAgentBadges[id],
  }));

  const connInsight: DockInsight | null = working
    ? annotations.length === 0
      ? {
          body: (
            <>
              No schema annotations yet. Run{" "}
              <span className="font-mono text-acc-ink">Analyze Schema</span> to find PII & relations.
            </>
          ),
          primaryLabel: "Analyze schema",
          primaryAction: () => openAgent("analyze"),
        }
      : projects.length === 0
        ? {
            body: (
              <>
                Schema analyzed. Run{" "}
                <span className="font-mono text-acc-ink">Onboarding</span> to discover business domains.
              </>
            ),
            primaryLabel: "Run onboarding",
            primaryAction: () => openAgent("onboarding"),
          }
        : {
            body: (
              <>
                <span className="text-acc-ink font-semibold">{piiTables.size}</span> PII tables ·{" "}
                <span className="text-acc-ink font-semibold">{relations.length}</span> relations ·{" "}
                <span className="text-acc-ink font-semibold">{projects.length}</span> projects.
              </>
            ),
            primaryLabel: "Run health check",
            primaryAction: () => openAgent("health"),
            secondaryLabel: "Open dictionary",
            secondaryAction: () => openAgent("dictionary"),
          }
    : null;

  const connActivity: DockActivityItem[] = [];
  for (const h of history.slice(0, 4)) {
    connActivity.push({
      icon: h.error ? "✗" : "⚡",
      text: (
        <span className="font-mono truncate">
          {h.sql.replace(/\s+/g, " ").slice(0, 60)}
          {h.sql.length > 60 ? "…" : ""}
        </span>
      ),
      when: formatTime(h.executed_at),
    });
  }

  const SCHEMA_CHIPS: FilterChipDef[] = [
    { id: "pii", label: "PII", tone: "pii" },
    { id: "fk", label: "FK" },
    { id: "indexed", label: "IDX" },
    { id: "recent", label: "Recent", disabled: true, title: "Coming soon" },
  ];

  function toggleSchemaFilter(id: string) {
    setSchemaFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id as SchemaFilter)) next.delete(id as SchemaFilter);
      else next.add(id as SchemaFilter);
      return next;
    });
  }

  function renderActiveNonQuery() {
    if (!activeTab) return null;
    if (!working) return null;
    if (activeTab.kind === "agent") {
      switch (activeTab.agent) {
        case "health":
          return (
            <HealthCheckWorkspace
              connectionId={working.id!}
              onClose={() => closeTab(activeTab.id)}
            />
          );
        case "performance":
          return (
            <PerformanceWorkspace
              connectionId={working.id!}
              onClose={() => closeTab(activeTab.id)}
              onInjectSql={injectFromAi}
            />
          );
        case "schema-diff":
          return (
            <SchemaDiffWorkspace
              connectionId={working.id!}
              databases={visibleDbs}
              onClose={() => closeTab(activeTab.id)}
              onInjectSql={injectFromAi}
            />
          );
        case "impact":
          return (
            <ImpactWorkspace
              connectionId={working.id!}
              databases={visibleDbs}
              onClose={() => closeTab(activeTab.id)}
            />
          );
        case "onboarding":
          return (
            <OnboardingWorkspace
              connectionId={working.id!}
              databases={visibleDbs}
              onClose={() => closeTab(activeTab.id)}
              onProjectCreated={() => refreshProjects()}
            />
          );
        case "dictionary":
          return (
            <DictionaryWorkspace
              connectionId={working.id!}
              databases={visibleDbs}
              onClose={() => closeTab(activeTab.id)}
            />
          );
        case "analyze":
          return (
            <AnalyzeSchemaWorkspace
              connectionId={working.id!}
              onClose={() => closeTab(activeTab.id)}
              onAnalyzed={() => void refreshInsights(working.id!)}
            />
          );
        case "infer-relations":
          return (
            <InferRelationsWorkspace
              connectionId={working.id!}
              onClose={() => closeTab(activeTab.id)}
              onInferred={() => void refreshInsights(working.id!)}
            />
          );
        case "repair":
          return (
            <RepairWorkspace
              connectionId={working.id!}
              databases={visibleDbs}
              onClose={() => closeTab(activeTab.id)}
            />
          );
        case "er-diagram":
          return (
            <ErDiagramWorkspace
              connectionId={working.id!}
              databases={visibleDbs}
              onClose={() => closeTab(activeTab.id)}
            />
          );
        case "deadlock":
          return (
            <DeadlockWorkspace
              connectionId={working.id!}
              onClose={() => closeTab(activeTab.id)}
            />
          );
      }
    }
    return null;
  }

  const queryTabs = tabs.filter((t) => t.kind === "query");
  const milvusSearchTabs = tabs.filter(
    (t): t is Extract<Tab, { kind: "milvus-search" }> =>
      t.kind === "milvus-search",
  );
  const activeIsQuery = activeTab?.kind === "query";
  const nonQueryNode = renderActiveNonQuery();

  return (
    <div className="h-screen w-screen flex flex-col bg-bg overflow-hidden text-[13px]">
      <Titlebar
        mode={mode}
        connections={connections}
        projects={projects}
        onSelectConnection={(c) => void openConnection(c)}
        onSelectProject={(p) => void openProject(p)}
        onAddConnection={startNew}
        onAddProject={() =>
          setEditingProject({ id: null, name: "", description: null })
        }
        onEditConnection={(c) => void startEdit(c)}
        onEditProject={setEditingProject}
        onCloseConnection={() => void closeWorkspace()}
        onGoHome={goHome}
        onOpenSettings={() => setShowSettings(true)}
        onToggleDock={() => setDockOpen((v) => !v)}
        dockOpen={dockOpen}
      />

      {mode.kind !== "home" && (
        <Tabbar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={closeTab}
          onNewQueryTab={
            mode.kind === "connection" && working && working.kind !== "milvus"
              ? newQueryTab
              : undefined
          }
        />
      )}

      <div className="flex flex-1 min-h-0">
        {mode.kind === "home" && (
          <main className="flex-1 min-w-0 flex flex-col bg-bg overflow-hidden relative">
            <Home
              connections={connections}
              projects={projects}
              onAddConnection={startNew}
              onOpenConnection={(c) => void openConnection(c)}
              onEditConnection={(c) => void startEdit(c)}
              onNewProject={() =>
                setEditingProject({ id: null, name: "", description: null })
              }
              onOpenProject={(p) => void openProject(p)}
              onEditProject={setEditingProject}
            />
          </main>
        )}

        {mode.kind === "connection" && working && working.kind === "redis" && (
          <RedisExplorerShell
            conn={working}
            tabs={tabs}
            activeTab={activeTab}
            onOpenKey={openRedisKey}
            onOpenConsole={openRedisConsole}
          />
        )}

        {mode.kind === "connection" && working && working.kind !== "redis" && (
          <>
            <WorkspaceSidebar
              toolbar={
                <SearchBar
                  query={schemaQuery}
                  onQueryChange={setSchemaQuery}
                  placeholder={
                    working.kind === "milvus"
                      ? "Search collections…"
                      : "Search schema…"
                  }
                  bindShortcut
                  chips={working.kind === "milvus" ? undefined : SCHEMA_CHIPS}
                  active={schemaFilters as Set<string>}
                  onToggleChip={toggleSchemaFilter}
                  trailing={
                    working.kind === "milvus" ? undefined : (
                      <label
                        className="text-[10px] text-muted flex items-center gap-1 cursor-pointer shrink-0"
                        title="Show system schemas (information_schema, mysql, etc.)"
                      >
                        <input
                          type="checkbox"
                          checked={showSystemDbs}
                          onChange={(e) => setShowSystemDbs(e.target.checked)}
                          className="accent-acc w-3 h-3"
                        />
                        sys
                      </label>
                    )
                  }
                />
              }
              tree={
                <SchemaTreeView
                  databases={databases}
                  visibleDbs={visibleDbs}
                  tablesByDb={tablesByDb}
                  columnsByTableKey={columnsByTableKey}
                  expandedDbs={expandedDbs}
                  expandedTables={expandedTables}
                  piiTables={piiTables}
                  piiColumns={piiColumns}
                  selectedKey={selectedKey}
                  query={schemaQuery}
                  filters={schemaFilters}
                  onToggleDb={(db) => void toggleDb(db)}
                  onToggleTable={(db, t) => void toggleTable(db, t)}
                  onClickTable={clickTable}
                  onDoubleClickTable={
                    working.kind === "milvus" ? doubleClickTable : undefined
                  }
                  onClickColumn={clickColumn}
                  onRequestSuggestions={(db, t) => void requestSuggestions(db, t)}
                />
              }
              secondary={
                <ConnSecondary
                  databases={databases}
                  suggestions={suggestions}
                  suggestionsTable={suggestionsTable}
                  suggestionsBusy={suggestionsBusy}
                  suggestionsError={suggestionsError}
                  onClearSuggestions={() => {
                    setSuggestions([]);
                    setSuggestionsTable("");
                    setSuggestionsError("");
                  }}
                  onInjectSql={injectFromAi}
                  annotationsCount={annotations.length}
                  piiCount={piiTables.size}
                  relationsCount={relations.length}
                  tablesCount={tablesCount}
                  history={history}
                  onUseHistory={injectFromAi}
                />
              }
            />

            <main className="flex-1 min-w-0 flex flex-col bg-bg overflow-hidden relative">
              {tabs.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted">
                  <div className="text-center text-[13px]">
                    {working.kind === "milvus" ? (
                      <>
                        <div className="mb-1">No search tabs open.</div>
                        <div className="text-subtle">
                          Double-click a collection in the sidebar to start.
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-[14px] mb-2">No tabs open.</div>
                        <button
                          onClick={newQueryTab}
                          className="text-[13px] text-acc hover:text-acc-ink"
                        >
                          + New query
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {queryTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`flex-1 min-w-0 min-h-0 flex flex-col ${
                        activeIsQuery && tab.id === activeTabId ? "" : "hidden"
                      }`}
                    >
                      <QueryWorkspace
                        conn={working}
                        injection={queryInjections[tab.id] ?? initialInjection}
                        onAiInject={stableInjectFromAi}
                        onExecuted={stableOnQueryExecuted}
                      />
                    </div>
                  ))}
                  {milvusSearchTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`flex-1 min-w-0 min-h-0 flex flex-col ${
                        activeTab?.id === tab.id ? "" : "hidden"
                      }`}
                    >
                      <MilvusSearchWorkspace
                        conn={working}
                        collection={tab.collection}
                        db={tab.database}
                        description={null}
                      />
                    </div>
                  ))}
                  {!activeIsQuery && activeTab?.kind !== "milvus-search" && nonQueryNode}
                </>
              )}
            </main>

            {dockOpen && (
              <WorkspaceDock
                title="AI Agents"
                agents={connAgents}
                activeAgentId={activeAgent}
                onOpenAgent={(id) => openAgent(id as AgentId)}
                insight={connInsight}
                activity={connActivity}
              />
            )}
          </>
        )}

        {mode.kind === "project" && activeProject && (
          <ProjectShell
            project={activeProject}
            connections={connections}
            activeTab={activeTab}
            onOpenAgent={openProjectAgent}
            onCloseTab={closeTab}
            onEditProject={() => setEditingProject(activeProject)}
            onStatsChange={setProjectStats}
            dockOpen={dockOpen}
            onTablePreview={(t) => void openProjectPreview(t)}
            onTableDrill={(t) => openProjectDrill(t)}
            pendingDrillTable={pendingDrillTable}
            onAckPendingDrill={() => setPendingDrillTable(null)}
            queryInjections={queryInjections}
            onExecuted={stableOnQueryExecuted}
            refreshKey={projectRefreshKey}
          />
        )}

        {mode.kind === "project" && !activeProject && (
          <main className="flex-1 flex items-center justify-center text-muted">
            Project not found.
          </main>
        )}
      </div>

      <Statusbar
        mode={mode}
        working={working}
        activeProject={activeProject}
        databasesCount={visibleDbs.length}
        tablesCount={tablesCount}
        serverVersion={serverVersion}
        activeTabLabel={activeTabLabel}
        selectionLabel={selectedKey}
        threadsRunning={serverStatus?.threads_running ?? null}
        projectTableCount={projectStats.tableCount}
        projectConnsOpen={projectStats.connsOpen}
        projectConnsTotal={projectStats.connsTotal}
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {editingProject && (
        <ProjectEditorModal
          project={editingProject}
          connections={connections}
          showSystemDbs={showSystemDbs}
          getDatabases={async (connId) => {
            // Ensures the pool is open; idempotent server-side.
            await invoke("open_connection", { id: connId });
            return await invoke<string[]>("list_databases", { id: connId });
          }}
          getTables={async (connId, db) => {
            const list = await invoke<TableMetaForTree[]>("list_table_meta", {
              connectionId: connId,
              database: db,
            });
            return list.map((t) => t.name);
          }}
          defaultDb={
            working?.database && visibleDbs.includes(working.database)
              ? working.database
              : undefined
          }
          onClose={() => setEditingProject(null)}
          onSaved={() => {
            void refreshProjects();
            setProjectRefreshKey((k) => k + 1);
          }}
          onDeleted={() => {
            void refreshProjects();
            setProjectRefreshKey((k) => k + 1);
            setEditingProject(null);
          }}
        />
      )}
      {editing && (
        <EditFormModal
          editing={editing}
          password={password}
          busy={busy}
          result={result}
          isError={isError}
          onChange={setEditing}
          onPasswordChange={setPassword}
          onSave={() => void save()}
          onTest={() => void test()}
          onCancel={() => {
            setEditing(null);
            setResult("");
            setIsError(false);
          }}
          onDelete={
            editing.id
              ? () => {
                  const target = editing;
                  setEditing(null);
                  void removeConnection(target);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function Home({
  connections,
  projects,
  onAddConnection,
  onOpenConnection,
  onEditConnection,
  onNewProject,
  onOpenProject,
  onEditProject,
}: {
  connections: Connection[];
  projects: Project[];
  onAddConnection: () => void;
  onOpenConnection: (c: Connection) => void;
  onEditConnection: (c: Connection) => void;
  onNewProject: () => void;
  onOpenProject: (p: Project) => void;
  onEditProject: (p: Project) => void;
}) {
  const empty = connections.length === 0 && projects.length === 0;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-[1100px] mx-auto px-8 py-8 flex flex-col gap-8">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-[8px] flex items-center justify-center text-white text-[15px] font-bold"
            style={{
              background: "linear-gradient(135deg, var(--acc) 0%, var(--acc-2) 100%)",
              boxShadow: "var(--sh-2)",
            }}
          >
            sq
          </div>
          <div className="flex-1">
            <h1 className="text-[15px] font-bold text-ink">SquireDB</h1>
            <p className="text-[11.5px] text-muted">
              AI-native, local-first MySQL client.
            </p>
          </div>
          <button
            onClick={onAddConnection}
            className="px-2.5 h-7 text-[11.5px] font-semibold text-white bg-acc hover:bg-acc-2 rounded-md"
          >
            + New connection
          </button>
          <button
            onClick={onNewProject}
            className="px-2.5 h-7 text-[11.5px] font-semibold text-acc bg-panel border border-acc/40 hover:bg-acc-soft rounded-md"
          >
            + New project
          </button>
        </div>

        {empty && (
          <div className="px-6 py-8 bg-panel border border-border rounded-md text-center">
            <div className="text-[12.5px] text-ink-2 mb-2">
              Welcome — start by adding a connection.
            </div>
            <div className="text-[11.5px] text-muted mb-4">
              Or create a project first; you can attach tables from any connection later.
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={onAddConnection}
                className="px-3 h-7 text-[11.5px] font-semibold text-white bg-acc hover:bg-acc-2 rounded-md"
              >
                + New connection
              </button>
              <button
                onClick={onNewProject}
                className="px-3 h-7 text-[11.5px] font-semibold text-acc bg-panel border border-acc/40 hover:bg-acc-soft rounded-md"
              >
                + New project
              </button>
            </div>
          </div>
        )}

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[10px] uppercase tracking-wider font-bold text-ink-2">
              Connections
            </h2>
            <span className="text-[10.5px] text-muted">[{connections.length}]</span>
            <div className="flex-1" />
            <button
              onClick={onAddConnection}
              className="text-[11px] text-acc hover:text-acc-ink"
            >
              + new
            </button>
          </div>
          {connections.length === 0 ? (
            <div className="px-4 py-5 bg-panel-2 border border-dashed border-border rounded-md text-[11.5px] text-muted text-center">
              No connections yet.
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
            >
              {connections.map((c) => (
                <div
                  key={c.id ?? c.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenConnection(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onOpenConnection(c);
                  }}
                  className="group relative text-left p-3 bg-panel border border-border hover:border-acc/60 hover:shadow-sm hover:bg-acc-soft/30 rounded-md flex flex-col gap-1.5 transition-colors cursor-pointer"
                  title={`${c.host}:${c.port}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[12.5px] font-semibold text-ink truncate flex-1">
                      {c.name}
                    </span>
                    {(() => {
                      const meta = connectionKindMeta(c.kind);
                      return (
                        <span
                          className={`shrink-0 h-[15px] px-1.5 rounded-[3px] text-[9.5px] font-bold uppercase tracking-wider flex items-center ${meta.cls}`}
                          title={`kind: ${c.kind}`}
                        >
                          {meta.label}
                        </span>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditConnection(c);
                      }}
                      className="text-[10.5px] text-muted hover:text-acc cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      edit
                    </button>
                  </div>
                  <div
                    className="text-[10.5px] text-muted font-mono truncate"
                    title={
                      c.kind === "sqlite"
                        ? c.database ?? ""
                        : `${c.host}:${c.port}`
                    }
                  >
                    {c.kind === "sqlite"
                      ? c.database
                        ? c.database.split("/").pop() || c.database
                        : "(no file)"
                      : `${c.host}:${c.port}`}
                  </div>
                  <div className="text-[10.5px] text-subtle truncate">
                    {c.kind === "milvus"
                      ? c.database
                        ? `db: ${c.database}`
                        : "db: default"
                      : c.kind === "sqlite"
                        ? "SQLite"
                        : c.kind === "redis"
                          ? `Redis · database ${c.database ?? "0"}`
                          : `${c.username}${c.database ? ` · ${c.database}` : ""}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[10px] uppercase tracking-wider font-bold text-ink-2">
              Projects
            </h2>
            <span className="text-[10.5px] text-muted">[{projects.length}]</span>
            <div className="flex-1" />
            <button
              onClick={onNewProject}
              className="text-[11px] text-acc hover:text-acc-ink"
            >
              + new
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="px-4 py-5 bg-panel-2 border border-dashed border-border rounded-md text-[11.5px] text-muted text-center">
              No projects yet. Projects let you group tables across databases or
              connections.
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
            >
              {projects.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenProject(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onOpenProject(p);
                  }}
                  className="group relative text-left p-3 bg-panel border border-border hover:border-acc/60 hover:shadow-sm hover:bg-acc-soft/30 rounded-md flex flex-col gap-1.5 transition-colors cursor-pointer min-h-[68px]"
                  title={p.description ?? ""}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-semibold text-ink truncate flex-1">
                      {p.name}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditProject(p);
                      }}
                      className="text-[10.5px] text-muted hover:text-acc cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      edit
                    </button>
                  </div>
                  <div className="text-[10.5px] text-muted truncate">
                    {p.description || (
                      <span className="italic text-subtle">no description</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type EditFormModalProps = {
  editing: Connection;
  password: string;
  busy: boolean;
  result: string;
  isError: boolean;
  onChange: (c: Connection) => void;
  onPasswordChange: (s: string) => void;
  onSave: () => void;
  onTest: () => void;
  onCancel: () => void;
  onDelete?: () => void;
};

function EditFormModal({
  editing,
  password,
  busy,
  result,
  isError,
  onChange,
  onPasswordChange,
  onSave,
  onTest,
  onCancel,
  onDelete,
}: EditFormModalProps) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center"
      style={{ background: "rgba(20,20,15,0.32)" }}
      onClick={onCancel}
    >
      <div
        className="bg-panel border border-border rounded-lg w-[520px] max-h-[90vh] overflow-auto"
        style={{ boxShadow: "var(--sh-3)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-10 border-b border-border">
          <div className="text-[13px] font-semibold text-ink">
            {editing.id ? "Edit connection" : "New connection"}
          </div>
          <button
            onClick={onCancel}
            className="w-6 h-6 text-muted hover:text-ink hover:bg-bg-2 rounded flex items-center justify-center"
          >
            ×
          </button>
        </div>
        <div className="p-4">
          <EditForm
            conn={editing}
            password={password}
            busy={busy}
            onChange={onChange}
            onPasswordChange={onPasswordChange}
            onSave={onSave}
            onTest={onTest}
            onCancel={onCancel}
          />
          {result && (
            <pre
              className={`mt-3 px-3 py-2 rounded text-[12px] whitespace-pre-wrap ${
                isError ? "bg-crit-soft text-crit" : "bg-ok-soft text-ok"
              }`}
            >
              {result}
            </pre>
          )}
          {onDelete && (
            <div className="mt-4 pt-3 border-t border-border">
              <button
                onClick={onDelete}
                className="text-[12px] text-crit hover:underline"
              >
                Delete connection
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
