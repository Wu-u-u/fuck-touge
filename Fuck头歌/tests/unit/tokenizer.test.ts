import { describe, expect, it, vi } from "vitest";
import {
  JAVA_MONARCH,
  createTokenizerController,
  isOurJavaDef,
  javaDef,
} from "../../src/features/theme/tokenizer";

const platformDef = { tokenizer: { root: [] }, platform: true };
const isSmart = (def: any) => JSON.stringify(def).includes("keyword.control");

function setup(on = true) {
  const calls: Array<{ id: string; def: any }> = [];
  const L: any = {
    setMonarchTokensProvider(id: string, def: any) {
      calls.push({ id, def });
    },
  };
  const M: any = { editor: {}, languages: L };
  let themeOn = on;
  const timers = { setTimeout: vi.fn((_fn: () => void, _ms: number) => 0) };
  const tokenizer = createTokenizerController({
    getMonaco: () => M,
    isThemeOn: () => themeOn,
    timers,
  });
  return { calls, L, M, tokenizer, timers, setOn: (v: boolean) => (themeOn = v) };
}

describe("Java monarch 数据", () => {
  it("smart 有细粒度关键字，plain 没有", () => {
    expect(isSmart(JAVA_MONARCH(true))).toBe(true);
    expect(isSmart(JAVA_MONARCH(false))).toBe(false);
    expect(JSON.stringify(JAVA_MONARCH(true))).toContain("string");
    expect(JSON.stringify(JAVA_MONARCH(false))).toContain("string");
  });

  it("javaDef 可被识别为自己生成的定义", () => {
    expect(isOurJavaDef(javaDef(true))).toBe(true);
    expect(isOurJavaDef(platformDef)).toBe(false);
    expect(isOurJavaDef(null)).toBe(false);
  });
});

describe("install / restore", () => {
  it("主题开启 → install 装 smart 定义", () => {
    const { calls, tokenizer } = setup(true);
    tokenizer.install();
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("java");
    expect(isSmart(calls[0].def)).toBe(true);
  });

  it("主题关闭 → install 不动作", () => {
    const { calls, tokenizer } = setup(false);
    tokenizer.install();
    expect(calls).toHaveLength(0);
  });

  it("主题关闭 → restore 还原平台 provider；没有平台 provider 时用 plain", () => {
    const first = setup(false);
    first.L.__ftJavaPlatformDef = platformDef;
    first.tokenizer.restore();
    expect(first.calls[0].def).toBe(platformDef);

    const second = setup(false);
    second.tokenizer.restore();
    expect(isSmart(second.calls[0].def)).toBe(false);
  });

  it("主题开启 → restore 不动作", () => {
    const { calls, tokenizer } = setup(true);
    tokenizer.restore();
    expect(calls).toHaveLength(0);
  });
});

describe("installHook", () => {
  it("记录平台 provider，并在开启时替换为 smart 定义", () => {
    const { calls, L, M, tokenizer } = setup(true);
    tokenizer.installHook(M);
    L.setMonarchTokensProvider("java", platformDef);
    expect(L.__ftJavaPlatformDef).toBe(platformDef);
    expect(calls).toHaveLength(1);
    expect(isSmart(calls[0].def)).toBe(true);
  });

  it("关闭时透传平台 provider（启动即关闭不接管）", () => {
    const { calls, L, M, tokenizer } = setup(false);
    tokenizer.installHook(M);
    L.setMonarchTokensProvider("java", platformDef);
    expect(calls[0].def).toBe(platformDef);
  });

  it("只挂一次；非 java 语言透传", () => {
    const { calls, L, M, tokenizer } = setup(true);
    tokenizer.installHook(M);
    tokenizer.installHook(M);
    L.setMonarchTokensProvider("json", platformDef);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("json");
  });
});

describe("scheduleRetries", () => {
  it("按 400/1200/2500 重试，且只在主题开启时执行", () => {
    const first = setup(true);
    first.tokenizer.scheduleRetries();
    expect(first.timers.setTimeout).toHaveBeenCalledTimes(3);
    expect(first.timers.setTimeout.mock.calls.map((c: any[]) => c[1])).toEqual([400, 1200, 2500]);
    first.timers.setTimeout.mock.calls.forEach((c: any[]) => c[0]());
    expect(first.calls).toHaveLength(3);

    const second = setup(false);
    second.tokenizer.scheduleRetries();
    second.timers.setTimeout.mock.calls.forEach((c: any[]) => c[0]());
    expect(second.calls).toHaveLength(0);
  });
});
