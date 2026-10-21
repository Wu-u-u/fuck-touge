/**
 * 页面皮肤：SKIN_CSS + data-ft-skin / data-ft-font 属性 + 样式注入。
 * 行为与 main.ts 原实现一致（仅答题页生效；等 <head>，5s 超时退回 documentElement）。
 */

import { $ } from "../../shared/dom";
import type { ThemeName } from "../../shared/types";
import skinCss from "./skin.css?raw";

export const SKIN_CSS = skinCss;
export const HEAD_WAIT_MS = 5000;

/** 答题页（…/tasks/课程/关卡组/关卡）；主页/目录保持平台原样 */
export const isAnswerPage = (pathname: string = location.pathname): boolean =>
  /^\/tasks\/[^/]+\/[^/]+\/[^/]+/.test(pathname);

export interface SkinControllerDeps {
  isThemeOn(): boolean;
  getThemeName(): ThemeName;
  isFontOn(): boolean;
  /** 默认使用 location.pathname 判断答题页；测试可注入 */
  isAnswerPage?(): boolean;
  timers?: { setTimeout(fn: () => void, ms: number): unknown };
}

export interface SkinController {
  apply(): void;
}

export function createSkinController(deps: SkinControllerDeps): SkinController {
  const timers = deps.timers || { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };
  const onAnswerPage = deps.isAnswerPage || (() => isAnswerPage());
  let skinStyle: HTMLStyleElement | null = null; // 在途（还没挂上）的样式节点

  const attachSkinStyle = (): void => {
    const pending = skinStyle;
    skinStyle = null;
    if (!pending) return;
    try {
      const root = document.head || document.documentElement;
      if (root && !pending.isConnected) root.appendChild(pending);
    } catch (e) {
      /* 挂载失败就放弃，下次 apply 发现缺样式会重建 */
    }
  };

  // 皮肤样式：document_start 时 <head> 可能还没出现，直接挂 documentElement 虽然也生效，
  // 但页面骨架载入后容易被整体替换掉——所以等 head 出现（MutationObserver，另设超时上限），
  // 上限 HEAD_WAIT_MS 内没等到再退回 documentElement，保证样式最终一定挂上
  const injectSkinStyle = (): void => {
    if (skinStyle || $("#ft-skin-style")) return; // 已挂上 / 已在途就不重复注入
    const style = document.createElement("style");
    style.id = "ft-skin-style";
    style.textContent = SKIN_CSS;
    skinStyle = style;
    if (document.head) {
      attachSkinStyle();
      return;
    }
    let mo: MutationObserver | null = null;
    const cap = timers.setTimeout(() => {
      try {
        mo?.disconnect();
      } catch (e) {}
      attachSkinStyle();
    }, HEAD_WAIT_MS);
    try {
      mo = new MutationObserver(() => {
        if (!document.head) return;
        clearTimeout(cap as any);
        try {
          mo!.disconnect();
        } catch (e) {}
        attachSkinStyle();
      });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) {
      clearTimeout(cap as any);
      attachSkinStyle();
    }
  };

  const apply = (): void => {
    const el = document.documentElement;
    if (!el) {
      timers.setTimeout(apply, 10); // document_start 早期可能还没有 <html>
      return;
    }
    const on = onAnswerPage(); // 皮肤只作用于答题页，主页/目录保持平台原样
    const themeOn = deps.isThemeOn();
    const fontOn = deps.isFontOn();
    themeOn && on
      ? el.setAttribute("data-ft-skin", deps.getThemeName() === "github" ? "github" : "catppuccin")
      : el.removeAttribute("data-ft-skin");
    fontOn && on ? el.setAttribute("data-ft-font", "") : el.removeAttribute("data-ft-font");
    if (on && (themeOn || fontOn)) injectSkinStyle(); // 去重/等 head/超时兜底都在这里面
  };

  return { apply };
}
