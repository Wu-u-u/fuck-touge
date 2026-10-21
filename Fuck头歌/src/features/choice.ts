/**
 * 选择题评测观察（从 main.ts 原样抽出）：
 * - 手动点「评测」且页面无 Monaco 编辑器 → 开始观察；
 * - 看到庆祝弹层（=.通过）→ 停止观察，交给 auto-next 弹层路径跳关；
 * - 3 秒内没有弹层 → 视为未通过，只提示「未检测到通过，已停止自动跳转」，不跳关；
 * - 换关 → 立即作废（不在新关弹旧提示）。
 */

import { $, $$, levelKey, visible } from "../shared/dom";
import { toast as defaultToast } from "../ui/toast";

export interface ChoiceWatcherDeps {
  toast?: (msg: string) => void;
  now?: () => number;
}

export interface ChoiceWatcher {
  install(): () => void;
  isWatching(): boolean;
}

export function createChoiceWatcher(deps: ChoiceWatcherDeps = {}): ChoiceWatcher {
  const toast = deps.toast || defaultToast;
  const now = deps.now || (() => Date.now());
  let choiceEval: { at: number; key: string } | null = null; // { 评测开始时间戳, 关卡标识 }

  const resultBox = () =>
    $$(".evaluate-result-container, [class*=\"evaluate-result\"]").find(visible) || null;

  const watch = (): void => {
    if (!choiceEval) return;
    // 换关了 → 上一次评测的观察立即作废，不能在新关弹旧提示
    if (levelKey() !== choiceEval.key) {
      choiceEval = null;
      return;
    }
    // 平台只在“通过”（含部分正确）时弹庆祝弹层，失败没有任何可判定信号；
    // 因此：看到弹层 → 交给弹层路径跳关；一段时间内没有弹层 → 视为未通过，只提示不跳关。
    if (resultBox()) {
      choiceEval = null;
      return;
    }
    if (now() - choiceEval.at > 3000) {
      choiceEval = null;
      toast("未检测到通过，已停止自动跳转");
      return;
    }
    setTimeout(watch, 150);
  };

  const onClick = (e: Event): void => {
    const btn = (e.target as Element | null)?.closest?.("button, [role=button], a");
    if (!btn || ((btn as HTMLElement).innerText || "").trim() !== "评测" || $(".monaco-editor")) return; // 仅限选择题
    choiceEval = { at: now(), key: levelKey() };
    setTimeout(watch, 150);
  };

  const install = (): (() => void) => {
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  };

  return { install, isWatching: () => !!choiceEval };
}
