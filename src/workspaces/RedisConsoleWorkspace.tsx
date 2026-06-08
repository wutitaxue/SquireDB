import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

type Entry =
  | { kind: "input"; text: string }
  | { kind: "output"; value: unknown }
  | { kind: "error"; text: string };

const COMMON_COMMANDS = [
  "INFO server",
  "DBSIZE",
  "KEYS *",
  "CLIENT LIST",
  "MEMORY STATS",
];

export function RedisConsoleWorkspace({
  connectionId,
  db,
}: {
  connectionId: number;
  db: number;
}) {
  const [history, setHistory] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pastCmds, setPastCmds] = useState<string[]>([]);
  const [pastIdx, setPastIdx] = useState<number>(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const submit = useCallback(
    async (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed) return;
      setBusy(true);
      setHistory((h) => [...h, { kind: "input", text: trimmed }]);
      setPastCmds((p) => [...p, trimmed]);
      setPastIdx(-1);
      try {
        const value = await invoke<unknown>("redis_exec", {
          connectionId,
          db,
          command: trimmed,
        });
        setHistory((h) => [...h, { kind: "output", value }]);
      } catch (err) {
        setHistory((h) => [...h, { kind: "error", text: String(err) }]);
      } finally {
        setBusy(false);
      }
    },
    [connectionId, db],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="h-9 flex items-center gap-2 px-3 border-b border-border shrink-0">
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
          Console
        </span>
        <span className="text-border-2">·</span>
        <span className="font-mono text-[12px] text-ink">database {db}</span>
        <div className="flex-1" />
        <span className="text-[10.5px] text-muted">
          quote args with spaces: <span className="font-mono">SET k "v w"</span>
        </span>
        <button
          onClick={() => setHistory([])}
          disabled={history.length === 0}
          className="h-7 px-3 text-[12px] font-medium text-ink-2 hover:bg-bg-2 rounded-md disabled:opacity-30"
        >
          Clear
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] space-y-1"
      >
        {history.length === 0 && (
          <div className="text-muted text-[11.5px]">
            Try one of:&nbsp;
            {COMMON_COMMANDS.map((c, i) => (
              <span key={c}>
                {i > 0 && " · "}
                <button
                  onClick={() => setDraft(c)}
                  className="text-acc hover:text-acc-ink"
                >
                  {c}
                </button>
              </span>
            ))}
          </div>
        )}
        {history.map((e, i) =>
          e.kind === "input" ? (
            <div key={i} className="text-acc-ink">
              <span className="text-muted">db{db}&gt; </span>
              {e.text}
            </div>
          ) : e.kind === "error" ? (
            <pre key={i} className="text-crit whitespace-pre-wrap pl-4">
              {e.text}
            </pre>
          ) : (
            <pre
              key={i}
              className="text-ink whitespace-pre-wrap pl-4 break-all"
            >
              {formatValue(e.value)}
            </pre>
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft);
          setDraft("");
        }}
        className="flex gap-2 px-3 py-2 border-t border-border shrink-0"
      >
        <span className="text-[12px] text-muted font-mono pt-1.5">db{db}&gt;</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              if (pastCmds.length === 0) return;
              e.preventDefault();
              const next = pastIdx === -1 ? pastCmds.length - 1 : Math.max(0, pastIdx - 1);
              setPastIdx(next);
              setDraft(pastCmds[next]);
            } else if (e.key === "ArrowDown") {
              if (pastIdx === -1) return;
              e.preventDefault();
              const next = pastIdx + 1;
              if (next >= pastCmds.length) {
                setPastIdx(-1);
                setDraft("");
              } else {
                setPastIdx(next);
                setDraft(pastCmds[next]);
              }
            }
          }}
          placeholder="GET foo / HGETALL bar / SET k v / KEYS user:*"
          disabled={busy}
          autoFocus
          className="form-input flex-1 font-mono text-[12px]"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50"
        >
          {busy ? "…" : "Run"}
        </button>
      </form>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null) return "(nil)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}
