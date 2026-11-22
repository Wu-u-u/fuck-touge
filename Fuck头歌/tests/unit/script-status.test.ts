import { describe, expect, it } from "vitest";
import {
  MAX_SCRIPT_LOGS,
  filterClearedScriptLogs,
  normalizeScriptLogClearMap,
  markScriptLogsCleared,
  mergeScriptLogs,
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

  it("乱序日志按 at 升序归一化/合并", () => {
    const raw = [
      normalizeScriptLog({ at: 3000, level: "info", text: "c" })!,
      normalizeScriptLog({ at: 1000, level: "info", text: "a" })!,
      normalizeScriptLog({ at: 2000, level: "info", text: "b" })!,
    ];
    expect(normalizeScriptLogs(raw).map((x) => x.text)).toEqual(["a", "b", "c"]);
    expect(mergeScriptLogs([raw[0], raw[2]], [raw[1]]).map((x) => x.text)).toEqual(["a", "b", "c"]);
  });

  it("日志合并按 时间/级别/槽位/上下文/文本 去重，并保留上限", () => {
    const log = (at: number, text: string) => normalizeScriptLog({ at, level: "info", slot: "1", text })!;
    const first = log(1000, "评测成功");
    const second = log(2000, "进入下一关");
    expect(mergeScriptLogs([first, second], [log(1000, "评测成功"), log(3000, "新日志")])).toHaveLength(3);
    // 已有重复也会收敛
    expect(mergeScriptLogs([first, first, second], [])).toHaveLength(2);
    // 同一文本但时间不同 → 是两条
    expect(mergeScriptLogs([first], [log(1001, "评测成功")])).toHaveLength(2);
    const many = Array.from({ length: 24 }, (_, i) => log(10_000 + i, `old-${i}`));
    const merged = mergeScriptLogs(many, [log(20_001, "a"), log(20_002, "b"), log(20_003, "c")]);
    expect(merged).toHaveLength(MAX_SCRIPT_LOGS);
    expect(merged[merged.length - 1].text).toBe("c");
  });

  it("清空标记按槽位过滤 <= clearedAt 的旧日志", () => {
    const base = Date.now();
    const log = (at: number, slot: string, text: string) => normalizeScriptLog({ at, slot, level: "info", text })!;
    const logs = [log(base - 3000, "1", "old1"), log(base - 500, "1", "new1"), log(base - 2000, "2", "other2")];
    const map = markScriptLogsCleared({}, "1", base - 1000);
    expect(filterClearedScriptLogs(logs, map).map((x) => x.text)).toEqual(["new1", "other2"]);
    expect(map["1"]).toBe(base - 1000);
  });

  it("清空 marker 30 天过期、最多保留 64 个槽位", () => {
    const now = 100 * 24 * 3600 * 1000;
    const day = 24 * 3600 * 1000;
    const map = normalizeScriptLogClearMap({ old: now - 31 * day, fresh: now - day }, now);
    expect(map).toEqual({ fresh: now - day });

    const many: Record<string, number> = {};
    for (let i = 0; i < 70; i++) many[`slot-${i}`] = now - i;
    const capped = normalizeScriptLogClearMap(many, now);
    expect(Object.keys(capped)).toHaveLength(64);
    expect(capped["slot-0"]).toBe(now);
    expect(capped["slot-69"]).toBeUndefined();
  });

  it("10.31s 心跳阈值：stopped 永不过期", () => {
    const now = 1_000_000;
    expect(scriptStatusIsStale({ version: 1, updatedAt: now - 10_310, state: "running", slot: "", course: "", chapter: "", level: "", message: "" }, now)).toBe(false);
    expect(scriptStatusIsStale({ version: 1, updatedAt: now - 10_311, state: "waiting", slot: "", course: "", chapter: "", level: "", message: "" }, now)).toBe(true);
    expect(scriptStatusIsStale({ version: 1, updatedAt: now - 999_999, state: "stopped", slot: "", course: "", chapter: "", level: "", message: "" }, now)).toBe(false);
  });
});
