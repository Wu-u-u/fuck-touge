// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  PASTED_MAX,
  createPasteGuard,
  diffRange,
  isUserEditKey,
  suspectTamper,
} from "../../src/features/paste-guard";
import type { GuardModel } from "../../src/features/paste-guard";

class FakeModel {
  value: string;
  applied: Array<{ range: any; text: string }> = [];
  listeners: Array<(e: any) => void> = [];
  __ftLastValue?: string;
  __ftHooked?: boolean;

  constructor(value: string) {
    this.value = value;
  }
  getValue() {
    return this.value;
  }
  setValue(v: string) {
    this.value = v;
  }
  onDidChangeContent(fn: (e: any) => void) {
    this.listeners.push(fn);
    return { dispose() {} };
  }
  applyEdits(edits: Array<{ range: any; text: string }>) {
    this.applied.push(...edits);
  }
  getPositionAt(offset: number) {
    return { lineNumber: 1, column: offset + 1 };
  }
}

class FakeRange {
  constructor(
    public startLine: number,
    public startColumn: number,
    public endLine: number,
    public endColumn: number,
  ) {}
}

function makeClock(start = 1000) {
  let t = start;
  let timers: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, at: t + ms });
      return timers.length;
    },
    advance(ms: number) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      due.forEach((x) => x.fn());
    },
    pending: () => timers.length,
  };
}

function makeGuard(model: FakeModel) {
  const clock = makeClock();
  const guard = createPasteGuard({
    getModels: () => [model],
    getRange: () => FakeRange as any,
    now: clock.now,
    setTimer: clock.setTimer,
  });
  return { guard, clock };
}

let disposers: Array<() => void> = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
});

describe("diffRange", () => {
  it("完全相同 → 空区间", () => {
    expect(diffRange("abc", "abc")).toEqual({ start: 3, end: 3 });
  });
  it("中间替换", () => {
    expect(diffRange("hello", "hallo")).toEqual({ start: 1, end: 2 });
  });
  it("尾部删除", () => {
    expect(diffRange("hello", "hell")).toEqual({ start: 4, end: 5 });
  });
  it("头部插入", () => {
    expect(diffRange("abc", "xabc")).toEqual({ start: 0, end: 0 });
  });
});

describe("suspectTamper", () => {
  it("位置重合 → 命中", () => {
    expect(suspectTamper([{ start: 5, len: 6, text: "PASTED" }], 5, 11, "PASTED")).toBe(true);
  });
  it("无关位置与内容 → 不命中", () => {
    expect(suspectTamper([{ start: 5, len: 6, text: "PASTED" }], 20, 26, "OTHERX")).toBe(false);
  });
  it("位置未知但内容一致（≥4 字符）→ 命中", () => {
    expect(suspectTamper([{ start: -1, len: 0, text: "PASTED" }], 20, 26, "PASTED")).toBe(true);
  });
  it("单字符删除不算篡改", () => {
    expect(suspectTamper([{ start: -1, len: 0, text: "P" }], 20, 21, "P")).toBe(false);
  });
  it("含零宽字符的粘贴内容仍能匹配", () => {
    const text = "PA\u200bSTED";
    expect(suspectTamper([{ start: -1, len: 0, text }], 20, 20 + text.length, text)).toBe(true);
  });
  it("多段粘贴记录逐条比对", () => {
    expect(
      suspectTamper([{ start: -1, len: 0, text: "AAA" }, { start: -1, len: 0, text: "PASTED" }], 20, 26, "PASTED"),
    ).toBe(true);
  });
});

