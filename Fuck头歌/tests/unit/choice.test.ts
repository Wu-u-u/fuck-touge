// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoNext } from "../../src/features/auto-next";
import { createChoiceWatcher } from "../../src/features/choice";

function setInnerText(el: HTMLElement, text: string): void {
  el.textContent = text;
  Object.defineProperty(el, "innerText", {
    configurable: true,
    get: () => el.textContent || "",
    set: (v: string) => { el.textContent = v; },
  });
}

function setRect(el: Element): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ width: 10, height: 10 }),
  });
}

function makeEvalBtn(): HTMLButtonElement {
  const b = document.createElement("button");
  setInnerText(b, "评测");
  document.body.appendChild(b);
  return b;
}

function makeResultBox(): HTMLElement {
  const box = document.createElement("div");
  box.className = "evaluate-result-container";
  setRect(box);
  const btn = document.createElement("button");
  setInnerText(btn, "下一关");
  setRect(btn);
  box.appendChild(btn);
  document.body.appendChild(box);
  return box;
}

function makeTestResult(cls: "success" | "failer"): HTMLElement {
  const box = document.createElement("div");
  box.className = `test-result ${cls}`;
  setRect(box);
  document.body.appendChild(box);
  return box;
}

function makeToolbarNext(): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = "/tasks/a/b/next";
  setInnerText(a, "下一关");
  setRect(a);
  document.body.appendChild(a);
  return a;
}

beforeEach(() => {
  document.body.innerHTML = "";
  history.replaceState({}, "", "/tasks/a/b/c");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
  // jsdom 的 window 是代理对象，clickLikeUser 传 view: window 会触发类型校验。
  const RealMouseEvent = window.MouseEvent;
  vi.stubGlobal(
    "MouseEvent",
    class extends RealMouseEvent {
      constructor(type: string, init: MouseEventInit = {}) {
        const { view: _view, ...rest } = init as any;
        super(type, rest);
      }
    },
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("choice watcher", () => {
  it("新 success 面板 → 点一次工具栏下一关", () => {
    const w = createChoiceWatcher({ toast: () => {} });
    const dispose = w.install();
    const old = makeTestResult("success");
    const btn = makeEvalBtn();
    const next = makeToolbarNext();
    let clicked = 0;
    next.addEventListener("click", () => clicked++);

    btn.click();
    expect(w.isWatching()).toBe(true);
    const fresh = makeTestResult("success");
    expect(fresh).not.toBe(old);
    vi.advanceTimersByTime(150);

    expect(clicked).toBe(1);
    expect(w.isWatching()).toBe(false);
    dispose();
  });

  it("评测前旧 success 不动 → 不跳，超时只提示一次", () => {
    const toast = vi.fn();
    const w = createChoiceWatcher({ toast });
    const dispose = w.install();
    makeTestResult("success");
    const next = makeToolbarNext();
    let clicked = 0;
    next.addEventListener("click", () => clicked++);

    makeEvalBtn().click();
    for (let i = 0; i < 70; i++) vi.advanceTimersByTime(150);

    expect(clicked).toBe(0);
    expect(w.isWatching()).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("未检测到通过，已停止自动跳转");
    dispose();
  });

  it("failer 面板 → 不跳", () => {
    const w = createChoiceWatcher({ toast: () => {} });
    const dispose = w.install();
    const next = makeToolbarNext();
    let clicked = 0;
    next.addEventListener("click", () => clicked++);

    makeEvalBtn().click();
    makeTestResult("failer");
    vi.advanceTimersByTime(150);

    expect(clicked).toBe(0);
    expect(w.isWatching()).toBe(false);
    dispose();
  });

  it("最后一关没有下一关 → 不跳", () => {
    const w = createChoiceWatcher({ toast: () => {} });
    const dispose = w.install();
    makeEvalBtn().click();
    makeTestResult("success");
    vi.advanceTimersByTime(150);

    expect(w.isWatching()).toBe(false);
    dispose();
  });

  it("评测后换关 → 观察作废且不跳", () => {
    const w = createChoiceWatcher({ toast: () => {} });
    const dispose = w.install();
    const next = makeToolbarNext();
    let clicked = 0;
    next.addEventListener("click", () => clicked++);

    makeEvalBtn().click();
    history.pushState({}, "", "/tasks/a/b/next");
    vi.advanceTimersByTime(150);

    expect(clicked).toBe(0);
    expect(w.isWatching()).toBe(false);
    dispose();
  });

  it("庆祝弹层与新面板同时出现 → 只走旧路径一次", () => {
    const autoNext = createAutoNext({ toast: () => {} });
    const w = createChoiceWatcher({
      toast: () => {},
      claimJump: (key) => autoNext.claimJump(key),
    });
    const dispose = w.install();
    const box = makeResultBox();
    const next = box.querySelector("button") as HTMLButtonElement;
    let clicked = 0;
    next.addEventListener("click", () => clicked++);

    makeEvalBtn().click();
    makeTestResult("success");
    makeToolbarNext();
    vi.advanceTimersByTime(150);
    expect(clicked).toBe(0); // 旧弹层路径优先，choice 不重复点

    autoNext.autoNext();
    vi.advanceTimersByTime(200);
    expect(clicked).toBe(1);
    dispose();
  });

  it("无弹层、无新面板：10s 后只提示、不跳关", () => {
    const toast = vi.fn();
    const w = createChoiceWatcher({ toast });
    const dispose = w.install();
    const next = makeToolbarNext();
    let clicked = 0;
    next.addEventListener("click", () => clicked++);

    makeEvalBtn().click();
    for (let i = 0; i < 70; i++) vi.advanceTimersByTime(150);

    expect(clicked).toBe(0);
    expect(w.isWatching()).toBe(false);
    expect(toast).toHaveBeenCalledWith("未检测到通过，已停止自动跳转");
    dispose();
  });

  it("出现庆祝弹层 → 交给弹层路径，不弹失败提示", () => {
    const toast = vi.fn();
    const w = createChoiceWatcher({ toast });
    const dispose = w.install();
    makeEvalBtn().click();

    makeResultBox();
    vi.advanceTimersByTime(150);
    expect(w.isWatching()).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    dispose();
  });

  it("代码页（有 Monaco）点击评测不启动观察", () => {
    const w = createChoiceWatcher({ toast: () => {} });
    const dispose = w.install();
    const ed = document.createElement("div");
    ed.className = "monaco-editor";
    document.body.appendChild(ed);

    makeEvalBtn().click();
    expect(w.isWatching()).toBe(false);
    dispose();
  });
});
