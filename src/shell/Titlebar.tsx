import { useEffect, useRef, useState } from "react";
import type { Connection, Project } from "../types";
import type { AppMode } from "./types";

type Props = {
  mode: AppMode;
  connections: Connection[];
  projects: Project[];
  onSelectConnection: (conn: Connection) => void;
  onSelectProject: (project: Project) => void;
  onAddConnection: () => void;
  onAddProject: () => void;
  onEditConnection: (conn: Connection) => void;
  onEditProject: (project: Project) => void;
  onCloseConnection: () => void;
  onGoHome: () => void;
  onOpenSettings: () => void;
  onToggleDock: () => void;
  dockOpen: boolean;
  insightCount?: number;
};

export function Titlebar({
  mode,
  connections,
  projects,
  onSelectConnection,
  onSelectProject,
  onAddConnection,
  onAddProject,
  onEditConnection,
  onEditProject,
  onCloseConnection,
  onGoHome,
  onOpenSettings,
  onToggleDock,
  dockOpen,
  insightCount = 0,
}: Props) {
  return (
    <div
      data-tauri-drag-region
      className="flex items-center h-9 pl-[78px] pr-3 bg-bg-2 border-b border-border gap-2 shrink-0 select-none"
    >
      <button
        onClick={onGoHome}
        title="Home"
        className={`flex items-center gap-2 h-6 pl-1 pr-2 rounded-md ${
          mode.kind === "home"
            ? "bg-acc-soft text-acc-ink"
            : "hover:bg-bg text-ink"
        }`}
      >
        <span
          className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center text-white text-[10px] font-bold"
          style={{
            background: "linear-gradient(135deg, var(--acc) 0%, var(--acc-2) 100%)",
            boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.3)",
          }}
        >
          sq
        </span>
        <span className="text-[13px] font-semibold">SquireDB</span>
      </button>

      <span className="text-border-2 mx-0.5">·</span>

      <ConnectionPicker
        mode={mode}
        connections={connections}
        onSelect={onSelectConnection}
        onAdd={onAddConnection}
        onEdit={onEditConnection}
        onClose={onCloseConnection}
      />

      <ProjectPicker
        mode={mode}
        projects={projects}
        onSelect={onSelectProject}
        onAdd={onAddProject}
        onEdit={onEditProject}
      />

      <div className="flex-1" />

      <button
        onClick={onToggleDock}
        className={`relative h-6 px-2 text-xs rounded-md ${dockOpen ? "bg-acc-soft text-acc-ink" : "text-ink-2 hover:bg-bg"}`}
        title="AI Agents dock"
      >
        ⚹ AI Agents
        {!dockOpen && insightCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-crit text-white text-[9px] font-bold flex items-center justify-center">
            {insightCount}
          </span>
        )}
      </button>

      <button
        onClick={onOpenSettings}
        className="h-6 w-6 text-sm text-ink-2 hover:text-ink rounded-md hover:bg-bg flex items-center justify-center"
        title="Settings"
      >
        ⚙
      </button>
    </div>
  );
}

function ConnectionPicker({
  mode,
  connections,
  onSelect,
  onAdd,
  onEdit,
  onClose,
}: {
  mode: AppMode;
  connections: Connection[];
  onSelect: (c: Connection) => void;
  onAdd: () => void;
  onEdit: (c: Connection) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const activeConnId = mode.kind === "connection" ? mode.connectionId : null;
  const active =
    connections.find((c) => c.id === activeConnId) ?? null;

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 h-6 px-2 border rounded-md text-xs ${
          active
            ? "bg-acc-soft border-acc/30 text-acc-ink"
            : "bg-panel border-border text-ink hover:bg-panel-2"
        }`}
      >
        <span
          className={`w-[7px] h-[7px] rounded-full ${active ? "bg-ok" : "bg-subtle"}`}
          style={active ? { boxShadow: "0 0 0 2px rgba(2,122,72,0.12)" } : {}}
        />
        <span className="font-semibold">
          {active ? active.name : "Connections"}
        </span>
        <span className="text-subtle">▾</span>
      </button>
      {open && (
        <div
          className="absolute top-[30px] left-0 w-[320px] bg-panel border border-border rounded-lg z-20 py-1"
          style={{ boxShadow: "var(--sh-3)" }}
        >
          {connections.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">No connections yet.</div>
          )}
          {connections.map((c) => {
            const isActive = c.id === activeConnId;
            return (
              <div
                key={c.id ?? c.name}
                className="group flex items-center gap-2 px-3 py-1.5 hover:bg-bg-2 cursor-pointer"
                onClick={() => {
                  setOpen(false);
                  onSelect(c);
                }}
              >
                <span
                  className={`w-2 h-2 rounded-full ${isActive ? "bg-ok" : "bg-subtle"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ink font-medium truncate">
                    {c.name}
                  </div>
                  <div className="text-[11px] text-muted truncate">
                    {c.username}@{c.host}:{c.port}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onEdit(c);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-xs text-muted px-1.5 hover:text-ink"
                  title="Edit"
                >
                  ✎
                </button>
              </div>
            );
          })}
          <div className="border-t border-border mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-acc hover:bg-bg-2"
            >
              + Add connection
            </button>
            {active && (
              <button
                onClick={() => {
                  setOpen(false);
                  onClose();
                }}
                className="w-full text-left px-3 py-1.5 text-[13px] text-crit hover:bg-bg-2"
              >
                Close {active.name}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectPicker({
  mode,
  projects,
  onSelect,
  onAdd,
  onEdit,
}: {
  mode: AppMode;
  projects: Project[];
  onSelect: (p: Project) => void;
  onAdd: () => void;
  onEdit: (p: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const activeProjectId = mode.kind === "project" ? mode.projectId : null;
  const active = projects.find((p) => p.id === activeProjectId) ?? null;

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 h-6 px-2 border rounded-md text-xs ${
          active
            ? "bg-acc-soft border-acc/30 text-acc-ink"
            : "bg-panel border-border text-ink hover:bg-panel-2"
        }`}
      >
        <span className="text-[11px]">📁</span>
        <span className="font-semibold">{active ? active.name : "Projects"}</span>
        <span className="text-subtle">▾</span>
      </button>
      {open && (
        <div
          className="absolute top-[30px] left-0 w-[280px] bg-panel border border-border rounded-lg z-20 py-1"
          style={{ boxShadow: "var(--sh-3)" }}
        >
          {projects.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">No projects yet.</div>
          )}
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            return (
              <div
                key={p.id}
                className="group flex items-center gap-2 px-3 py-1.5 hover:bg-bg-2 cursor-pointer"
                onClick={() => {
                  setOpen(false);
                  onSelect(p);
                }}
              >
                <span
                  className={`w-2 h-2 rounded-full ${isActive ? "bg-acc" : "bg-subtle"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ink font-medium truncate">
                    {p.name}
                  </div>
                  {p.description && (
                    <div className="text-[11px] text-muted truncate">
                      {p.description}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onEdit(p);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-xs text-muted px-1.5 hover:text-ink"
                  title="Edit"
                >
                  ✎
                </button>
              </div>
            );
          })}
          <div className="border-t border-border mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-acc hover:bg-bg-2"
            >
              + New project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
