import type { ReactNode } from "react";

export type AgentBadge = {
  text: string;
  tone: "crit" | "warn" | "info" | "ok";
};

export type AgentItem = {
  id: string;
  name: string;
  sub: string;
  icon: string;
  badge?: AgentBadge;
};

export type DockInsight = {
  body: ReactNode;
  primaryLabel?: string;
  primaryAction?: () => void;
  secondaryLabel?: string;
  secondaryAction?: () => void;
};

export type DockActivityItem = {
  icon: string;
  text: ReactNode;
  when: string;
  onClick?: () => void;
};

type Props = {
  /** Header label (e.g. "AI Agents", "Project Agents"). */
  title?: string;
  agents: AgentItem[];
  activeAgentId: string | null;
  onOpenAgent: (id: string) => void;
  insight?: DockInsight | null;
  insightHeading?: string;
  activity?: DockActivityItem[];
  activityEmptyLabel?: string;
  /** Render a placeholder body instead of agents/activity (used when disabled). */
  empty?: ReactNode;
  /** When provided, the dock header renders a collapse button that calls this. */
  onClose?: () => void;
};

const TONE: Record<AgentBadge["tone"], string> = {
  crit: "bg-crit-soft text-crit",
  warn: "bg-warn-soft text-warn",
  info: "bg-info-soft text-info",
  ok: "bg-ok-soft text-ok",
};

export function WorkspaceDock({
  title = "AI Agents",
  agents,
  activeAgentId,
  onOpenAgent,
  insight,
  insightHeading = "Latest insight",
  activity = [],
  activityEmptyLabel = "No recent activity.",
  empty,
  onClose,
}: Props) {
  return (
    <aside className="w-[320px] shrink-0 bg-panel border-l border-border flex flex-col overflow-hidden">
      <div className="flex items-center h-9 px-3 border-b border-border shrink-0">
        <span
          className="w-4 h-4 mr-2 rounded text-[12px] font-bold text-white flex items-center justify-center"
          style={{
            background: "linear-gradient(135deg, var(--acc) 0%, var(--acc-2) 100%)",
          }}
        >
          ⚹
        </span>
        <span className="text-[12px] font-bold text-ink">{title}</span>
        <div className="flex-1" />
        {onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 text-[12px] text-ink-2 hover:text-ink hover:bg-bg-2 rounded flex items-center justify-center"
            title="Collapse AI Agents panel"
            aria-label="Collapse panel"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 1.5 L7 5 L3.5 8.5" />
            </svg>
          </button>
        )}
      </div>

      {empty ? (
        empty
      ) : (
        <>
          {insight && (
            <div className="px-3 py-3 border-b border-border">
              <div className="rounded-lg bg-bg-2 p-3">
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
                  {insightHeading}
                </div>
                <div className="text-[12px] text-ink-2 leading-relaxed">
                  {insight.body}
                </div>
                {(insight.primaryLabel || insight.secondaryLabel) && (
                  <div className="flex gap-1.5 mt-2">
                    {insight.primaryLabel && insight.primaryAction && (
                      <button
                        onClick={insight.primaryAction}
                        className="px-2 py-1 text-[11px] font-medium bg-panel border border-border rounded-md hover:bg-bg text-ink-2"
                      >
                        {insight.primaryLabel}
                      </button>
                    )}
                    {insight.secondaryLabel && insight.secondaryAction && (
                      <button
                        onClick={insight.secondaryAction}
                        className="px-2 py-1 text-[11px] text-muted hover:text-ink"
                      >
                        {insight.secondaryLabel}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-2 py-2">
            <ul className="flex flex-col gap-0.5">
              {agents.map((a) => {
                const active = a.id === activeAgentId;
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => onOpenAgent(a.id)}
                      className={`w-full flex items-center gap-3 px-2 py-2 rounded-md text-left ${
                        active ? "bg-acc-soft" : "hover:bg-bg-2"
                      }`}
                    >
                      <span
                        className={`w-7 h-7 rounded-md flex items-center justify-center text-[14px] shrink-0 ${
                          active ? "bg-acc text-white" : "bg-bg-2 text-ink-2"
                        }`}
                      >
                        {a.icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-[12.5px] truncate ${
                            active
                              ? "text-acc-ink font-semibold"
                              : "text-ink font-semibold"
                          }`}
                        >
                          {a.name}
                        </div>
                        <div className="text-[11px] text-muted truncate">{a.sub}</div>
                      </div>
                      {a.badge && (
                        <span
                          className={`min-w-[22px] h-4 px-1.5 rounded-full flex items-center justify-center text-[10px] font-bold uppercase tracking-wider ${TONE[a.badge.tone]}`}
                        >
                          {a.badge.text}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="border-t border-border px-3 py-2 max-h-[180px] overflow-y-auto shrink-0">
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1.5">
              Activity
            </div>
            {activity.length === 0 ? (
              <div className="text-[11px] text-subtle italic">{activityEmptyLabel}</div>
            ) : (
              <ul className="space-y-1.5 text-[11px]">
                {activity.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-ink-2">
                    <span className="shrink-0 text-[12px] leading-none mt-0.5">
                      {a.icon}
                    </span>
                    {a.onClick ? (
                      <button
                        onClick={a.onClick}
                        className="flex-1 text-left truncate hover:text-acc-ink"
                        title="Replay"
                      >
                        {a.text}
                      </button>
                    ) : (
                      <span className="flex-1 truncate">{a.text}</span>
                    )}
                    <span className="text-subtle shrink-0">{a.when}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
