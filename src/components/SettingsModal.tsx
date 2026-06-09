import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AiModelView,
  Connection,
  EmbeddingModelView,
  EmbeddingProvider,
  McpStatus,
} from "../types";

type TabKind = "chat" | "embedding" | "mcp";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKind>("chat");

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-30 flex items-center justify-center"
      style={{ background: "rgba(20,20,15,0.32)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-panel border border-border rounded-lg w-[640px] max-w-[92vw] max-h-[90vh] flex flex-col"
        style={{ boxShadow: "var(--sh-3)" }}
      >
        <div className="flex items-center justify-between px-4 h-10 border-b border-border shrink-0">
          <div className="text-[13px] font-semibold text-ink">Settings</div>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 text-muted hover:text-ink hover:bg-bg-2 rounded flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="flex items-center gap-1 px-3 pt-2.5 border-b border-border shrink-0">
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
            Chat
          </TabButton>
          <TabButton
            active={tab === "embedding"}
            onClick={() => setTab("embedding")}
          >
            Embedding
          </TabButton>
          <TabButton active={tab === "mcp"} onClick={() => setTab("mcp")}>
            MCP Server
          </TabButton>
        </div>

        <div className="overflow-y-auto">
          {tab === "chat" ? (
            <ChatForm onClose={onClose} />
          ) : tab === "embedding" ? (
            <EmbeddingForm onClose={onClose} />
          ) : (
            <McpForm onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 px-3 text-[12px] font-medium rounded-t-md border border-b-0 -mb-px transition-colors ${
        active
          ? "bg-panel text-ink border-border"
          : "bg-transparent text-muted border-transparent hover:text-ink hover:bg-bg-2"
      }`}
    >
      {children}
    </button>
  );
}

function ChatForm({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<AiModelView[]>([]);
  const [editing, setEditing] = useState<AiModelView | null | "new">(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const list = await invoke<AiModelView[]>("list_ai_models");
      setModels(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function activate(id: number) {
    setError("");
    setNotice("");
    try {
      await invoke("set_active_ai_model", { id });
      setNotice("Active model switched.");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(m: AiModelView) {
    if (
      !window.confirm(
        `Delete model "${m.name}"? Its API key will also be cleared.`,
      )
    )
      return;
    setError("");
    setNotice("");
    try {
      await invoke("delete_ai_model", { id: m.id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  if (editing !== null) {
    return (
      <ChatEditForm
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
      />
    );
  }

  return (
    <div className="p-4 flex flex-col gap-3">
      <p className="text-[11.5px] text-muted leading-relaxed">
        Configure one or more OpenAI-compatible models. The active model is used
        for every AI-powered feature.
      </p>

      {models.length === 0 ? (
        <div className="text-[12px] text-muted bg-bg-2 border border-border rounded px-3 py-4 text-center">
          No models configured yet. Add one to enable AI features.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {models.map((m) => (
            <ModelCard
              key={m.id}
              title={m.name}
              subtitle={
                <>
                  <span className="font-mono">{m.model}</span>
                  <span className="text-subtle"> · </span>
                  <span className="font-mono">{m.base_url}</span>
                </>
              }
              isActive={m.is_active}
              hasKey={m.has_api_key}
              onActivate={() => void activate(m.id)}
              onEdit={() => setEditing(m)}
              onDelete={() => void remove(m)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="h-7 px-3 text-[12px] font-medium text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
        >
          + Add model
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-3 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
        >
          Close
        </button>
      </div>

      {error && (
        <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {notice && !error && (
        <div className="px-3 py-2 bg-ok-soft text-ok text-[12px] rounded">
          {notice}
        </div>
      )}
    </div>
  );
}

function ChatEditForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: AiModelView | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  // null (never set) → default ON, matching observed model behavior
  const [enableThinking, setEnableThinking] = useState(
    initial?.enable_thinking ?? true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (initial) {
        await invoke("update_ai_model", {
          id: initial.id,
          name,
          baseUrl,
          model,
          apiKey,
          enableThinking,
        });
      } else {
        await invoke("create_ai_model", {
          name,
          baseUrl,
          model,
          apiKey,
          enableThinking,
        });
      }
      await onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="p-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold text-ink">
          {initial ? `Edit "${initial.name}"` : "Add chat model"}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-muted hover:text-ink"
        >
          ← Back
        </button>
      </div>

      <Field label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="OpenAI · DeepSeek · Company GPT …"
          required
          className="form-input"
        />
      </Field>

      <Field label="Base URL" required>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
          required
          className="form-input"
        />
      </Field>

      <Field label="Model" required>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-4o-mini"
          required
          className="form-input"
        />
      </Field>

      <Field
        label="API Key"
        hint={initial?.has_api_key ? "stored — leave blank to keep" : "sk-…"}
      >
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            initial?.has_api_key ? "(leave blank to keep)" : "sk-..."
          }
          autoComplete="off"
          className="form-input"
        />
      </Field>

      <label className="flex items-start gap-2.5 mt-1 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enableThinking}
          onChange={(e) => setEnableThinking(e.target.checked)}
          className="mt-0.5 w-3.5 h-3.5 accent-acc cursor-pointer"
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] text-ink font-medium">
            启用思考模式（Reasoning）
          </span>
          <span className="text-[11px] text-muted leading-snug">
            让模型输出 reasoning_content 后再给答案，质量更高但更慢、消耗更多
            token。关掉可省钱。对应 DeepSeek 的{" "}
            <code className="font-mono text-[10.5px] px-1 bg-bg-2 rounded text-ink-2">
              thinking.type
            </code>{" "}
            参数。
          </span>
        </div>
      </label>

      {error && (
        <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-3 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/**
 * Shared visual unit for "one model in the list". Chat tab and Embedding tab
 * render different metadata in `subtitle`, but layout — active radio, name,
 * meta, edit / delete actions — is identical, so co-locating prevents drift.
 */
function ModelCard({
  title,
  subtitle,
  isActive,
  hasKey,
  onActivate,
  onEdit,
  onDelete,
}: {
  title: string;
  subtitle: React.ReactNode;
  isActive: boolean;
  hasKey: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 border rounded-md ${
        isActive ? "border-acc bg-acc-soft" : "border-border bg-panel"
      }`}
    >
      <label className="shrink-0 cursor-pointer select-none">
        <input
          type="radio"
          checked={isActive}
          onChange={onActivate}
          className="w-3.5 h-3.5 accent-acc cursor-pointer"
        />
      </label>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink truncate">
            {title}
          </span>
          {isActive && (
            <span className="text-[10px] uppercase tracking-wider text-acc font-bold">
              Active
            </span>
          )}
          {!hasKey && (
            <span className="text-[10px] uppercase tracking-wider text-warn font-bold">
              No key
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted truncate">{subtitle}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          className="h-6 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded hover:bg-bg-2"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="h-6 px-2 text-[11px] text-crit bg-panel border border-border rounded hover:bg-bg-2"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function EmbeddingForm({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<EmbeddingModelView[]>([]);
  const [editing, setEditing] = useState<EmbeddingModelView | null | "new">(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const list = await invoke<EmbeddingModelView[]>("list_embedding_models");
      setModels(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function activate(id: number) {
    setError("");
    setNotice("");
    try {
      await invoke("set_active_embedding_model", { id });
      setNotice("Active model switched.");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(m: EmbeddingModelView) {
    if (
      !window.confirm(
        `Delete embedding "${m.name}"? Its API key will also be cleared.`,
      )
    )
      return;
    setError("");
    setNotice("");
    try {
      await invoke("delete_embedding_model", { id: m.id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  if (editing !== null) {
    return (
      <EmbeddingEditForm
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
      />
    );
  }

  return (
    <div className="p-4 flex flex-col gap-3">
      <p className="text-[11.5px] text-muted leading-relaxed">
        Configure one or more embedding providers (OpenAI-compatible or Azure
        OpenAI). The active model is used for schema vectorization and semantic
        search.
      </p>

      {models.length === 0 ? (
        <div className="text-[12px] text-muted bg-bg-2 border border-border rounded px-3 py-4 text-center">
          No embedding models configured yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {models.map((m) => (
            <ModelCard
              key={m.id}
              title={m.name}
              subtitle={
                <>
                  <span className="uppercase">{m.provider}</span>
                  <span className="text-subtle"> · </span>
                  <span className="font-mono">
                    {m.provider === "azure" ? m.deployment : m.model}
                  </span>
                  <span className="text-subtle"> · </span>
                  <span className="font-mono truncate">{m.base_url}</span>
                </>
              }
              isActive={m.is_active}
              hasKey={m.has_api_key}
              onActivate={() => void activate(m.id)}
              onEdit={() => setEditing(m)}
              onDelete={() => void remove(m)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="h-7 px-3 text-[12px] font-medium text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
        >
          + Add embedding
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-3 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
        >
          Close
        </button>
      </div>

      {error && (
        <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {notice && !error && (
        <div className="px-3 py-2 bg-ok-soft text-ok text-[12px] rounded">
          {notice}
        </div>
      )}
    </div>
  );
}

function EmbeddingEditForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: EmbeddingModelView | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState<EmbeddingProvider>(
    initial?.provider ?? "openai",
  );
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [deployment, setDeployment] = useState(initial?.deployment ?? "");
  const [apiVersion, setApiVersion] = useState(initial?.api_version ?? "");
  // String state lets the user clear the field freely; empty → omit on save.
  const [dimensions, setDimensions] = useState(
    initial?.dimensions != null ? String(initial.dimensions) : "",
  );
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      let dims: number | null = null;
      const trimmed = dimensions.trim();
      if (trimmed !== "") {
        const n = Number(trimmed);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error("Dimensions must be a positive integer.");
        }
        dims = n;
      }
      if (provider === "azure") {
        if (!deployment.trim()) {
          throw new Error("Deployment is required for Azure OpenAI.");
        }
        if (!apiVersion.trim()) {
          throw new Error("API Version is required for Azure OpenAI.");
        }
      } else if (!model.trim()) {
        throw new Error("Model is required.");
      }
      const payload = {
        name,
        provider,
        baseUrl,
        model,
        deployment,
        apiVersion,
        dimensions: dims,
        apiKey,
      };
      if (initial) {
        await invoke("update_embedding_model", { id: initial.id, ...payload });
      } else {
        await invoke("create_embedding_model", payload);
      }
      await onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const isAzure = provider === "azure";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="p-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold text-ink">
          {initial ? `Edit "${initial.name}"` : "Add embedding model"}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-muted hover:text-ink"
        >
          ← Back
        </button>
      </div>

      <Field label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="OpenAI Embeddings · Voyage · Azure …"
          required
          className="form-input"
        />
      </Field>

      <Field label="Provider" required>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as EmbeddingProvider)}
          className="form-input"
        >
          <option value="openai">OpenAI-compatible</option>
          <option value="azure">Azure OpenAI</option>
        </select>
      </Field>

      <Field label={isAzure ? "Endpoint" : "Base URL"} required>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={
            isAzure
              ? "https://<resource>.openai.azure.com"
              : "https://api.openai.com/v1"
          }
          required
          className="form-input"
        />
      </Field>

      {isAzure ? (
        <>
          <Field label="Deployment" required>
            <input
              value={deployment}
              onChange={(e) => setDeployment(e.target.value)}
              placeholder="my-embedding-deployment"
              required
              className="form-input"
            />
          </Field>

          <Field label="API Version" required>
            <input
              value={apiVersion}
              onChange={(e) => setApiVersion(e.target.value)}
              placeholder="2024-02-15-preview"
              required
              className="form-input"
            />
          </Field>
        </>
      ) : (
        <Field label="Model" required>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="text-embedding-3-small"
            required
            className="form-input"
          />
        </Field>
      )}

      <Field
        label="Dimensions"
        hint="optional · leave blank for model default"
      >
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={dimensions}
          onChange={(e) => setDimensions(e.target.value)}
          placeholder="e.g. 1536"
          className="form-input"
        />
      </Field>

      <Field
        label="API Key"
        hint={
          initial?.has_api_key
            ? "stored — leave blank to keep"
            : isAzure
              ? "from Azure portal"
              : "sk-…"
        }
      >
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            initial?.has_api_key
              ? "(leave blank to keep)"
              : isAzure
                ? "Azure key"
                : "sk-..."
          }
          autoComplete="off"
          className="form-input"
        />
      </Field>

      {error && (
        <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-3 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
        {label}
        {required ? (
          <span className="text-crit normal-case tracking-normal"> *</span>
        ) : hint ? (
          <span className="ml-1 text-subtle normal-case tracking-normal font-normal">
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

// =================================================================== //
// MCP Server tab
// =================================================================== //

function McpForm({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState<string>("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [portInput, setPortInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const [s, t, conns] = await Promise.all([
        invoke<McpStatus>("get_mcp_status"),
        invoke<string>("get_mcp_token"),
        invoke<Connection[]>("list_connections"),
      ]);
      setStatus(s);
      setToken(t);
      setPortInput(String(s.bindPort));
      setConnections(conns.filter((c) => (c.kind ?? "mysql") === "mysql"));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function withBusy<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(next: boolean) {
    const s = await withBusy(() =>
      invoke<McpStatus>("set_mcp_enabled", { enabled: next }),
    );
    if (s) {
      setStatus(s);
      setNotice("Saved. Restart Squire to apply.");
    }
  }

  async function savePort() {
    const n = Number(portInput);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setError("Port must be an integer between 1024 and 65535.");
      return;
    }
    const s = await withBusy(() =>
      invoke<McpStatus>("set_mcp_port", { port: n }),
    );
    if (s) {
      setStatus(s);
      setNotice("Port saved. Restart Squire to apply.");
    }
  }

  async function regenerateToken() {
    if (
      !window.confirm(
        "Regenerate MCP token? Existing Claude clients will lose access until you re-configure them.",
      )
    )
      return;
    const t = await withBusy(() => invoke<string>("regenerate_mcp_token"));
    if (t) {
      setToken(t);
      setTokenVisible(true);
      setNotice("New token generated. Copy it and update your Claude clients.");
    }
  }

  async function toggleConn(id: number) {
    if (!status) return;
    const current = new Set(status.allowedConnIds);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    const ids = Array.from(current);
    const s = await withBusy(() =>
      invoke<McpStatus>("set_mcp_allowed_conns", { ids }),
    );
    if (s) setStatus(s);
  }

  async function clearAllow() {
    const s = await withBusy(() =>
      invoke<McpStatus>("set_mcp_allowed_conns", { ids: [] }),
    );
    if (s) setStatus(s);
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${what} to clipboard.`);
      setError("");
    } catch (e) {
      setError(`Copy failed: ${e}`);
    }
  }

  const endpoint = useMemo(() => {
    const port = status?.actualPort || status?.bindPort || 7421;
    return `http://127.0.0.1:${port}/mcp`;
  }, [status]);

  const claudeCodeCmd = useMemo(
    () =>
      `claude mcp add squiredb --transport http ${endpoint} --header "Authorization: Bearer ${token || "<TOKEN>"}"`,
    [endpoint, token],
  );

  const claudeDesktopJson = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            squiredb: {
              url: endpoint,
              headers: {
                Authorization: `Bearer ${token || "<TOKEN>"}`,
              },
            },
          },
        },
        null,
        2,
      ),
    [endpoint, token],
  );

  if (!status) {
    return (
      <div className="p-4 text-[12px] text-muted">
        Loading MCP settings…
        {error && (
          <pre className="mt-3 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
            {error}
          </pre>
        )}
      </div>
    );
  }

  const allowAll = status.allowedConnIds.length === 0;

  return (
    <div className="p-4 flex flex-col gap-4">
      <p className="text-[11.5px] text-muted leading-relaxed">
        Expose Squire&apos;s database operations as an MCP server on{" "}
        <code className="font-mono text-[11px] px-1 bg-bg-2 rounded text-ink-2">
          127.0.0.1
        </code>{" "}
        so Claude Code / Claude Desktop can call them. Read-only — only
        SELECT / SHOW / DESC / EXPLAIN allowed; results capped at 1000 rows.
      </p>

      {/* ── Status row ── */}
      <div className="flex items-center gap-3 p-3 bg-bg-2 rounded border border-border">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            status.running ? "bg-ok" : "bg-muted"
          }`}
        />
        <div className="flex-1 text-[12px] text-ink">
          {status.running ? (
            <>
              Server running on{" "}
              <code className="font-mono text-[11px] px-1 bg-panel rounded">
                127.0.0.1:{status.actualPort}
              </code>
            </>
          ) : (
            "Server is not running."
          )}
          {status.requiresRestart && (
            <span className="ml-2 text-warn text-[11px]">
              · Restart Squire to apply current settings
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={busy}
            onChange={(e) => void toggleEnabled(e.target.checked)}
            className="w-3.5 h-3.5 accent-acc cursor-pointer"
          />
          <span className="text-[12px] text-ink font-medium">
            {status.enabled ? "Enabled" : "Disabled"}
          </span>
        </label>
      </div>

      {/* ── Port ── */}
      <div className="flex items-end gap-2">
        <Field label="Port" hint="default 7421">
          <input
            type="number"
            min={1024}
            max={65535}
            step={1}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            className="form-input w-32"
          />
        </Field>
        <button
          type="button"
          onClick={() => void savePort()}
          disabled={busy || portInput === String(status.bindPort)}
          className="h-7 px-3 text-[12px] font-medium text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save port
        </button>
      </div>

      {/* ── Token ── */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
          Bearer token
        </span>
        <div className="flex items-center gap-2">
          <input
            type={tokenVisible ? "text" : "password"}
            readOnly
            value={token}
            className="form-input font-mono text-[11px] flex-1"
          />
          <button
            type="button"
            onClick={() => setTokenVisible((v) => !v)}
            className="h-7 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded hover:bg-bg-2"
          >
            {tokenVisible ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            onClick={() => void copy(token, "token")}
            disabled={!token}
            className="h-7 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded hover:bg-bg-2 disabled:opacity-50"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => void regenerateToken()}
            disabled={busy}
            className="h-7 px-2 text-[11px] text-crit bg-panel border border-border rounded hover:bg-bg-2 disabled:opacity-50"
          >
            Regenerate
          </button>
        </div>
      </div>

      {/* ── Allowed connections ── */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
            Allowed connections
          </span>
          {!allowAll && (
            <button
              type="button"
              onClick={() => void clearAllow()}
              disabled={busy}
              className="text-[10.5px] text-acc hover:underline"
            >
              Allow all
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted leading-snug">
          {allowAll
            ? "Currently allowing all connections (no allowlist). Pick specific ones below to restrict. Changes take effect immediately."
            : "Only the checked connections can be queried via MCP. Changes take effect immediately."}
        </p>
        <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto border border-border rounded">
          {connections.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted">
              No MySQL connections saved yet.
            </div>
          ) : (
            connections.map((c) => {
              const id = c.id!;
              const checked = status.allowedConnIds.includes(id);
              return (
                <label
                  key={id}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-bg-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={() => void toggleConn(id)}
                    className="w-3.5 h-3.5 accent-acc cursor-pointer"
                  />
                  <span className="text-[12px] text-ink">{c.name}</span>
                  <span className="text-[11px] text-muted font-mono">
                    {c.host}:{c.port}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>

      {/* ── Endpoint + quick setup ── */}
      <div className="flex flex-col gap-2 p-3 bg-bg-2 rounded border border-border">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
            Endpoint
          </span>
          <code className="font-mono text-[11px] text-ink flex-1">
            {endpoint}
          </code>
          <button
            type="button"
            onClick={() => void copy(endpoint, "endpoint")}
            className="h-6 px-2 text-[11px] text-ink-2 bg-panel border border-border rounded hover:bg-bg-2"
          >
            Copy
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
              Claude Code
            </span>
            <button
              type="button"
              onClick={() => void copy(claudeCodeCmd, "Claude Code command")}
              className="h-5 px-2 text-[10.5px] text-ink-2 bg-panel border border-border rounded hover:bg-bg-2"
            >
              Copy command
            </button>
          </div>
          <pre className="m-0 p-2 bg-panel border border-border rounded font-mono text-[10.5px] text-ink-2 whitespace-pre-wrap break-all">
            {claudeCodeCmd}
          </pre>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">
              Claude Desktop · claude_desktop_config.json
            </span>
            <button
              type="button"
              onClick={() => void copy(claudeDesktopJson, "Claude Desktop JSON")}
              className="h-5 px-2 text-[10.5px] text-ink-2 bg-panel border border-border rounded hover:bg-bg-2"
            >
              Copy JSON
            </button>
          </div>
          <pre className="m-0 p-2 bg-panel border border-border rounded font-mono text-[10.5px] text-ink-2 whitespace-pre overflow-x-auto">
            {claudeDesktopJson}
          </pre>
        </div>
      </div>

      {/* ── Notice / error ── */}
      {error && (
        <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {notice && !error && (
        <div className="px-3 py-2 bg-ok-soft text-ok text-[12px] rounded">
          {notice}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-3 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2"
        >
          Close
        </button>
      </div>
    </div>
  );
}
