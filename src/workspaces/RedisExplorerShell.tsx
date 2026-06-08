import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useEffect, useMemo } from "react";

import { WorkspaceSidebar } from "../shell/WorkspaceSidebar";
import { TreeGroupRow } from "../shell/atoms/TreeGroupRow";
import type { Connection, RedisScanResult } from "../types";
import type { Tab } from "../shell/types";
import { RedisKeyWorkspace } from "./RedisKeyWorkspace";
import { RedisConsoleWorkspace } from "./RedisConsoleWorkspace";

const REDIS_DB_COUNT = 16;
const SCAN_PAGE_SIZE = 200;

type KeyListState = {
  pattern: string;
  cursor: number;
  keys: string[];
  busy: boolean;
  error: string;
};

const emptyKeyList: KeyListState = {
  pattern: "*",
  cursor: 0,
  keys: [],
  busy: false,
  error: "",
};

export function RedisExplorerShell({
  conn,
  tabs,
  activeTab,
  onOpenKey,
  onOpenConsole,
}: {
  conn: Connection;
  tabs: Tab[];
  activeTab: Tab | null;
  onOpenKey: (db: number, key: string) => void;
  onOpenConsole: (db: number) => void;
}) {
  const connId = conn.id ?? -1;
  const defaultDb = parseInt(conn.database ?? "0", 10) || 0;
  const [selectedDb, setSelectedDb] = useState<number>(defaultDb);
  const [expandedDbs, setExpandedDbs] = useState<Set<number>>(
    () => new Set([defaultDb]),
  );
  const [keysByDb, setKeysByDb] = useState<Record<number, KeyListState>>({});

  const getDbState = useCallback(
    (db: number): KeyListState => keysByDb[db] ?? emptyKeyList,
    [keysByDb],
  );

  const patchDbState = useCallback(
    (db: number, patch: Partial<KeyListState>) => {
      setKeysByDb((prev) => ({
        ...prev,
        [db]: { ...(prev[db] ?? emptyKeyList), ...patch },
      }));
    },
    [],
  );

  const scan = useCallback(
    async (db: number, pattern: string, cursor: number) => {
      if (connId < 0) return;
      patchDbState(db, { busy: true, error: "" });
      try {
        const result = await invoke<RedisScanResult>("redis_scan", {
          connectionId: connId,
          db,
          pattern: pattern || "*",
          cursor,
          count: SCAN_PAGE_SIZE,
        });
        setKeysByDb((prev) => {
          const existing = prev[db] ?? emptyKeyList;
          const merged =
            cursor === 0
              ? result.keys
              : Array.from(new Set([...existing.keys, ...result.keys]));
          return {
            ...prev,
            [db]: {
              pattern,
              cursor: result.cursor,
              keys: merged,
              busy: false,
              error: "",
            },
          };
        });
      } catch (err) {
        patchDbState(db, { busy: false, error: String(err) });
      }
    },
    [connId, patchDbState],
  );

  const toggleDb = useCallback(
    (db: number) => {
      setSelectedDb(db);
      setExpandedDbs((prev) => {
        const next = new Set(prev);
        if (next.has(db)) {
          next.delete(db);
        } else {
          next.add(db);
        }
        return next;
      });
      const state = keysByDb[db];
      if (!state) {
        void scan(db, "*", 0);
      }
    },
    [keysByDb, scan],
  );

  // Auto-scan default db on mount
  useEffect(() => {
    if (!keysByDb[defaultDb]) {
      void scan(defaultDb, "*", 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeKey = useMemo(() => {
    if (activeTab?.kind === "redis-key") {
      return { db: activeTab.db, key: activeTab.rkey };
    }
    return null;
  }, [activeTab]);

  return (
    <>
      <WorkspaceSidebar
        toolbar={
          <div className="text-[10.5px] text-muted px-1">
            Selected: <span className="font-mono text-ink-2">database {selectedDb}</span>
          </div>
        }
        tree={
          <div className="flex flex-col gap-0">
            {Array.from({ length: REDIS_DB_COUNT }).map((_, db) => {
              const state = getDbState(db);
              const expanded = expandedDbs.has(db);
              return (
                <div key={db}>
                  <TreeGroupRow
                    expanded={expanded}
                    onClick={() => toggleDb(db)}
                    label={`database ${db}`}
                    trailing={
                      state.keys.length > 0 ? (
                        <span className="text-[10px] text-subtle font-mono shrink-0">
                          {state.keys.length}
                          {state.cursor !== 0 ? "+" : ""}
                        </span>
                      ) : undefined
                    }
                  />
                  {expanded && (
                    <div className="pl-3 pr-1 py-1 flex flex-col gap-1">
                      <PatternBar
                        pattern={state.pattern}
                        busy={state.busy}
                        onSubmit={(p) => void scan(db, p, 0)}
                      />
                      {state.error && (
                        <div className="text-[10.5px] text-crit px-1">
                          {state.error}
                        </div>
                      )}
                      {state.keys.length === 0 && !state.busy && !state.error && (
                        <div className="text-[10.5px] text-muted px-1 italic">
                          (no keys)
                        </div>
                      )}
                      {state.keys.map((k) => {
                        const isActive =
                          activeKey?.db === db && activeKey?.key === k;
                        return (
                          <button
                            key={k}
                            onClick={() => {
                              setSelectedDb(db);
                              onOpenKey(db, k);
                            }}
                            className={`h-[22px] pl-2 pr-1 text-[11px] font-mono truncate text-left rounded-sm ${
                              isActive
                                ? "bg-acc-soft text-acc-ink"
                                : "text-ink-2 hover:bg-bg-2"
                            }`}
                            title={k}
                          >
                            {k}
                          </button>
                        );
                      })}
                      {state.cursor !== 0 && (
                        <button
                          onClick={() => void scan(db, state.pattern, state.cursor)}
                          disabled={state.busy}
                          className="h-6 mt-1 text-[10.5px] text-acc hover:text-acc-ink disabled:opacity-50"
                        >
                          {state.busy ? "Loading…" : "Load more"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        }
        secondary={
          <div className="px-3 py-2 flex flex-col gap-1.5">
            <button
              onClick={() => onOpenConsole(selectedDb)}
              className="h-7 text-[12px] font-medium bg-panel-2 border border-border rounded-md hover:bg-bg-2"
            >
              + Console (database {selectedDb})
            </button>
            <div className="text-[10px] text-subtle px-1">
              Each tab is scoped to one database. The console runs commands
              against the database selected when the tab was opened.
            </div>
          </div>
        }
      />

      <main className="flex-1 min-w-0 flex flex-col bg-bg overflow-hidden relative">
        {tabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted">
            <div className="text-center text-[13px]">
              <div className="mb-1">No tabs open.</div>
              <div className="text-subtle">
                Click a key in the sidebar, or open a console.
              </div>
            </div>
          </div>
        ) : (
          <>
            {tabs.map((tab) => {
              if (tab.kind === "redis-key") {
                return (
                  <div
                    key={tab.id}
                    className={`flex-1 min-w-0 min-h-0 flex flex-col ${
                      activeTab?.id === tab.id ? "" : "hidden"
                    }`}
                  >
                    <RedisKeyWorkspace
                      connectionId={connId}
                      db={tab.db}
                      rkey={tab.rkey}
                    />
                  </div>
                );
              }
              if (tab.kind === "redis-console") {
                return (
                  <div
                    key={tab.id}
                    className={`flex-1 min-w-0 min-h-0 flex flex-col ${
                      activeTab?.id === tab.id ? "" : "hidden"
                    }`}
                  >
                    <RedisConsoleWorkspace
                      connectionId={connId}
                      db={tab.db}
                    />
                  </div>
                );
              }
              return null;
            })}
          </>
        )}
      </main>
    </>
  );
}

function PatternBar({
  pattern,
  busy,
  onSubmit,
}: {
  pattern: string;
  busy: boolean;
  onSubmit: (p: string) => void;
}) {
  const [draft, setDraft] = useState(pattern);
  useEffect(() => {
    setDraft(pattern);
  }, [pattern]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft || "*");
      }}
      className="flex gap-1"
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="pattern, e.g. user:*"
        className="form-input h-6 text-[11px] font-mono flex-1"
      />
      <button
        type="submit"
        disabled={busy}
        className="h-6 px-2 text-[10.5px] bg-panel-2 border border-border rounded-md hover:bg-bg-2 disabled:opacity-50"
      >
        Scan
      </button>
    </form>
  );
}
