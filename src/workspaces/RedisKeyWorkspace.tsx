import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

import type { RedisKeyValue } from "../types";

export function RedisKeyWorkspace({
  connectionId,
  db,
  rkey,
}: {
  connectionId: number;
  db: number;
  rkey: string;
}) {
  const [value, setValue] = useState<RedisKeyValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const v = await invoke<RedisKeyValue>("redis_get_value", {
        connectionId,
        db,
        key: rkey,
      });
      setValue(v);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [connectionId, db, rkey]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="h-9 flex items-center gap-2 px-3 border-b border-border shrink-0">
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
          database {db}
        </span>
        <span className="text-border-2">·</span>
        <span className="font-mono text-[12px] text-ink truncate" title={rkey}>
          {rkey}
        </span>
        {value && value.type !== "none" && value.type !== "other" && (
          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold bg-panel-2 border border-border text-ink-2">
            {value.type}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void load()}
          disabled={busy}
          className="h-7 px-3 text-[12px] font-medium bg-panel-2 border border-border rounded-md hover:bg-bg-2 disabled:opacity-50"
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {error && (
          <div className="text-[12px] text-crit font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}
        {!error && !value && !busy && (
          <div className="text-muted text-[12px]">No value loaded.</div>
        )}
        {!error && value && <ValueView value={value} />}
      </div>
    </div>
  );
}

function ValueView({ value }: { value: RedisKeyValue }) {
  switch (value.type) {
    case "string":
      return (
        <pre className="font-mono text-[12px] text-ink whitespace-pre-wrap break-words bg-panel-2 border border-border rounded-md p-3">
          {value.value}
        </pre>
      );
    case "list":
      return (
        <Container truncated={value.truncated} total={value.total} unit="items">
          <ol className="font-mono text-[12px] text-ink list-decimal pl-6 space-y-0.5">
            {value.values.map((v, i) => (
              <li key={i} className="break-all">
                {v}
              </li>
            ))}
          </ol>
        </Container>
      );
    case "set":
      return (
        <Container truncated={value.truncated} total={value.total} unit="members">
          <ul className="font-mono text-[12px] text-ink space-y-0.5">
            {value.values.map((v, i) => (
              <li key={i} className="break-all">
                · {v}
              </li>
            ))}
          </ul>
        </Container>
      );
    case "hash":
      return (
        <Container truncated={value.truncated} total={value.total} unit="fields">
          <table className="w-full font-mono text-[12px]">
            <tbody>
              {value.entries.map(([k, v], i) => (
                <tr key={i} className="border-b border-border-2/50">
                  <td className="py-1 pr-3 text-ink-2 align-top whitespace-nowrap">
                    {k}
                  </td>
                  <td className="py-1 text-ink break-all">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Container>
      );
    case "zset":
      return (
        <Container truncated={value.truncated} total={value.total} unit="members">
          <table className="w-full font-mono text-[12px]">
            <thead>
              <tr className="text-muted text-[10px] uppercase tracking-wide">
                <th className="text-left py-1 pr-3 font-semibold">member</th>
                <th className="text-right py-1 font-semibold">score</th>
              </tr>
            </thead>
            <tbody>
              {value.entries.map(([m, s], i) => (
                <tr key={i} className="border-b border-border-2/50">
                  <td className="py-1 pr-3 text-ink break-all">{m}</td>
                  <td className="py-1 text-right text-ink-2">{s}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Container>
      );
    case "none":
      return <div className="text-muted text-[12px]">(key does not exist)</div>;
    case "other":
      return (
        <div className="text-muted text-[12px]">
          Type <span className="font-mono text-ink-2">{value.type_name}</span>{" "}
          not yet supported.
        </div>
      );
  }
}

function Container({
  total,
  truncated,
  unit,
  children,
}: {
  total: number;
  truncated: boolean;
  unit: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10.5px] text-muted mb-2 flex items-center gap-2">
        <span>
          {total} {unit}
        </span>
        {truncated && (
          <span className="px-1.5 py-0.5 rounded bg-warn-soft text-warn-ink uppercase text-[10px] tracking-wide font-semibold">
            preview · first 200
          </span>
        )}
      </div>
      <div className="bg-panel-2 border border-border rounded-md p-3">
        {children}
      </div>
    </div>
  );
}
