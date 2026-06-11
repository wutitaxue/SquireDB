import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem =
  | { kind: "separator" }
  | {
      kind: "action";
      label: string;
      icon?: string;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
      shortcut?: string;
    };

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + rect.width > window.innerWidth - 4) {
      nx = Math.max(4, window.innerWidth - rect.width - 4);
    }
    if (ny + rect.height > window.innerHeight - 4) {
      ny = Math.max(4, window.innerHeight - rect.height - 4);
    }
    if (nx !== pos.x || ny !== pos.y) {
      setPos({ x: nx, y: ny });
    }
  }, [x, y, pos.x, pos.y]);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[9999] min-w-[200px] py-1 bg-panel border border-border rounded shadow-lg text-[12px]"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.kind === "separator") {
          return (
            <div key={`sep-${i}`} className="my-1 border-t border-border" />
          );
        }
        return (
          <button
            key={`it-${i}`}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
            className={[
              "w-full flex items-center gap-2 px-3 py-1.5 text-left",
              item.disabled
                ? "text-muted/60 cursor-not-allowed"
                : item.danger
                  ? "text-danger hover:bg-danger/10"
                  : "text-ink-2 hover:bg-bg-2",
            ].join(" ")}
          >
            {item.icon !== undefined && (
              <span className="w-4 text-center shrink-0">{item.icon}</span>
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className="text-muted text-[10px] tabular-nums">
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body
  );
}

export function useContextMenu() {
  const [state, setState] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  function open(e: { clientX: number; clientY: number }, items: ContextMenuItem[]) {
    setState({ x: e.clientX, y: e.clientY, items });
  }
  function close() {
    setState(null);
  }
  const element = state ? (
    <ContextMenu x={state.x} y={state.y} items={state.items} onClose={close} />
  ) : null;
  return { open, close, element };
}
