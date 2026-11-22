import { CUSTOM_CONFIG_KEY, activeWallpaper, isMediaKey, normalizeCustomConfig, pageViewConfig } from "../shared/custom";
import { dataUrlToBlob } from "../features/media-cache";
import type { CustomConfig } from "../shared/types";
import {
  MAX_SCRIPT_LOGS,
  SCRIPT_LOGS_KEY,
  SCRIPT_SOURCE,
  SCRIPT_STATUS_KEY,
  normalizeScriptLog,
  normalizeScriptLogs,
  normalizeScriptStatus,
} from "../shared/script-status";

const BRIDGE_SOURCE = "fuck-touge-bridge";
const MAIN_SOURCE = "fuck-touge-main";

/** bridge 生命周期内复用 blob URL；页面 reload 后由页面 IDB 接管 */
const mediaBlobUrls = new Map<string, string>();

const post = (config: unknown): void => {
  try {
    window.postMessage({ source: BRIDGE_SOURCE, type: "config", config }, "*");
  } catch (e) {}
};


/** 通知页面清理已删除壁纸的 IDB/object URL；只传 key 列表 */
const postCleanup = (cfg: CustomConfig): void => {
  try {
    const keys = cfg.background.wallpapers
      .map((w) => w.mediaKey || "")
      .filter((k) => isMediaKey(k));
    const valid = new Set(keys);
    // bridge 自己的 blob URL 也会持有 Blob；删除壁纸后必须 revoke
    for (const [key, url] of mediaBlobUrls) {
      if (valid.has(key)) continue;
      try { URL.revokeObjectURL(url); } catch (e) {}
      mediaBlobUrls.delete(key);
    }
    window.postMessage({ source: BRIDGE_SOURCE, type: "media-cleanup", keys }, "*");
  } catch (e) {}
};

const push = (): void => {
  try {
    chrome.storage.local.get(CUSTOM_CONFIG_KEY, (result) => {
      if (chrome.runtime?.lastError) return;
      const cfg = normalizeCustomConfig(result?.[CUSTOM_CONFIG_KEY]);
      post(pageViewConfig(cfg));
      postCleanup(cfg);
    });
  } catch (e) {
    const cfg = normalizeCustomConfig(null);
    post(pageViewConfig(cfg));
    postCleanup(cfg);
  }
};

const storageGet = (keys: string | string[]): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    } catch (e) {
      resolve({});
    }
  });

const storageSet = (items: Record<string, unknown>): Promise<void> =>
  new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => resolve());
    } catch (e) {
      resolve();
    }
  });

// 脚本可能连续发多条日志；串行化 read-modify-write，避免日志互相覆盖
let scriptQueue: Promise<void> = Promise.resolve();
const enqueueScript = (fn: () => Promise<void>): void => {
  scriptQueue = scriptQueue.then(fn, fn);
};

const appendLogs = async (raws: unknown[]): Promise<void> => {
  if (!raws.length) return;
  const current = await storageGet(SCRIPT_LOGS_KEY);
  const logs = normalizeScriptLogs(current[SCRIPT_LOGS_KEY]);
  for (const raw of raws) {
    const log = normalizeScriptLog(raw);
    if (log) logs.push(log);
  }
  await storageSet({ [SCRIPT_LOGS_KEY]: logs.slice(-MAX_SCRIPT_LOGS) });
};

const handleScriptMessage = (data: Record<string, unknown>): void => {
  const type = data.type;
  const payload = data.payload;

  if (type === "status") {
    const status = normalizeScriptStatus(payload);
    if (!status) return;
    enqueueScript(async () => {
      await storageSet({ [SCRIPT_STATUS_KEY]: status });
      const p = payload as Record<string, unknown> | null;
      const extras: unknown[] = [];
      if (p && Array.isArray(p.logs)) extras.push(...p.logs);
      if (p && p.log) extras.push(p.log);
      if (extras.length) await appendLogs(extras);
    });
    return;
  }

  if (type === "log") {
    const log = normalizeScriptLog(payload);
    if (log) enqueueScript(() => appendLogs([log]));
    return;
  }

  if (type === "logs") {
    const raw = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).logs)
        ? ((payload as Record<string, unknown>).logs as unknown[])
        : [];
    if (raw.length) enqueueScript(() => appendLogs(raw));
  }
};

window.addEventListener("message", (e: MessageEvent): void => {
  if (e.source !== window) return;
  const data = e.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return;

  if (data.source === SCRIPT_SOURCE) {
    handleScriptMessage(data);
    return;
  }

  if (data.source === MAIN_SOURCE && data.type === "config-request") {
    push();
    return;
  }

  if (data.source === MAIN_SOURCE && data.type === "media-request") {
    const key = typeof data.key === "string" ? data.key : "";
    if (!isMediaKey(key)) return;
    void (async () => {
      try {
        const cachedUrl = mediaBlobUrls.get(key);
        if (cachedUrl) {
          window.postMessage({ source: BRIDGE_SOURCE, type: "media-url", key, url: cachedUrl }, "*");
          return;
        }
        const current = await storageGet(CUSTOM_CONFIG_KEY);
        const cfg = normalizeCustomConfig(current[CUSTOM_CONFIG_KEY]);
        const active = activeWallpaper(cfg);
        const raw = await storageGet(key);
        let media = typeof raw[key] === "string" ? String(raw[key]) : "";
        // 迁移期兼容：config 里可能还留着 data URL
        if (!media && active && active.mediaKey === key) media = active.image;
        if (!media) {
          window.postMessage({ source: BRIDGE_SOURCE, type: "media-missing", key }, "*");
          return;
        }
        // blob URL 同源可被 MAIN world fetch/使用；只传短 URL，不再复制 63MB 字符串
        const blob = await dataUrlToBlob(media);
        if (blob) {
          const url = URL.createObjectURL(blob);
          mediaBlobUrls.set(key, url);
          window.postMessage({ source: BRIDGE_SOURCE, type: "media-url", key, url }, "*");
          return;
        }
        window.postMessage({ source: BRIDGE_SOURCE, type: "media", key, data: media }, "*");
      } catch (e) {}
    })();
    return;
  }

  if (data.source === MAIN_SOURCE && data.type === "cycle-wallpaper") {
    void (async () => {
      const current = await storageGet(CUSTOM_CONFIG_KEY);
      const cfg = normalizeCustomConfig(current[CUSTOM_CONFIG_KEY]);
      const list = cfg.background.wallpapers;
      if (!cfg.background.enabled || list.length < 2) return;
      const idx = list.findIndex((w) => w.id === cfg.background.activeId);
      const next = list[(idx + 1 + list.length) % list.length];
      cfg.background.activeId = next.id;
      cfg.background.image = "";
      cfg.materialSeed = next.seed;
      await storageSet({ [CUSTOM_CONFIG_KEY]: cfg });
    })();
  }
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CUSTOM_CONFIG_KEY]) return;
    const cfg = normalizeCustomConfig(changes[CUSTOM_CONFIG_KEY].newValue);
    post(pageViewConfig(cfg));
    postCleanup(cfg);
  });
} catch (e) {}

push();
