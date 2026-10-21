// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JUMP_KEY,
  createAutoNext,
  findNextBtn,
  levelKey,
} from "../../src/features/auto-next";

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

function makeModal(label = "下一关") {
  const box = document.createElement("div");
  box.className = "evaluate-result-container";
  setRect(box);
  const btn = document.createElement("button");
  setInnerText(btn, label);
  setRect(btn);
  box.appendChild(btn);
  document.body.appendChild(box);
  return { box, btn };
}

beforeEach(() => {
  document.body.innerHTML = "";
  history.replaceState({}, "", "/tasks/a/b/c");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
  // Vitest 的 jsdom 全局 window 是代理对象，直接传 view 会触发 jsdom 的类型校验；
  // 测试里去掉 view（生产代码仍按原实现传 window）。
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

describe("levelKey", () => {
  it("拼接 pathname/search/hash", () => {
    expect(levelKey({ pathname: "/tasks/a/b/c", search: "?x=1", hash: "#h" })).toBe(
      "/tasks/a/b/c?x=1#h",
    );
  });
});

describe("findNextBtn", () => {
  it("识别 下一关 / 完成 / 最后一关", () => {
    for (const [label, kind] of [
      ["下一关", "next"],
      ["完成", "last"],
      ["最后一关", "last"],
    ] as const) {
      document.body.innerHTML = "";
      const { btn } = makeModal(label);
      const found = findNextBtn(document.body);
      expect(found?.el).toBe(btn);
      expect(found?.kind).toBe(kind);
    }
  });

  it("忽略隐藏按钮", () => {
    const { btn } = makeModal("下一关");
    btn.style.display = "none";
    expect(findNextBtn(document.body)).toBeNull();
  });

  it("禁用按钮仍会被返回（由 autoNext 等待激活）", () => {
    const { btn } = makeModal("下一关");
    (btn as HTMLButtonElement).disabled = true;
    expect(findNextBtn(document.body)?.el).toBe(btn);
  });
});

describe("claimJump", () => {
  it("同一关 5s 内只认领一次，换关/超时可再次认领", () => {
    const ctl = createAutoNext({ toast: () => {} });
    expect(ctl.claimJump("/tasks/a")).toBe(true);
    expect(ctl.claimJump("/tasks/a")).toBe(false);

    vi.setSystemTime(new Date(1_005_001));
    expect(ctl.claimJump("/tasks/a")).toBe(true);

    expect(ctl.claimJump("/tasks/b")).toBe(true);
    ctl.resetClaim();
    expect(ctl.getClaim()).toEqual({ key: "", at: 0 });
  });
});

describe("autoNext", () => {
  it("可见弹层 + 下一关：200ms 后点击一次并提示 + 写 sessionStorage", () => {
    const toast = vi.fn();
    const ctl = createAutoNext({ toast });
    const { btn } = makeModal("下一关");
    let clicked = 0;
    btn.addEventListener("click", () => clicked++);

    ctl.autoNext();
    expect(clicked).toBe(0);
    vi.advanceTimersByTime(200);

    expect(clicked).toBe(1);
    expect(toast).toHaveBeenCalledWith("已为您自动跳转至下一关 😋");
    expect(sessionStorage.getItem(JUMP_KEY)).toContain("next");
  });

  it("双击/重复 tick 只点一次", () => {
    const ctl = createAutoNext({ toast: () => {} });
    const { btn } = makeModal();
    let clicked = 0;
    btn.addEventListener("click", () => clicked++);

    ctl.autoNext();
    ctl.autoNext();
    vi.advanceTimersByTime(200);
    expect(clicked).toBe(1);
  });

  it("换关后放弃本次点击", () => {
    const ctl = createAutoNext({ toast: () => {} });
    const { btn } = makeModal();
    let clicked = 0;
    btn.addEventListener("click", () => clicked++);

    ctl.autoNext();
    history.pushState({}, "", "/tasks/other/level/x");
    vi.advanceTimersByTime(200);
    expect(clicked).toBe(0);
  });

  it("隐藏按钮不点；9s 后提示未检测到跳转按钮", () => {
    const toast = vi.fn();
    const ctl = createAutoNext({ toast });
    const { btn } = makeModal();
    btn.style.display = "none";
    let clicked = 0;
    btn.addEventListener("click", () => clicked++);

    ctl.autoNext();
    vi.advanceTimersByTime(200);
    expect(clicked).toBe(0);

    vi.advanceTimersByTime(9001);
    ctl.autoNext();
    expect(toast).toHaveBeenCalledWith("未检测到跳转按钮");
  });

  it("禁用按钮：等待激活；10s 后提示手动点击", () => {
    const toast = vi.fn();
    const ctl = createAutoNext({ toast });
    const { btn } = makeModal();
    (btn as HTMLButtonElement).disabled = true;
    let clicked = 0;
    btn.addEventListener("click", () => clicked++);

    ctl.autoNext();
    vi.advanceTimersByTime(200);
    expect(clicked).toBe(0);

    vi.setSystemTime(new Date(1_010_001));
    ctl.autoNext();
    expect(toast).toHaveBeenCalledWith("跳转按钮未激活，请手动点击「下一关」");
  });

  it("完成按钮提示最后一关", () => {
    const toast = vi.fn();
    const ctl = createAutoNext({ toast });
    const { btn } = makeModal("完成");
    let clicked = 0;
    btn.addEventListener("click", () => clicked++);

    ctl.autoNext();
    vi.advanceTimersByTime(200);
    expect(clicked).toBe(1);
    expect(toast).toHaveBeenCalledWith("已经是最后一关了 😋");
  });

  it("install 后 1s interval 也会触发检查", () => {
    const ctl = createAutoNext({ toast: () => {} });
    const { btn } = makeModal();
    let clicked = 0;
    btn.addEventListener("click", () => clicked++);
    const dispose = ctl.install();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(200);
    expect(clicked).toBe(1);
    dispose();
  });
});
