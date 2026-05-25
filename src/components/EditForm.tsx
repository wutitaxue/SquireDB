import type { Connection, ConnectionKind } from "../types";

const DEFAULT_PORTS: Record<ConnectionKind, number> = {
  mysql: 3306,
  milvus: 19530,
};

export function EditForm({
  conn,
  password,
  busy,
  onChange,
  onPasswordChange,
  onSave,
  onTest,
  onCancel,
}: {
  conn: Connection;
  password: string;
  busy: boolean;
  onChange: (c: Connection) => void;
  onPasswordChange: (p: string) => void;
  onSave: () => void;
  onTest: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof Connection>(key: K, value: Connection[K]) =>
    onChange({ ...conn, [key]: value });

  const isMilvus = conn.kind === "milvus";

  function setKind(kind: ConnectionKind) {
    // When switching kind, swap default port iff current port matches the
    // *other* default (i.e. user hasn't typed a custom port yet).
    const portIsOtherDefault =
      conn.port === DEFAULT_PORTS[conn.kind === "mysql" ? "milvus" : "mysql"];
    onChange({
      ...conn,
      kind,
      port: portIsOtherDefault ? DEFAULT_PORTS[kind] : conn.port,
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      className="flex flex-col gap-3"
    >
      <Field label="Kind" required>
        <div className="flex gap-2">
          <KindButton
            label="MySQL"
            sub="SQL · 3306"
            active={!isMilvus}
            onClick={() => setKind("mysql")}
          />
          <KindButton
            label="Milvus"
            sub="Vector · 19530"
            active={isMilvus}
            onClick={() => setKind("milvus")}
          />
        </div>
      </Field>

      <Field label="Name" required>
        <input
          value={conn.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder={isMilvus ? "My Zilliz cluster" : "My local MySQL"}
          required
          autoFocus
          className="form-input"
        />
      </Field>

      <div className="flex gap-3">
        <div className="flex-1">
          <Field
            label="Host"
            required
            hint={isMilvus ? "or full URL https://…" : undefined}
          >
            <input
              value={conn.host}
              onChange={(e) => set("host", e.target.value)}
              placeholder={
                isMilvus ? "localhost or in03-xyz.zillizcloud.com" : "localhost"
              }
              required
              className="form-input"
            />
          </Field>
        </div>
        <div className="w-[110px]">
          <Field label="Port" required>
            <input
              type="number"
              value={conn.port}
              onChange={(e) => set("port", parseInt(e.target.value || "0", 10))}
              required
              className="form-input no-spin"
            />
          </Field>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <Field
            label={isMilvus ? "Username" : "Username"}
            required={!isMilvus}
            hint={isMilvus ? "blank if using API key" : undefined}
          >
            <input
              value={conn.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder={isMilvus ? "(optional)" : "root"}
              required={!isMilvus}
              className="form-input"
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field label={isMilvus ? "Token / Password" : "Password"}>
            <input
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder={isMilvus ? "Zilliz API key or password" : "••••••••"}
              className="form-input"
            />
          </Field>
        </div>
      </div>

      <Field
        label="Database"
        hint={isMilvus ? "milvus db, optional (default: default)" : "optional"}
      >
        <input
          value={conn.database ?? ""}
          onChange={(e) => set("database", e.target.value || null)}
          placeholder={isMilvus ? "default" : "leave blank to choose later"}
          className="form-input"
        />
      </Field>

      <div className="flex items-center gap-2 pt-2 mt-1 border-t border-border">
        <button
          type="button"
          onClick={onTest}
          disabled={busy}
          className="h-7 px-3 text-[12px] font-medium text-ink-2 bg-panel-2 border border-border rounded-md hover:bg-bg-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Testing…" : "Test connection"}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-7 px-3 text-[12px] font-medium text-ink-2 hover:bg-bg-2 rounded-md disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function KindButton({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 flex flex-col items-start gap-0.5 px-3 py-2 rounded-md border text-left ${
        active
          ? "border-acc bg-acc-soft text-acc-ink"
          : "border-border bg-panel hover:bg-bg-2 text-ink-2"
      }`}
    >
      <span className="text-[12px] font-semibold">{label}</span>
      <span className="text-[10px] text-muted">{sub}</span>
    </button>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted">
        {label}
        {required && <span className="text-crit normal-case tracking-normal">*</span>}
        {hint && (
          <span className="text-subtle normal-case tracking-normal font-normal">
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
