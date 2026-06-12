import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CARDINALITIES,
  SYSTEM_DBS,
  type AiRelationsReport,
  type Connection,
  type Project,
  type ProjectRelation,
  type ProjectTable,
} from "../types";
import { ProjectCacheMappingsSection } from "./ProjectCacheMappingsSection";

export function ProjectEditorModal({
  project,
  connections,
  showSystemDbs,
  getDatabases,
  getTables,
  defaultDb,
  onClose,
  onSaved,
  onDeleted,
}: {
  project: Project;
  /** All saved connections — picker source. */
  connections: Connection[];
  showSystemDbs: boolean;
  /** Opens the connection if needed, returns all databases. */
  getDatabases: (connId: number) => Promise<string[]>;
  /** Returns all table names in (connId, db). Connection must already be open. */
  getTables: (connId: number, db: string) => Promise<string[]>;
  defaultDb?: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [current, setCurrent] = useState<Project>(project);
  const [tables, setTables] = useState<ProjectTable[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // No "owning" connection any more — picker defaults to first table-bearing conn.
  // Redis / Milvus have no notion of "browse databases/tables" so they're excluded.
  const [addConnId, setAddConnId] = useState<number>(
    connections.find((c) => c.kind === "mysql" || c.kind === "sqlite")?.id ?? 0,
  );
  const [addDb, setAddDb] = useState(defaultDb ?? "");
  const [addDbs, setAddDbs] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [openingConn, setOpeningConn] = useState(false);
  const [pickerError, setPickerError] = useState("");

  const [addDbTables, setAddDbTables] = useState<string[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);

  const [pendingTables, setPendingTables] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const [relations, setRelations] = useState<ProjectRelation[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [aiInferring, setAiInferring] = useState(false);
  const [aiInferMsg, setAiInferMsg] = useState("");
  const [aiInferErr, setAiInferErr] = useState(false);

  const [relFrom, setRelFrom] = useState<{
    connId: number;
    db: string;
    table: string;
    column: string;
  }>({ connId: 0, db: "", table: "", column: "" });
  const [relTo, setRelTo] = useState<{
    connId: number;
    db: string;
    table: string;
    column: string;
  }>({ connId: 0, db: "", table: "", column: "" });
  const [relCard, setRelCard] = useState<string>("N-1");
  const [fromColumns, setFromColumns] = useState<string[]>([]);
  const [toColumns, setToColumns] = useState<string[]>([]);

  const [openConnIds, setOpenConnIds] = useState<Set<number>>(new Set());

  async function refreshOpenConns() {
    try {
      const ids = await invoke<number[]>("list_open_connection_ids");
      setOpenConnIds(new Set(ids));
    } catch {
      // best-effort; modal still works
    }
  }

  useEffect(() => {
    void refreshOpenConns();
  }, []);

  async function refreshTables(projectId: number) {
    try {
      const list = await invoke<ProjectTable[]>("list_project_tables", {
        projectId,
      });
      setTables(list);
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshRelations(projectId: number) {
    try {
      const list = await invoke<ProjectRelation[]>("list_project_relations", {
        projectId,
      });
      setRelations(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (current.id) {
      void refreshTables(current.id);
      void refreshRelations(current.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id]);

  // Once project tables load, re-point the picker default to a connection / db
  // that the project actually uses — picking BMS when the project lives on
  // Siis is confusing and triggers spurious "Connection not open" errors.
  const alignedToProjectRef = useRef(false);
  useEffect(() => {
    if (alignedToProjectRef.current) return;
    if (tables.length === 0) return;
    const first = tables[0];
    alignedToProjectRef.current = true;
    setAddConnId(first.connection_id);
    setAddDb(first.database_name);
  }, [tables]);

  // Load DBs whenever the selected connection changes.
  // Only loads when the conn is already open — closed conns require explicit click on "Open".
  useEffect(() => {
    let cancelled = false;
    setPickerError("");
    if (!addConnId) {
      setAddDbs([]);
      return;
    }
    if (!openConnIds.has(addConnId)) {
      setAddDbs([]);
      return;
    }
    setLoadingDbs(true);
    (async () => {
      try {
        const all = await getDatabases(addConnId);
        if (cancelled) return;
        const filtered = showSystemDbs ? all : all.filter((d) => !SYSTEM_DBS.has(d));
        setAddDbs(filtered);
        if (!filtered.includes(addDb)) {
          setAddDb(filtered[0] ?? "");
        }
      } catch (e) {
        if (!cancelled) setPickerError(String(e));
      } finally {
        if (!cancelled) setLoadingDbs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addConnId, showSystemDbs, openConnIds]);

  async function openPickerConn() {
    if (!addConnId) return;
    setOpeningConn(true);
    setPickerError("");
    try {
      await getDatabases(addConnId);
      await refreshOpenConns();
    } catch (e) {
      setPickerError(String(e));
    } finally {
      setOpeningConn(false);
    }
  }

  // Load tables whenever (conn, db) changes.
  useEffect(() => {
    let cancelled = false;
    if (!addConnId || !addDb) {
      setAddDbTables([]);
      setPendingTables(new Set());
      return;
    }
    setLoadingTables(true);
    (async () => {
      try {
        const list = await getTables(addConnId, addDb);
        if (cancelled) return;
        setAddDbTables(list);
        setPendingTables(new Set());
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoadingTables(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addConnId, addDb]);

  useEffect(() => {
    if (!relFrom.connId || !relFrom.db || !relFrom.table) {
      setFromColumns([]);
      return;
    }
    void invoke<string[]>("list_columns", {
      connectionId: relFrom.connId,
      database: relFrom.db,
      table: relFrom.table,
    }).then((cols) => {
      setFromColumns(cols);
      setRelFrom((prev) => ({ ...prev, column: cols[0] ?? "" }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relFrom.connId, relFrom.db, relFrom.table]);

  useEffect(() => {
    if (!relTo.connId || !relTo.db || !relTo.table) {
      setToColumns([]);
      return;
    }
    void invoke<string[]>("list_columns", {
      connectionId: relTo.connId,
      database: relTo.db,
      table: relTo.table,
    }).then((cols) => {
      setToColumns(cols);
      setRelTo((prev) => ({ ...prev, column: cols[0] ?? "" }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relTo.connId, relTo.db, relTo.table]);

  async function saveProject() {
    if (!current.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await invoke<Project>("save_project", { project: current });
      setCurrent(saved);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function addSelectedTables() {
    if (!current.id) {
      setError("Save the project first");
      return;
    }
    if (pendingTables.size === 0) return;
    setError("");
    setAdding(true);
    try {
      const arr = Array.from(pendingTables);
      const needsPrimary = tables.length === 0;
      for (let i = 0; i < arr.length; i++) {
        await invoke("add_project_table", {
          projectId: current.id,
          connectionId: addConnId,
          databaseName: addDb,
          tableName: arr[i],
          alias: null,
          isPrimary: needsPrimary && i === 0,
        });
      }
      setPendingTables(new Set());
      await refreshTables(current.id);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  function togglePending(t: string) {
    setPendingTables((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function toggleAllPending(addableTables: string[]) {
    setPendingTables((prev) => {
      const allChecked = addableTables.every((t) => prev.has(t));
      if (allChecked) return new Set();
      return new Set(addableTables);
    });
  }

  async function removeTable(id: number) {
    setError("");
    try {
      await invoke("remove_project_table", { projectTableId: id });
      if (current.id) await refreshTables(current.id);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  async function togglePickerTable(name: string) {
    const existing = tables.find(
      (t) =>
        t.connection_id === addConnId &&
        t.database_name === addDb &&
        t.table_name === name,
    );
    if (existing) {
      await removeTable(existing.id);
    } else {
      togglePending(name);
    }
  }

  async function setPrimary(id: number) {
    if (!current.id) return;
    setError("");
    try {
      await invoke("set_project_primary_table", {
        projectId: current.id,
        projectTableId: id,
      });
      await refreshTables(current.id);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  async function importRelations() {
    if (!current.id) return;
    const scopeConn = tables[0]?.connection_id ?? 0;
    if (!scopeConn) {
      setError("Add at least one table first — schema analysis is per-connection.");
      return;
    }
    setImporting(true);
    setImportMsg("");
    setError("");
    try {
      const count = await invoke<number>("import_schema_relations_to_project", {
        projectId: current.id,
        connectionId: scopeConn,
      });
      await refreshRelations(current.id);
      onSaved();
      setImportMsg(`Imported ${count} relations from schema analysis.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }

  async function inferProjectAiRelations() {
    if (!current.id || aiInferring) return;
    const scopeConn = tables[0]?.connection_id ?? 0;
    if (!scopeConn) {
      setError("Add at least one table first — AI relation inference is per-connection.");
      return;
    }
    setAiInferring(true);
    setAiInferMsg("AI thinking…");
    setAiInferErr(false);
    setError("");
    try {
      const report = await invoke<AiRelationsReport>(
        "generate_ai_relations_for_project",
        { connectionId: scopeConn, projectId: current.id },
      );
      await refreshRelations(current.id);
      onSaved();
      let msg =
        `${report.accepted}/${report.proposed} accepted` +
        (report.rejected_unknown_endpoint > 0
          ? ` · ${report.rejected_unknown_endpoint} rejected (hallucinated)`
          : "") +
        ` · ${report.elapsed_ms}ms`;
      if (report.rejections.length > 0) {
        msg += `\nRejected sample: ${report.rejections.join("; ")}`;
      }
      setAiInferMsg(msg);
      setAiInferErr(false);
    } catch (e) {
      setAiInferMsg(String(e));
      setAiInferErr(true);
    } finally {
      setAiInferring(false);
    }
  }

  async function addRelation() {
    if (!current.id) return;
    if (!relFrom.connId || !relFrom.db || !relFrom.table || !relFrom.column) {
      setError("Pick a 'from' table and column");
      return;
    }
    if (!relTo.connId || !relTo.db || !relTo.table || !relTo.column) {
      setError("Pick a 'to' table and column");
      return;
    }
    setError("");
    try {
      await invoke("add_project_relation", {
        projectId: current.id,
        fromConnectionId: relFrom.connId,
        fromDb: relFrom.db,
        fromTable: relFrom.table,
        fromColumn: relFrom.column,
        toConnectionId: relTo.connId,
        toDb: relTo.db,
        toTable: relTo.table,
        toColumn: relTo.column,
        cardinality: relCard,
      });
      await refreshRelations(current.id);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeRelation(id: number) {
    setError("");
    try {
      await invoke("remove_project_relation", { relationId: id });
      if (current.id) await refreshRelations(current.id);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteProject() {
    if (!current.id) {
      onClose();
      return;
    }
    if (
      !confirm(`Delete project "${current.name}"? This removes its tables and relations.`)
    )
      return;
    try {
      await invoke("delete_project", { id: current.id });
      onDeleted();
    } catch (e) {
      setError(String(e));
    }
  }

  const connsUsed = useMemo(() => new Set(tables.map((t) => t.connection_id)), [tables]);
  const dbsUsed = useMemo(
    () => new Set(tables.map((t) => `${t.connection_id}|${t.database_name}`)),
    [tables],
  );
  // The "anchor" connection — first table's conn — used purely to decide
  // which tables/relations get an "external" badge. Single-conn projects
  // show no badges; multi-conn projects show badges on everything that
  // isn't on the anchor.
  const primaryConnId = useMemo<number | null>(() => {
    const primary = tables.find((t) => t.is_primary === 1);
    return primary?.connection_id ?? tables[0]?.connection_id ?? null;
  }, [tables]);

  const inProject = useMemo(() => {
    const s = new Set<string>();
    for (const t of tables) {
      if (t.connection_id === addConnId && t.database_name === addDb) {
        s.add(t.table_name);
      }
    }
    return s;
  }, [tables, addConnId, addDb]);
  const addable = addDbTables.filter((t) => !inProject.has(t));
  const allChecked =
    addable.length > 0 && addable.every((t) => pendingTables.has(t));

  function connLabel(connId: number): string {
    const c = connections.find((x) => x.id === connId);
    return c ? c.name : `#${connId}`;
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center"
      style={{ background: "rgba(20,20,15,0.32)" }}
      onClick={onClose}
    >
      <div
        className="bg-panel border border-border rounded-lg w-[1040px] max-w-[94vw] max-h-[88vh] flex flex-col"
        style={{ boxShadow: "var(--sh-3)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-10 border-b border-border shrink-0">
          <div className="flex items-baseline gap-2">
            <div className="text-[13px] font-semibold text-ink">
              {current.id ? "Edit project" : "New project"}
            </div>
            {current.id && tables.length > 0 && (
              <div className="text-[11px] text-muted">
                {tables.length} table{tables.length !== 1 ? "s" : ""}
                {connsUsed.size > 1 && (
                  <span className="ml-1 text-acc font-semibold">
                    · {connsUsed.size} connections
                  </span>
                )}
                {dbsUsed.size > 1 && (
                  <span className="ml-1 text-acc">· {dbsUsed.size} databases</span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 text-muted hover:text-ink hover:bg-bg-2 rounded flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          <ProjectMetaForm
            current={current}
            saving={saving}
            onChange={setCurrent}
            onSave={() => void saveProject()}
            onDelete={current.id ? () => void deleteProject() : undefined}
          />

          {error && (
            <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
              {error}
            </pre>
          )}

          {!current.id ? (
            <div className="px-3 py-6 bg-panel-2 border border-border rounded-md text-[12px] text-muted text-center">
              Click <span className="font-semibold text-ink-2">Create</span> to save
              the project first, then add tables to it.
            </div>
          ) : (
            <>
              <SectionDivider title="Tables in this project" />

              {tables.length > 0 && (
                <ProjectTablesList
                  tables={tables}
                  openConnIds={openConnIds}
                  connLabel={connLabel}
                  onSetPrimary={(id) => void setPrimary(id)}
                  onRemove={(id) => void removeTable(id)}
                  onJumpToPicker={(connId, db) => {
                    setAddConnId(connId);
                    setAddDb(db);
                  }}
                />
              )}

              <div className="flex items-center gap-2 pt-1">
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted">
                  Add tables
                </div>
                <div className="text-[10.5px] text-subtle">
                  Pick any connection / database below — including connections this
                  project hasn't used yet.
                </div>
              </div>

              <div className="border border-border rounded-md overflow-hidden bg-panel shrink-0">
                <div className="flex items-center gap-1.5 px-2 h-9 border-b border-border bg-panel-2 shrink-0">
                  <select
                    value={addConnId}
                    onChange={(e) => {
                      setAddConnId(parseInt(e.target.value, 10));
                      setAddDb("");
                    }}
                    className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded outline-none focus:border-acc hover:border-acc cursor-pointer"
                    title="Connection"
                  >
                    {connections
                      .filter((c) => c.kind === "mysql" || c.kind === "sqlite")
                      .map((c) => {
                        if (c.id == null) return null;
                        const open = openConnIds.has(c.id);
                        return (
                          <option key={c.id} value={c.id}>
                            {open ? "● " : "○ "}
                            {c.name}
                            {!open ? " (closed)" : ""}
                          </option>
                        );
                      })}
                  </select>
                  <span className="text-[11px] text-subtle">/</span>
                  <select
                    value={addDb}
                    onChange={(e) => setAddDb(e.target.value)}
                    disabled={loadingDbs || addDbs.length === 0}
                    className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded outline-none focus:border-acc hover:border-acc disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    title="Database"
                  >
                    {loadingDbs ? (
                      <option>Loading…</option>
                    ) : addDbs.length === 0 ? (
                      <option value="">(no databases)</option>
                    ) : (
                      addDbs.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))
                    )}
                  </select>
                  <span className="text-[10.5px] text-subtle ml-1">
                    {addDbTables.length} tables · {inProject.size} in project
                  </span>
                  <div className="flex-1" />
                  <button
                    onClick={() => toggleAllPending(addable)}
                    disabled={addable.length === 0}
                    className="h-6 px-2 text-[11px] text-ink-2 hover:bg-bg-2 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {allChecked ? "Clear" : "Select all"}
                  </button>
                  <button
                    onClick={() => void addSelectedTables()}
                    disabled={adding || pendingTables.size === 0}
                    className="h-6 px-2.5 text-[11px] font-semibold text-white bg-acc rounded hover:bg-acc-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {adding
                      ? "Adding…"
                      : pendingTables.size === 0
                        ? "Add"
                        : `Add ${pendingTables.size}`}
                  </button>
                </div>
                {addConnId && !openConnIds.has(addConnId) ? (
                  <div className="px-3 py-4 text-[11.5px] text-muted text-center flex flex-col items-center gap-2">
                    <span>
                      Connection{" "}
                      <span className="font-mono text-ink-2">
                        {connections.find((c) => c.id === addConnId)?.name ?? `#${addConnId}`}
                      </span>{" "}
                      is closed — open it to browse tables.
                    </span>
                    <button
                      onClick={() => void openPickerConn()}
                      disabled={openingConn}
                      className="h-6 px-3 text-[11px] font-semibold text-white bg-acc rounded hover:bg-acc-2 disabled:opacity-50"
                    >
                      {openingConn ? "Opening…" : "Open connection"}
                    </button>
                    {pickerError && (
                      <div className="text-[11px] text-crit bg-crit-soft px-2 py-1 rounded max-w-full break-words">
                        {pickerError}
                      </div>
                    )}
                  </div>
                ) : loadingTables ? (
                  <div className="px-3 py-6 text-[11.5px] text-muted text-center">
                    Loading tables…
                  </div>
                ) : pickerError ? (
                  <div className="px-3 py-3 text-[11px] text-crit bg-crit-soft text-center break-words">
                    {pickerError}
                  </div>
                ) : addDbTables.length === 0 ? (
                  <div className="px-3 py-6 text-[11.5px] text-muted text-center">
                    {addDb ? "No tables in this database." : "Pick a database."}
                  </div>
                ) : (
                  <div
                    className="p-1 max-h-[220px] overflow-auto"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                      gap: 1,
                    }}
                  >
                    {addDbTables.map((t) => {
                      const added = inProject.has(t);
                      const checked = added || pendingTables.has(t);
                      const projectRow = added
                        ? tables.find(
                            (x) =>
                              x.connection_id === addConnId &&
                              x.database_name === addDb &&
                              x.table_name === t,
                          )
                        : undefined;
                      const isPrimary = projectRow?.is_primary === 1;
                      const isPending = !added && pendingTables.has(t);
                      return (
                        <label
                          key={t}
                          className={`group flex items-center gap-1.5 px-1.5 h-7 text-[11.5px] font-mono rounded cursor-pointer transition-colors ${
                            added
                              ? "bg-acc-soft/40 text-acc-ink hover:bg-acc-soft/70"
                              : isPending
                                ? "bg-warn-soft/40 text-ink-2 hover:bg-warn-soft/70"
                                : "text-ink-2 hover:bg-bg-2"
                          }`}
                          title={
                            added
                              ? `In project — uncheck to remove`
                              : `Check to add to project`
                          }
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => void togglePickerTable(t)}
                            className="cursor-pointer accent-acc"
                          />
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">
                            {t}
                            {isPrimary && (
                              <span
                                className="ml-1 text-acc font-sans"
                                title="Primary table"
                              >
                                ★
                              </span>
                            )}
                          </span>
                          {added && !isPrimary && projectRow && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void setPrimary(projectRow.id);
                              }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-[9px] uppercase tracking-wide text-acc hover:underline shrink-0"
                            >
                              ★ primary
                            </button>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {tables.length === 0 && (
                <div className="px-3 py-2 bg-panel-2 border border-border rounded-md text-[11.5px] text-muted text-center">
                  No tables yet. Check tables above to add them — the first added
                  becomes the primary table.
                </div>
              )}

              <SectionDivider
                title="Relations"
                actions={
                  <>
                    <button
                      onClick={() => void importRelations()}
                      disabled={importing}
                      className="h-6 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2 disabled:opacity-50"
                    >
                      {importing ? "Importing…" : "Import from schema analysis"}
                    </button>
                    <button
                      onClick={() => void inferProjectAiRelations()}
                      disabled={aiInferring}
                      className="h-6 px-2 text-[11px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50"
                    >
                      {aiInferring ? "AI thinking…" : "🤖 AI Infer"}
                    </button>
                  </>
                }
              />
              {importMsg && (
                <div className="text-[11px] text-ok bg-ok-soft px-2 py-1 rounded">
                  {importMsg}
                </div>
              )}
              {aiInferMsg && (
                <div
                  className={`text-[11px] px-2 py-1 rounded whitespace-pre-wrap break-words ${
                    aiInferErr ? "text-crit bg-crit-soft" : "text-ok bg-ok-soft"
                  }`}
                >
                  {aiInferMsg}
                </div>
              )}

              <div className="bg-acc-soft/30 border border-acc/20 rounded-md p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink w-10 shrink-0">
                    From
                  </span>
                  <select
                    value={`${relFrom.connId}|${relFrom.db}|${relFrom.table}`}
                    onChange={(e) => {
                      const [connStr, db, table] = e.target.value.split("|");
                      setRelFrom({
                        connId: parseInt(connStr || "0", 10),
                        db: db ?? "",
                        table: table ?? "",
                        column: "",
                      });
                    }}
                    className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc flex-1 min-w-0"
                  >
                    <option value="0||">(pick)</option>
                    {tables.map((t) => (
                      <option
                        key={t.id}
                        value={`${t.connection_id}|${t.database_name}|${t.table_name}`}
                      >
                        {t.connection_id !== primaryConnId
                          ? `[${connLabel(t.connection_id)}] `
                          : ""}
                        {t.database_name}.{t.table_name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={relFrom.column}
                    onChange={(e) => setRelFrom({ ...relFrom, column: e.target.value })}
                    disabled={fromColumns.length === 0}
                    className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc disabled:opacity-50 w-[200px] shrink-0"
                  >
                    {fromColumns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink w-10 shrink-0">
                    To
                  </span>
                  <select
                    value={`${relTo.connId}|${relTo.db}|${relTo.table}`}
                    onChange={(e) => {
                      const [connStr, db, table] = e.target.value.split("|");
                      setRelTo({
                        connId: parseInt(connStr || "0", 10),
                        db: db ?? "",
                        table: table ?? "",
                        column: "",
                      });
                    }}
                    className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc flex-1 min-w-0"
                  >
                    <option value="0||">(pick)</option>
                    {tables.map((t) => (
                      <option
                        key={t.id}
                        value={`${t.connection_id}|${t.database_name}|${t.table_name}`}
                      >
                        {t.connection_id !== primaryConnId
                          ? `[${connLabel(t.connection_id)}] `
                          : ""}
                        {t.database_name}.{t.table_name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={relTo.column}
                    onChange={(e) => setRelTo({ ...relTo, column: e.target.value })}
                    disabled={toColumns.length === 0}
                    className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc disabled:opacity-50 w-[200px] shrink-0"
                  >
                    {toColumns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink w-10 shrink-0">
                    Card
                  </span>
                  <select
                    value={relCard}
                    onChange={(e) => setRelCard(e.target.value)}
                    className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc w-[120px] shrink-0"
                  >
                    {CARDINALITIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <div className="flex-1" />
                  <button
                    onClick={() => void addRelation()}
                    className="h-7 px-4 text-[11px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2"
                  >
                    Add relation
                  </button>
                </div>
              </div>

              {relations.length === 0 ? (
                <div className="px-3 py-3 bg-panel-2 border border-border rounded-md text-[11.5px] text-muted text-center">
                  No relations yet. Add manually or import from schema analysis (after
                  running Analyze Schema).
                </div>
              ) : (
                <div className="border border-border rounded-md overflow-hidden">
                  <div
                    className="grid bg-bg-2 px-3 h-7 items-center gap-3 border-b border-border text-[10px] uppercase tracking-wider font-bold text-muted"
                    style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 60px 80px 60px" }}
                  >
                    <div>From</div>
                    <div>To</div>
                    <div className="text-center">Card.</div>
                    <div>Source</div>
                    <div></div>
                  </div>
                  <div style={{ maxHeight: 240, overflowY: "auto" }}>
                  {relations.map((r) => {
                    const crossConn = r.from_connection_id !== r.to_connection_id;
                    const crossDb = !crossConn && r.from_db !== r.to_db;
                    return (
                      <div
                        key={r.id}
                        className="grid px-3 h-8 items-center gap-3 border-b border-border last:border-b-0 text-[11px] hover:bg-[rgba(0,109,104,0.03)]"
                        style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 60px 80px 60px" }}
                      >
                        <code className="font-mono text-ink-2 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 block">
                          {r.from_connection_id !== primaryConnId && (
                            <span className="text-[9px] mr-1 px-1 bg-acc-soft text-acc-ink rounded font-sans font-bold">
                              {connLabel(r.from_connection_id)}
                            </span>
                          )}
                          {r.from_db}.{r.from_table}.{r.from_column}
                          {crossConn && (
                            <span
                              className="ml-1 text-[9px] px-1 bg-pii-soft text-pii rounded font-sans font-bold"
                              title="Cross-connection relation"
                            >
                              X-CONN
                            </span>
                          )}
                          {crossDb && (
                            <span
                              className="ml-1 text-[9px] px-1 bg-acc-soft text-acc-ink rounded font-sans font-bold"
                              title="Cross-database relation"
                            >
                              X-DB
                            </span>
                          )}
                        </code>
                        <code className="font-mono text-ink-2 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 block">
                          {r.to_connection_id !== primaryConnId && (
                            <span className="text-[9px] mr-1 px-1 bg-acc-soft text-acc-ink rounded font-sans font-bold">
                              {connLabel(r.to_connection_id)}
                            </span>
                          )}
                          {r.to_db}.{r.to_table}.{r.to_column}
                        </code>
                        <div className="text-center font-mono text-ink-2">
                          {r.cardinality}
                        </div>
                        <div className="text-subtle">{r.source}</div>
                        <div className="text-right">
                          <button
                            onClick={() => void removeRelation(r.id)}
                            className="text-[11px] text-crit hover:underline"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}

              {current.id != null && (
                <ProjectCacheMappingsSection
                  projectId={current.id}
                  tables={tables}
                  connections={connections}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectMetaForm({
  current,
  saving,
  onChange,
  onSave,
  onDelete,
}: {
  current: Project;
  saving: boolean;
  onChange: (p: Project) => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
          Name <span className="text-crit normal-case tracking-normal">*</span>
        </span>
        <input
          value={current.name}
          onChange={(e) => onChange({ ...current, name: e.target.value })}
          placeholder="e.g. Customer Support"
          required
          autoFocus={!current.id}
          className="form-input"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
          Description{" "}
          <span className="text-subtle normal-case tracking-normal font-normal">
            optional
          </span>
        </span>
        <input
          value={current.description ?? ""}
          onChange={(e) =>
            onChange({ ...current, description: e.target.value || null })
          }
          placeholder="What does this project track?"
          className="form-input"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : current.id ? "Save" : "Create"}
        </button>
        <div className="flex-1" />
        {onDelete && (
          <button
            onClick={onDelete}
            className="h-7 px-3 text-[12px] text-crit hover:bg-crit-soft rounded-md"
          >
            Delete project
          </button>
        )}
      </div>
    </div>
  );
}

function SectionDivider({
  title,
  actions,
}: {
  title: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 pt-2 mt-1 border-t border-border">
      <div className="text-[11px] uppercase tracking-wider font-bold text-ink-2">
        {title}
      </div>
      <div className="flex-1" />
      {actions}
    </div>
  );
}

function ProjectTablesList({
  tables,
  openConnIds,
  connLabel,
  onSetPrimary,
  onRemove,
  onJumpToPicker,
}: {
  tables: ProjectTable[];
  openConnIds: Set<number>;
  connLabel: (id: number) => string;
  onSetPrimary: (id: number) => void;
  onRemove: (id: number) => void;
  onJumpToPicker: (connId: number, db: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  type Group = { connId: number; db: string; rows: ProjectTable[] };
  const groups: Group[] = [];
  for (const t of tables) {
    let g = groups.find(
      (x) => x.connId === t.connection_id && x.db === t.database_name,
    );
    if (!g) {
      g = { connId: t.connection_id, db: t.database_name, rows: [] };
      groups.push(g);
    }
    g.rows.push(t);
  }
  for (const g of groups) {
    g.rows.sort((a, b) => a.table_name.localeCompare(b.table_name));
  }

  return (
    <div className="border border-border rounded-md bg-panel shrink-0">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center gap-2 px-3 h-7 border-b border-border bg-bg-2 hover:bg-panel-2 text-left"
      >
        <span className="text-[10px] text-muted inline-block">
          {expanded ? "▼" : "▶"}
        </span>
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
          Already in project
        </span>
        <span className="text-[10.5px] text-subtle">
          {tables.length} table{tables.length !== 1 ? "s" : ""}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-subtle">
          {expanded ? "click to collapse" : "click to expand"}
        </span>
      </button>
      {expanded && <div className="max-h-[180px] overflow-auto">
        {groups.map((g) => {
          const open = openConnIds.has(g.connId);
          return (
            <div key={`${g.connId}|${g.db}`} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onJumpToPicker(g.connId, g.db)}
                className="w-full flex items-center gap-2 px-3 h-6 bg-panel-2 hover:bg-bg-2 text-left"
                title="Jump to this database in the picker below"
              >
                <span className={`text-[10px] ${open ? "text-ok" : "text-muted"}`}>
                  {open ? "●" : "○"}
                </span>
                <span className="text-[11px] font-mono text-ink-2 truncate">
                  {connLabel(g.connId)} <span className="text-subtle">/</span> {g.db}
                </span>
                {!open && (
                  <span className="text-[9px] px-1 bg-warn-soft text-warn rounded font-sans font-bold">
                    CLOSED
                  </span>
                )}
                <div className="flex-1" />
                <span className="text-[10px] text-subtle">{g.rows.length}</span>
              </button>
              <div
                className="p-1"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                  gap: 1,
                }}
              >
                {g.rows.map((t) => {
                  const isPrimary = t.is_primary === 1;
                  return (
                    <div
                      key={t.id}
                      className="row flex items-center gap-1.5 px-2 h-6 text-[11.5px] font-mono rounded hover:bg-bg-2"
                    >
                      <span className="truncate flex-1 text-ink-2" title={t.table_name}>
                        {t.table_name}
                        {isPrimary && (
                          <span
                            className="ml-1 text-acc font-sans"
                            title="Primary table"
                          >
                            ★
                          </span>
                        )}
                      </span>
                      {!isPrimary && (
                        <button
                          type="button"
                          onClick={() => onSetPrimary(t.id)}
                          className="text-[9px] uppercase tracking-wide text-acc hover:underline shrink-0"
                          title="Set as primary table"
                        >
                          ★
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onRemove(t.id)}
                        className="text-[10px] text-crit hover:underline shrink-0"
                        title="Remove from project"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}
