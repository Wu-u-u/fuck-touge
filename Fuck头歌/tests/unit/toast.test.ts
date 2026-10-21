// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../../src/ui/toast";

describe("toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("创建固定定位提示并挂到 body", () => {
    toast("hello");
    const el = document.body.querySelector("div")!;
    expect(el).toBeTruthy();
    expect(el.textContent).toBe("hello");
    expect(el.style.position).toBe("fixed");
    expect(el.style.top).toBe("26px");
    expect(el.style.zIndex).toBe("2147483647");
    expect(el.style.pointerEvents).toBe("none");
  });

  it("2.6s 后淡出，再 600ms 移除", () => {
    toast("bye");
    const el = document.body.querySelector("div")!;
    expect(document.body.contains(el)).toBe(true);

    vi.advanceTimersByTime(2600);
    expect(el.style.opacity).toBe("0");
    expect(document.body.contains(el)).toBe(true);

    vi.advanceTimersByTime(600);
    expect(document.body.contains(el)).toBe(false);
  });

  it("多条提示互不影响，各自按时移除", () => {
    toast("a");
    toast("b");
    expect(document.body.querySelectorAll("div").length).toBe(2);
    vi.advanceTimersByTime(3200);
    expect(document.body.querySelectorAll("div").length).toBe(0);
  });
});
