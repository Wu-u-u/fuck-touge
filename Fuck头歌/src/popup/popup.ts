import { CUSTOM_CONFIG_KEY, activeWallpaper, normalizeCustomConfig } from "../shared/custom";
import { deleteEditorPath, setEditorPath } from "../shared/editor-options";
import { applyMaterialPalette, clearMaterialPalette } from "../shared/material-theme";
import {
  MAX_SCRIPT_LOGS,
  SCRIPT_LOGS_KEY,
  SCRIPT_STATUS_KEY,
  normalizeScriptLogs,
  normalizeScriptStatus,
  scriptStatusIsStale,
  type ScriptLogEntry,
  type ScriptStatus,
} from "../shared/script-status";
import type { PublicSettings } from "../shared/types";

/** 最小 Chrome API 面（便于单测注入；真实弹窗用全局 chrome） */
export interface PopupChromeApi {
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<
      Array<{ id?: number; url?: string }>
    >;
  };
  scripting: {
    executeScript<T = unknown>(injection: {
      target: { tabId: number };
      world: "MAIN";
      func: (...args: any[]) => T;
      args: any[];
    }): Promise<Array<{ result?: T }>>;
  };
  storage?: {
    local: {
      get(keys: string | string[], callback: (items: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
      remove(keys: string | string[], callback?: () => void): void;
    };
    onChanged?: {
      addListener(
        callback: (
          changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
          area: string,
        ) => void,
      ): void;
    };
  };
}

const LABELS: Record<string, string> = { catppuccin: "Catppuccin", github: "GitHub 高对比" };

const isEducoder = (url?: string): boolean =>
  /^https?:\/\/([^/]*\.)?educoder\.net\//.test(url || "");

export function initPopup(chromeApi: PopupChromeApi, doc: Document = document): void {
  const tt = doc.getElementById("tt") as HTMLInputElement;
  const tf = doc.getElementById("tf") as HTMLInputElement;
  const tc = doc.getElementById("tc") as HTMLInputElement;
  const themeSub = doc.getElementById("themeSub") as HTMLElement;
  const themePick = doc.getElementById("themePick") as HTMLElement;
  const opts = [...themePick.querySelectorAll<HTMLElement>(".opt")];
  const msg = doc.getElementById("msg") as HTMLElement;
  const tb = doc.getElementById("tb") as HTMLInputElement | null;
  const bgPick = doc.getElementById("bgPick") as HTMLElement | null;
  const ts = doc.getElementById("ts") as HTMLInputElement | null;
  const tw = doc.getElementById("tw") as HTMLInputElement | null;
  const scriptCard = doc.getElementById("scriptCard") as HTMLElement | null;
  const scriptTitle = doc.getElementById("scriptTitle") as HTMLElement | null;
  const scriptSlot = doc.getElementById("scriptSlot") as HTMLElement | null;
  const scriptMeta = doc.getElementById("scriptMeta") as HTMLElement | null;
  const scriptMsg = doc.getElementById("scriptMsg") as HTMLElement | null;
  const logCount = doc.getElementById("logCount") as HTMLElement | null;
  const logList = doc.getElementById("logList") as HTMLElement | null;
  const copyLogsBtn = doc.getElementById("copyLogs") as HTMLButtonElement | null;
  const clearLogsBtn = doc.getElementById("clearLogs") as HTMLButtonElement | null;

  const setMsg = (text: string, warn = false): void => {
    msg.textContent = text;
    msg.className = warn ? "desc warn" : "desc";
  };

  /* 背景/编辑器开关独立于页面：不依赖当前标签页是否头歌，也不走 __fuckTougeUI */
  const customStorage = chromeApi.storage?.local;
  let customCfg = normalizeCustomConfig(null);

  const renderCustom = (): void => {
    if (tb) tb.checked = customCfg.background.enabled;
    if (bgPick) {
      bgPick.hidden = !customCfg.background.enabled;
      bgPick.textContent = customCfg.background.wallpapers.length ? "更换背景图 →" : "选择背景图 →";
    }
    if (ts) ts.checked = customCfg.editor.smoothScrolling === true;
    if (tw) tw.checked = customCfg.editor.mouseWheelZoom === true;
  };

  const writeCustom = (): void => {
    try {
      customStorage?.set({ [CUSTOM_CONFIG_KEY]: customCfg });
    } catch (e) {}
  };

  const applyMaterial = (): void => {
    const seed = activeWallpaper(customCfg)?.seed || customCfg.materialSeed;
    if (customCfg.materialYou && seed) {
      applyMaterialPalette(document.documentElement, seed);
    } else {
      clearMaterialPalette(document.documentElement);
    }
  };

  const readCustom = (): void => {
    if (!customStorage) return;
    try {
      customStorage.get(CUSTOM_CONFIG_KEY, (items) => {
        customCfg = normalizeCustomConfig(items?.[CUSTOM_CONFIG_KEY]);
        renderCustom();
        applyMaterial();
      });
    } catch (e) {}
  };

  if (!customStorage) {
    for (const input of [tb, ts, tw]) {
      if (input) input.disabled = true;
    }
    if (bgPick) bgPick.hidden = true;
  } else {
    tb?.addEventListener("change", () => {
      customCfg.background.enabled = !!tb.checked;
      renderCustom();
      writeCustom();
    });
    ts?.addEventListener("change", () => {
      if (ts.checked) setEditorPath(customCfg.editor, "smoothScrolling", true);
      else deleteEditorPath(customCfg.editor, "smoothScrolling");
      renderCustom();
      writeCustom();
    });
    tw?.addEventListener("change", () => {
      if (tw.checked) setEditorPath(customCfg.editor, "mouseWheelZoom", true);
      else deleteEditorPath(customCfg.editor, "mouseWheelZoom");
      renderCustom();
      writeCustom();
    });
    readCustom();
    chromeApi.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes[CUSTOM_CONFIG_KEY]) readCustom();
    });
  }

  /* 答题脚本状态 / 日志：只展示当前槽位，不提供启动/停止控制 */
  const scriptStorage = chromeApi.storage?.local;
  let scriptStatus: ScriptStatus | null = null;
  let scriptLogs: ScriptLogEntry[] = [];
  let statusTimer = 0;

  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const clockText = (at: number): string => {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return "--:--:--";
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  const fullTimeText = (at: number): string => {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return "--";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockText(at)}`;
  };
  const agoText = (at: number): string => {
    const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 2) return "刚刚";
    if (sec < 60) return `${sec} 秒前`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
    if (sec < 86_400) return `${Math.floor(sec / 3600)} 小时前`;
    return `${Math.floor(sec / 86_400)} 天前`;
  };

  const renderScriptStatus = (): void => {
    if (!scriptCard) return;
    const status = scriptStatus;
    const now = Date.now();
    let tone: "green" | "yellow" | "red" = "red";
    let title = "刷题脚本未执行";
    let slot = "槽位 --";
    let meta = "启动答题脚本后这里会显示状态";
    let message = "";

    if (status) {
      slot = `槽位 ${status.slot || "--"}`;
      const context = [status.course, status.chapter, status.level].filter(Boolean).join(" · ");
      const stale = scriptStatusIsStale(status, now);

      if (stale) {
        title = "刷题脚本未执行";
        meta = `最后心跳 ${agoText(status.updatedAt)}`;
        message = "超过 10.31 秒没有收到心跳";
      } else if (status.state === "running") {
        tone = "green";
        title = "运行中";
        meta = context || `最后心跳 ${agoText(status.updatedAt)}`;
        message = status.message;
      } else if (status.state === "waiting") {
        tone = "yellow";
        title = "等待中";
        meta = context || `最后心跳 ${agoText(status.updatedAt)}`;
        message = status.message;
      } else if (status.state === "stopped") {
        tone = "yellow";
        title = "已停止";
        meta = context || `最后更新 ${agoText(status.updatedAt)}`;
        message = status.message;
      } else {
        tone = "red";
        title = "脚本错误";
        meta = context || `最后更新 ${agoText(status.updatedAt)}`;
        message = status.message || "脚本报告错误";
      }
    }

    scriptCard.dataset.state = tone;
    if (scriptTitle) scriptTitle.textContent = title;
    if (scriptSlot) scriptSlot.textContent = slot;
    if (scriptMeta) {
      scriptMeta.textContent = meta;
      scriptMeta.title = meta;
    }
    if (scriptMsg) {
      scriptMsg.textContent = message;
      scriptMsg.title = message;
    }
  };

  let logsRendered = false;
  let lastLogsKey: string | null = null;
  // 契约：只显示当前状态对应槽位的日志；旧格式没有 slot 的条目保留
  const currentSlotLogs = (): ScriptLogEntry[] => {
    const slot = scriptStatus?.slot || "";
    if (!slot) return scriptLogs;
    return scriptLogs.filter((log) => !log.slot || log.slot === slot);
  };
  const renderScriptLogs = (): void => {
    if (!logList) return;
    scriptLogs = normalizeScriptLogs(scriptLogs);
    const logs = currentSlotLogs();
    // 心跳每秒刷新 status，但日志没变时不要重建 25 个 DOM 节点
    const key = logs.map((log) => `${log.at}|${log.level}|${log.slot}|${log.levelName}|${log.text}`).join("\n");
    if (lastLogsKey === key) return;
    lastLogsKey = key;
    const stickToBottom = !logsRendered
      || logList.scrollHeight - logList.scrollTop - logList.clientHeight < 24;
    logsRendered = true;
    logList.textContent = "";
    if (logCount) {
      logCount.textContent = String(logs.length);
      logCount.title = `最多保留 ${MAX_SCRIPT_LOGS} 条（当前槽位）`;
    }
    const empty = !logs.length;
    if (copyLogsBtn) copyLogsBtn.disabled = empty;
    if (clearLogsBtn) clearLogsBtn.disabled = empty;

    if (empty) {
      const row = doc.createElement("div");
      row.className = "log-empty";
      row.textContent = "暂无日志";
      logList.appendChild(row);
      return;
    }

    for (const log of logs) {
      const row = doc.createElement("div");
      row.className = "log-item";
      row.title = [log.course, log.chapter, log.levelName].filter(Boolean).join(" · ");

      const time = doc.createElement("span");
      time.className = "log-time";
      time.textContent = clockText(log.at);

      const level = doc.createElement("span");
      const lv = (log.level || "info").toLowerCase();
      level.className = "log-level" + (lv.includes("err") ? " error" : lv.includes("warn") ? " warn" : "");
      level.textContent = log.level || "info";

      const body = doc.createElement("span");
      body.className = "log-text";
      body.textContent = log.levelName ? `${log.levelName} · ${log.text}` : log.text;

      row.append(time, level, body);
      logList.appendChild(row);
    }
    if (stickToBottom) logList.scrollTop = logList.scrollHeight;
  };

  const copyLogText = (): string =>
    currentSlotLogs()
      .map((log) => {
        const ctx = [log.course, log.chapter, log.levelName].filter(Boolean).join(" / ");
        return `[${fullTimeText(log.at)}] [${log.level}] [槽${log.slot || "--"}]${ctx ? ` ${ctx}` : ""} ${log.text}`;
      })
      .join("\n");

  const flashCopy = (ok: boolean): void => {
    if (!copyLogsBtn) return;
    const old = "复制";
    copyLogsBtn.textContent = ok ? "已复制" : "复制失败";
    window.setTimeout(() => {
      if (copyLogsBtn) copyLogsBtn.textContent = old;
    }, 1200);
  };

  const fallbackCopy = (text: string): boolean => {
    try {
      const ta = doc.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  };

  const readScriptState = (): void => {
    if (!scriptStorage) {
      renderScriptStatus();
      renderScriptLogs();
      return;
    }
    try {
      scriptStorage.get([SCRIPT_STATUS_KEY, SCRIPT_LOGS_KEY], (items) => {
        scriptStatus = normalizeScriptStatus(items?.[SCRIPT_STATUS_KEY]);
        scriptLogs = normalizeScriptLogs(items?.[SCRIPT_LOGS_KEY]);
        renderScriptStatus();
        renderScriptLogs();
      });
    } catch (e) {
      renderScriptStatus();
      renderScriptLogs();
    }
  };

  copyLogsBtn?.addEventListener("click", () => {
    if (!currentSlotLogs().length) return;
    const text = copyLogText();
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => flashCopy(true),
          () => flashCopy(fallbackCopy(text)),
        );
      } else {
        flashCopy(fallbackCopy(text));
      }
    } catch (e) {
      flashCopy(fallbackCopy(text));
    }
  });

  clearLogsBtn?.addEventListener("click", () => {
    scriptLogs = [];
    renderScriptLogs();
    try {
      scriptStorage?.remove(SCRIPT_LOGS_KEY);
    } catch (e) {}
  });

  if (scriptCard) {
    readScriptState();
    try {
      chromeApi.storage?.onChanged?.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[SCRIPT_STATUS_KEY]) {
          scriptStatus = normalizeScriptStatus(changes[SCRIPT_STATUS_KEY].newValue);
          renderScriptStatus();
          renderScriptLogs();
        }
        if (changes[SCRIPT_LOGS_KEY]) {
          scriptLogs = normalizeScriptLogs(changes[SCRIPT_LOGS_KEY].newValue);
          renderScriptLogs();
        }
      });
    } catch (e) {}
    statusTimer = window.setInterval(() => {
      if (scriptStatus) renderScriptStatus();
    }, 1000);
    window.addEventListener("unload", () => {
      if (statusTimer) clearInterval(statusTimer);
    });
  }

  async function withPage<T>(
    func: (...args: any[]) => T,
    args: any[] = [],
  ): Promise<{ ok: boolean; value?: T }> {
    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isEducoder(tab.url) || tab.id == null) return { ok: false };
    try {
      const [res] = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func,
        args,
      });
      return { ok: true, value: res ? res.result : undefined };
    } catch (e) {
      return { ok: false };
    }
  }

  (async () => {
    const st = await withPage(() => (window.__fuckTougeUI ? window.__fuckTougeUI.get() : null));
    if (!st.ok) {
      tt.disabled = tf.disabled = tc.disabled = true;
      setMsg("当前页面不是头歌页面 🤔", true);
      return;
    }
    const initial = st.value;
    if (!initial) {
      tt.disabled = tf.disabled = tc.disabled = true;
      setMsg("页面未就绪或脚本未注入，刷新页面后重试 🔄", true);
      return;
    }

    let picked = "catppuccin";
    const render = (s: PublicSettings): void => {
      tt.checked = !!s.theme;
      tf.checked = !!s.font;
      tc.checked = !!s.cursor;
      picked = LABELS[s.themeName] ? s.themeName : "catppuccin";
      themeSub.textContent = LABELS[picked] + " · 深浅自动";
      themePick.hidden = !tt.checked;
      opts.forEach((b) => {
        const on = b.dataset.name === picked;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on)); // 主题选项是“按下”式切换按钮，状态同步给读屏
      });
    };
    render(initial);
    setMsg("修改即时生效 ✨");

    // 连点竞态：tabs.query / executeScript 的完成顺序不保证，旧请求的响应可能后到，
    // 把新请求刚渲染的状态又盖回去 —— 给每次请求发一个单调递增序号，
    // 响应回来时限次不同（已有更新操作存在）→ 过期响应整条丢弃：不渲染、不再提示。
    // 同时只推本次变化的字段：页面端 __fuckTougeUI.set 支持局部更新，全量快照反而放大竞态窗口。
    let seq = 0;
    const push = async (patch: Partial<PublicSettings>): Promise<void> => {
      const my = ++seq;
      const r = await withPage(
        (n: Partial<PublicSettings>) => window.__fuckTougeUI && window.__fuckTougeUI.set(n),
        [patch],
      );
      if (my !== seq) return;
      if (r.ok && r.value) {
        render(r.value);
        setMsg("修改即时生效 ✨");
      } else {
        setMsg("页面已刷新或不是头歌页面，请重试 🔄", true);
      }
    };

    tt.addEventListener("change", () => push({ theme: tt.checked }));
    tf.addEventListener("change", () => push({ font: tf.checked }));
    tc.addEventListener("change", () => push({ cursor: tc.checked }));
    opts.forEach((b) =>
      b.addEventListener("click", () =>
        push({ themeName: b.dataset.name as PublicSettings["themeName"] }),
      ),
    );
  })();
}

// 真实弹窗环境自动初始化；单测（jsdom，无 chrome）只导入 initPopup
if (typeof chrome !== "undefined" && typeof document !== "undefined") {
  initPopup(chrome as unknown as PopupChromeApi);
}
