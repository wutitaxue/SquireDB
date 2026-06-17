import type { Tab } from "./types";
import { AGENT_META, PROJECT_AGENT_META } from "./types";
import { useContextMenu, type ContextMenuItem } from "./atoms/ContextMenu";

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseOthers?: (id: string) => void;
  onCloseToRight?: (id: string) => void;
  onCloseAll?: () => void;
  onDuplicate?: (id: string) => void;
  onNewQueryTab?: () => void;
};

function tabIcon(tab: Tab): string {
  if (tab.kind === "query") return "⟨/⟩";
  if (tab.kind === "project-drill") return "🔍";
  if (tab.kind === "project-agent") return PROJECT_AGENT_META[tab.agent].icon;
  if (tab.kind === "milvus-search") return "◆";
  if (tab.kind === "redis-key") return "🔑";
  if (tab.kind === "redis-console") return "❯_";
  if (tab.kind === "table-designer") return "✎";
  if (tab.kind === "agent") return AGENT_META[tab.agent].icon;
  return "•";
}

export function Tabbar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onDuplicate,
  onNewQueryTab,
}: Props) {
  const ctx = useContextMenu();

  if (tabs.length === 0 && !onNewQueryTab) return null;

  function openMenu(e: React.MouseEvent, tab: Tab) {
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === tab.id);
    const hasOthers = tabs.length > 1;
    const hasRight = idx >= 0 && idx < tabs.length - 1;
    // Duplicate makes sense only for tabs that re-derive their state from an
    // injection (SQL editor tabs). Agent / drill / designer tabs are tied to
    // a single id and a duplicate wouldn't carry their internal state.
    const canDuplicate = tab.kind === "query" && !!onDuplicate;

    const items: ContextMenuItem[] = [
      {
        kind: "action",
        label: "Close",
        icon: "×",
        shortcut: "⌘W",
        onClick: () => onCloseTab(tab.id),
      },
      {
        kind: "action",
        label: "Close others",
        onClick: () => onCloseOthers?.(tab.id),
        disabled: !hasOthers || !onCloseOthers,
      },
      {
        kind: "action",
        label: "Close to the right",
        onClick: () => onCloseToRight?.(tab.id),
        disabled: !hasRight || !onCloseToRight,
      },
      {
        kind: "action",
        label: "Close all",
        onClick: () => onCloseAll?.(),
        disabled: !onCloseAll,
        danger: true,
      },
    ];
    if (canDuplicate) {
      items.push({ kind: "separator" });
      items.push({
        kind: "action",
        label: "Duplicate",
        icon: "⎘",
        onClick: () => onDuplicate?.(tab.id),
      });
    }
    ctx.open(e, items);
  }

  return (
    <div className="flex items-stretch h-[34px] bg-bg-2 border-b border-border shrink-0 overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`group relative flex items-center h-full pl-3 pr-2 gap-2 border-r border-border cursor-pointer min-w-0 max-w-[220px] ${
              active ? "bg-bg" : "hover:bg-bg/60"
            }`}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(e) => openMenu(e, tab)}
            onAuxClick={(e) => {
              // Middle-click closes the tab — standard browser convention.
              if (e.button === 1) {
                e.preventDefault();
                onCloseTab(tab.id);
              }
            }}
          >
            {active && (
              <span className="absolute top-0 left-0 right-0 h-[2px] bg-acc" />
            )}
            <span className="text-[11px] shrink-0 opacity-80">{tabIcon(tab)}</span>
            <span
              className={`text-[12px] truncate ${active ? "text-ink font-medium" : "text-ink-2"}`}
            >
              {tab.name}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              className={`shrink-0 w-4 h-4 flex items-center justify-center rounded text-muted hover:text-ink hover:bg-bg-2 text-[14px] leading-none ${
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
              title="Close tab"
            >
              ×
            </button>
          </div>
        );
      })}
      {onNewQueryTab && (
        <button
          onClick={onNewQueryTab}
          className="flex items-center justify-center h-full w-8 text-muted hover:text-ink hover:bg-bg/60"
          title="New query tab"
        >
          +
        </button>
      )}
      <div className="flex-1" />
      {ctx.element}
    </div>
  );
}