describe("isUserEditKey", () => {
  it("撤销/剪切/删词/删行和弦", () => {
    expect(isUserEditKey({ key: "z", ctrlKey: true })).toBe(true);
    expect(isUserEditKey({ key: "x", ctrlKey: true })).toBe(true);
    expect(isUserEditKey({ key: "Backspace", ctrlKey: true })).toBe(true);
    expect(isUserEditKey({ key: "Delete", metaKey: true })).toBe(true);
    expect(isUserEditKey({ key: "k", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isUserEditKey({ key: "Backspace", altKey: true })).toBe(true);
  });
  it("普通删除/回车/可打印字符", () => {
    expect(isUserEditKey({ key: "Backspace" })).toBe(true);
    expect(isUserEditKey({ key: "Delete" })).toBe(true);
    expect(isUserEditKey({ key: "Enter" })).toBe(true);
    expect(isUserEditKey({ key: "Tab" })).toBe(true);
    expect(isUserEditKey({ key: "a" })).toBe(true);
  });
  it("Ctrl+A / 纯修饰键不算编辑", () => {
    expect(isUserEditKey({ key: "a", ctrlKey: true })).toBe(false);
    expect(isUserEditKey({ key: "Shift" })).toBe(false);
    expect(isUserEditKey({ key: "a", ctrlKey: true, shiftKey: true })).toBe(false);
  });
});

describe("保护窗口状态机", () => {
  it("openGuard：窗口 300ms、预算清零、记录粘贴、快照模型", () => {
    const model = new FakeModel("hello");
    const { guard, clock } = makeGuard(model);

    guard.openGuard("PASTED");
    const s = guard.getState();
    expect(s.watchUntil).toBe(clock.now() + 300);
    expect(s.undoCount).toBe(0);
    expect(s.pasted[0].text).toBe("PASTED");
    expect(model.__ftLastValue).toBe("hello");
  });

  it("keydown 空文本 + paste 文本合并为一条", () => {
    const { guard } = makeGuard(new FakeModel("x"));
    guard.openGuard();
    guard.openGuard("hello");
    const s = guard.getState();
    expect(s.pasted).toHaveLength(1);
    expect(s.pasted[0].text).toBe("hello");
  });

  it("连续粘贴保留最近 3 条（新的在前）", () => {
    const { guard } = makeGuard(new FakeModel("x"));
    guard.openGuard("A");
    guard.openGuard("B");
    guard.openGuard("C");
    guard.openGuard("D");
    const s = guard.getState();
    expect(s.pasted.map((p) => p.text)).toEqual(["D", "C", "B"]);
    expect(PASTED_MAX).toBe(3);
  });

  it("cancelGuard：窗口关闭、预算置满、代次 +1、清空粘贴记录", () => {
    const model = new FakeModel("x");
    const { guard } = makeGuard(model);
    guard.openGuard("PASTED");
    const g0 = guard.getState().guardGen;
    guard.cancelGuard();
    const s = guard.getState();
    expect(s.watchUntil).toBe(0);
    expect(s.undoCount).toBe(3);
    expect(s.guardGen).toBe(g0 + 1);
    expect(s.pasted).toEqual([]);
  });

  it("openGuard 不递增代次（连续粘贴不废弃上次回插）", () => {
    const { guard } = makeGuard(new FakeModel("x"));
    const g0 = guard.getState().guardGen;
    guard.openGuard("A");
    guard.openGuard("B");
    expect(guard.getState().guardGen).toBe(g0);
  });
});

describe("事件监听", () => {
  it("Backspace 取消保护", () => {
    const { guard } = makeGuard(new FakeModel("x"));
    disposers.push(guard.install());
    guard.openGuard("x");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    expect(guard.getState().undoCount).toBe(3);
  });

  it("合成鼠标事件（isTrusted=false）不取消保护", () => {
    const { guard, clock } = makeGuard(new FakeModel("x"));
    disposers.push(guard.install());
    guard.openGuard("x");
    window.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(guard.getState().undoCount).toBe(0);
    expect(guard.getState().watchUntil).toBeGreaterThan(clock.now());
  });

  it("beforeinput：insertFromPaste 不取消，删除类取消", () => {
    const { guard } = makeGuard(new FakeModel("x"));
    disposers.push(guard.install());
    guard.openGuard("x");

    const pasteInput = new Event("beforeinput") as any;
    Object.defineProperty(pasteInput, "inputType", { value: "insertFromPaste" });
    window.dispatchEvent(pasteInput);
    expect(guard.getState().undoCount).toBe(0);

    const delInput = new Event("beforeinput") as any;
    Object.defineProperty(delInput, "inputType", { value: "deleteContentBackward" });
    window.dispatchEvent(delInput);
    expect(guard.getState().undoCount).toBe(3);
  });

  it("paste 事件开启保护并记录文本", () => {
    const { guard, clock } = makeGuard(new FakeModel("x"));
    disposers.push(guard.install());
    const ev = new Event("paste") as any;
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "PASTED" : "") },
    });
    window.dispatchEvent(ev);
    expect(guard.getState().pasted[0].text).toBe("PASTED");
    expect(guard.getState().watchUntil).toBeGreaterThan(clock.now());
  });

  it("Ctrl+V 开启保护；Ctrl+C 阻断后续同层监听", () => {
    const { guard, clock } = makeGuard(new FakeModel("x"));
    disposers.push(guard.install());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }));
    expect(guard.getState().watchUntil).toBeGreaterThan(clock.now());

    let pageHandlerCalled = false;
    window.addEventListener("keydown", () => { pageHandlerCalled = true; }, true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    expect(pageHandlerCalled).toBe(false);
  });

  it("dispose 后监听失效", () => {
    const { guard } = makeGuard(new FakeModel("x"));
    const dispose = guard.install();
    guard.openGuard("x");
    dispose();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    expect(guard.getState().undoCount).toBe(0);
  });
});

