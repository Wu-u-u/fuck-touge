import { COLOR_DEFS, contrastText, isImageSource, normalizeCustomConfig } from "../shared/custom";
import type { CustomConfig } from "../shared/types";
import { isAnswerPage } from "./theme/skin";

const STYLE_ID = "ft-custom-visual";
const BG_ID = "ft-bg";
const BRIDGE_SOURCE = "fuck-touge-bridge";
const MAIN_SOURCE = "fuck-touge-main";

export interface CustomVisualDeps {
  isThemeOn(): boolean;
  isAnswerPage?(): boolean;
  isTopFrame?(): boolean;
  onConfig?(config: CustomConfig): void;
}

export interface CustomVisualController {
  install(): void;
  apply(): void;
  dispose(): void;
  getConfig(): CustomConfig;
}

const defaultTopFrame = (): boolean => {
  try {
    return window.top === window;
  } catch (e) {
    return false;
  }
};

/**
 * 背景与页面颜色（只作用于答题页 + 主题开启 + 顶层 frame）。
 * 配置来自 bridge 的 postMessage；本模块不直接碰 chrome.storage。
 */
export function createCustomVisual(deps: CustomVisualDeps): CustomVisualController {
  const onAnswerPage = deps.isAnswerPage || (() => isAnswerPage());
  const onTopFrame = deps.isTopFrame || defaultTopFrame;
  let config: CustomConfig = normalizeCustomConfig(null);
  let retryTimer = 0;

  const clearRetry = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
  };

  const scheduleRetry = (): void => {
    if (retryTimer) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      apply();
    }, 50);
  };

  const ensureStyle = (css: string): void => {
    try {
      let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head || document.documentElement)?.appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
    } catch (e) {}
  };

  const removeStyle = (): void => {
    try {
      document.getElementById(STYLE_ID)?.remove();
    } catch (e) {}
  };

  const removeBg = (): void => {
    try {
      document.getElementById(BG_ID)?.remove();
    } catch (e) {}
  };

  const ensureBg = (bg: CustomConfig["background"]): void => {
    if (!document.body) {
      scheduleRetry();
      return;
    }
    let el = document.getElementById(BG_ID) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = BG_ID;
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    }
    // JSON.stringify 给 url() 做转义，data URL / 外链里的引号不会破坏 CSS
    el.style.backgroundImage = `url(${JSON.stringify(bg.image)})`;
    el.style.backgroundSize =
      bg.fit === "stretch" ? "100% 100%" : bg.fit === "contain" ? "contain" : "cover";
    el.style.backgroundPosition = "center";
    el.style.backgroundRepeat = "no-repeat";
    el.style.opacity = String(bg.opacity);
    el.style.position = bg.fixed ? "fixed" : "absolute";
    el.style.inset = "0";
    el.style.zIndex = "-1";
    el.style.pointerEvents = "none";
  };

  const buildCss = (cfg: CustomConfig, withBg: boolean): string => {
    const rules: string[] = [];
    const colorLines: string[] = [];

    for (const def of COLOR_DEFS) {
      const value = cfg.colors[def.key];
      if (!value) continue;
      colorLines.push(`  ${def.cssVar}: ${value};`);
      // 让同一颜色覆盖到关联变量，避免面板/边框/链接还是旧色
      if (def.key === "panel") colorLines.push(`  --ft-panel2: ${value};`);
      if (def.key === "border") colorLines.push(`  --ft-code-border: ${value};`);
      if (def.key === "accent") {
        colorLines.push(`  --ft-link: ${value};`);
        colorLines.push(`  --ft-accent-fg: ${contrastText(value)};`);
      }
    }
    if (colorLines.length) {
      rules.push(`html[data-ft-skin] {\n${colorLines.join("\n")}\n}`);
    }

    if (withBg) {
      const panelAlpha = `${Math.round(cfg.background.panelOpacity * 100)}%`;
      const editorAlpha = `${Math.round(cfg.background.editorOpacity * 100)}%`;
      rules.push(`html[data-ft-skin][data-ft-bg] { --ft-panel-alpha: ${panelAlpha}; --ft-editor-alpha: ${editorAlpha}; }`);
      rules.push(`html[data-ft-skin][data-ft-bg] body { background: transparent !important; }`);
      if (!cfg.background.fixed) {
        rules.push(`html[data-ft-skin][data-ft-bg] body { position: relative; }`);
      }
      rules.push(`html[data-ft-skin][data-ft-bg] :is(
  .left-panel, .task-header,
  [class*="task-header"], [class*="tab-nav"], [class*="tabs___"],
  [class*="test-case-item"], [class*="content-wrapper"], [class*="resize-y-bar"]
) { background-color: color-mix(in srgb, var(--ft-panel) var(--ft-panel-alpha), transparent) !important; }`);
      // 左侧面板内部还有 task-header / tab-nav / content-wrapper 自带底色；不清掉会三层叠加，背景几乎看不见
      rules.push(`html[data-ft-skin][data-ft-bg] .left-panel :is(
  .task-header, [class*="tab-nav"], [class*="content-wrapper"]
) { background-color: transparent !important; }`);
      rules.push(`html[data-ft-skin][data-ft-bg] :is(
  .task-header-container, [class*="test-set-container"], [class*="action-container"],
  [class*="test-header"], [class*="choose-game-item"]
) { background-color: color-mix(in srgb, var(--ft-panel2) var(--ft-panel-alpha), transparent) !important; }`);
      // 编辑器区域单独一层：容器透明，编辑器背景用 editor-alpha；文字不受影响
      rules.push(`html[data-ft-skin][data-ft-bg] :is(.right-panel, [class*="code-area-container"]) {
  background-color: transparent !important;
}`);
      rules.push(`html[data-ft-skin][data-ft-bg] :is(
  .monaco-editor, .monaco-editor .monaco-editor-background,
  .monaco-editor .margin
) {
  background-color: color-mix(in srgb, var(--ft-bg) var(--ft-editor-alpha), transparent) !important;
}`);
    }

    return rules.join("\n");
  };

  function apply(): void {
    const root = document.documentElement;
    if (!root) {
      scheduleRetry();
      return;
    }

    const active = deps.isThemeOn() && onAnswerPage() && onTopFrame();
    const bgOn = active && config.background.enabled && isImageSource(config.background.image);
    const hasColors = active && Object.keys(config.colors).length > 0;

    if (!active) {
      clearRetry();
      root.removeAttribute("data-ft-bg");
      root.removeAttribute("data-ft-custom");
      removeStyle();
      removeBg();
      return;
    }

    if (hasColors) root.setAttribute("data-ft-custom", "");
    else root.removeAttribute("data-ft-custom");

    if (bgOn) root.setAttribute("data-ft-bg", "");
    else root.removeAttribute("data-ft-bg");

    const css = buildCss(config, bgOn);
    if (css) ensureStyle(css);
    else removeStyle();

    if (bgOn) ensureBg(config.background);
    else {
      clearRetry();
      removeBg();
    }
  }

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== window) return;
    const data = e.data as { source?: string; type?: string; config?: unknown } | null;
    if (!data || data.source !== BRIDGE_SOURCE || data.type !== "config") return;
    config = normalizeCustomConfig(data.config);
    apply();
    try {
      deps.onConfig?.(config);
    } catch (e) {}
  };

  return {
    install: (): void => {
      window.addEventListener("message", onMessage);
      try {
        window.postMessage({ source: MAIN_SOURCE, type: "config-request" }, "*");
      } catch (e) {}
      // 页面骨架出现后补一次，避免 document_start 时 body 还不存在
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply, { once: true });
      }
    },
    apply,
    getConfig: () => config,
    dispose: (): void => {
      window.removeEventListener("message", onMessage);
      clearRetry();
      removeStyle();
      removeBg();
    },
  };
}
