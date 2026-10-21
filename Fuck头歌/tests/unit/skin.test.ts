// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createSkinController, isAnswerPage } from "../../src/features/theme/skin";

afterEach(() => {
  document.documentElement.removeAttribute("data-ft-skin");
  document.documentElement.removeAttribute("data-ft-font");
  document.querySelectorAll("#ft-skin-style").forEach((e) => e.remove());
});

function setup(opts: {
  themeOn?: boolean;
  fontOn?: boolean;
  themeName?: string;
  answer?: boolean;
} = {}) {
  const state = {
    themeOn: opts.themeOn ?? true,
    fontOn: opts.fontOn ?? true,
    themeName: (opts.themeName ?? "catppuccin") as any,
  };
  const controller = createSkinController({
    isThemeOn: () => state.themeOn,
    getThemeName: () => state.themeName,
    isFontOn: () => state.fontOn,
    isAnswerPage: () => opts.answer ?? true,
  });
  return { controller, state };
}

describe("isAnswerPage", () => {
  it("只匹配 /tasks/课程/关卡组/关卡", () => {
    expect(isAnswerPage("/tasks/JODEM6CH/4155347/g4oxl5jy2tqr")).toBe(true);
    expect(isAnswerPage("/tasks/JODEM6CH/4155347")).toBe(false);
    expect(isAnswerPage("/")).toBe(false);
    expect(isAnswerPage("/classrooms/JODEM6CH/shixun_homework")).toBe(false);
  });
});

describe("applySkin", () => {
  it("主题 + 字体开启：写入属性并注入样式", () => {
    const { controller } = setup();
    controller.apply();
    const el = document.documentElement;
    expect(el.getAttribute("data-ft-skin")).toBe("catppuccin");
    expect(el.hasAttribute("data-ft-font")).toBe(true);
    const style = document.getElementById("ft-skin-style") as HTMLStyleElement;
    expect(style).toBeTruthy();
    expect(style.textContent).toContain("--ft-bg: #1e1e2e");
    expect(style.textContent).toContain('html[data-ft-skin="github"]');
  });

  it("GitHub 主题名生效", () => {
    const { controller } = setup({ themeName: "github" });
    controller.apply();
    expect(document.documentElement.getAttribute("data-ft-skin")).toBe("github");
  });

  it("无效主题名回退 catppuccin", () => {
    const { controller } = setup({ themeName: "neon" });
    controller.apply();
    expect(document.documentElement.getAttribute("data-ft-skin")).toBe("catppuccin");
  });

  it("非答题页：不加属性、不注入样式", () => {
    const { controller } = setup({ answer: false });
    controller.apply();
    expect(document.documentElement.hasAttribute("data-ft-skin")).toBe(false);
    expect(document.documentElement.hasAttribute("data-ft-font")).toBe(false);
    expect(document.getElementById("ft-skin-style")).toBeNull();
  });

  it("主题关、字体开：只保留 data-ft-font", () => {
    const { controller } = setup({ themeOn: false, fontOn: true });
    controller.apply();
    expect(document.documentElement.hasAttribute("data-ft-skin")).toBe(false);
    expect(document.documentElement.hasAttribute("data-ft-font")).toBe(true);
    expect(document.getElementById("ft-skin-style")).toBeTruthy();
  });

  it("全关：属性都移除、不注入样式", () => {
    const { controller } = setup({ themeOn: false, fontOn: false });
    controller.apply();
    expect(document.documentElement.hasAttribute("data-ft-skin")).toBe(false);
    expect(document.documentElement.hasAttribute("data-ft-font")).toBe(false);
    expect(document.getElementById("ft-skin-style")).toBeNull();
  });

  it("重复 apply 不重复注入", () => {
    const { controller, state } = setup();
    controller.apply();
    state.themeName = "github";
    controller.apply();
    expect(document.querySelectorAll("#ft-skin-style")).toHaveLength(1);
    expect(document.documentElement.getAttribute("data-ft-skin")).toBe("github");
  });
});
