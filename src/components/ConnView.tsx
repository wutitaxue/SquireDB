import type { Connection } from "../types";

export function ConnView({
  conn,
  busy,
  onOpen,
  onEdit,
  onDelete,
}: {
  conn: Connection;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div>
      <h2 style={{ margin: 0 }}>{conn.name}</h2>
      <dl style={{ marginTop: 16, display: "grid", gridTemplateColumns: "120px 1fr", gap: 6 }}>
        <dt style={{ color: "#666" }}>Host</dt>
        <dd style={{ margin: 0 }}>{conn.host}</dd>
        <dt style={{ color: "#666" }}>Port</dt>
        <dd style={{ margin: 0 }}>{conn.port}</dd>
        <dt style={{ color: "#666" }}>Username</dt>
        <dd style={{ margin: 0 }}>{conn.username}</dd>
        <dt style={{ color: "#666" }}>Database</dt>
        <dd style={{ margin: 0 }}>{conn.database || <em style={{ color: "#999" }}>(none)</em>}</dd>
        {conn.created_at && (
          <>
            <dt style={{ color: "#666" }}>Created</dt>
            <dd style={{ margin: 0 }}>{conn.created_at}</dd>
          </>
        )}
      </dl>

      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <button onClick={onOpen} disabled={busy} style={{ fontWeight: 600 }}>
          {busy ? "Opening…" : "Open"}
        </button>
        <button onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button onClick={onDelete} disabled={busy} style={{ color: "#a8071a" }}>
          Delete
        </button>
      </div>
    </div>
  );
}
