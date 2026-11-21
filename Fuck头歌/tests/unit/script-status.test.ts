import { describe, expect, it } from "vitest";
import {
  MAX_SCRIPT_LOGS,
  normalizeScriptLog,
  normalizeScriptLogs,
  normalizeScriptStatus,
  scriptStatusIsStale,
} from "../../src/shared/script-status";

describe("script status normalization", () => {
  it("只接受合法 state，补齐时间/字段", () => {
    expect(normalizeScriptStatus({ state: "wat" })).toBeNull();
    const s = normalizeScriptStatus({
      state: "running",
      slot: 15,
      course: " 课程 ",
      chapter: "章节",
      level: "第3关",
      message: "写代码",
    });
    expect(s).toMatchObject({
      version: 1,
      state: "running",
      slot: "15",
      course: "课程",
      chapter: "章节",
      level: "第3关",
      message: "写代码",
    });
    expect(s!.updatedAt).toBeGreaterThan(0);
  });

  it("日志最多保留 25 条，空文本丢弃", () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      at: 1000 + i,
      level: "info",
      text: `log-${i}`,
    }));
    raw.push({ at: 1, level: "info", text: "" });
    const logs = normalizeScriptLogs(raw);
    expect(logs).toHaveLength(MAX_SCRIPT_LOGS);
    expect(logs[0].text).toBe("log-5");
    expect(logs[logs.length - 1].text).toBe("log-29");
    expect(normalizeScriptLog({ text: "" })).toBeNull();
  });

  it("10.31s 心跳阈值：stopped 永不过期", () => {
    const now = 1_000_000;
    expect(scriptStatusIsStale({ version: 1, updatedAt: now - 10_310, state: "running", slot: "", course: "", chapter: "", level: "", message: "" }, now)).toBe(false);
    expect(scriptStatusIsStale({ version: 1, updatedAt: now - 10_311, state: "waiting", slot: "", course: "", chapter: "", level: "", message: "" }, now)).toBe(true);
    expect(scriptStatusIsStale({ version: 1, updatedAt: now - 999_999, state: "stopped", slot: "", course: "", chapter: "", level: "", message: "" }, now)).toBe(false);
  });
});
