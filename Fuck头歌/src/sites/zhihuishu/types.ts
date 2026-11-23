/** 智慧树站点的配置、状态与纯逻辑；不依赖任何 educoder 模块。 */

export const ZHS_CONFIG_KEY = "fuckTougeZhsConfig";
export const ZHS_STATUS_KEY = "fuckTougeZhsStatus";
export const ZHS_LOGS_KEY = "fuckTougeZhsLogs";
export const ZHS_WATCH_KEY = "fuckTougeZhsWatch";
export const MAX_ZHS_LOGS = 25;

export type ZhsMode = "correct" | "quick";
export type ZhsQuality = "smooth" | "auto";
export type ZhsState = "idle" | "waiting" | "playing" | "paused" | "quiz" | "next" | "done" | "blocked" | "error";

export interface ZhsConfig {
  enabled: boolean;
  mode: ZhsMode;
  speed: number;
  autoNext: boolean;
  reviewCompleted: boolean;
  quality: ZhsQuality;
}

export const DEFAULT_ZHS_CONFIG: ZhsConfig = {
  enabled: false,
  mode: "quick",
  speed: 1.25,
  autoNext: true,
  reviewCompleted: false,
  quality: "smooth",
};

export interface ZhsStatus {
  updatedAt: number;
  state: ZhsState;
  chapter: string;
  message: string;
}

export interface ZhsLog {
  at: number;
  level: string;
  text: string;
}

export interface ZhsWatch {
  date: string;
  seconds: number;
}

const STATES: ZhsState[] = [
  "idle", "waiting", "playing", "paused", "quiz", "next", "done", "blocked", "error",
];

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function normalizeZhsConfig(raw: unknown): ZhsConfig {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode: ZhsMode = o.mode === "correct" ? "correct" : "quick";
  const quality: ZhsQuality = o.quality === "auto" ? "auto" : "smooth";
  const speed = finite(o.speed) ? Math.min(2, Math.max(0.5, o.speed)) : DEFAULT_ZHS_CONFIG.speed;
  return {
    enabled: o.enabled === true,
    mode,
    speed,
    autoNext: o.autoNext !== false,
    reviewCompleted: o.reviewCompleted === true,
    quality,
  };
}

export function normalizeZhsStatus(raw: unknown): ZhsStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const state = STATES.includes(o.state as ZhsState) ? o.state as ZhsState : "idle";
  const text = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  return {
    updatedAt: finite(o.updatedAt) && o.updatedAt > 0 ? o.updatedAt : Date.now(),
    state,
    chapter: text(o.chapter, 120),
    message: text(o.message, 300),
  };
}

export function normalizeZhsLog(raw: unknown): ZhsLog | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim().slice(0, 300) : "";
  if (!text) return null;
  return {
    at: finite(o.at) && o.at > 0 ? o.at : Date.now(),
    level: typeof o.level === "string" && o.level.trim() ? o.level.trim().slice(0, 12) : "info",
    text,
  };
}

export function normalizeZhsLogs(raw: unknown): ZhsLog[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeZhsLog)
    .filter((x): x is ZhsLog => !!x)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_ZHS_LOGS);
}

export function mergeZhsLogs(current: ZhsLog[], incoming: ZhsLog[], max = MAX_ZHS_LOGS): ZhsLog[] {
  const seen = new Set<string>();
  const all: ZhsLog[] = [];
  for (const log of [...current, ...incoming]) {
    const key = `${log.at}|${log.level}|${log.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(log);
  }
  all.sort((a, b) => a.at - b.at);
  return all.slice(-max);
}

/** 从弹题文本里解析“正确答案：ABC” / “正确答案：对”。 */
export function parseCorrectAnswer(text: string): string[] {
  const match = String(text || "").match(/正确答案\s*[：:]\s*([A-Ha-h]{1,8}|对|错|正确|错误)/);
  if (!match) return [];
  const raw = match[1];
  if (/^[A-Ha-h]+$/.test(raw)) {
    return [...new Set(raw.toUpperCase().split(""))].sort();
  }
  return [raw.includes("错") ? "错" : "对"];
}

/** 把答案字母/对错映射到选项下标；无法可靠映射时返回空数组。 */
export function answerOptionIndexes(answer: string[], options: string[]): number[] {
  if (!answer.length || !options.length) return [];
  if (answer[0] === "对" || answer[0] === "错") {
    const want = answer[0] === "对" ? ["对", "正确", "是"] : ["错", "错误", "否"];
    const index = options.findIndex((option) => want.some((word) => option.includes(word)));
    return index >= 0 ? [index] : [];
  }
  const indexes = answer
    .map((letter) => letter.toUpperCase().charCodeAt(0) - 65)
    .filter((index) => index >= 0 && index < options.length);
  return [...new Set(indexes)].sort((a, b) => a - b);
}

/** ended、右侧完成标记、进度条三选一即可认为本节完成。 */
export function isCompletedState(input: {
  ended?: boolean;
  completed?: boolean;
  progress?: number;
}): boolean {
  return input.ended === true
    || input.completed === true
    || (typeof input.progress === "number" && input.progress >= 0.995);
}

/** “未完成/未学完”不能当成已完成。 */
export function textIndicatesCompleted(text: string): boolean {
  return /完成|学完/.test(text) && !/未完成|未学完/.test(text);
}

const dayKey = (at = Date.now()): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function normalizeZhsWatch(raw: unknown, now = Date.now()): ZhsWatch {
  const date = dayKey(now);
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const seconds = typeof o.seconds === "number" && Number.isFinite(o.seconds) && o.seconds > 0
    ? Math.floor(o.seconds)
    : 0;
  return { date, seconds: o.date === date ? seconds : 0 };
}

export function addZhsWatch(raw: unknown, delta: number, now = Date.now()): ZhsWatch {
  const current = normalizeZhsWatch(raw, now);
  if (!Number.isFinite(delta) || delta <= 0) return current;
  return { date: current.date, seconds: Math.floor(current.seconds + Math.min(delta, 10)) };
}

export function formatZhsWatch(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function isZhsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return parsed.hostname === "zhihuishu.com" || parsed.hostname.endsWith(".zhihuishu.com");
  } catch (e) {
    return false;
  }
}
