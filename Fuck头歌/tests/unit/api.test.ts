// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installUIApi } from "../../src/api";
import type { PublicSettings } from "../../src/shared/types";

const base: PublicSettings = {
  theme: true,
  font: true,
  themeName: "catppuccin",
  cursor: false,
};

function setup(initial: PublicSettings = base) {
  let state = { ...initial };
  const calls: string[] = [];
  const deps = {
    getState: () => ({ ...state }),
    setTheme: vi.fn((on: boolean) => {
      calls.push("theme");
      state.theme = on;
    }),
    setThemeName: vi.fn((name?: string) => {
      calls.push("themeName");
      if (name === "github" || name === "catppuccin") state.themeName = name;
    }),
    setFont: vi.fn((on: boolean) => {
      calls.push("font");
      state.font = on;
    }),
    setCursor: vi.fn((on: boolean) => {
      calls.push("cursor");
      state.cursor = on;
    }),
  };
  installUIApi(deps);
  return { deps, calls };
}

beforeEach(() => {
  delete (window as any).__fuckTougeUI;
});

describe("安装", () => {
  it("暴露 get，返回当前状态", () => {
    setup();
    expect(window.__fuckTougeUI!.get()).toEqual(base);
  });
});

describe("set 局部更新", () => {
  it("只传 theme → 只调用 setTheme，返回更新后的状态", () => {
    const { deps } = setup();
    const next = window.__fuckTougeUI!.set({ theme: false });

    expect(deps.setTheme).toHaveBeenCalledWith(false);
    expect(deps.setFont).not.toHaveBeenCalled();
    expect(deps.setCursor).not.toHaveBeenCalled();
    expect(deps.setThemeName).not.toHaveBeenCalled();
    expect(next.theme).toBe(false);
    expect(next.font).toBe(true);
    expect(next.themeName).toBe("catppuccin");
  });

  it("font + cursor 同时更新", () => {
    const { deps } = setup();
    const next = window.__fuckTougeUI!.set({ font: false, cursor: true });

    expect(deps.setFont).toHaveBeenCalledWith(false);
    expect(deps.setCursor).toHaveBeenCalledWith(true);
    expect(deps.setTheme).not.toHaveBeenCalled();
    expect(next.font).toBe(false);
    expect(next.cursor).toBe(true);
  });

  it("按 themeName → theme → font → cursor 的顺序分发", () => {
    const { calls } = setup();
    window.__fuckTougeUI!.set({ themeName: "github", theme: false, font: false, cursor: true });
    expect(calls).toEqual(["themeName", "theme", "font", "cursor"]);
  });

  it("非对象/空参数不调用任何 setter，仍返回当前状态", () => {
    const { deps } = setup();
    window.__fuckTougeUI!.set(null as any);
    window.__fuckTougeUI!.set("x" as any);
    expect(deps.setTheme).not.toHaveBeenCalled();
    expect(deps.setFont).not.toHaveBeenCalled();
    expect(window.__fuckTougeUI!.get()).toEqual(base);
  });
});
