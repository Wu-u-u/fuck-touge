/** 智慧树专用 popup：独立 DOM/CSS/存储，不加载任何头歌业务。 */
import {
  DEFAULT_ZHS_CONFIG,
  MAX_ZHS_LOGS,
  ZHS_CONFIG_KEY,
  ZHS_LOGS_KEY,
  ZHS_STATUS_KEY,
  ZHS_WATCH_KEY,
  formatZhsWatch,
  normalizeZhsConfig,
  normalizeZhsLogs,
  normalizeZhsStatus,
  normalizeZhsWatch,
  type ZhsConfig,
  type ZhsLog,
  type ZhsStatus,
} from "./types";

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const timeText = (at: number): string => {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const stateLabel: Record<string, string> = {
  idle: "未启动",
  waiting: "等待中",
  playing: "播放中",
  paused: "已暂停",
  quiz: "处理弹题",
  next: "切换下一集",
  done: "已完成",
  blocked: "等待验证",
  error: "出错",
};

let config: ZhsConfig = { ...DEFAULT_ZHS_CONFIG };
let status: ZhsStatus | null = null;
let logs: ZhsLog[] = [];
let watch = normalizeZhsWatch(null);

const enabled = $<HTMLInputElement>("enabled");
const speed = $<HTMLInputElement>("speed");
const autoNext = $<HTMLInputElement>("autoNext");
const reviewRow = $("reviewRow");
const reviewCompleted = $<HTMLInputElement>("reviewCompleted");
const quality = $<HTMLInputElement>("quality");
const statePill = $("statePill");
const statusTitle = $("statusTitle");
const statusMsg = $("statusMsg");
const logCount = $("logCount");
const logList = $("logList");
const watchTime = $("watchTime");

const save = (patch: Partial<ZhsConfig>): void => {
  config = normalizeZhsConfig({ ...config, ...patch });
  try {
    void chrome.storage.local.set({ [ZHS_CONFIG_KEY]: config });
  } catch (e) {}
  if (enabled) enabled.checked = config.enabled;
  if (speed) speed.checked = Math.abs(config.speed - 1.25) < 0.01;
  if (autoNext) autoNext.checked = config.autoNext;
  if (reviewRow) reviewRow.hidden = !config.autoNext;
  if (reviewCompleted) reviewCompleted.checked = config.reviewCompleted;
  if (quality) quality.checked = config.quality === "smooth";
  const mode = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${config.mode}"]`);
  if (mode) mode.checked = true;
};

const renderStatus = (): void => {
  const state = status?.state || "idle";
  if (statePill) {
    statePill.dataset.state = state;
    statePill.textContent = stateLabel[state] || state;
  }
  if (statusTitle) statusTitle.textContent = stateLabel[state] || "未启动";
  if (statusMsg) {
    const context = status?.chapter ? `${status.chapter} · ` : "";
    statusMsg.textContent = status?.message ? `${context}${status.message}` : "打开智慧树视频页后启动";
  }
};

const renderLogs = (): void => {
  if (!logList) return;
  logs = normalizeZhsLogs(logs);
  if (logCount) logCount.textContent = String(logs.length);
  logList.textContent = "";
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无日志";
    logList.appendChild(empty);
    return;
  }
  for (const log of logs.slice(-MAX_ZHS_LOGS)) {
    const row = document.createElement("div");
    row.className = "log-item";
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = timeText(log.at);
    const level = document.createElement("span");
    const lv = log.level.toLowerCase();
    level.className = "log-level" + (lv.includes("err") ? " error" : lv.includes("warn") ? " warn" : "");
    level.textContent = log.level;
    const body = document.createElement("span");
    body.className = "log-text";
    body.textContent = log.text;
    row.append(time, level, body);
    logList.appendChild(row);
  }
  logList.scrollTop = logList.scrollHeight;
};

const render = (): void => {
  if (enabled) enabled.checked = config.enabled;
  if (speed) speed.checked = Math.abs(config.speed - 1.25) < 0.01;
  if (autoNext) autoNext.checked = config.autoNext;
  if (reviewRow) reviewRow.hidden = !config.autoNext;
  if (reviewCompleted) reviewCompleted.checked = config.reviewCompleted;
  if (quality) quality.checked = config.quality === "smooth";
  const mode = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${config.mode}"]`);
  if (mode) mode.checked = true;
  renderStatus();
  if (watchTime) watchTime.textContent = formatZhsWatch(watch.seconds);
  renderLogs();
};

enabled?.addEventListener("change", () => save({ enabled: !!enabled.checked }));
speed?.addEventListener("change", () => save({ speed: speed.checked ? 1.25 : 1 }));
autoNext?.addEventListener("change", () => {
  save({ autoNext: !!autoNext.checked });
  if (reviewRow) reviewRow.hidden = !autoNext.checked;
});
reviewCompleted?.addEventListener("change", () => save({ reviewCompleted: !!reviewCompleted.checked }));
quality?.addEventListener("change", () => save({ quality: quality.checked ? "smooth" : "auto" }));
document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked && (radio.value === "correct" || radio.value === "quick")) save({ mode: radio.value });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[ZHS_CONFIG_KEY]) config = normalizeZhsConfig(changes[ZHS_CONFIG_KEY].newValue);
  if (changes[ZHS_STATUS_KEY]) status = normalizeZhsStatus(changes[ZHS_STATUS_KEY].newValue);
  if (changes[ZHS_LOGS_KEY]) logs = normalizeZhsLogs(changes[ZHS_LOGS_KEY].newValue);
  if (changes[ZHS_WATCH_KEY]) watch = normalizeZhsWatch(changes[ZHS_WATCH_KEY].newValue);
  render();
});

try {
  chrome.storage.local.get([ZHS_CONFIG_KEY, ZHS_STATUS_KEY, ZHS_LOGS_KEY, ZHS_WATCH_KEY], (result) => {
    config = normalizeZhsConfig(result?.[ZHS_CONFIG_KEY]);
    status = normalizeZhsStatus(result?.[ZHS_STATUS_KEY]);
    logs = normalizeZhsLogs(result?.[ZHS_LOGS_KEY]);
    watch = normalizeZhsWatch(result?.[ZHS_WATCH_KEY]);
    render();
  });
} catch (e) {
  render();
}
