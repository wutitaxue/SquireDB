import { useEffect, useRef, useState } from "react";
import { isImeComposing } from "../utils";

type Chip = {
  label: string;
  action: () => void;
  disabled?: boolean;
  title?: string;
};

type Prefill = {
  /** Bumped by parent to push a new prefill into the input. */
  token: number;
  value: string;
};

type Props = {
  onSubmit: (prompt: string) => void;
  busy: boolean;
  placeholder?: string;
  chips: Chip[];
  /** Bumped by parent to focus + select the input. */
  focusToken?: number;
  /**
   * Parent-driven prefill (e.g. chip "Add filter" injects a seed sentence).
   * Owning the prompt state inside this component means parent re-renders
   * on each keystroke are avoided — the heavy ResultsPane sibling no longer
   * re-renders while the user types into the AI input.
   */
  prefill?: Prefill;
};

export function AiStrip({
  onSubmit,
  busy,
  placeholder = "Ask AI to write, explain, or fix this query…",
  chips,
  focusToken = 0,
  prefill,
}: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (focusToken > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusToken]);

  useEffect(() => {
    if (prefill && prefill.token > 0) {
      setValue(prefill.value);
      // Defer focus so the new value is applied first.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    }
  }, [prefill?.token, prefill?.value]);

  function submit() {
    const v = value.trim();
    if (!v || busy) return;
    onSubmit(v);
    setValue("");
  }

  return (
    <div className="flex items-center h-[26px] bg-panel border border-border rounded-md px-2 gap-2">
      <span
        className="w-3.5 h-3.5 rounded-full shrink-0"
        style={{
          background:
            "conic-gradient(from 180deg, var(--acc), var(--acc-2), #6b3eaf, var(--acc))",
        }}
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        disabled={busy}
        className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-ink placeholder:text-subtle"
      />
      <kbd className="text-[10px] font-mono text-muted bg-bg px-1 rounded shrink-0">
        {busy ? "…" : "⌘⏎"}
      </kbd>
      <span className="w-px h-4 bg-border shrink-0" />
      <div className="flex gap-1 shrink-0">
        {chips.map((chip) => (
          <button
            key={chip.label}
            onClick={chip.action}
            disabled={chip.disabled || busy}
            title={chip.title}
            className="px-2 h-[20px] text-[11px] font-medium text-ink-2 bg-bg rounded-full hover:bg-bg-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}
