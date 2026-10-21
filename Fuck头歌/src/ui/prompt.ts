/**
 * 首次字体询问卡片（每页最多一张；是否询问由调用方通过 shouldAsk 决定）。
 * 逻辑/样式与原先 main.ts 内的 showUIPrompt + maybeAskUI 保持一致。
 */

import { $ } from "../shared/dom";

export interface FontPromptDeps {
  /** 是否需要询问（通常是 !fontAsked && !fontOn） */
  shouldAsk(): boolean;
  /** 用户选择后写状态（启用/暂不） */
  setFont(on: boolean): void;
}

export interface FontPrompt {
  show(): void;
  maybeAsk(): void;
}

export function createFontPrompt(deps: FontPromptDeps): FontPrompt {
  const show = (): void => {
    if ($(".fuck-touge-ui-prompt")) return;
    const wrap = document.createElement("div");
    wrap.className = "fuck-touge-ui-prompt";
    wrap.style.cssText =
      "position:fixed;right:16px;top:70px;z-index:2147483646;max-width:320px;" +
      "background:#1e1e1e;color:#eee;border:1px solid #3a3a3a;border-radius:12px;" +
      "padding:14px 16px;font-size:13px;line-height:1.6;box-shadow:0 10px 30px rgba(0,0,0,.45);";
    wrap.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;">Fuck 头歌 · 编辑器增强</div>' +
      '<div style="opacity:.85;margin-bottom:10px;">检测到头歌编辑器：是否启用更舒适的 Maple Mono 字体？（主题已默认开启）</div>' +
      '<div style="opacity:.6;font-size:12px;margin-bottom:12px;">提示：内置字体只替换英文/代码符号；想替换中文请自行安装 Maple Mono NF CN 字体</div>';
    const mkBtn = (text: string, primary: boolean): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText =
        "border:0;border-radius:8px;padding:6px 16px;font-size:13px;cursor:pointer;margin-right:8px;" +
        (primary ? "background:#1677ff;color:#fff;" : "background:#333;color:#ddd;");
      return b;
    };
    const done = (on: boolean): void => {
      deps.setFont(on);
      wrap.remove();
    };
    const yes = mkBtn("启用", true);
    const no = mkBtn("暂不", false);
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    wrap.append(yes, no);
    (document.body || document.documentElement).appendChild(wrap);
  };

  const maybeAsk = (): void => {
    try {
      if (!deps.shouldAsk()) return; // 字体问过一次 / 已开启就不再打扰
      if (!$(".monaco-editor")) return; // 只在有编辑器的页面询问
      show();
    } catch (e) {}
  };

  return { show, maybeAsk };
}
