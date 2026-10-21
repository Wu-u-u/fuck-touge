/**
 * 主题控制器：defineTheme、接管 setTheme、按开关应用主题、ensureDarkMode。
 * 与 main.ts 原实现一致：平台主题名 → Catppuccin/GitHub 深/浅变体；关闭时还原平台主题。
 */

import { $, $$ } from "../../shared/dom";
import type { MonacoLike, ThemeName } from "../../shared/types";
import type { TokenizerController } from "./tokenizer";
import { THEME_CHOICES, UI_THEMES, uiTheme } from "./themes";

export interface ThemeControllerDeps {
  getMonaco(): MonacoLike | undefined;
  isThemeOn(): boolean;
  getThemeName(): ThemeName;
  tokenizer: TokenizerController;
  timers?: { setTimeout(fn: () => void, ms: number): unknown };
}

export interface ThemeController {
  attach(M: MonacoLike): void;
  apply(): void;
  ensureDarkMode(): void;
  observeEditorTheme(el: Element): void;
  onAttached(M: MonacoLike): void;
  getPlatformTheme(): string;
  hasThemeTouched(): boolean;
}

export function createThemeController(deps: ThemeControllerDeps): ThemeController {
  let platformTheme = "vs-dark"; // 平台请求的主题：vs=浅色 / vs-dark=深色
  let themeTouched = false; // 平台是否主动调过 setTheme
  const timers = deps.timers || { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };

  const apply = (): void => {
    try {
      (deps.getMonaco()?.editor as any)?.__ftOrigSetTheme?.(
        deps.isThemeOn() ? uiTheme(platformTheme, deps.getThemeName()) : platformTheme,
      );
    } catch (e) {}
    if (deps.isThemeOn()) deps.tokenizer.install();
    else deps.tokenizer.restore();
  };

  // “默认深色”：启用时若平台是白背景，就点它自己的设置切到黑色背景（一次性、尽力而为）
  const ensureDarkMode = (): void => {
    if (platformTheme !== "vs") return;
    try {
      $$<HTMLElement>("i").find((e) => String(e.className).includes("icon-shezhi9"))?.click();
      timers.setTimeout(() => {
        try {
          const item = $<HTMLElement>(".tpi-code-setting .ant-select-selection-item");
          if (!item || (item.getAttribute("title") || item.innerText).indexOf("白色背景") < 0) return;
          const sel = $(".tpi-code-setting .ant-select-selector");
          sel?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          sel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          timers.setTimeout(() => {
            const opt = $$<HTMLElement>(".ant-select-item").find(
              (o) => (o.innerText || "").trim() === "黑色背景",
            );
            if (!opt) return;
            opt.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            timers.setTimeout(
              () => $$<HTMLElement>("i").find((e) => String(e.className).includes("icon-shezhi9"))?.click(),
              500,
            ); // 收起设置面板
          }, 300);
        } catch (e) {}
      }, 400);
    } catch (e) {}
  };

  const attach = (M: MonacoLike): void => {
    if (!M?.editor || (M.editor as any).__ftUIHooked) return;
    (M.editor as any).__ftUIHooked = true;

    if (!(M.editor as any).__ftThemesDefined) {
      (M.editor as any).__ftThemesDefined = true;
      Object.entries(UI_THEMES).forEach(([name, theme]) => {
        try {
          M.editor!.defineTheme?.(name, theme);
        } catch (e) {}
      });
    }

    const origSetTheme = M.editor.setTheme?.bind(M.editor);
    if (origSetTheme) {
      M.editor.__ftOrigSetTheme = origSetTheme;
      M.editor.setTheme = (name: string) => {
        themeTouched = true;
        platformTheme = name;
        return origSetTheme(deps.isThemeOn() ? uiTheme(name, deps.getThemeName()) : name);
      };
    }

    deps.tokenizer.installHook(M);
  };

  const onAttached = (M: MonacoLike): void => {
    if (deps.isThemeOn()) {
      try {
        (M.editor as any)?.__ftOrigSetTheme?.(uiTheme(platformTheme, deps.getThemeName()));
      } catch (e) {}
      deps.tokenizer.install();
      deps.tokenizer.scheduleRetries(); // 内置 Java 语法异步装载，装完会覆盖我们
    }
    if (deps.isThemeOn() && !(M.editor as any).__ftDarkChecked) {
      // 主题默认开启 → 首次进页面尝试切到黑色背景
      (M.editor as any).__ftDarkChecked = true;
      timers.setTimeout(() => ensureDarkMode(), 600);
    }
  };

  const observeEditorTheme = (el: Element): void => {
    if (themeTouched) return; // 页面没调过 setTheme → 从编辑器 class 判断深浅
    platformTheme = el.classList.contains("vs-dark") ? "vs-dark" : "vs";
  };

  return {
    attach,
    apply,
    ensureDarkMode,
    observeEditorTheme,
    onAttached,
    getPlatformTheme: () => platformTheme,
    hasThemeTouched: () => themeTouched,
  };
}
