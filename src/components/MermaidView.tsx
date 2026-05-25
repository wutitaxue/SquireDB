import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let initialized = false;
function ensureInit() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "strict",
    er: { useMaxWidth: false, layoutDirection: "LR" },
    flowchart: { useMaxWidth: false },
  });
  initialized = true;
}

type Props = {
  source: string;
  className?: string;
  onSvg?: (svg: string) => void;
};

export function MermaidView({ source, className, onSvg }: Props) {
  const [svg, setSvg] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const cancelled = useRef(false);

  useEffect(() => {
    ensureInit();
    cancelled.current = false;
    setErr("");
    setSvg("");
    if (!source.trim()) return;
    const id = "er-" + Math.random().toString(36).slice(2, 10);
    mermaid
      .render(id, source)
      .then(({ svg }) => {
        if (cancelled.current) return;
        setSvg(svg);
        onSvg?.(svg);
      })
      .catch((e) => {
        if (cancelled.current) return;
        setErr(String(e?.message ?? e));
      });
    return () => {
      cancelled.current = true;
    };
  }, [source, onSvg]);

  if (err) {
    return (
      <div className={className}>
        <div className="text-[12px] text-crit mb-1.5">Mermaid render failed</div>
        <pre className="text-[11px] text-muted whitespace-pre-wrap break-all">{err}</pre>
      </div>
    );
  }
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
