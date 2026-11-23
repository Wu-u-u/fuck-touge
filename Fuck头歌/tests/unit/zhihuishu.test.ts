import { describe, expect, it } from "vitest";
import {
  MAX_ZHS_LOGS,
  answerOptionIndexes,
  isCompletedState,
  isZhsUrl,
  textIndicatesCompleted,
  mergeZhsLogs,
  normalizeZhsConfig,
  normalizeZhsLog,
  normalizeZhsLogs,
  normalizeZhsStatus,
  normalizeZhsWatch,
  addZhsWatch,
  formatZhsWatch,
  parseCorrectAnswer,
} from "../../src/sites/zhihuishu/types";

describe("zhihuishu config/status", () => {
  it("normalizes config and keeps safe speed", () => {
    expect(normalizeZhsConfig({ enabled: true, mode: "correct", speed: 9, autoNext: false, quality: "auto" }))
      .toEqual({ enabled: true, mode: "correct", speed: 2, autoNext: false, reviewCompleted: false, quality: "auto" });
    expect(normalizeZhsConfig({ speed: 0.2 }).speed).toBe(0.5);
    expect(normalizeZhsConfig({}).mode).toBe("quick");
    expect(normalizeZhsConfig({ reviewCompleted: true }).reviewCompleted).toBe(true);
  });

  it("counts today's wall-clock watch time and resets on a new day", () => {
    const now = new Date(2026, 10, 23, 12, 0, 0).getTime();
    const empty = normalizeZhsWatch({ date: "2026-11-22", seconds: 100 }, now);
    expect(empty).toEqual({ date: "2026-11-23", seconds: 0 });
    const added = addZhsWatch({ date: "2026-11-23", seconds: 10 }, 2.6, now);
    expect(added.seconds).toBe(12);
    expect(formatZhsWatch(3723)).toBe("01:02:03");
    expect(addZhsWatch(added, 999, now).seconds).toBe(22);
  });

  it("normalizes status and log entries", () => {
    const s = normalizeZhsStatus({ state: "quiz", message: "弹题", chapter: "第一章" })!;
    expect(s.state).toBe("quiz");
    expect(s.chapter).toBe("第一章");
    expect(normalizeZhsStatus({ state: "bad" })!.state).toBe("idle");
    const log = normalizeZhsLog({ at: 10, level: "warn", text: "提示" })!;
    expect(log).toEqual({ at: 10, level: "warn", text: "提示" });
    expect(normalizeZhsLog({ text: "" })).toBeNull();
  });

  it("caps and merges logs", () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({ at: 100 + i, level: "info", text: `log-${i}` }));
    const logs = normalizeZhsLogs(raw);
    expect(logs).toHaveLength(MAX_ZHS_LOGS);
    expect(logs[0].text).toBe("log-5");
    expect(mergeZhsLogs([logs[0]], [logs[0], { at: 999, level: "info", text: "new" }]).at(-1)?.text).toBe("new");
  });
});

describe("zhihuishu quiz logic", () => {
  it("parses single and multiple choice answers", () => {
    expect(parseCorrectAnswer("正确答案：A")).toEqual(["A"]);
    expect(parseCorrectAnswer("正确答案：CAB")).toEqual(["A", "B", "C"]);
    expect(parseCorrectAnswer("正确答案：对")).toEqual(["对"]);
    expect(parseCorrectAnswer("没有答案")).toEqual([]);
  });

  it("maps letters and true/false to option indexes", () => {
    expect(answerOptionIndexes(["A", "C"], ["A", "B", "C"])).toEqual([0, 2]);
    expect(answerOptionIndexes(["对"], ["对", "错"])).toEqual([0]);
    expect(answerOptionIndexes(["错"], ["正确", "错误"])).toEqual([1]);
    expect(answerOptionIndexes(["D"], ["A", "B"])).toEqual([]);
  });
});

describe("zhihuishu page helpers", () => {
  it("recognizes only zhihuishu hosts", () => {
    expect(isZhsUrl("https://studyvideoh5.zhihuishu.com/stuStudy?x=1")).toBe(true);
    expect(isZhsUrl("https://www.zhihuishu.com/")).toBe(true);
    expect(isZhsUrl("https://evilzhihuishu.com/")).toBe(false);
    expect(isZhsUrl("https://www.educoder.net/")).toBe(false);
  });

  it("treats ended/completed/99.5% as complete", () => {
    expect(isCompletedState({ ended: true })).toBe(true);
    expect(isCompletedState({ completed: true })).toBe(true);
    expect(isCompletedState({ progress: 0.996 })).toBe(true);
    expect(isCompletedState({ progress: 0.9 })).toBe(false);
    expect(textIndicatesCompleted("当前节：未完成")).toBe(false);
    expect(textIndicatesCompleted("当前节：已完成")).toBe(true);
  });
});
