import type { ReactNode } from "react";

type Props = {
  /** Omit to skip the header row entirely (e.g. when the body provides its
   *  own toolbar / toggle). */
  title?: string;
  actions?: ReactNode;
  /** Render a thicker bottom border between sections. Default true. */
  bordered?: boolean;
  /** Compact padding (no inner px-2/py-2). Default false. */
  flush?: boolean;
  children: ReactNode;
};

export function Section({
  title,
  actions,
  bordered = true,
  flush = false,
  children,
}: Props) {
  const hasHeader = !!title || !!actions;
  return (
    <div className={bordered ? "border-b border-border py-2" : "py-2"}>
      {hasHeader && (
        <div className="flex items-center justify-between mb-1 px-2">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
            {title}
          </span>
          {actions}
        </div>
      )}
      <div className={flush ? "" : "px-2"}>{children}</div>
    </div>
  );
}
