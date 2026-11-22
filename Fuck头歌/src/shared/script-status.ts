/** 答题脚本状态 / 日志的共享契约与收敛函数（popup / bridge 共用）。 */

export const SCRIPT_STATUS_KEY = "fuckTougeScriptStatus";
export const SCRIPT_LOGS_KEY = "fuckTougeScriptLogs";
export const SCRIPT_SOURCE = "fuck-touge-script";
export const SCRIPT_STALE_MS = 10_310;
export const MAX_SCRIPT_LOGS = 25;

export type ScriptState = "running" | "waiting" | "stopped" | "error";

export interface ScriptStatus {
  version: 1;
  updatedAt: number;
  state: ScriptState;
  slot: string;
  course: string;
  chapter: string;
  level: string;
  message: string;
}

export interface ScriptLogEntry {
  at: number;
  level: string;
  slot: string;
  course: string;
  chapter: string;
  levelName: string;
  text: string;
}

const STATES: ScriptState[] = ["running", "waiting", "stopped", "error"];

const text = (value: unknown, max: number): string => {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};

const time = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Date.now();

export function normalizeScriptStatus(raw: unknown): ScriptStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const state = STATES.includes(o.state as ScriptState) ? (o.state as ScriptState) : null;
  if (!state) return null;
  return {
    version: 1,
    updatedAt: time(o.updatedAt),
    state,
    slot: text(o.slot, 16),
    course: text(o.course, 80),
    chapter: text(o.chapter, 80),
    level: text(o.level, 40),
    message: text(o.message, 200),
  };
}

export function normalizeScriptLog(raw: unknown): ScriptLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const body = text(o.text, 300);
  if (!body) return null;
  return {
    at: time(o.at),
    level: text(o.level, 12) || "info",
    slot: text(o.slot, 16),
    course: text(o.course, 80),
    chapter: text(o.chapter, 80),
    levelName: text(o.levelName, 40),
    text: body,
  };
}

export function normalizeScriptLogs(raw: unknown): ScriptLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptLogEntry[] = [];
  for (const item of raw) {
    const log = normalizeScriptLog(item);
    if (log) out.push(log);
  }
  return out
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_SCRIPT_LOGS);
}

const logKey = (log: ScriptLogEntry): string =>
  `${log.at}|${log.level}|${log.slot}|${log.course}|${log.chapter}|${log.levelName}|${log.text}`;

/**
 * 合并日志并去重：脚本可能把同一批 logs 随每次 heartbeat 重发，
 * 相同时间戳/级别/上下文的条目只保留一条，避免 25 条额度被重复日志占满。
 */
export function mergeScriptLogs(
  current: ScriptLogEntry[],
  incoming: ScriptLogEntry[],
  max = MAX_SCRIPT_LOGS,
): ScriptLogEntry[] {
  const merged: ScriptLogEntry[] = [];
  const seen = new Set<string>();
  for (const log of [...current, ...incoming]) {
    const key = logKey(log);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(log);
  }
  merged.sort((a, b) => a.at - b.at);
  return merged.slice(-max);
}

/** 非 stopped 的状态超过 10.31s 没心跳 → 视为脚本没在跑 */
export const scriptStatusIsStale = (status: ScriptStatus, now = Date.now()): boolean =>
  status.state !== "stopped" && now - status.updatedAt > SCRIPT_STALE_MS;