describe("modelChange 回插", () => {
  it("窗口内删除粘贴内容 → 30ms 后按原位置插回", () => {
    const model = new FakeModel("hello");
    const { guard, clock } = makeGuard(model);
    guard.openGuard("PASTED");

    model.setValue("helloPASTED");
    guard.onModelChange(model, { changes: [{ text: "PASTED", rangeOffset: 5, rangeLength: 0 }] });

    model.setValue("hello");
    guard.onModelChange(model, { changes: [{ text: "", rangeOffset: 5, rangeLength: 6 }] });
    expect(clock.pending()).toBe(1);

    clock.advance(30);
    expect(model.applied).toHaveLength(1);
    expect(model.applied[0].text).toBe("PASTED");
    expect((model.applied[0].range as FakeRange).startColumn).toBe(6);
  });

  it("多段删除按偏移升序回插", () => {
    const model = new FakeModel("AAABBBCCC");
    const { guard, clock } = makeGuard(model);
    guard.openGuard("AAABBBCCC");

    model.setValue("BBB");
    guard.onModelChange(model, {
      changes: [
        { text: "", rangeOffset: 0, rangeLength: 3 },
        { text: "", rangeOffset: 6, rangeLength: 3 },
      ],
    });
    clock.advance(30);

    expect(model.applied.map((e) => e.text)).toEqual(["AAA", "CCC"]);
    expect((model.applied[0].range as FakeRange).startColumn).toBe(1);
    expect((model.applied[1].range as FakeRange).startColumn).toBe(7);
  });

  it("回插前模型已被改 → 放弃", () => {
    const model = new FakeModel("hello");
    const { guard, clock } = makeGuard(model);
    guard.openGuard("PASTED");
    model.setValue("helloPASTED");
    guard.onModelChange(model, { changes: [{ text: "PASTED", rangeOffset: 5, rangeLength: 0 }] });
    model.setValue("hello");
    guard.onModelChange(model, { changes: [{ text: "", rangeOffset: 5, rangeLength: 6 }] });

    model.setValue("changed");
    clock.advance(30);
    expect(model.applied).toHaveLength(0);
  });

  it("用户编辑（cancelGuard）后排队回插作废", () => {
    const model = new FakeModel("hello");
    const { guard, clock } = makeGuard(model);
    guard.openGuard("PASTED");
    model.setValue("helloPASTED");
    guard.onModelChange(model, { changes: [{ text: "PASTED", rangeOffset: 5, rangeLength: 0 }] });
    model.setValue("hello");
    guard.onModelChange(model, { changes: [{ text: "", rangeOffset: 5, rangeLength: 6 }] });

    guard.cancelGuard();
    clock.advance(30);
    expect(model.applied).toHaveLength(0);
  });

  it("最多回插 3 次（预算用尽后不再排队）", () => {
    const model = new FakeModel("helloPASTED");
    const { guard, clock } = makeGuard(model);
    guard.openGuard("PASTED");

    for (let i = 0; i < 3; i++) {
      model.__ftLastValue = "helloPASTED";
      model.setValue("hello");
      guard.onModelChange(model, { changes: [{ text: "", rangeOffset: 5, rangeLength: 6 }] });
    }
    expect(guard.getState().undoCount).toBe(3);
    expect(clock.pending()).toBe(3);

    model.__ftLastValue = "helloPASTED";
    model.setValue("hello");
    guard.onModelChange(model, { changes: [{ text: "", rangeOffset: 5, rangeLength: 6 }] });
    expect(clock.pending()).toBe(3);
  });

  it("窗口过期 → 不回插", () => {
    const model = new FakeModel("helloPASTED");
    const { guard, clock } = makeGuard(model);
    guard.openGuard("PASTED");
    clock.advance(400);

    model.__ftLastValue = "helloPASTED";
    model.setValue("hello");
    guard.onModelChange(model, { changes: [{ text: "", rangeOffset: 5, rangeLength: 6 }] });
    expect(clock.pending()).toBe(0);
    expect(guard.getState().undoCount).toBe(0);
  });

  it("无关删除 → 不回插", () => {
    const model = new FakeModel("helloPASTED");
    const { guard, clock } = makeGuard(model);
    guard.openGuard("PASTED");

    model.__ftLastValue = "helloPASTED";
    model.setValue("PASTED");
    guard.onModelChange(model, { changes: [{ text: "", rangeOffset: 0, rangeLength: 5 }] });
    expect(clock.pending()).toBe(0);
  });
});
