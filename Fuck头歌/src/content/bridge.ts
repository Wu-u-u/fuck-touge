import { CUSTOM_CONFIG_KEY, activeWallpaper, isMediaKey, normalizeCustomConfig } from "../shared/custom";
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

const post = (config: unknown): void => {
  try {
    window.postMessage({ source: BRIDGE_SOURCE, type: "config", config }, "*");
  } catch (e) {}
};

// 页面只需要当前壁纸；有 mediaKey 时只传 key，页面自己从 IDB 取媒体，
// 避免每次切换都复制几十 MB 的 data URL。
const pageView = (cfg: ReturnType<typeof normalizeCustomConfig>) => {
  const active = activeWallpaper(cfg);
  const view = active
    ? { ...active, image: active.mediaKey ? "" : active.image }
    : null;
  return {
    ...cfg,
    materialSeed: active?.seed || cfg.materialSeed,
    background: {
      ...cfg.background,
      image: view?.image || "",
      wallpapers: view ? [view] : [],
    },
  };
};

const push = (): void => {
  try {
    chrome.storage.local.get(CUSTOM_CONFIG_KEY, (result) => {
      if (chrome.runtime?.lastError) return;
      post(pageView(normalizeCustomConfig(result?.[CUSTOM_CONFIG_KEY])));
    });
  } catch (e) {
    post(pageView(normalizeCustomConfig(null)));
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
        const current = await storageGet(CUSTOM_CONFIG_KEY);
        const cfg = normalizeCustomConfig(current[CUSTOM_CONFIG_KEY]);
        const active = activeWallpaper(cfg);
        const raw = await storageGet(key);
        let media = typeof raw[key] === "string" ? String(raw[key]) : "";
        // 迁移期兼容：config 里可能还留着 data URL
        if (!media && active && active.mediaKey === key) media = active.image;
        window.postMessage(
          media
            ? { source: BRIDGE_SOURCE, type: "media", key, data: media }
            : { source: BRIDGE_SOURCE, type: "media-missing", key },
          "*",
        );
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
    post(pageView(normalizeCustomConfig(changes[CUSTOM_CONFIG_KEY].newValue)));
  });
} catch (e) {}

push();
