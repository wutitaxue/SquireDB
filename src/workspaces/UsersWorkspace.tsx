import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DbUser, UserAction } from "../types";
import {
  AgentPanel,
  Card,
  ErrorPre,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from "../shell/AgentPanel";

type Props = {
  connectionId: number;
  databases: string[];
  onClose: () => void;
};

/** A pending action awaiting confirmation: the structured action plus the
 *  exact SQL the backend previewed for it. */
type Pending = { action: UserAction; label: string; sql: string; danger: boolean };

export function UsersWorkspace({ connectionId, databases, onClose }: Props) {
  const [users, setUsers] = useState<DbUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const list = await invoke<DbUser[]>("list_db_users", { connectionId });
      setUsers(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  function userKey(u: DbUser): string {
    return `${u.user}@${u.host}`;
  }

  /** Preview the SQL for an action, then open the confirm modal. */
  async function stage(action: UserAction, label: string, danger: boolean) {
    setError("");
    try {
      const sql = await invoke<string>("preview_user_action", { action });
      setPending({ action, label, sql, danger });
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirm() {
    if (!pending) return;
    setApplyBusy(true);
    try {
      const ran = await invoke<string>("apply_user_action", {
        connectionId,
        action: pending.action,
      });
      setNotice(`Applied: ${ran}`);
      setPending(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setApplyBusy(false);
    }
  }

  const subtitle = users
    ? `${users.length} account${users.length === 1 ? "" : "s"}`
    : "Read mysql.user + SHOW GRANTS";

  return (
    <AgentPanel
      icon="👤"
      title="Users & Privileges"
      subtitle={subtitle}
      actions={
        <>
          <SecondaryButton onClick={() => void refresh()}>Refresh</SecondaryButton>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </>
      }
    >
      {error && <ErrorPre>{error}</ErrorPre>}
      {notice && (
        <div className="mb-2 text-[12px] text-ok flex items-center gap-2">
          <span className="w-[6px] h-[6px] rounded-full bg-ok" />
          {notice}
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>Accounts</SectionTitle>
          <PrimaryButton onClick={() => setPending(newUserDraft())}>
            + New user
          </PrimaryButton>
        </div>
        {loading && <div className="text-[12px] text-muted">Loading…</div>}
        {users && users.length === 0 && (
          <div className="text-[12px] text-muted italic">No accounts.</div>
        )}
        <ul className="flex flex-col gap-1">
          {users?.map((u) => {
            const key = userKey(u);
            const isOpen = expanded.has(key);
            return (
              <li key={key} className="border border-border rounded-md overflow-hidden">
                <div className="flex items-center gap-2 px-2 py-1.5 bg-panel-2">
                  <button
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    className="text-[9px] text-subtle w-3 shrink-0"
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                  <span className="font-mono text-[12px] text-ink">
                    {u.user || "''"}
                    <span className="text-subtle">@{u.host}</span>
                  </span>
                  {u.locked === true && (
                    <span className="text-[9px] font-bold uppercase tracking-wider bg-warn-soft text-warn px-1 rounded">
                      locked
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <RowAction onClick={() => setPending(setPasswordDraft(u))}>
                      Password
                    </RowAction>
                    {u.locked === true ? (
                      <RowAction
                        onClick={() =>
                          void stage(
                            { kind: "set_lock", user: u.user, host: u.host, locked: false },
                            `Unlock ${key}`,
                            false,
                          )
                        }
                      >
                        Unlock
                      </RowAction>
                    ) : (
                      <RowAction
                        onClick={() =>
                          void stage(
                            { kind: "set_lock", user: u.user, host: u.host, locked: true },
                            `Lock ${key}`,
                            false,
                          )
                        }
                      >
                        Lock
                      </RowAction>
                    )}
                    <RowAction onClick={() => setPending(grantDraft(u, databases))}>
                      Grant
                    </RowAction>
                    <RowAction
                      danger
                      onClick={() =>
                        void stage(
                          { kind: "drop_user", user: u.user, host: u.host },
                          `Drop ${key}`,
                          true,
                        )
                      }
                    >
                      Drop
                    </RowAction>
                  </div>
                </div>
                {isOpen && (
                  <div className="px-3 py-2 text-[11px] font-mono text-ink-2 bg-panel">
                    {u.grants_error ? (
                      <span className="text-warn">{u.grants_error}</span>
                    ) : u.grants.length === 0 ? (
                      <span className="text-subtle italic">(no grants)</span>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {u.grants.map((g, i) => (
                          <li key={i} className="whitespace-pre-wrap break-all">
                            {g}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {pending && (
        <ActionModal
          pending={pending}
          databases={databases}
          busy={applyBusy}
          onChange={setPending}
          onCancel={() => setPending(null)}
          onPreview={stage}
          onConfirm={confirm}
        />
      )}
    </AgentPanel>
  );
}

function RowAction({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-6 px-2 text-[11px] rounded border border-border hover:bg-bg ${
        danger ? "text-crit" : "text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}

// --- Draft builders: open the modal in a form state (sql empty until previewed) ---

function newUserDraft(): Pending {
  return {
    action: { kind: "create_user", user: "", host: "%", password: "" },
    label: "Create user",
    sql: "",
    danger: false,
  };
}
function setPasswordDraft(u: DbUser): Pending {
  return {
    action: { kind: "set_password", user: u.user, host: u.host, password: "" },
    label: `Set password for ${u.user}@${u.host}`,
    sql: "",
    danger: false,
  };
}
function grantDraft(u: DbUser, databases: string[]): Pending {
  return {
    action: {
      kind: "grant",
      user: u.user,
      host: u.host,
      privileges: "SELECT",
      scope: databases[0] ? `\`${databases[0]}\`.*` : "*.*",
    },
    label: `Grant to ${u.user}@${u.host}`,
    sql: "",
    danger: false,
  };
}

/**
 * The action editor + confirmation modal. For form-shaped actions (create /
 * set-password / grant) it shows editable fields and a Preview step; for
 * simple actions (lock / drop) it's already previewed and just confirms.
 */
function ActionModal({
  pending,
  databases,
  busy,
  onChange,
  onCancel,
  onPreview,
  onConfirm,
}: {
  pending: Pending;
  databases: string[];
  busy: boolean;
  onChange: (p: Pending) => void;
  onCancel: () => void;
  onPreview: (action: UserAction, label: string, danger: boolean) => void;
  onConfirm: () => void;
}) {
  const a = pending.action;
  const isForm =
    a.kind === "create_user" || a.kind === "set_password" || a.kind === "grant";
  const [confirmText, setConfirmText] = useState("");
  const needsTyping = pending.danger; // Drop requires typing CONFIRM.

  function patch(next: UserAction) {
    // Editing a form field invalidates a prior preview.
    onChange({ ...pending, action: next, sql: "" });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[520px] max-h-[80vh] overflow-y-auto bg-panel border border-border rounded-lg shadow-3">
        <div className="px-4 py-3 border-b border-border font-semibold text-[13px] text-ink">
          {pending.label}
        </div>
        <div className="p-4 flex flex-col gap-3">
          {a.kind === "create_user" && (
            <>
              <Field label="User">
                <input
                  className="form-input"
                  value={a.user}
                  onChange={(e) => patch({ ...a, user: e.target.value })}
                  autoFocus
                />
              </Field>
              <Field label="Host">
                <input
                  className="form-input"
                  value={a.host}
                  onChange={(e) => patch({ ...a, host: e.target.value })}
                />
              </Field>
              <Field label="Password">
                <input
                  className="form-input"
                  type="password"
                  value={a.password}
                  onChange={(e) => patch({ ...a, password: e.target.value })}
                />
              </Field>
            </>
          )}
          {a.kind === "set_password" && (
            <Field label="New password">
              <input
                className="form-input"
                type="password"
                value={a.password}
                onChange={(e) => patch({ ...a, password: e.target.value })}
                autoFocus
              />
            </Field>
          )}
          {a.kind === "grant" && (
            <>
              <Field label="Privileges">
                <input
                  className="form-input"
                  value={a.privileges}
                  onChange={(e) => patch({ ...a, privileges: e.target.value })}
                  placeholder="SELECT, INSERT, UPDATE"
                  autoFocus
                />
              </Field>
              <Field label="Scope">
                <div className="flex gap-1.5">
                  <select
                    className="h-8 px-1 text-[12px] bg-panel-2 border border-border rounded text-ink shrink-0"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) patch({ ...a, scope: e.target.value });
                    }}
                  >
                    <option value="">pick…</option>
                    <option value="*.*">*.* (global)</option>
                    {databases.map((d) => (
                      <option key={d} value={`\`${d}\`.*`}>
                        {d}.*
                      </option>
                    ))}
                  </select>
                  <input
                    className="form-input flex-1 min-w-0 font-mono"
                    value={a.scope}
                    onChange={(e) => patch({ ...a, scope: e.target.value })}
                  />
                </div>
              </Field>
            </>
          )}

          {pending.sql ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
                SQL to run
              </div>
              <pre className="text-[11px] font-mono bg-bg border border-border rounded p-2 whitespace-pre-wrap break-all text-ink-2">
                {pending.sql}
              </pre>
            </div>
          ) : null}

          {pending.sql && needsTyping && (
            <Field label="Type CONFIRM to proceed">
              <input
                className="form-input font-mono"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CONFIRM"
                autoFocus
              />
            </Field>
          )}
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          {!pending.sql ? (
            <PrimaryButton
              onClick={() => onPreview(pending.action, pending.label, pending.danger)}
              disabled={!isForm}
            >
              Preview SQL
            </PrimaryButton>
          ) : (
            <button
              onClick={onConfirm}
              disabled={busy || (needsTyping && confirmText !== "CONFIRM")}
              className={`h-8 px-4 text-[12px] font-semibold text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${
                pending.danger ? "bg-crit hover:opacity-90" : "bg-acc hover:bg-acc-2"
              }`}
            >
              {busy ? "Applying…" : "Run"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </label>
  );
}
