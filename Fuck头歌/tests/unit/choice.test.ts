// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  document.body.innerHTML = "";
  history.replaceState({}, "", "/tasks/a/b/c");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("choice watcher", () => {
  it("无弹层：3s 后只提示、不跳关", () => {
    const toast = vi.fn();
    const w = createChoiceWatcher({ toast });
    const dispose = w.install();
    const btn = makeEvalBtn();

    btn.click();
    expect(w.isWatching()).toBe(true);
    for (let i = 0; i < 25; i++) vi.advanceTimersByTime(150);

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

  it("仅有 submitted 结果面板不算通过（仍提示不跳）", () => {
    const toast = vi.fn();
    const w = createChoiceWatcher({ toast });
    const dispose = w.install();
    const panel = document.createElement("div");
    panel.className = "test-set-container";
    panel.innerHTML = '<div class="submitStatus">已提交</div>';
    setRect(panel);
    document.body.appendChild(panel);

    makeEvalBtn().click();
    for (let i = 0; i < 25; i++) vi.advanceTimersByTime(150);
    expect(toast).toHaveBeenCalledWith("未检测到通过，已停止自动跳转");
    dispose();
  });

  it("评测后换关 → 观察作废且不弹旧提示", () => {
    const toast = vi.fn();
    const w = createChoiceWatcher({ toast });
    const dispose = w.install();
    makeEvalBtn().click();
    expect(w.isWatching()).toBe(true);

    history.pushState({}, "", "/tasks/a/b/next");
    vi.advanceTimersByTime(150);
    expect(w.isWatching()).toBe(false);
    for (let i = 0; i < 25; i++) vi.advanceTimersByTime(150);
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
