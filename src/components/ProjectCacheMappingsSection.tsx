import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CACHE_COMMANDS,
  type CacheCommand,
  type Connection,
  type ProjectCacheMapping,
  type ProjectTable,
} from "../types";

type AddForm = {
  mysqlTable: string; // "connId|db|table"
  redisConnId: number;
  redisDb: number;
  pattern: string;
  command: CacheCommand;
  label: string;
};

const REDIS_DB_OPTIONS: number[] = Array.from({ length: 16 }, (_, i) => i);

const emptyForm = (
  firstTable: string,
  firstRedis: number,
): AddForm => ({
  mysqlTable: firstTable,
  redisConnId: firstRedis,
  redisDb: 0,
  pattern: "",
  command: "GET",
  label: "",
});

export function ProjectCacheMappingsSection({
  projectId,
  tables,
  connections,
}: {
  projectId: number;
  tables: ProjectTable[];
  connections: Connection[];
}) {
  const redisConns = useMemo(
    () => connections.filter((c) => c.kind === "redis" && c.id != null),
    [connections],
  );

  const [mappings, setMappings] = useState<ProjectCacheMapping[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const firstTableKey =
    tables.length > 0
      ? `${tables[0].connection_id}|${tables[0].database_name}|${tables[0].table_name}`
      : "";
  const firstRedis = redisConns[0]?.id ?? 0;
  const [form, setForm] = useState<AddForm>(emptyForm(firstTableKey, firstRedis));

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPattern, setEditPattern] = useState("");
  const [editCommand, setEditCommand] = useState<CacheCommand>("GET");
  const [editLabel, setEditLabel] = useState("");
  const [editDb, setEditDb] = useState(0);

  async function refresh() {
    try {
      const list = await invoke<ProjectCacheMapping[]>(
        "list_project_cache_mappings",
        { projectId },
      );
      setMappings(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Keep form defaults aligned with available picks.
  useEffect(() => {
    if (!form.mysqlTable && firstTableKey) {
      setForm((f) => ({ ...f, mysqlTable: firstTableKey }));
    }
    if (!form.redisConnId && firstRedis) {
      setForm((f) => ({ ...f, redisConnId: firstRedis }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstTableKey, firstRedis]);

  function connLabel(id: number): string {
    return connections.find((c) => c.id === id)?.name ?? `#${id}`;
  }

  function parsePattern(p: string): string[] {
    const out: string[] = [];
    const re = /\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p)) !== null) {
      if (m[1] && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }

  async function add() {
    const [connStr, db, table] = form.mysqlTable.split("|");
    const connId = parseInt(connStr || "0", 10);
    if (!connId || !db || !table) {
      setError("Pick a MySQL table.");
      return;
    }
    if (!form.redisConnId) {
      setError("Pick a Redis connection.");
      return;
    }
    if (parsePattern(form.pattern).length === 0) {
      setError("Pattern must contain at least one {column}.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await invoke("create_project_cache_mapping", {
        projectId,
        mysqlConnectionId: connId,
        mysqlDatabase: db,
        mysqlTable: table,
        redisConnectionId: form.redisConnId,
        redisDb: form.redisDb,
        keyPattern: form.pattern.trim(),
        command: form.command,
        label: form.label.trim() || null,
      });
      setForm({
        mysqlTable: form.mysqlTable,
        redisConnId: form.redisConnId,
        redisDb: form.redisDb,
        pattern: "",
        command: "GET",
        label: "",
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(m: ProjectCacheMapping) {
    setEditingId(m.id);
    setEditPattern(m.key_pattern);
    setEditCommand((m.command as CacheCommand) ?? "GET");
    setEditLabel(m.label ?? "");
    setEditDb(m.redis_db ?? 0);
  }

  async function saveEdit() {
    if (editingId === null) return;
    if (parsePattern(editPattern).length === 0) {
      setError("Pattern must contain at least one {column}.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await invoke("update_project_cache_mapping", {
        id: editingId,
        redisDb: editDb,
        keyPattern: editPattern.trim(),
        command: editCommand,
        label: editLabel.trim() || null,
      });
      setEditingId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Remove this cache mapping?")) return;
    try {
      await invoke("delete_project_cache_mapping", { id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const noPrereq = tables.length === 0 || redisConns.length === 0;

  return (
    <>
      <div className="flex items-center gap-2 pt-2 mt-1 border-t border-border">
        <div className="text-[11px] uppercase tracking-wider font-bold text-ink-2">
          Cache mappings
        </div>
        <div className="text-[10px] text-subtle">
          (Redis cache attached to MySQL rows — fetched on drill)
        </div>
        <div className="flex-1" />
      </div>

      {noPrereq ? (
        <div className="px-3 py-3 bg-panel-2 border border-border rounded-md text-[11.5px] text-muted text-center">
          {tables.length === 0
            ? "Add at least one project table first."
            : "No Redis connections configured. Add a Redis connection from Home → New connection → Redis."}
        </div>
      ) : (
        <>
          <div className="bg-acc-soft/30 border border-acc/20 rounded-md p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink w-12 shrink-0">
                Table
              </span>
              <select
                value={form.mysqlTable}
                onChange={(e) =>
                  setForm({ ...form, mysqlTable: e.target.value })
                }
                className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc flex-1 min-w-0"
              >
                {tables.map((t) => (
                  <option
                    key={t.id}
                    value={`${t.connection_id}|${t.database_name}|${t.table_name}`}
                  >
                    [{connLabel(t.connection_id)}] {t.database_name}.{t.table_name}
                  </option>
                ))}
              </select>
              <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink shrink-0">
                Redis
              </span>
              <select
                value={form.redisConnId}
                onChange={(e) =>
                  setForm({ ...form, redisConnId: parseInt(e.target.value, 10) })
                }
                className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc w-[160px] shrink-0"
              >
                {redisConns.map((c) => (
                  <option key={c.id ?? 0} value={c.id ?? 0}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span
                className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink shrink-0"
                title="Redis logical database (0-15)"
              >
                DB
              </span>
              <select
                value={form.redisDb}
                onChange={(e) =>
                  setForm({ ...form, redisDb: parseInt(e.target.value, 10) })
                }
                className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc w-[70px] shrink-0"
                title="Redis logical database (0-15)"
              >
                {REDIS_DB_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink shrink-0">
                Cmd
              </span>
              <select
                value={form.command}
                onChange={(e) =>
                  setForm({ ...form, command: e.target.value as CacheCommand })
                }
                className="h-7 px-2 text-[12px] font-mono bg-panel border border-border rounded-md outline-none focus:border-acc w-[110px] shrink-0"
              >
                {CACHE_COMMANDS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink w-12 shrink-0">
                Pattern
              </span>
              <input
                value={form.pattern}
                onChange={(e) => setForm({ ...form, pattern: e.target.value })}
                placeholder="user:{id}  or  cache:order:{order_id}:items"
                className="form-input flex-1 min-w-[260px] font-mono text-[12px]"
              />
              <span className="text-[11px] uppercase tracking-wider font-semibold text-acc-ink shrink-0">
                Label
              </span>
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="optional"
                className="form-input w-[180px] text-[12px] shrink-0"
              />
              <button
                onClick={() => void add()}
                disabled={busy}
                className="h-7 px-4 text-[11px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 shrink-0 ml-auto"
              >
                Add mapping
              </button>
            </div>
            <div className="text-[10.5px] text-subtle">
              Use <code>{"{column}"}</code> to interpolate row values into the
              key, e.g. <code>user:{"{id}"}</code>.
            </div>
          </div>

          {mappings.length === 0 ? (
            <div className="px-3 py-3 bg-panel-2 border border-border rounded-md text-[11.5px] text-muted text-center">
              No cache mappings yet.
            </div>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <div
                className="grid bg-bg-2 px-3 h-7 items-center gap-3 border-b border-border text-[10px] uppercase tracking-wider font-bold text-muted"
                style={{
                  gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr) 70px 110px",
                }}
              >
                <div>Table</div>
                <div>Redis</div>
                <div>Pattern / Label</div>
                <div className="text-center">Cmd</div>
                <div></div>
              </div>
              {mappings.map((m) => {
                const isEditing = editingId === m.id;
                return (
                  <div
                    key={m.id}
                    className="grid px-3 py-1.5 items-center gap-3 border-b border-border last:border-b-0 text-[11px] hover:bg-[rgba(0,109,104,0.03)]"
                    style={{
                      gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr) 70px 110px",
                    }}
                  >
                    <code className="font-mono text-ink-2 overflow-hidden text-ellipsis whitespace-nowrap">
                      <span className="text-[9px] mr-1 px-1 bg-acc-soft text-acc-ink rounded font-sans font-bold">
                        {connLabel(m.mysql_connection_id)}
                      </span>
                      {m.mysql_database}.{m.mysql_table}
                    </code>
                    <code className="font-mono text-ink-2 overflow-hidden text-ellipsis whitespace-nowrap flex items-center gap-1 min-w-0">
                      <span className="text-[9px] px-1 bg-pii-soft text-pii rounded font-sans font-bold shrink-0">
                        REDIS
                      </span>
                      <span className="truncate">
                        {connLabel(m.redis_connection_id)}
                      </span>
                      {isEditing ? (
                        <select
                          value={editDb}
                          onChange={(e) => setEditDb(parseInt(e.target.value, 10))}
                          className="h-5 px-1 text-[10px] font-mono bg-panel border border-border rounded outline-none focus:border-acc shrink-0"
                          title="Redis logical database (0-15)"
                        >
                          {REDIS_DB_OPTIONS.map((n) => (
                            <option key={n} value={n}>
                              db{n}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className="text-[9px] px-1 bg-bg-2 text-muted rounded font-sans font-bold shrink-0"
                          title="Redis logical database"
                        >
                          db{m.redis_db ?? 0}
                        </span>
                      )}
                    </code>
                    {isEditing ? (
                      <div className="flex flex-col gap-1">
                        <input
                          value={editPattern}
                          onChange={(e) => setEditPattern(e.target.value)}
                          className="form-input h-6 text-[11px] font-mono"
                          placeholder="key:{id}"
                        />
                        <input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          className="form-input h-6 text-[11px]"
                          placeholder="optional label"
                        />
                      </div>
                    ) : (
                      <div className="overflow-hidden">
                        <div className="font-mono text-ink-2 text-ellipsis whitespace-nowrap overflow-hidden">
                          {m.key_pattern}
                        </div>
                        {m.label && (
                          <div className="text-[10px] text-subtle">{m.label}</div>
                        )}
                      </div>
                    )}
                    <div className="text-center font-mono text-ink-2">
                      {isEditing ? (
                        <select
                          value={editCommand}
                          onChange={(e) =>
                            setEditCommand(e.target.value as CacheCommand)
                          }
                          className="h-6 px-1 text-[11px] font-mono bg-panel border border-border rounded outline-none focus:border-acc"
                        >
                          {CACHE_COMMANDS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      ) : (
                        m.command
                      )}
                    </div>
                    <div className="text-right flex gap-2 justify-end">
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => void saveEdit()}
                            disabled={busy}
                            className="text-[11px] text-acc hover:underline"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="text-[11px] text-muted hover:underline"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(m)}
                            className="text-[11px] text-acc hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => void remove(m.id)}
                            className="text-[11px] text-crit hover:underline"
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="text-[11px] text-crit bg-crit-soft px-2 py-1 rounded">
          {error}
        </div>
      )}
    </>
  );
}
