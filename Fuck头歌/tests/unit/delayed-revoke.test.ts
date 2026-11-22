// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedRevoker } from "../../src/shared/delayed-revoke";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("DelayedRevoker", () => {
  it("5s 后触发一次", () => {
    const fire = vi.fn();
    const r = new DelayedRevoker(fire);
    r.schedule("k");
    vi.advanceTimersByTime(4999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledWith("k");
    expect(fire).toHaveBeenCalledTimes(1);
    expect(r.pending("k")).toBe(false);
  });

  it("同一 key 重复 schedule 只触发一次", () => {
    const fire = vi.fn();
    const r = new DelayedRevoker(fire);
    r.schedule("k");
    r.schedule("k");
    vi.advanceTimersByTime(5000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("cancel 后不触发", () => {
    const fire = vi.fn();
    const r = new DelayedRevoker(fire);
    r.schedule("k");
    r.cancel("k");
    expect(r.pending("k")).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("cancelAll 清掉所有 key", () => {
    const fire = vi.fn();
    const r = new DelayedRevoker(fire);
    r.schedule("a");
    r.schedule("b");
    r.cancelAll();
    vi.advanceTimersByTime(6000);
    expect(fire).not.toHaveBeenCalled();
  });
});
