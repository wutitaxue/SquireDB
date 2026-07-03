import { useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { sql, MySQL } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";

// Keywords that can legally follow a table reference — used to avoid mistaking
// them for a table alias (e.g. `FROM users WHERE ...` — `WHERE` is not an alias).
const CLAUSE_KW = new Set([
  "on", "using", "where", "inner", "left", "right", "full", "cross", "outer",
  "join", "straight_join", "natural", "group", "order", "having", "limit",
  "offset", "union", "select", "set", "values", "for", "lock", "window",
  "into", "as", "and", "or",
]);

/** Parse the FROM / JOIN table references (with optional aliases) out of a
 *  single SQL statement. Regex-based and deliberately forgiving: it handles
 *  comma-joined FROM lists and multiple JOINs, skips subqueries, and ignores
 *  clause keywords that look like aliases. Good enough to drive completion. */
function tablesInScope(stmt: string): Array<{ table: string; alias?: string }> {
  const refs: Array<{ table: string; alias?: string }> = [];
  const re = /\b(from|join)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt))) {
    const isFrom = m[1].toLowerCase() === "from";
    let i = m.index + m[0].length;
    for (;;) {
      const tbl = /^\s*([`\w.]+)/.exec(stmt.slice(i));
      if (!tbl || tbl[1].startsWith("(")) break;
      i += tbl[0].length;
      const table = tbl[1].replace(/`/g, "");
      let alias: string | undefined;
      const al = /^\s+(?:as\s+)?([`\w]+)/i.exec(stmt.slice(i));
      if (al) {
        const cand = al[1].replace(/`/g, "");
        if (!CLAUSE_KW.has(cand.toLowerCase())) {
          alias = cand;
          i += al[0].length;
        }
      }
      if (table && !CLAUSE_KW.has(table.toLowerCase())) refs.push({ table, alias });
      const comma = /^\s*,/.exec(stmt.slice(i));
      if (isFrom && comma) {
        i += comma[0].length;
        continue;
      }
      break;
    }
  }
  return refs;
}

/** Completion source that offers columns of the tables in the current
 *  statement's FROM / JOIN when the user types a bare identifier — the piece
 *  lang-sql doesn't do on its own (it only completes columns after a
 *  `table.` / `alias.` prefix). Dotted references are left to lang-sql. */
function columnContextCompletion(schema: Record<string, string[]>): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\w*/);
    if (!word) return null;
    // Skip dotted refs (`t.col`) — lang-sql resolves those correctly already.
    if (word.from > 0 && context.state.sliceDoc(word.from - 1, word.from) === ".") return null;
    if (word.from === word.to && !context.explicit) return null;

    const full = context.state.doc.toString();
    const pos = context.pos;
    const start = full.lastIndexOf(";", pos - 1) + 1;
    let end = full.indexOf(";", pos);
    if (end === -1) end = full.length;
    const refs = tablesInScope(full.slice(start, end));
    if (refs.length === 0) return null;

    // column name -> the table names / aliases that expose it (shown as detail).
    const byCol = new Map<string, Set<string>>();
    for (const ref of refs) {
      const bare = ref.table.split(".").pop() ?? ref.table;
      const cols = schema[ref.table] ?? schema[bare] ?? [];
      const owner = ref.alias ?? bare;
      for (const c of cols) {
        let owners = byCol.get(c);
        if (!owners) {
          owners = new Set();
          byCol.set(c, owners);
        }
        owners.add(owner);
      }
    }
    if (byCol.size === 0) return null;

    const options = [...byCol.entries()].map(([label, owners]) => ({
      label,
      type: "property",
      detail: [...owners].join(", "),
      boost: 2,
    }));
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}

/** Read the currently-selected fragment from a CodeMirror ref. Returns
 *  `undefined` when there's no selection or the editor isn't mounted —
 *  callers should fall back to the full document in that case. */
