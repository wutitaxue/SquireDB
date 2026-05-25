import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isImeComposing, parseLookupValue } from "../utils";

type Props = {
  rowIdx: number;
  colIdx: number;
  rowNumber: number;
  columnName: string;
  columnType: string;
  schema?: string;
  table?: string;
  /** Current display value (pending if any, else the original from the row). */
  value: unknown;
  /** True if the result set is editable AND this column is editable in MySQL. */
  editable: boolean;
  /** True if the displayed value is a buffered pending edit (not yet committed). */
  isPending: boolean;
  onApply: (rowIdx: number, colIdx: number, value: unknown) => void;
  onRevert?: (rowIdx: number, colIdx: number) => void;
  onClose: () => void;
};

type Detection = {
  kind: "json" | "text" | "null";
  /** Parsed JSON value — used by the tree renderer. */
  parsed?: unknown;
  /** Pretty-formatted JSON, used for Raw mode + Copy. */
  pretty?: string;
  /** Parse error to surface if it looked like JSON but didn't parse. */
  jsonError?: string;
  /** Byte size of raw string (UTF-8). 0 for null. */
  bytes: number;
  /** Number of \n + 1 in raw string. */
  lines: number;
};

function detect(raw: string | null): Detection {
  if (raw === null) return { kind: "null", bytes: 0, lines: 0 };
  const bytes = new TextEncoder().encode(raw).length;
  const lines = raw.length === 0 ? 0 : raw.split("\n").length;
  const trimmed = raw.trim();
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (looksJson) {
    try {
      const parsed = JSON.parse(trimmed);
      return {
        kind: "json",
        parsed,
        pretty: JSON.stringify(parsed, null, 2),
        bytes,
        lines,
      };
    } catch (e) {
      return {
        kind: "text",
        jsonError: e instanceof Error ? e.message : String(e),
        bytes,
        lines,
      };
    }
  }
  return { kind: "text", bytes, lines };
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

export function CellViewer(props: Props) {
  const {
    rowIdx,
    colIdx,
    rowNumber,
    columnName,
    columnType,
    schema,
    table,
    value,
    editable,
    isPending,
    onApply,
    onRevert,
    onClose,
  } = props;

  const raw = useMemo<string | null>(() => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }, [value]);

  const detection = useMemo<Detection>(() => {
    // MySQL JSON columns arrive as real JS objects — skip the stringify/parse
    // round-trip and treat them as JSON directly.
    if (value !== null && value !== undefined && typeof value === "object") {
      const pretty = JSON.stringify(value, null, 2);
      const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
      return {
        kind: "json",
        parsed: value,
        pretty,
        bytes,
        lines: pretty.split("\n").length,
      };
    }
    return detect(raw);
  }, [value, raw]);

  const [mode, setMode] = useState<"tree" | "raw">(
    detection.kind === "json" ? "tree" : "raw",
  );
  const [wrap, setWrap] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  // Bumping `treeKey` forces the tree subtree to remount with a new
  // `defaultDepth`, which is how Expand/Collapse all is implemented (each node
  // owns its own open state via useState — remounting resets it).
  const [treeKey, setTreeKey] = useState(0);
  const [treeDefaultDepth, setTreeDefaultDepth] = useState(2);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const lowerSearch = search.trim().toLowerCase();

  // Reset mode + search when the underlying value changes (cell flips type).
  useEffect(() => {
    setMode(detection.kind === "json" ? "tree" : "raw");
    setEditing(false);
    setTreeDefaultDepth(2);
    setTreeKey((k) => k + 1);
    setSearch("");
  }, [rowIdx, colIdx, detection.kind]);

  const matchCount = useMemo(() => {
    if (!lowerSearch) return 0;
    if (mode === "tree" && detection.kind === "json" && detection.parsed !== undefined) {
      return countMatches(detection.parsed, lowerSearch);
    }
    if (raw) {
      return countMatchesInString(raw, lowerSearch);
    }
    return 0;
  }, [lowerSearch, mode, detection, raw]);

  // Reset the active match cursor whenever the search query, mode, or tree
  // layout changes — the previous index would point at a different mark or
  // none at all.
  useEffect(() => {
    setActiveMatchIdx(0);
  }, [lowerSearch, mode, treeKey]);

  // Scroll the active match into view after each render that affected which
  // mark is "active" or how many marks exist. rAF lets the DOM commit first.
  useEffect(() => {
    if (!lowerSearch || matchCount === 0) return;
    const raf = requestAnimationFrame(() => {
      const root = bodyRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>(
        `[data-match-idx="${activeMatchIdx}"]`,
      );
      if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeMatchIdx, lowerSearch, matchCount, mode, treeKey]);

  function nextMatch() {
    if (matchCount === 0) return;
    setActiveMatchIdx((i) => (i + 1) % matchCount);
  }
  function prevMatch() {
    if (matchCount === 0) return;
    setActiveMatchIdx((i) => (i - 1 + matchCount) % matchCount);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !editing) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  function startEdit() {
    if (!editable) return;
    setDraft(raw === null ? "null" : raw);
    setEditing(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  function apply() {
    if (!editing) return;
    onApply(rowIdx, colIdx, parseLookupValue(draft));
    setEditing(false);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }

  function copyCurrent() {
    const text =
      detection.kind === "json"
        ? (detection.pretty ?? "")
        : (raw ?? "");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  function expandAll() {
    setTreeDefaultDepth(99);
    setTreeKey((k) => k + 1);
  }
  function collapseAll() {
    setTreeDefaultDepth(0);
    setTreeKey((k) => k + 1);
  }

  const qualified = [schema, table, columnName].filter(Boolean).join(".");

  return (
    <div
      className="absolute top-0 right-0 bottom-0 w-[min(560px,55%)] bg-panel border-l border-border z-30 flex flex-col"
      style={{ boxShadow: "var(--sh-3)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-3 px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[12px] text-ink truncate" title={qualified}>
            {qualified}
          </div>
          <div className="flex items-center gap-2 text-[10.5px] text-muted mt-0.5 flex-wrap">
            <span>row {rowNumber}</span>
            <span className="text-border-2">·</span>
            <span className="font-mono">{columnType}</span>
            <span className="text-border-2">·</span>
            <span>
              {detection.kind === "null"
                ? "NULL"
                : detection.kind === "json"
                  ? "JSON"
                  : "Text"}
            </span>
            {detection.kind !== "null" && (
              <>
                <span className="text-border-2">·</span>
                <span className="tabular-nums">{formatBytes(detection.bytes)}</span>
                <span className="text-border-2">·</span>
                <span className="tabular-nums">{detection.lines} line{detection.lines === 1 ? "" : "s"}</span>
              </>
            )}
            {isPending && (
              <>
                <span className="text-border-2">·</span>
                <span className="text-warn font-semibold">pending edit</span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 text-muted hover:text-ink hover:bg-bg-2 rounded flex items-center justify-center shrink-0"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-bg-2 shrink-0 text-[11px]">
        {detection.kind === "json" && !editing && (
          <div className="flex items-center h-6 p-0.5 bg-panel rounded-md border border-border">
            <button
              onClick={() => setMode("tree")}
              className={`h-5 px-2 text-[11px] rounded ${
                mode === "tree" ? "bg-bg-2 text-ink font-medium" : "text-muted hover:text-ink"
              }`}
            >
              Tree
            </button>
            <button
              onClick={() => setMode("raw")}
              className={`h-5 px-2 text-[11px] rounded ${
                mode === "raw" ? "bg-bg-2 text-ink font-medium" : "text-muted hover:text-ink"
              }`}
            >
              Raw
            </button>
          </div>
        )}

        {detection.kind === "json" && mode === "tree" && !editing && (
          <>
            <button
              onClick={expandAll}
              className="h-6 px-2 text-[11px] text-ink-2 hover:bg-panel rounded"
              title="Expand all nodes"
            >
              Expand all
            </button>
            <button
              onClick={collapseAll}
              className="h-6 px-2 text-[11px] text-ink-2 hover:bg-panel rounded"
              title="Collapse all nodes"
            >
              Collapse all
            </button>
          </>
        )}

        {!editing && detection.kind !== "null" && mode !== "tree" && (
          <label className="flex items-center gap-1.5 text-muted cursor-pointer select-none ml-1">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => setWrap(e.target.checked)}
              className="w-3 h-3 accent-acc cursor-pointer"
            />
            <span>wrap</span>
          </label>
        )}

        <div className="flex-1" />

        {!editing && detection.kind !== "null" && (
          <div
            className={`flex items-center h-6 px-2 bg-panel border rounded-md gap-1.5 ${
              search ? "border-acc/30" : "border-border"
            }`}
          >
            <span className="text-muted text-[10px] leading-none select-none">⌕</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSearch("");
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) prevMatch();
                  else nextMatch();
                }
              }}
              placeholder="search"
              spellCheck={false}
              className="w-28 bg-transparent outline-none text-[11px] text-ink placeholder:text-subtle"
            />
            {search &&
              (matchCount > 0 ? (
                <span className="text-[10px] text-muted tabular-nums shrink-0">
                  {activeMatchIdx + 1}/{matchCount}
                </span>
              ) : (
                <span className="text-[10px] text-warn tabular-nums shrink-0">
                  0
                </span>
              ))}
            {search && matchCount > 0 && (
              <>
                <button
                  onClick={prevMatch}
                  className="text-[11px] text-muted hover:text-ink leading-none shrink-0"
                  title="Previous match (Shift+Enter)"
                  type="button"
                >
                  ‹
                </button>
                <button
                  onClick={nextMatch}
                  className="text-[11px] text-muted hover:text-ink leading-none shrink-0"
                  title="Next match (Enter)"
                  type="button"
                >
                  ›
                </button>
              </>
            )}
            {search && (
              <button
                onClick={() => setSearch("")}
                className="text-[11px] text-muted hover:text-ink leading-none shrink-0"
                title="Clear search (Esc)"
                type="button"
              >
                ×
              </button>
            )}
          </div>
        )}

        {!editing && detection.kind !== "null" && (
          <button
            onClick={copyCurrent}
            className="h-6 px-2 text-[11px] text-ink-2 hover:bg-panel rounded"
            title="Copy current view to clipboard"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        )}

        {editable && !editing && (
          <button
            onClick={startEdit}
            className="h-6 px-2.5 text-[11px] font-semibold text-acc-ink bg-acc-soft border border-acc/20 rounded hover:bg-acc-soft/80"
          >
            Edit
          </button>
        )}

        {isPending && !editing && onRevert && (
          <button
            onClick={() => {
              onRevert(rowIdx, colIdx);
              onClose();
            }}
            className="h-6 px-2 text-[11px] text-warn hover:bg-warn-soft/40 rounded"
            title="Drop the pending edit for this cell"
          >
            Revert
          </button>
        )}
      </div>

      <div ref={bodyRef} className="flex-1 min-h-0 overflow-auto">
        {detection.kind === "null" && !editing && (
          <div className="flex items-center justify-center h-full text-subtle italic text-[12px]">
            NULL
          </div>
        )}

        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                apply();
              }
            }}
            spellCheck={false}
            className="w-full h-full px-3 py-2 text-[12px] font-mono bg-panel text-ink-2 outline-none resize-none"
            placeholder="value (type `null` for SQL NULL)"
          />
        ) : detection.kind === "null" ? null : mode === "tree" &&
          detection.kind === "json" ? (
          <JsonTreeView
            key={treeKey}
            data={detection.parsed}
            defaultDepth={treeDefaultDepth}
            searchTerm={lowerSearch}
            activeMatchIdx={activeMatchIdx}
          />
        ) : (
          <pre
            className="px-3 py-2 text-[12px] font-mono text-ink-2 m-0"
            style={{
              whiteSpace: wrap ? "pre-wrap" : "pre",
              wordBreak: wrap ? "break-word" : "normal",
            }}
          >
            {raw !== null
              ? highlightedText(raw, lowerSearch, { counter: 0 }, activeMatchIdx)
              : null}
          </pre>
        )}

        {detection.jsonError && !editing && (
          <div className="px-3 py-2 text-[11px] text-warn border-t border-border bg-warn-soft/30">
            Looks like JSON but failed to parse: {detection.jsonError}
          </div>
        )}
      </div>

      {editing && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border shrink-0 text-[11px]">
          <span className="text-muted flex-1">
            Type <code className="font-mono bg-bg-2 px-1 rounded">null</code> for SQL NULL.
            Apply queues the edit — click Save in the result toolbar to commit.
          </span>
          <button
            onClick={cancelEdit}
            className="h-7 px-3 text-[11px] text-ink-2 bg-bg border border-border rounded hover:bg-bg-2"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            className="h-7 px-3 text-[11px] font-semibold text-white bg-acc rounded hover:bg-acc-2"
            title="Apply (⌘⏎)"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Counter threaded through the render to assign a stable sequential index to
 * every `<mark>` rendered for a search hit. Mutated synchronously during render
 * — safe because the object is recreated each render.
 */
type MatchCtx = { counter: number };

function JsonTreeView({
  data,
  defaultDepth,
  searchTerm,
  activeMatchIdx,
}: {
  data: unknown;
  defaultDepth: number;
  searchTerm: string;
  activeMatchIdx: number;
}) {
  const ctx: MatchCtx = { counter: 0 };
  return (
    <div className="px-3 py-2 text-[12px] font-mono leading-[1.55] select-text">
      <JsonNode
        value={data}
        depth={0}
        defaultDepth={defaultDepth}
        searchTerm={searchTerm}
        ctx={ctx}
        activeMatchIdx={activeMatchIdx}
      />
    </div>
  );
}

function JsonNode({
  label,
  value,
  depth,
  defaultDepth,
  trailingComma,
  searchTerm,
  ctx,
  activeMatchIdx,
}: {
  label?: string | number;
  value: unknown;
  depth: number;
  defaultDepth: number;
  trailingComma?: boolean;
  searchTerm: string;
  ctx: MatchCtx;
  activeMatchIdx: number;
}) {
  const isArray = Array.isArray(value);
  const isObject = !!value && typeof value === "object" && !isArray;
  const isContainer = isArray || isObject;
  const entries: Array<[string | number, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : isObject
      ? Object.entries(value as Record<string, unknown>)
      : [];
  const [expanded, setExpanded] = useState(depth < defaultDepth);

  // When a search is active, force-expand any container whose subtree has a
  // match. Without this, hits hidden inside collapsed nodes would be invisible.
  const hasMatch =
    !!searchTerm && isContainer && subtreeContains(value, searchTerm);
  const effectiveExpanded = expanded || hasMatch;

  const indent = depth * 14;

  // Primitive line (string / number / boolean / null).
  if (!isContainer) {
    return (
      <div className="flex items-baseline" style={{ paddingLeft: indent + 16 }}>
        <NodeLabel
          label={label}
          searchTerm={searchTerm}
          ctx={ctx}
          activeMatchIdx={activeMatchIdx}
        />
        <PrimitiveValue
          value={value}
          searchTerm={searchTerm}
          ctx={ctx}
          activeMatchIdx={activeMatchIdx}
        />
        {trailingComma && <span className="text-subtle">,</span>}
      </div>
    );
  }

  // Empty container — single line `[]` / `{}`.
  if (entries.length === 0) {
    return (
      <div className="flex items-baseline" style={{ paddingLeft: indent + 16 }}>
        <NodeLabel
          label={label}
          searchTerm={searchTerm}
          ctx={ctx}
          activeMatchIdx={activeMatchIdx}
        />
        <span className="text-subtle">{isArray ? "[]" : "{}"}</span>
        {trailingComma && <span className="text-subtle">,</span>}
      </div>
    );
  }

  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";

  return (
    <div>
      <div
        className="flex items-baseline cursor-pointer hover:bg-bg-2/40 rounded-sm"
        style={{ paddingLeft: indent }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="inline-flex justify-center w-4 text-muted text-[10px] select-none">
          {effectiveExpanded ? "▾" : "▸"}
        </span>
        <NodeLabel
          label={label}
          searchTerm={searchTerm}
          ctx={ctx}
          activeMatchIdx={activeMatchIdx}
        />
        <span className="text-subtle">{openBracket}</span>
        {!effectiveExpanded && (
          <>
            <span className="text-muted text-[11px] mx-1.5">
              … {entries.length} {isArray ? "items" : "keys"}
            </span>
            <span className="text-subtle">{closeBracket}</span>
            {trailingComma && <span className="text-subtle">,</span>}
          </>
        )}
      </div>
      {effectiveExpanded && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={String(k)}
              label={k}
              value={v}
              depth={depth + 1}
              defaultDepth={defaultDepth}
              trailingComma={i < entries.length - 1}
              searchTerm={searchTerm}
              ctx={ctx}
              activeMatchIdx={activeMatchIdx}
            />
          ))}
          <div className="flex items-baseline" style={{ paddingLeft: indent + 16 }}>
            <span className="text-subtle">{closeBracket}</span>
            {trailingComma && <span className="text-subtle">,</span>}
          </div>
        </>
      )}
    </div>
  );
}

