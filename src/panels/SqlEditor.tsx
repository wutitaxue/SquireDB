import { useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { sql, MySQL } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

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

  const extensions = useMemo(
    () => [
      sql({ dialect: MySQL, schema, upperCaseKeywords: true }),
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
    ],
    [schema],
  );

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
