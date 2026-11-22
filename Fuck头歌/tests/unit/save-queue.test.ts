// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaveQueue, flushOnPageHide } from "../../src/shared/save-queue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createSaveQueue", () => {
  it("260ms 内多次 schedule 只保存一次", () => {
    const save = vi.fn();
    const q = createSaveQueue(save, 260);
    q.schedule();
    q.schedule();
    expect(q.pending()).toBe(true);
    vi.advanceTimersByTime(259);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(q.pending()).toBe(false);
  });

  it("flush 立即保存并取消后续定时器", () => {
    const save = vi.fn();
    const q = createSaveQueue(save, 260);
    q.schedule();
    expect(q.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(q.pending()).toBe(false);
    expect(q.flush()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("cancel 不保存", () => {
    const save = vi.fn();
    const q = createSaveQueue(save, 260);
    q.schedule();
    q.cancel();
    vi.advanceTimersByTime(500);
    expect(save).not.toHaveBeenCalled();
    expect(q.pending()).toBe(false);
  });
});

describe("flushOnPageHide", () => {
  it("pagehide 触发 flush，取消监听后不再触发", () => {
    const save = vi.fn();
    const q = createSaveQueue(save, 260);
    const target = new EventTarget();
    const remove = flushOnPageHide(q, target);

    q.schedule();
    target.dispatchEvent(new Event("pagehide"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(q.pending()).toBe(false);

    remove();
    q.schedule();
    target.dispatchEvent(new Event("pagehide"));
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(260);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