function NodeLabel({
  label,
  searchTerm,
  ctx,
  activeMatchIdx,
}: {
  label?: string | number;
  searchTerm: string;
  ctx: MatchCtx;
  activeMatchIdx: number;
}) {
  if (label === undefined) return null;
  if (typeof label === "number") {
    return (
      <span className="text-subtle mr-2 tabular-nums select-none">{label}</span>
    );
  }
  return (
    <span className="mr-1">
      <span className="text-acc-ink">
        &quot;{highlightedText(label, searchTerm, ctx, activeMatchIdx)}&quot;
      </span>
      <span className="text-subtle mr-1">:</span>
    </span>
  );
}

function PrimitiveValue({
  value,
  searchTerm,
  ctx,
  activeMatchIdx,
}: {
  value: unknown;
  searchTerm: string;
  ctx: MatchCtx;
  activeMatchIdx: number;
}) {
  if (value === null) {
    return <span className="text-subtle italic">null</span>;
  }
  if (typeof value === "string") {
    return (
      <span className="text-ok break-all">
        &quot;{highlightedText(value, searchTerm, ctx, activeMatchIdx)}&quot;
      </span>
    );
  }
  if (typeof value === "number") {
    return (
      <span className="text-acc tabular-nums">
        {highlightedText(String(value), searchTerm, ctx, activeMatchIdx)}
      </span>
    );
  }
  if (typeof value === "boolean") {
    return (
      <span className="text-warn">
        {highlightedText(String(value), searchTerm, ctx, activeMatchIdx)}
      </span>
    );
  }
  return <span className="text-ink-2">{String(value)}</span>;
}

