import { useState } from "react";
import type { CacheValue } from "../../types";

export function DrillCacheCard({ value }: { value: CacheValue }) {
  const [expanded, setExpanded] = useState(true);

  const headerTitle = value.label ?? value.key;
  const subTitle = value.label ? value.key : null;

  return (
    <div className="border border-border rounded-md bg-panel">
      <button
        onClick={() => setExpanded((x) => !x)}
        className="w-full text-left bg-bg-2 px-3 h-9 flex items-center gap-2 hover:brightness-95"
      >
        <span className="text-[11px]">{expanded ? "▼" : "▶"}</span>
        <span className="text-[9px] px-1 bg-pii-soft text-pii rounded font-sans font-bold">
          REDIS
        </span>
        <span className="font-mono text-[12.5px] font-semibold truncate">
          {headerTitle}
        </span>
        <span className="text-[10.5px] text-muted font-mono">{value.command}</span>
        <div className="flex-1" />
        <TtlPill ttl={value.ttl_seconds} exists={value.exists} />
      </button>
      {subTitle && expanded && (
        <div className="px-3 pt-2 text-[10.5px] font-mono text-subtle truncate">
          {subTitle}
        </div>
      )}
      {expanded && (
        <div className="px-3 py-2 text-[12px]">
          {value.error ? (
            <div className="text-crit text-[11px] whitespace-pre-wrap">
              {value.error}
            </div>
          ) : !value.exists ? (
            <div className="text-subtle italic">Key does not exist.</div>
          ) : (
            <ValueBody value={value} />
          )}
          {value.truncated && (
            <div className="text-[10px] text-subtle mt-1 italic">
              Truncated — showing first 100 items.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ValueBody({ value }: { value: CacheValue }) {
  if (value.string_value !== null && value.string_value !== undefined) {
    return (
      <pre className="font-mono text-[11.5px] whitespace-pre-wrap break-all bg-panel-2 p-2 rounded border border-border">
        {value.string_value}
      </pre>
    );
  }
  if (value.hash_value) {
    const entries = Object.entries(value.hash_value);
    if (entries.length === 0) {
      return <div className="text-subtle italic">Empty hash.</div>;
    }
    return (
      <div
        className="grid gap-x-3 gap-y-1 font-mono text-[11.5px]"
        style={{ gridTemplateColumns: "180px 1fr" }}
      >
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <div className="text-muted truncate">{k}</div>
            <div className="text-ink-2 break-all">{v}</div>
          </div>
        ))}
      </div>
    );
  }
  if (value.list_value) {
    return (
      <ol className="font-mono text-[11.5px] text-ink-2 list-decimal pl-5">
        {value.list_value.map((v, i) => (
          <li key={i} className="break-all">
            {v}
          </li>
        ))}
      </ol>
    );
  }
  if (value.set_value) {
    return (
      <ul className="font-mono text-[11.5px] text-ink-2 list-disc pl-5">
        {value.set_value.map((v, i) => (
          <li key={i} className="break-all">
            {v}
          </li>
        ))}
      </ul>
    );
  }
  if (value.zset_value) {
    return (
      <div
        className="grid gap-x-3 gap-y-1 font-mono text-[11.5px]"
        style={{ gridTemplateColumns: "1fr 80px" }}
      >
        <div className="text-[10px] uppercase text-muted">Member</div>
        <div className="text-[10px] uppercase text-muted text-right">Score</div>
        {value.zset_value.map((e, i) => (
          <div key={i} className="contents">
            <div className="text-ink-2 break-all">{e.member}</div>
            <div className="text-ink-2 text-right tabular-nums">{e.score}</div>
          </div>
        ))}
      </div>
    );
  }
  return <div className="text-subtle italic">No data.</div>;
}

function TtlPill({
  ttl,
  exists,
}: {
  ttl: number | null;
  exists: boolean;
}) {
  if (!exists || ttl === null) {
    return null;
  }
  if (ttl === -1) {
    return (
      <span
        className="text-[10px] px-1.5 h-4 inline-flex items-center bg-bg-2 text-muted rounded"
        title="No expiry"
      >
        ∞
      </span>
    );
  }
  const label = formatTtl(ttl);
  return (
    <span
      className="text-[10px] px-1.5 h-4 inline-flex items-center bg-acc-soft text-acc-ink rounded font-mono"
      title={`TTL ${ttl}s`}
    >
      ⏱ {label}
    </span>
  );
}

function formatTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