export function getSelection(ref: React.RefObject<ReactCodeMirrorRef | null>): string | undefined {
  const view = ref.current?.view;
  if (!view) return undefined;
  const { from, to } = view.state.selection.main;
  if (from === to) return undefined;
  return view.state.sliceDoc(from, to);
}

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** Called by ⌘/Ctrl+Enter. When the editor has a non-empty selection, the
   *  selected text is passed so the caller can run only that fragment. With
   *  no selection, `selected` is undefined and the caller should fall back to
   *  the full document. The Run button reads selection separately via the
   *  editorRef + getSelection helper. */
  onRun: (selected?: string) => void;
  /** Optional ref to the underlying CodeMirror instance. Pass when the parent
   *  needs to read the current selection outside of the Mod-Enter keymap —
   *  e.g. when clicking a Run button. */
  editorRef?: React.RefObject<ReactCodeMirrorRef | null>;
  readOnly?: boolean;
  schema?: Record<string, string[]>;
};

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#af3e6a", fontWeight: "700" },
  { tag: t.controlKeyword, color: "#af3e6a", fontWeight: "700" },
  { tag: t.operatorKeyword, color: "#af3e6a", fontWeight: "700" },
  { tag: t.function(t.variableName), color: "#6b3eaf" },
  { tag: t.function(t.propertyName), color: "#6b3eaf" },
  { tag: t.string, color: "#2e7d32" },
  { tag: t.special(t.string), color: "#2e7d32" },
  { tag: t.number, color: "#b46d00" },
  { tag: t.bool, color: "#b46d00" },
  { tag: t.null, color: "#b46d00" },
  { tag: t.lineComment, color: "var(--subtle)", fontStyle: "italic" },
  { tag: t.blockComment, color: "var(--subtle)", fontStyle: "italic" },
  { tag: t.propertyName, color: "var(--ink)" },
  { tag: t.variableName, color: "var(--ink)" },
  { tag: t.typeName, color: "#6b3eaf" },
  { tag: t.punctuation, color: "var(--muted)" },
]);

// Stable identity — passed as `basicSetup` prop to react-codemirror. The
// wrapper's reconfigure effect lists this object in its dep array; an inline
// `{...}` literal at the callsite would force the editor to reconfigure on
// every keystroke, which is visibly laggy when held-down (e.g. continuous
// Delete / Backspace).
const basicSetup = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  indentOnInput: false,
  searchKeymap: false,
} as const;

const editorTheme = EditorView.theme(
  {
    "&": {
      background: "var(--panel-2)",
      color: "var(--ink)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      lineHeight: "1.55",
    },
    ".cm-content": {
      padding: "8px 0",
      caretColor: "var(--acc)",
    },
    ".cm-gutters": {
      background: "var(--panel-2)",
      border: "none",
      color: "var(--subtle)",
      paddingRight: "8px",
      borderRight: "1px solid var(--border)",
      minWidth: "38px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 6px",
      fontSize: "11.5px",
    },
    ".cm-activeLineGutter": {
      background: "transparent",
      color: "var(--ink-2)",
    },
    ".cm-activeLine": {
      background: "rgba(0,109,104,0.04)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--acc)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, ::selection": {
      background: "rgba(0,109,104,0.18) !important",
    },
    ".cm-selectionBackground": {
      background: "rgba(0,109,104,0.16) !important",
    },
    ".cm-tooltip": {
      background: "var(--panel)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "var(--sh-2)",
      color: "var(--ink)",
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
    },
    ".cm-tooltip-autocomplete .cm-completionLabel": {
      fontFamily: "var(--font-mono)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "var(--acc-soft)",
      color: "var(--acc-ink)",
    },
    ".cm-matchingBracket": {
      background: "rgba(0,109,104,0.18)",
      color: "var(--acc-ink)",
    },
  },
  { dark: false },
);

export function SqlEditor({ value, onChange, onRun, editorRef, readOnly, schema }: Props) {
  // onRun identity often changes per keystroke at the callsite (it closes over
  // local state). Holding it in a ref keeps the extensions array stable so
  // CodeMirror doesn't reconfigure the whole editor (recompiling the SQL
  // grammar etc.) on every character typed — that was the typing-lag source.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const extensions = useMemo(() => {
    const sqlSupport = sql({ dialect: MySQL, schema, upperCaseKeywords: true });
    return [
      sqlSupport,
      // Extra completion source scoped to the SQL language: bare-identifier
      // column completion from the current statement's FROM / JOIN tables.
      // Merged with lang-sql's own table/keyword source by the autocomplete
      // facet, and boosted so columns rank above them.
      sqlSupport.language.data.of({
        autocomplete: columnContextCompletion(schema ?? {}),
      }),
      syntaxHighlighting(highlight),
      editorTheme,
      keymap.of([
        {
          key: "Mod-Enter",
          run: (view) => {
            const { from, to } = view.state.selection.main;
            const selected = from !== to ? view.state.sliceDoc(from, to) : undefined;
            onRunRef.current(selected);
            return true;
          },
        },
      ]),
      EditorView.lineWrapping,
    ];
  }, [schema]);

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      onChange={onChange}
      extensions={extensions}
      readOnly={readOnly}
      basicSetup={basicSetup}
    />
  );
}