/**
 * Wrap occurrences of `query` (case-insensitive) in <mark>, assigning each one
 * a globally sequential `data-match-idx` via the shared `ctx` counter so that
 * the parent can scroll to / restyle a specific match. The match whose index
 * equals `activeMatchIdx` gets a more vivid background.
 */
function highlightedText(
  text: string,
  query: string,
  ctx: MatchCtx,
  activeMatchIdx: number,
): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i <= text.length) {
    const idx = lower.indexOf(query, i);
    if (idx === -1) {
      nodes.push(text.slice(i));
      break;
    }
    if (idx > i) nodes.push(text.slice(i, idx));
    const matchIdx = ctx.counter++;
    const isActive = matchIdx === activeMatchIdx;
    nodes.push(
      <mark
        key={key++}
        data-match-idx={matchIdx}
        className={
          isActive
            ? "bg-warn text-white rounded-sm px-[1px] ring-1 ring-warn"
            : "bg-warn-soft text-ink rounded-sm px-[1px]"
        }
      >
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    i = idx + query.length;
  }
  return <>{nodes}</>;
}

/** Does any key, string-primitive, number, or boolean inside `value` contain `q`? */
function subtreeContains(value: unknown, q: string): boolean {
  if (!q) return false;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.toLowerCase().includes(q);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase().includes(q);
  }
  if (Array.isArray(value)) {
    return value.some((v) => subtreeContains(v, q));
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase().includes(q)) return true;
      if (subtreeContains(v, q)) return true;
    }
    return false;
  }
  return false;
}

