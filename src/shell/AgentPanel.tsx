import type { ReactNode } from "react";

type Props = {
  icon: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function AgentPanel({ icon, title, subtitle, actions, children }: Props) {
  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      <div className="flex items-center gap-3 h-14 px-4 bg-panel border-b border-border shrink-0">
        <span className="w-9 h-9 rounded-lg bg-acc-soft text-acc flex items-center justify-center text-[16px] shrink-0">
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold text-ink truncate">{title}</div>
          {subtitle && (
            <div className="text-[12px] text-muted truncate">{subtitle}</div>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-5">{children}</div>
    </div>
  );
}

export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`bg-panel border border-border rounded-lg ${padded ? "p-4" : ""} ${className}`}
      style={{ boxShadow: "var(--sh-1)" }}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between mb-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-0.5">
          {title}
        </div>
        {subtitle && (
          <div className="text-[12px] text-ink-2">{subtitle}</div>
        )}
      </div>
      {right}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
      {children}
    </div>
  );
}

export type SevTone = "crit" | "warn" | "ok" | "info" | "pii" | "neutral";

const SEV_CLASS: Record<SevTone, string> = {
  crit: "bg-crit-soft text-crit",
  warn: "bg-warn-soft text-warn",
  ok: "bg-ok-soft text-ok",
  info: "bg-info-soft text-info",
  pii: "bg-pii-soft text-pii",
  neutral: "bg-bg-2 text-muted",
};

export function SevPill({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: SevTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center px-1.5 h-[18px] rounded-sm text-[10px] uppercase tracking-wider font-bold ${SEV_CLASS[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function RiskDot({ tone }: { tone: SevTone }) {
  const TONE_BG: Record<SevTone, string> = {
    crit: "bg-crit",
    warn: "bg-warn",
    ok: "bg-ok",
    info: "bg-info",
    pii: "bg-pii",
    neutral: "bg-subtle",
  };
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${TONE_BG[tone]}`} />;
}

export function KpiCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: SevTone;
}) {
  const VALUE_TONE: Record<SevTone, string> = {
    crit: "text-crit",
    warn: "text-warn",
    ok: "text-ok",
    info: "text-info",
    pii: "text-pii",
    neutral: "text-ink",
  };
  return (
    <Card>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
        {label}
      </div>
      <div className={`text-[24px] font-bold tabular-nums leading-none ${VALUE_TONE[tone]}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </Card>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-7 px-2.5 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
}

export function ErrorPre({ children }: { children: ReactNode }) {
  return (
    <pre className="m-0 p-3 bg-crit-soft text-crit text-[12px] rounded-lg whitespace-pre-wrap font-mono">
      {children}
    </pre>
  );
}
