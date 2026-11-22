import { CUSTOM_CONFIG_KEY, activeWallpaper, normalizeCustomConfig } from "../shared/custom";
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

const post = (config: unknown, media: Blob | null = null): void => {
  try {
    window.postMessage({ source: BRIDGE_SOURCE, type: "config", config, media }, "*");
  } catch (e) {}
};

// 页面只需要当前壁纸；不要把 5 张图全量 postMessage 过去
const pageView = (cfg: ReturnType<typeof normalizeCustomConfig>) => {
  const active = activeWallpaper(cfg);
  return {
    ...cfg,
    materialSeed: active?.seed || cfg.materialSeed,
    background: {
      ...cfg.background,
      image: active?.image || "",
      wallpapers: active ? [{ ...active }] : [],
    },
  };
};

const resolveActive = async (cfg: ReturnType<typeof normalizeCustomConfig>) => {
  const active = activeWallpaper(cfg);
  if (active && !active.image && active.mediaKey) {
    const data = await storageGet(active.mediaKey);
    active.image = typeof data[active.mediaKey] === "string" ? String(data[active.mediaKey]) : "";
  }
  return { cfg: pageView(cfg), media: null as Blob | null };
};

const push = (): void => {
  try {
    chrome.storage.local.get(CUSTOM_CONFIG_KEY, async (result) => {
      if (chrome.runtime?.lastError) return;
      const resolved = await resolveActive(normalizeCustomConfig(result?.[CUSTOM_CONFIG_KEY]));
      post(resolved.cfg, resolved.media);
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
    void resolveActive(normalizeCustomConfig(changes[CUSTOM_CONFIG_KEY].newValue)).then((r) => post(r.cfg, r.media));
  });
} catch (e) {}

push();
