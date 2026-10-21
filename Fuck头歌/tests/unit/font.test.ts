// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FONT_OPTIONS,
  createFontController,
  readFontOptions,
  shouldAskFont,
} from "../../src/features/font";

const EO = { fontFamily: 1, fontLigatures: 2, bracketPairColorization: 3 };
const ORIG = { 1: "orig-font", 2: false, 3: { enabled: false } };

function makeMonaco(extra: Record<string, unknown> = {}) {
  return { editor: { EditorOption: EO, remeasureFonts: vi.fn(), ...extra } } as any;
}

function makeEditor(values: Record<number, unknown> = ORIG) {
  return {
    getOption: (k: number) => values[k],
    updateOptions: vi.fn(),
  } as any;
}

afterEach(() => {
  delete (document as any).fonts;
});

describe("shouldAskFont", () => {
  it("只在未询问且未开启时询问", () => {
    expect(shouldAskFont(false, false)).toBe(true);
    expect(shouldAskFont(true, false)).toBe(false);
    expect(shouldAskFont(false, true)).toBe(false);
    expect(shouldAskFont(true, true)).toBe(false);
  });
});

describe("readFontOptions", () => {
  it("读取字体三项原值", () => {
    expect(readFontOptions(makeEditor(), makeMonaco())).toEqual({
      fontFamily: "orig-font",
      fontLigatures: false,
      bracketPairColorization: { enabled: false },
    });
  });

  it("没有 EditorOption → 空快照", () => {
    expect(readFontOptions(makeEditor(), { editor: {} } as any)).toEqual({});
  });

  it("getOption 抛错 → 空快照", () => {
    const ed = makeEditor();
    ed.getOption = () => {
      throw new Error("boom");
    };
    expect(readFontOptions(ed, makeMonaco())).toEqual({});
  });
});

describe("applyFont", () => {
  it("开启：写入 FONT_OPTIONS，跳过已销毁编辑器", () => {
    const ed = makeEditor();
    const disposed = makeEditor();
    const controller = createFontController({
      getEditors: () => [
        { ed, disposed: false },
        { ed: disposed, disposed: true },
      ],
      isFontOn: () => true,
      getMonaco: () => makeMonaco(),
    });
    controller.apply();
    expect(ed.updateOptions).toHaveBeenCalledWith(FONT_OPTIONS);
    expect(disposed.updateOptions).not.toHaveBeenCalled();
  });

  it("关闭：写回原快照", () => {
    const ed = makeEditor();
    const controller = createFontController({
      getEditors: () => [{ ed, orig: ORIG, disposed: false }],
      isFontOn: () => false,
      getMonaco: () => makeMonaco(),
    });
    controller.apply();
    expect(ed.updateOptions).toHaveBeenCalledWith(ORIG);
  });

  it("开启时在 fonts.ready 后触发 remeasureFonts", async () => {
    const remeasure = vi.fn();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    const controller = createFontController({
      getEditors: () => [{ ed: makeEditor(), disposed: false }],
      isFontOn: () => true,
      getMonaco: () => ({ editor: { EditorOption: EO, remeasureFonts: remeasure } } as any),
    });
    controller.apply();
    await Promise.resolve();
    await Promise.resolve();
    expect(remeasure).toHaveBeenCalledTimes(1);
  });

  it("关闭时不触发 remeasureFonts", () => {
    const remeasure = vi.fn();
    const controller = createFontController({
      getEditors: () => [{ ed: makeEditor(), disposed: false, orig: ORIG }],
      isFontOn: () => false,
      getMonaco: () => ({ editor: { EditorOption: EO, remeasureFonts: remeasure } } as any),
    });
    controller.apply();
    expect(remeasure).not.toHaveBeenCalled();
  });
});
