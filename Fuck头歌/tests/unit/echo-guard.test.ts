import { describe, expect, it } from "vitest";
import { createEchoGuard } from "../../src/shared/echo-guard";

describe("createEchoGuard", () => {
  it("标记后 2s 内视为自己写入，过期后失效", () => {
    let t = 1000;
    const g = createEchoGuard(2000, () => t);
    g.mark("a");
    expect(g.isEcho("a")).toBe(true);
    expect(g.isEcho("b")).toBe(false);
    t += 2001;
    expect(g.isEcho("a")).toBe(false);
  });

  it("mark 时清理过期项", () => {
    let t = 1000;
    const g = createEchoGuard(2000, () => t);
    g.mark("old");
    t += 3000;
    g.mark("new");
    expect(g.isEcho("old")).toBe(false);
    expect(g.isEcho("new")).toBe(true);
  });

  it("最多保留 20 个最近快照", () => {
    let t = 1000;
    const g = createEchoGuard(60_000, () => t++);
    for (let i = 0; i < 25; i++) g.mark(`s${i}`);
    expect(g.isEcho("s0")).toBe(false);
    expect(g.isEcho("s24")).toBe(true);
  });
});