function countMatchesInString(s: string, q: string): number {
  if (!q) return 0;
  const lower = s.toLowerCase();
  let n = 0;
  let i = 0;
  while (true) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) return n;
    n += 1;
    i = idx + q.length;
  }
}

/** Sum of substring matches across all keys and primitive values in the tree. */
function countMatches(value: unknown, q: string): number {
  if (!q) return 0;
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return countMatchesInString(value, q);
  if (typeof value === "number" || typeof value === "boolean") {
    return countMatchesInString(String(value), q);
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((acc, v) => acc + countMatches(v, q), 0);
  }
  if (typeof value === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      n += countMatchesInString(k, q);
      n += countMatches(v, q);
    }
    return n;
  }
  return 0;
}

/**
 * Heuristic: should double-click on this cell open the CellViewer drawer
 * instead of the tiny inline editor? Yes for long strings, anything that
 * parses as JSON, and any non-primitive (object / array) — MySQL JSON columns
 * land on the frontend as real JS objects, not strings, and stuffing one into
 * the inline input would coerce it to "[object Object]".
 */
export function isViewerWorthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "object") return true;
  if (typeof v !== "string") return false;
  if (v.length >= 80) return true;
  const t = v.trim();
  if (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  ) {
    try {
      JSON.parse(t);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
