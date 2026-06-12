import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";
import type { ConnectionKind, InvolvedTableRef, TableAccess } from "./types";

/**
 * Write text to the system clipboard via Tauri's clipboard-manager plugin.
 * Goes through the native bridge so it doesn't depend on the webview's
 * user-gesture window — works even after multiple `await invoke()` round-trips
 * (which silently break `navigator.clipboard.writeText` on WKWebView).
 *
 * Falls back to `navigator.clipboard.writeText` only if the plugin path
 * throws (e.g. running in a plain browser preview without the bridge).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await tauriWriteText(text);
    return true;
  } catch (e) {
    console.warn("clipboard-manager writeText failed, falling back", e);
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e2) {
      console.warn("navigator.clipboard.writeText also failed", e2);
      return false;
    }
  }
}

/**
 * Display metadata for a connection kind. Used by Home cards, Titlebar
 * dropdowns, and any future surface that needs to label what *kind* of
 * data source a connection talks to. Unknown kinds fall back to a
 * neutral grey badge with the raw kind string so we don't have to ship
 * a UI change every time the backend adds a new driver.
 */
export type ConnectionKindMeta = {
  label: string;
  /** Tailwind class string for badge background + text. */
  cls: string;
};

export function connectionKindMeta(kind: string): ConnectionKindMeta {
  switch (kind as ConnectionKind) {
    case "mysql":
      return { label: "MySQL", cls: "bg-info-soft text-info" };
    case "milvus":
      return { label: "Milvus", cls: "bg-acc-soft text-acc-ink" };
    default:
      // Future drivers: render the raw kind capitalized in a neutral pill.
      return {
        label: kind ? kind[0].toUpperCase() + kind.slice(1) : "?",
        cls: "bg-bg text-muted border border-border",
      };
  }
}

/**
 * True while an IME (Chinese / Japanese / Korean input method) composition is
 * in progress. Use this guard at the top of any `onKeyDown` that submits on
 * Enter — otherwise pressing Enter to confirm an IME candidate fires the
 * submit handler with a half-finished prompt.
 *
 * Checks both the modern `isComposing` flag on the native event and the
 * legacy `keyCode === 229` fallback for older WebViews.
 */
export function isImeComposing(
  e: ReactKeyboardEvent | KeyboardEvent,
): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  if (native.isComposing) return true;
  // Safari / older Chromium: only keyCode 229 is reliable during composition.
  const kc = "keyCode" in e ? (e as { keyCode: number }).keyCode : native.keyCode;
  return kc === 229;
}

export const cellHead: CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "1px solid #ddd",
  whiteSpace: "nowrap",
};

export const cellBody: CSSProperties = {
  padding: "6px 10px",
  whiteSpace: "nowrap",
};

export function renderCell(v: unknown): string {
  if (v === null) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function formatTime(iso: string): string {
  const m = iso.match(/(\d{2}):(\d{2}):(\d{2})$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : iso;
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function parseLookupValue(s: string): unknown {
  const t = s.trim();
  if (t === "") return "";
  if (t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(t)) {
    const n = parseFloat(t);
    if (!Number.isNaN(n)) return n;
  }
  return t;
}

export const SEVERITY_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  good: { bg: "#e6f4ea", fg: "#1e7e34", label: "GOOD" },
  ok: { bg: "#f5f5f5", fg: "#444", label: "OK" },
  slow: { bg: "#fff7e6", fg: "#ad6800", label: "SLOW" },
  critical: { bg: "#fdecea", fg: "#a8071a", label: "CRITICAL" },
};

export const RISK_LABELS: Record<string, string> = {
  full_table_scan: "Full table scan",
  full_index_scan: "Full index scan",
  filesort: "Using filesort",
  temporary_table: "Using temporary table",
  large_scan: "Large scan (≥100k rows)",
};

export function involvedTablesFromAccess(tables: TableAccess[]): InvolvedTableRef[] {
  const seen = new Set<string>();
  const out: InvolvedTableRef[] = [];
  for (const t of tables) {
    let database = "";
    let table = t.table_name;
    const idx = t.table_name.indexOf(".");
    if (idx > 0) {
      database = t.table_name.slice(0, idx).replace(/`/g, "");
      table = t.table_name.slice(idx + 1).replace(/`/g, "");
    } else {
      table = t.table_name.replace(/`/g, "");
    }
    const key = `${database}|${table}`;
    if (!seen.has(key) && table) {
      seen.add(key);
      out.push({ database, table });
    }
  }
  return out;
}
