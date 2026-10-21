// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  buildCursorOptions,
  createCursorController,
  readCursorOptions,
} from "../../src/features/cursor";

const EO = { cursorBlinking: 1, cursorSmoothCaretAnimation: 2 };
const ORIG = { blinking: "blink", caret: false };

function makeMonaco(option: any = EO) {
  return { editor: { EditorOption: option } } as any;
}

function makeEditor(values: Record<number, unknown> = { 1: "blink", 2: false }) {
  return {
    getOption: (k: number) => values[k],
    updateOptions: vi.fn(),
  } as any;
}

describe("readCursorOptions", () => {
  it("读取闪烁与平滑动画原值", () => {
    expect(readCursorOptions(makeEditor(), makeMonaco())).toEqual(ORIG);
  });

  it("没有 EditorOption → null", () => {
    expect(readCursorOptions(makeEditor(), { editor: {} } as any)).toBeNull();
  });

  it("getOption 抛错 → null", () => {
    const ed = makeEditor();
    ed.getOption = () => {
      throw new Error("boom");
    };
    expect(readCursorOptions(ed, makeMonaco())).toBeNull();
  });
});

describe("buildCursorOptions", () => {
  it("开启 → smooth + 平滑动画 true", () => {
    expect(buildCursorOptions(ORIG, true, makeMonaco())).toEqual({
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: true,
    });
  });

  it("关闭 → 按原值还原", () => {
    expect(buildCursorOptions(ORIG, false, makeMonaco())).toEqual({
      cursorBlinking: "blink",
      cursorSmoothCaretAnimation: false,
    });
  });

  it("没有原快照 → 空对象（不覆盖页面设置）", () => {
    expect(buildCursorOptions(null, true, makeMonaco())).toEqual({});
  });

  it("没有 EditorOption → 空对象", () => {
    expect(buildCursorOptions(ORIG, true, { editor: {} } as any)).toEqual({});
  });
});

describe("applyCursor", () => {
  it("开启：所有未销毁编辑器写入 smooth", () => {
    const ed = makeEditor();
    const disposed = makeEditor();
    const controller = createCursorController({
      getEditors: () => [
        { ed, cursorOrig: ORIG, disposed: false },
        { ed: disposed, cursorOrig: ORIG, disposed: true },
      ],
      isCursorOn: () => true,
      getMonaco: () => makeMonaco(),
    });
    controller.apply();
    expect(ed.updateOptions).toHaveBeenCalledWith({
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: true,
    });
    expect(disposed.updateOptions).not.toHaveBeenCalled();
  });

  it("关闭：写回原值", () => {
    const ed = makeEditor();
    const controller = createCursorController({
      getEditors: () => [{ ed, cursorOrig: ORIG, disposed: false }],
      isCursorOn: () => false,
      getMonaco: () => makeMonaco(),
    });
    controller.apply();
    expect(ed.updateOptions).toHaveBeenCalledWith({
      cursorBlinking: "blink",
      cursorSmoothCaretAnimation: false,
    });
  });
});
