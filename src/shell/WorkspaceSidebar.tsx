import type { ReactNode } from "react";

type Props = {
  /** Top toolbar slot (search bar + filter chips). */
  toolbar?: ReactNode;
  /** Main scrollable tree slot. */
  tree: ReactNode;
  /** Secondary stack slot (sections at bottom, capped height). */
  secondary?: ReactNode;
};

export function WorkspaceSidebar({ toolbar, tree, secondary }: Props) {
  return (
    <aside className="w-[260px] shrink-0 bg-bg-2 border-r border-border flex flex-col overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-y-auto px-1 py-1 min-h-0">{tree}</div>
      {secondary && (
        <div className="border-t border-border max-h-[45%] shrink-0 flex flex-col min-h-0">
          {secondary}
        </div>
      )}
    </aside>
  );
}
