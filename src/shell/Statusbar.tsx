import { useEffect, useState } from "react";
import type { Connection, Project } from "../types";
import type { AppMode } from "./types";

type Props = {
  mode: AppMode;
  working: Connection | null;
  activeProject: Project | null;
  databasesCount: number;
  tablesCount: number;
  serverVersion: string | null;
  activeTabLabel: string | null;
  selectionLabel: string | null;
  threadsRunning: number | null;
  // Project mode extras
  projectTableCount: number;
  projectConnsOpen: number;
  projectConnsTotal: number;
  version?: string;
};

function nowUtc(): string {
  const d = new Date();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export function Statusbar({
  mode,
  working,
  activeProject,
  databasesCount,
  tablesCount,
  serverVersion,
  activeTabLabel,
  selectionLabel,
  threadsRunning,
  projectTableCount,
  projectConnsOpen,
  projectConnsTotal,
  version = "0.3.5",
}: Props) {
  const [clock, setClock] = useState(nowUtc());

  useEffect(() => {
    const t = setInterval(() => setClock(nowUtc()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex items-center h-6 px-3 bg-bg-2 border-t border-border text-[11px] text-muted font-medium shrink-0 gap-3 select-none">
      {mode.kind === "connection" && working ? (
        <>
          <span className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full bg-ok"
              style={{ boxShadow: "0 0 0 2px rgba(2,122,72,0.12)" }}
            />
            <span className="text-ink-2">{working.name}</span>
          </span>
          {working.kind === "milvus" ? (
            <>
              <span className="text-border-2">·</span>
              <span className="font-mono">Milvus</span>
              <span className="text-border-2">·</span>
              <span className="font-mono">
                {working.host}:{working.port}
              </span>
              {working.database && (
                <>
                  <span className="text-border-2">·</span>
                  <span className="font-mono">db: {working.database}</span>
                </>
              )}
            </>
          ) : working.kind === "sqlite" ? (
            <>
              <span className="text-border-2">·</span>
              <span className="font-mono">SQLite</span>
              {working.database && (
                <>
                  <span className="text-border-2">·</span>
                  <span
                    className="font-mono truncate max-w-[300px]"
                    title={working.database}
                  >
                    {working.database.split("/").pop() || working.database}
                  </span>
                </>
              )}
            </>
          ) : working.kind === "redis" ? (
            <>
              <span className="text-border-2">·</span>
              <span className="font-mono">Redis</span>
              <span className="text-border-2">·</span>
              <span className="font-mono">
                {working.host}:{working.port}
              </span>
              <span className="text-border-2">·</span>
              <span className="font-mono">database {working.database ?? "0"}</span>
            </>
          ) : (
            <>
              {serverVersion && (
                <>
                  <span className="text-border-2">·</span>
                  <span className="font-mono">MySQL {serverVersion}</span>
                </>
              )}
              <span className="text-border-2">·</span>
              <span className="font-mono">
                {working.username}@{working.host}:{working.port}
              </span>
              <span className="text-border-2">·</span>
              <span className="tabular-nums">
                {databasesCount} db · {tablesCount} tables loaded
              </span>
              {selectionLabel && (
                <>
                  <span className="text-border-2">·</span>
                  <span className="font-mono text-ink-2 truncate max-w-[200px]">
                    {selectionLabel}
                  </span>
                </>
              )}
            </>
          )}
        </>
      ) : mode.kind === "project" && activeProject ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className="text-[12px]">📁</span>
            <span className="text-ink-2">{activeProject.name}</span>
          </span>
          <span className="text-border-2">·</span>
          <span className="tabular-nums">
            {projectTableCount} table{projectTableCount !== 1 ? "s" : ""}
          </span>
          <span className="text-border-2">·</span>
          <span className="flex items-center gap-1 tabular-nums">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                projectConnsOpen === projectConnsTotal ? "bg-ok" : "bg-warn"
              }`}
            />
            {projectConnsOpen}/{projectConnsTotal} conn open
          </span>
        </>
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-subtle" />
          <span>Home</span>
        </span>
      )}

      <div className="flex-1" />

      {mode.kind !== "home" && activeTabLabel && (
        <>
          <span className="font-mono text-ink-2 truncate max-w-[160px]">
            {activeTabLabel}
          </span>
          <span className="text-border-2">·</span>
        </>
      )}
      {mode.kind === "connection" && working && working.kind !== "milvus" && threadsRunning != null && (
        <>
          <span className="flex items-center gap-1">
            <span
              className={`w-1.5 h-1.5 rounded-full ${threadsRunning > 20 ? "bg-warn" : "bg-ok"}`}
            />
            <span className="tabular-nums">{threadsRunning} running</span>
          </span>
          <span className="text-border-2">·</span>
        </>
      )}
      <span className="tabular-nums">{clock}</span>
      <span className="text-border-2">·</span>
      <span>SquireDB v{version}</span>
    </div>
  );
}
