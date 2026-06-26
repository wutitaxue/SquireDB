import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterState = {
  available: { version: string; notes: string | null } | null;
  downloading: boolean;
  progress: number | null;
  error: string | null;
  install: () => Promise<void>;
};

export function useUpdater(): UpdaterState {
  const [available, setAvailable] = useState<UpdaterState["available"]>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const upd = await check();
        if (cancelled || !upd) return;
        updateRef.current = upd;
        setAvailable({ version: upd.version, notes: upd.body ?? null });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const install = useCallback(async () => {
    const upd = updateRef.current;
    if (!upd || downloading) return;
    setDownloading(true);
    setError(null);
    setProgress(0);
    let total = 0;
    let downloaded = 0;
    try {
      await upd.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total = evt.data.contentLength ?? 0;
          downloaded = 0;
        } else if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          if (total > 0) setProgress(Math.min(100, Math.round((downloaded / total) * 100)));
        } else if (evt.event === "Finished") {
          setProgress(100);
        }
      });
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDownloading(false);
      setProgress(null);
    }
  }, [downloading]);

  return { available, downloading, progress, error, install };
}
