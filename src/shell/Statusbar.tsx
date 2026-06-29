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
  activeAiName: string | null;
  activeEmbeddingName: string | null;
  version: string;
  updateAvailable: { version: string } | null;
  updateDownloading: boolean;
  updateProgress: number | null;
  onUpdate: () => void;
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
  activeAiName,
  activeEmbeddingName,
  version,
  updateAvailable,
  updateDownloading,
  updateProgress,
  onUpdate,
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
      {activeAiName && (
        <>
          <span
            className="flex items-center gap-1 truncate max-w-[140px]"
            title={`Active chat model: ${activeAiName}`}
          >
            <span>🤖</span>
            <span className="text-ink-2 truncate">{activeAiName}</span>
          </span>
          <span className="text-border-2">·</span>
        </>
      )}
      {activeEmbeddingName && (
        <>
          <span
            className="flex items-center gap-1 truncate max-w-[140px]"
            title={`Active embedding: ${activeEmbeddingName}`}
          >
            <span>📐</span>
            <span className="text-ink-2 truncate">{activeEmbeddingName}</span>
          </span>
          <span className="text-border-2">·</span>
        </>
      )}
      <span className="tabular-nums">{clock}</span>
      <span className="text-border-2">·</span>
      {updateDownloading ? (
        <span
          className="flex items-center gap-1.5 px-2 h-4 rounded-full bg-acc-soft/60 text-acc font-medium tabular-nums"
          title="Downloading update…"
        >
          <span className="w-2 h-2 rounded-full bg-acc animate-pulse" />
          {updateProgress != null ? `Updating ${updateProgress}%` : "Updating…"}
        </span>
      ) : updateAvailable ? (
        <button
          type="button"
          onClick={onUpdate}
          className="flex items-center gap-1.5 px-2 h-4 rounded-full bg-acc-soft/60 hover:bg-acc-soft text-acc font-medium transition cursor-pointer"
          title={`Click to update to v${updateAvailable.version}`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-acc" />
          <span>↑ v{updateAvailable.version} available</span>
        </button>
      ) : (
        <span>{version ? `SquireDB v${version}` : "SquireDB"}</span>
      )}
    </div>
  );
}
