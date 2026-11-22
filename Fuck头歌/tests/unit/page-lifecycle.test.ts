import { describe, expect, it, vi } from "vitest";
import { runOnPageHide } from "../../src/shared/page-lifecycle";

describe("runOnPageHide", () => {
  it("pagehide 执行任务，取消监听后不再执行", () => {
    const task = vi.fn();
    const target = new EventTarget();
    const remove = runOnPageHide(task, target);

    target.dispatchEvent(new Event("pagehide"));
    expect(task).toHaveBeenCalledTimes(1);
    remove();
    target.dispatchEvent(new Event("pagehide"));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("bfcache（persisted）pagehide 不执行一次性清理", () => {
    const task = vi.fn();
    const target = new EventTarget();
    const remove = runOnPageHide(task, target);
    const event = new Event("pagehide");
    Object.defineProperty(event, "persisted", { value: true });
    target.dispatchEvent(event);
    expect(task).not.toHaveBeenCalled();
    remove();
  });
});
