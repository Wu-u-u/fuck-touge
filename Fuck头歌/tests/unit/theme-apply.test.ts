// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThemeController } from "../../src/features/theme/apply";

function makeM() {
  const defined: Array<{ name: string; data: unknown }> = [];
  const setThemeCalls: string[] = [];
  const editor: any = {
    defineTheme(name: string, data: unknown) {
      defined.push({ name, data });
    },
    setTheme(name: string) {
      setThemeCalls.push(name);
    },
  };
  const M: any = { editor, languages: { setMonarchTokensProvider() {} } };
  return { M, defined, setThemeCalls };
}

function makeTokenizer() {
  return {
    installHook: vi.fn(),
    install: vi.fn(),
    restore: vi.fn(),
    scheduleRetries: vi.fn(),
  };
}

function setup(themeOn = true, themeName: "catppuccin" | "github" = "catppuccin") {
  const { M, defined, setThemeCalls } = makeM();
  const tokenizer = makeTokenizer();
  const timers = { setTimeout: vi.fn((_fn: () => void, _ms: number) => 0) };
  const controller = createThemeController({
    getMonaco: () => M,
    isThemeOn: () => themeOn,
    getThemeName: () => themeName,
    tokenizer,
    timers,
  });
  return { M, defined, setThemeCalls, tokenizer, controller, timers };
}

afterEach(() => {
  vi.clearAllTimers();
});

describe("attach", () => {
  it("定义 4 套主题且只定义一次", () => {
    const { M, defined, tokenizer, controller } = setup();
    controller.attach(M);
    expect(defined.map((d) => d.name).sort()).toEqual([
      "catppuccin-latte",
      "catppuccin-mocha",
      "github-hc-dark",
      "github-hc-light",
    ]);
    controller.attach(M);
    expect(defined).toHaveLength(4);
    expect(tokenizer.installHook).toHaveBeenCalledTimes(1);
  });

  it("接管 setTheme：开启时映射为主题变体并记录平台主题", () => {
    const { M, setThemeCalls, controller } = setup(true, "github");
    controller.attach(M);
    M.editor.setTheme("vs-dark");
    expect(setThemeCalls).toEqual(["github-hc-dark"]);
    expect(controller.getPlatformTheme()).toBe("vs-dark");
    expect(controller.hasThemeTouched()).toBe(true);
  });

  it("关闭时 setTheme 透传平台名", () => {
    const { M, setThemeCalls, controller } = setup(false);
    controller.attach(M);
    M.editor.setTheme("vs");
    expect(setThemeCalls).toEqual(["vs"]);
    expect(controller.getPlatformTheme()).toBe("vs");
  });
});

describe("apply", () => {
  it("开启 → 应用映射后的主题并安装 tokenizer", () => {
    const { M, setThemeCalls, tokenizer, controller } = setup(true);
    controller.attach(M);
    controller.apply();
    expect(setThemeCalls).toEqual(["catppuccin-mocha"]);
    expect(tokenizer.install).toHaveBeenCalledTimes(1);
    expect(tokenizer.restore).not.toHaveBeenCalled();
  });

  it("关闭 → 还原平台主题并 restore tokenizer", () => {
    const { M, setThemeCalls, tokenizer, controller } = setup(false);
    controller.attach(M);
    M.editor.setTheme("vs");
    controller.apply();
    expect(setThemeCalls).toEqual(["vs", "vs"]);
    expect(tokenizer.restore).toHaveBeenCalledTimes(1);
    expect(tokenizer.install).not.toHaveBeenCalled();
  });
});

describe("observeEditorTheme", () => {
  it("平台未调过 setTheme 时按编辑器 class 判断深浅", () => {
    const { controller } = setup();
    const dark = document.createElement("div");
    dark.className = "monaco-editor vs-dark";
    controller.observeEditorTheme(dark);
    expect(controller.getPlatformTheme()).toBe("vs-dark");

    const light = document.createElement("div");
    light.className = "monaco-editor vs";
    controller.observeEditorTheme(light);
    expect(controller.getPlatformTheme()).toBe("vs");
  });

  it("平台调过 setTheme 后不再覆盖", () => {
    const { M, controller } = setup();
    controller.attach(M);
    M.editor.setTheme("vs-dark");
    const light = document.createElement("div");
    light.className = "vs";
    controller.observeEditorTheme(light);
    expect(controller.getPlatformTheme()).toBe("vs-dark");
  });
});

describe("onAttached", () => {
  it("开启 → 应用主题、安装 + 重试 tokenizer、600ms 后尝试深色", () => {
    const { M, setThemeCalls, tokenizer, controller, timers } = setup(true);
    controller.attach(M);
    controller.onAttached(M);
    expect(setThemeCalls).toEqual(["catppuccin-mocha"]);
    expect(tokenizer.install).toHaveBeenCalledTimes(1);
    expect(tokenizer.scheduleRetries).toHaveBeenCalledTimes(1);
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 600);
  });

  it("关闭 → 不安装 tokenizer、不调度深色", () => {
    const { M, tokenizer, controller, timers } = setup(false);
    controller.attach(M);
    controller.onAttached(M);
    expect(tokenizer.install).not.toHaveBeenCalled();
    expect(tokenizer.scheduleRetries).not.toHaveBeenCalled();
    expect(timers.setTimeout).not.toHaveBeenCalled();
  });
});

describe("ensureDarkMode", () => {
  it("平台不是浅色 → 直接返回", () => {
    const { controller, timers } = setup();
    controller.ensureDarkMode();
    expect(timers.setTimeout).not.toHaveBeenCalled();
  });

  it("平台是浅色 → 安排 400ms 后操作设置面板（无对应 DOM 时安全 no-op）", () => {
    const { controller, timers } = setup();
    const light = document.createElement("div");
    light.className = "vs";
    controller.observeEditorTheme(light);
    expect(() => controller.ensureDarkMode()).not.toThrow();
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 400);
  });
});
