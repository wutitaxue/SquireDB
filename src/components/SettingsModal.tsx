import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AiConfigView,
  EmbeddingConfigView,
  EmbeddingProvider,
} from "../types";

type TabKind = "chat" | "embedding";

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
        className="bg-panel border border-border rounded-lg w-[520px] max-w-[92vw] flex flex-col"
        style={{ boxShadow: "var(--sh-3)" }}
      >
        <div className="flex items-center justify-between px-4 h-10 border-b border-border shrink-0">
          <div className="text-[13px] font-semibold text-ink">AI Settings</div>
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
        </div>

        {tab === "chat" ? (
          <ChatForm onClose={onClose} />
        ) : (
          <EmbeddingForm onClose={onClose} />
        )}
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
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enableThinking, setEnableThinking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<AiConfigView>("get_ai_config")
      .then((c) => {
        setConfig(c);
        setBaseUrl(c.base_url);
        setModel(c.model);
        // null (never set) → default ON, matching observed model behavior
        setEnableThinking(c.enable_thinking ?? true);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await invoke("save_ai_config", {
        baseUrl,
        model,
        apiKey,
        enableThinking,
      });
      setSaved(true);
      setApiKey("");
      const updated = await invoke<AiConfigView>("get_ai_config");
      setConfig(updated);
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
      <p className="text-[11.5px] text-muted leading-relaxed">
        OpenAI-compatible API. Works with OpenAI, DeepSeek, Azure OpenAI, or any
        service exposing{" "}
        <code className="font-mono text-[11px] px-1 bg-bg-2 rounded text-ink-2">
          /chat/completions
        </code>
        .
      </p>

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
        hint={config?.has_api_key ? "stored — leave blank to keep" : "sk-…"}
      >
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            config?.has_api_key ? "(leave blank to keep)" : "sk-..."
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

      <FormFooter
        error={error}
        saved={saved}
        saving={saving}
        onClose={onClose}
      />
    </form>
  );
}

function EmbeddingForm({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<EmbeddingConfigView | null>(null);
  const [provider, setProvider] = useState<EmbeddingProvider>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [deployment, setDeployment] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  // Keep dimensions as a string in form state so the input can be cleared
  // freely. Empty string → omit on save (model default).
  const [dimensions, setDimensions] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<EmbeddingConfigView>("get_embedding_config")
      .then((c) => {
        setConfig(c);
        setProvider(c.provider);
        setBaseUrl(c.base_url);
        setModel(c.model);
        setDeployment(c.deployment);
        setApiVersion(c.api_version);
        setDimensions(c.dimensions != null ? String(c.dimensions) : "");
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
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
      await invoke("save_embedding_config", {
        provider,
        baseUrl,
        model,
        deployment,
        apiVersion,
        dimensions: dims,
        apiKey,
      });
      setSaved(true);
      setApiKey("");
      const updated = await invoke<EmbeddingConfigView>("get_embedding_config");
      setConfig(updated);
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
      <p className="text-[11.5px] text-muted leading-relaxed">
        {isAzure ? (
          <>
            Azure OpenAI Embeddings. Calls{" "}
            <code className="font-mono text-[11px] px-1 bg-bg-2 rounded text-ink-2">
              {`{endpoint}/openai/deployments/{deployment}/embeddings?api-version=…`}
            </code>{" "}
            with{" "}
            <code className="font-mono text-[11px] px-1 bg-bg-2 rounded text-ink-2">
              api-key
            </code>{" "}
            header.
          </>
        ) : (
          <>
            OpenAI-compatible API. Works with OpenAI, Voyage, Jina, vLLM, or any
            service exposing{" "}
            <code className="font-mono text-[11px] px-1 bg-bg-2 rounded text-ink-2">
              /embeddings
            </code>
            .
          </>
        )}
      </p>

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
        hint={config?.has_api_key ? "stored — leave blank to keep" : isAzure ? "from Azure portal" : "sk-…"}
      >
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            config?.has_api_key
              ? "(leave blank to keep)"
              : isAzure
                ? "Azure key"
                : "sk-..."
          }
          autoComplete="off"
          className="form-input"
        />
      </Field>

      <FormFooter
        error={error}
        saved={saved}
        saving={saving}
        onClose={onClose}
      />
    </form>
  );
}

function FormFooter({
  error,
  saved,
  saving,
  onClose,
}: {
  error: string;
  saved: boolean;
  saving: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {error && (
        <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {saved && !error && (
        <div className="px-3 py-2 bg-ok-soft text-ok text-[12px] rounded">
          Settings saved.
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
        <button
          type="submit"
          disabled={saving}
          className="h-7 px-3 text-[12px] font-semibold text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
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
