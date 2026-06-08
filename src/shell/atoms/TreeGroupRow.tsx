import type { ReactNode } from "react";

/**
 * Shared sidebar group row (depth-1, e.g. a database under a connection or a
 * top-level redis db). Owns the chevron / row height / hover / muted style so
 * SchemaTreeView, ProjectTreeView and RedisExplorerShell move together.
 */
export function TreeGroupRow({
  expanded,
  onClick,
  label,
  trailing,
  muted,
  title,
}: {
  expanded: boolean;
  onClick: () => void;
  label: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-1.5 h-6 px-2 text-[12px] rounded hover:bg-bg ${
        muted ? "text-muted" : "text-ink-2 font-medium"
      }`}
    >
      <span className="text-[9px] text-subtle w-2 shrink-0">
        {expanded ? "▾" : "▸"}
      </span>
      <span className="truncate flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}
