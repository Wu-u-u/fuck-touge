// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaRetryQueue } from "../../src/shared/media-retry";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("MediaRetryQueue", () => {
  it("3s 后执行一次", () => {
    const task = vi.fn();
    const q = new MediaRetryQueue(1, 3000);
    expect(q.schedule("k", task)).toBe(true);
    expect(q.pending("k")).toBe(true);
    vi.advanceTimersByTime(2999);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
    expect(q.pending("k")).toBe(false);
  });

  it("同 key 重复 schedule 不叠加", () => {
    const task = vi.fn();
    const q = new MediaRetryQueue(1, 3000);
    expect(q.schedule("k", task)).toBe(true);
    expect(q.schedule("k", task)).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("默认只重试一次", () => {
    const task = vi.fn();
    const q = new MediaRetryQueue(1, 3000);
    q.schedule("k", task);
    vi.advanceTimersByTime(3000);
    expect(q.schedule("k", task)).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("clear 取消并重置，可再次 schedule", () => {
    const task = vi.fn();
    const q = new MediaRetryQueue(1, 3000);
    q.schedule("k", task);
    q.clear("k");
    vi.advanceTimersByTime(3000);
    expect(task).not.toHaveBeenCalled();
    expect(q.schedule("k", task)).toBe(true);
  });

  it("retain 清掉已不存在的 key", () => {
    const task = vi.fn();
    const q = new MediaRetryQueue(1, 3000);
    q.schedule("keep", task);
    q.schedule("gone", task);
    q.retain(new Set(["keep"]));
    expect(q.pending("keep")).toBe(true);
    expect(q.pending("gone")).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("clearAll 清掉所有 key", () => {
    const task = vi.fn();
    const q = new MediaRetryQueue(1, 3000);
    q.schedule("a", task);
    q.schedule("b", task);
    q.clearAll();
    vi.advanceTimersByTime(6000);
    expect(task).not.toHaveBeenCalled();
  });
});
