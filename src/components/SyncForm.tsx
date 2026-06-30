import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  SyncConfigDisplay,
  SyncConfigInput,
  SyncDeviceObject,
  SyncPullPreview,
  SyncPushResult,
} from "../types";
import { SyncPullModal } from "./SyncPullModal";

type ProviderPreset = {
  id: string;
  label: string;
  region: string;
  endpoint: string;
  pathStyle: boolean;
  /** When true, the endpoint field is filled by the user (contains an account id etc.). */
  endpointEditable: boolean;
  hint: string;
};

const PRESETS: ProviderPreset[] = [
  {
    id: "r2",
    label: "Cloudflare R2",
    region: "auto",
    endpoint: "https://<account-id>.r2.cloudflarestorage.com",
    pathStyle: true,
    endpointEditable: true,
    hint: "Endpoint 形如 https://<account-id>.r2.cloudflarestorage.com，Region 固定 auto。",
  },
  {
    id: "aws",
    label: "AWS S3",
    region: "us-east-1",
    endpoint: "",
    pathStyle: false,
    endpointEditable: false,
    hint: "Endpoint 留空走 AWS 默认。需要 IAM 权限 PutObject/GetObject/HeadObject/ListBucket/DeleteObject。",
  },
  {
    id: "b2",
    label: "Backblaze B2",
    region: "us-west-001",
    endpoint: "https://s3.us-west-001.backblazeb2.com",
    pathStyle: true,
    endpointEditable: true,
    hint: "Endpoint 形如 https://s3.<region>.backblazeb2.com。",
  },
  {
    id: "oss",
    label: "阿里云 OSS",
    region: "oss-cn-hangzhou",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    pathStyle: false,
    endpointEditable: true,
    hint: "需在 OSS 开启 S3 兼容；Endpoint 形如 https://oss-<region>.aliyuncs.com。",
  },
  {
    id: "cos",
    label: "腾讯云 COS",
    region: "ap-guangzhou",
    endpoint: "https://cos.ap-guangzhou.myqcloud.com",
    pathStyle: false,
    endpointEditable: true,
    hint: "Endpoint 形如 https://cos.<region>.myqcloud.com。Bucket 名带 appid 后缀。",
  },
  {
    id: "minio",
    label: "MinIO",
    region: "us-east-1",
    endpoint: "http://127.0.0.1:9000",
    pathStyle: true,
    endpointEditable: true,
    hint: "自建 MinIO，通常 path-style + 自定义 endpoint。",
  },
  {
    id: "custom",
    label: "自定义 S3 兼容",
    region: "us-east-1",
    endpoint: "",
    pathStyle: true,
    endpointEditable: true,
    hint: "任意 S3 兼容服务，手填 endpoint / region。",
  },
];

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function SyncForm({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [provider, setProvider] = useState("r2");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("auto");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState(""); // empty = keep existing
  const [hasSecretKey, setHasSecretKey] = useState(false);
  const [pathStyle, setPathStyle] = useState(true);
  const [prefix, setPrefix] = useState("squiredb-sync");
  const [deviceName, setDeviceName] = useState("");

  const [configured, setConfigured] = useState(false);
  const [lastPushedAt, setLastPushedAt] = useState<string | null>(null);
  const [lastPulledAt, setLastPulledAt] = useState<string | null>(null);
  const [lastPulledFrom, setLastPulledFrom] = useState<string | null>(null);

  const [devices, setDevices] = useState<SyncDeviceObject[] | null>(null);
  const [preview, setPreview] = useState<SyncPullPreview | null>(null);

  const preset = PRESETS.find((p) => p.id === provider) ?? PRESETS[0];

  function applyDisplay(d: SyncConfigDisplay) {
    setProvider(d.provider || "r2");
    setEndpoint(d.endpoint);
    setRegion(d.region || "auto");
    setBucket(d.bucket);
    setAccessKey(d.access_key);
    setHasSecretKey(d.has_secret_key);
    setSecretKey("");
    setPathStyle(d.path_style);
    setPrefix(d.prefix || "squiredb-sync");
    setDeviceName(d.device_name);
    setConfigured(d.configured);
    setLastPushedAt(d.last_pushed_at);
    setLastPulledAt(d.last_pulled_at);
    setLastPulledFrom(d.last_pulled_from);
  }

  async function refresh() {
    try {
      const d = await invoke<SyncConfigDisplay>("sync_get_config");
      applyDisplay(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function onPickProvider(id: string) {
    setProvider(id);
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    // Only auto-fill region / endpoint / path-style when the field is still at a
    // default-ish value, so we don't clobber what the user already typed.
    setRegion((r) => (r === "" || r === "auto" || isPresetRegion(r) ? p.region : r));
    setPathStyle(p.pathStyle);
    if (!p.endpointEditable) {
      setEndpoint("");
    } else if (endpoint === "" || isPresetEndpoint(endpoint)) {
      setEndpoint(p.endpoint);
    }
  }

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

  function buildInput(): SyncConfigInput {
    return {
      provider,
      endpoint: preset.endpointEditable ? endpoint.trim() : "",
      region: region.trim(),
      bucket: bucket.trim(),
      access_key: accessKey.trim(),
      secret_key: secretKey ? secretKey : null,
      path_style: pathStyle,
      prefix: prefix.trim() || "squiredb-sync",
      device_name: deviceName.trim() || "SquireDB",
    };
  }

  async function save() {
    if (!bucket.trim() || !accessKey.trim()) {
      setError("Bucket 和 Access Key ID 必填。");
      return;
    }
    if (!hasSecretKey && !secretKey) {
      setError("Secret Access Key 必填。");
      return;
    }
    const ok = await withBusy(async () => {
      await invoke("sync_save_config", { input: buildInput() });
      return true;
    });
    if (ok) {
      setNotice("已保存并验证连通性。");
      await refresh();
    }
  }

  async function push() {
    const res = await withBusy(() => invoke<SyncPushResult>("sync_push"));
    if (res) {
      setNotice(
        `已 Push「${res.device_name}」(${fmtBytes(res.bytes)}) → ${res.object_key}`,
      );
      await refresh();
    }
  }

  async function openPull() {
    const list = await withBusy(() =>
      invoke<SyncDeviceObject[]>("sync_list_devices"),
    );
    if (list) setDevices(list);
  }

  async function pickDevice(name: string) {
    const p = await withBusy(() =>
      invoke<SyncPullPreview>("sync_preview_pull", { deviceName: name }),
    );
    if (p) {
      setDevices(null);
      setPreview(p);
    }
  }

  async function clearConfig() {
    if (!window.confirm("清除本机的云同步配置？远端 bundle 不会被删除。")) return;
    const ok = await withBusy(async () => {
      await invoke("sync_clear_config");
      return true;
    });
    if (ok) {
      setNotice("已清除本机同步配置。");
      await refresh();
    }
  }

  if (loading) {
    return <div className="p-4 text-[12px] text-muted">Loading sync settings…</div>;
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      <p className="text-[11.5px] text-muted leading-relaxed">
        通过 S3 兼容对象存储在多台设备间同步配置（连接 / 项目 / AI 模型 / 保存的查询 /
        Settings）。
        <span className="text-warn">
          {" "}
          Bundle 含明文连接密码与 API Key —— 务必使用私有 Bucket + 最小权限 Access Key。
        </span>
      </p>

      {/* Provider */}
      <Field label="服务商">
        <select
          value={provider}
          onChange={(e) => onPickProvider(e.target.value)}
          className="form-input"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="-mt-2 text-[11px] text-subtle leading-snug">{preset.hint}</p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Region">
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="form-input"
            placeholder="auto"
          />
        </Field>
        <Field label="Bucket" required>
          <input
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            className="form-input"
            placeholder="my-squiredb-sync"
          />
        </Field>
      </div>

      {preset.endpointEditable && (
        <Field label="Endpoint">
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="form-input font-mono text-[11px]"
            placeholder={preset.endpoint}
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Access Key ID" required>
          <input
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            className="form-input font-mono text-[11px]"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Secret Access Key"
          hint={hasSecretKey ? "留空保持现有密钥" : undefined}
          required={!hasSecretKey}
        >
          <input
            type="password"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            className="form-input font-mono text-[11px]"
            placeholder={hasSecretKey ? "••••••••（已保存）" : ""}
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Key 前缀">
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            className="form-input font-mono text-[11px]"
            placeholder="squiredb-sync"
          />
        </Field>
        <Field label="设备名" hint="本机 bundle 的文件名">
          <input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            className="form-input"
            placeholder="MacBookPro-Home"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={pathStyle}
          onChange={(e) => setPathStyle(e.target.checked)}
          className="w-3.5 h-3.5 accent-acc cursor-pointer"
        />
        <span className="text-[12px] text-ink">Path-style 寻址</span>
        <span className="text-[11px] text-subtle">
          （R2 / MinIO / B2 建议开；AWS / 阿里云 / 腾讯云通常关）
        </span>
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="h-7 px-3 text-[12px] font-medium text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50"
        >
          保存并验证
        </button>
        {configured && (
          <button
            type="button"
            onClick={() => void clearConfig()}
            disabled={busy}
            className="h-7 px-3 text-[12px] text-crit bg-panel border border-border rounded-md hover:bg-bg-2 disabled:opacity-50"
          >
            清除配置
          </button>
        )}
      </div>

      {/* Push / Pull */}
      {configured && (
        <div className="flex flex-col gap-2 p-3 bg-bg-2 rounded border border-border">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void push()}
              disabled={busy}
              className="h-7 px-3 text-[12px] font-medium text-white bg-acc rounded-md hover:bg-acc-2 disabled:opacity-50"
            >
              ⬆ Push 本机配置
            </button>
            <button
              type="button"
              onClick={() => void openPull()}
              disabled={busy}
              className="h-7 px-3 text-[12px] text-ink-2 bg-panel border border-border rounded-md hover:bg-bg-2 disabled:opacity-50"
            >
              ⬇ Pull 其他设备…
            </button>
          </div>
          <div className="text-[11px] text-muted leading-relaxed">
            上次 Push：{fmtTime(lastPushedAt)}
            <br />
            上次 Pull：{fmtTime(lastPulledAt)}
            {lastPulledFrom ? `（来自 ${lastPulledFrom}）` : ""}
          </div>
        </div>
      )}

      {error && (
        <pre className="m-0 px-3 py-2 bg-crit-soft text-crit text-[12px] rounded whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {notice && !error && (
        <div className="px-3 py-2 bg-ok-soft text-ok text-[12px] rounded whitespace-pre-wrap">
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

      {/* Device picker */}
      {devices && (
        <DevicePicker
          devices={devices}
          currentDevice={deviceName}
          onPick={(name) => void pickDevice(name)}
          onClose={() => setDevices(null)}
        />
      )}

      {/* Conflict resolution + apply */}
      {preview && (
        <SyncPullModal
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={(msg) => {
            setPreview(null);
            setNotice(msg);
            void refresh();
          }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}

function DevicePicker({
  devices,
  currentDevice,
  onPick,
  onClose,
}: {
  devices: SyncDeviceObject[];
  currentDevice: string;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{ background: "rgba(20,20,15,0.32)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-panel border border-border rounded-lg w-[440px] max-w-[92vw] flex flex-col"
        style={{ boxShadow: "var(--sh-3)" }}
      >
        <div className="flex items-center justify-between px-4 h-10 border-b border-border">
          <div className="text-[13px] font-semibold text-ink">选择来源设备</div>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 text-muted hover:text-ink hover:bg-bg-2 rounded flex items-center justify-center"
          >
            ×
          </button>
        </div>
        <div className="p-2 flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
          {devices.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-muted text-center">
              远端还没有任何 bundle。先在另一台设备上 Push。
            </div>
          ) : (
            devices.map((d) => {
              const isSelf = d.device_name === currentDevice;
              return (
                <button
                  key={d.key}
                  type="button"
                  disabled={isSelf}
                  onClick={() => onPick(d.device_name)}
                  className="flex items-center gap-3 px-3 py-2 rounded text-left hover:bg-bg-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="text-[14px]">{isSelf ? "○" : "●"}</span>
                  <div className="flex-1">
                    <div className="text-[12px] text-ink font-medium">
                      {d.device_name}
                      {isSelf && (
                        <span className="ml-2 text-[10px] text-subtle">(本机)</span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted">
                      {fmtTime(d.last_modified)} · {fmtBytes(d.size)}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
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

function isPresetRegion(r: string): boolean {
  return PRESETS.some((p) => p.region === r);
}

function isPresetEndpoint(e: string): boolean {
  return PRESETS.some((p) => p.endpoint === e);
}
