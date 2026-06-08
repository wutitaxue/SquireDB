import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { Connection, ConnectionKind } from "../types";

const DEFAULT_PORTS: Record<ConnectionKind, number> = {
  mysql: 3306,
  milvus: 19530,
  sqlite: 0,
  redis: 6379,
};

const KNOWN_DEFAULT_PORTS = new Set<number>(Object.values(DEFAULT_PORTS));

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
  const isSqlite = conn.kind === "sqlite";
  const isRedis = conn.kind === "redis";

  function setKind(kind: ConnectionKind) {
    // Swap default port iff current port is one of the known defaults (i.e.
    // user hasn't typed a custom port).
    const portIsKnownDefault = KNOWN_DEFAULT_PORTS.has(conn.port);
    onChange({
      ...conn,
      kind,
      port: portIsKnownDefault ? DEFAULT_PORTS[kind] : conn.port,
    });
  }

  async function pickFile() {
    const selected = await openFileDialog({
      multiple: false,
      filters: [
        { name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string" && selected.length > 0) {
      set("database", selected);
    }
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
        <div className="flex gap-2 flex-wrap">
          <KindButton
            label="MySQL"
            sub="SQL · 3306"
            active={conn.kind === "mysql"}
            onClick={() => setKind("mysql")}
          />
          <KindButton
            label="SQLite"
            sub="SQL · file"
            active={isSqlite}
            onClick={() => setKind("sqlite")}
          />
          <KindButton
            label="Redis"
            sub="KV · 6379"
            active={isRedis}
            onClick={() => setKind("redis")}
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
          placeholder={
            isMilvus
              ? "My Zilliz cluster"
              : isSqlite
                ? "My local SQLite"
                : "My local MySQL"
          }
          required
          autoFocus
          className="form-input"
        />
      </Field>

      {isSqlite ? (
        <Field label="File path" required hint="absolute path to .db / .sqlite file">
          <div className="flex gap-2">
            <input
              value={conn.database ?? ""}
              onChange={(e) => set("database", e.target.value || null)}
              placeholder="/Users/me/data.db"
              required
              className="form-input flex-1"
            />
            <button
              type="button"
              onClick={() => void pickFile()}
              disabled={busy}
              className="h-7 px-3 text-[12px] font-medium text-ink-2 bg-panel-2 border border-border rounded-md hover:bg-bg-2 disabled:opacity-50"
            >
              Browse…
            </button>
          </div>
        </Field>
      ) : (
        <>
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
                  onChange={(e) =>
                    set("port", parseInt(e.target.value || "0", 10))
                  }
                  required
                  className="form-input no-spin"
                />
              </Field>
            </div>
          </div>

          {isRedis ? (
            <div className="flex gap-3">
              <div className="flex-1">
                <Field label="Username" hint="ACL user, blank = default">
                  <input
                    value={conn.username}
                    onChange={(e) => set("username", e.target.value)}
                    placeholder="default"
                    className="form-input"
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Password" hint="blank if no AUTH">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => onPasswordChange(e.target.value)}
                    placeholder="••••••••"
                    className="form-input"
                  />
                </Field>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <div className="flex-1">
                <Field
                  label="Username"
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
          )}

          <Field
            label="Database"
            hint={
              isRedis
                ? "0–15 (default: 0)"
                : isMilvus
                  ? "milvus db, optional (default: default)"
                  : "optional"
            }
          >
            <input
              value={conn.database ?? ""}
              onChange={(e) => set("database", e.target.value || null)}
              placeholder={
                isRedis ? "0" : isMilvus ? "default" : "leave blank to choose later"
              }
              className="form-input"
            />
          </Field>
        </>
      )}

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
