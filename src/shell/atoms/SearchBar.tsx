import { useEffect, useRef } from "react";

export type FilterChipDef = {
  id: string;
  label: string;
  tone?: "default" | "pii";
  disabled?: boolean;
  title?: string;
};

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  placeholder?: string;
  /** Cmd/Ctrl-K binds focus to this search bar when true. */
  bindShortcut?: boolean;

  chips?: FilterChipDef[];
  active?: Set<string>;
  onToggleChip?: (id: string) => void;

  /** Optional trailing slot in the chip row (e.g. system-db checkbox). */
  trailing?: React.ReactNode;
};

export function SearchBar({
  query,
  onQueryChange,
  placeholder = "Search…",
  bindShortcut = false,
  chips,
  active,
  onToggleChip,
  trailing,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!bindShortcut) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindShortcut]);

  return (
    <div className="px-3 py-2 border-b border-border shrink-0">
      <div className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-panel border border-border">
        <span className="text-subtle text-[11px] shrink-0">⌕</span>
        <input
          ref={inputRef}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="flex-1 bg-transparent outline-none text-[12px] text-ink placeholder:text-subtle min-w-0"
        />
        {query ? (
          <button
            onClick={() => onQueryChange("")}
            className="text-[11px] text-muted hover:text-ink px-1 shrink-0"
            title="Clear"
          >
            ×
          </button>
        ) : bindShortcut ? (
          <kbd className="text-[10px] font-mono text-muted bg-bg px-1 rounded shrink-0">
            ⌘K
          </kbd>
        ) : null}
      </div>

      {(chips && chips.length > 0) || trailing ? (
        <div className="flex items-center mt-2 gap-1">
          {chips?.map((chip) => (
            <FilterChip
              key={chip.id}
              chip={chip}
              isActive={active?.has(chip.id) ?? false}
              onToggle={() => onToggleChip?.(chip.id)}
            />
          ))}
          {trailing && (
            <>
              <div className="flex-1" />
              {trailing}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({
  chip,
  isActive,
  onToggle,
}: {
  chip: FilterChipDef;
  isActive: boolean;
  onToggle: () => void;
}) {
  const { label, tone, disabled, title } = chip;
  return (
    <button
      onClick={disabled ? undefined : onToggle}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] font-semibold transition border ${
        disabled
          ? "bg-panel border-border text-subtle cursor-not-allowed"
          : isActive
            ? tone === "pii"
              ? "bg-pii text-white border-pii"
              : "bg-acc text-white border-acc"
            : "bg-panel border-border text-ink-2 hover:bg-bg"
      }`}
    >
      {tone === "pii" && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-white" : "bg-pii"}`}
        />
      )}
      {label}
    </button>
  );
}
