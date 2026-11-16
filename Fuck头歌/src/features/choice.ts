/**
 * 选择题评测观察（从 main.ts 原样抽出）：
 * - 手动点「评测」且页面无 Monaco 编辑器 → 开始观察；
 * - 兼容旧路径：看到庆祝弹层（=.evaluate-result-container）→ 停止观察，交给 auto-next 跳关；
 * - 新路径：平台只给 `.test-result.success` 面板（无庆祝弹层）时，等新面板出现后点工具栏「下一关」；
 * - 评测前已有的旧 `.test-result` 只作为基线，不动它、不拿它当本次结果；
 * - `.test-result.failer` → 不跳，保留失败提示；
 * - 没有可见「下一关」（最后一关）→ 不跳；
 * - 换关 → 立即停止观察；10 秒没有新面板 → 提示一次，不误跳；
 * - 新旧路径通过 `claimJump()` 互斥，同一关只能跳一次。
 */

import { $, $$, levelKey, visible } from "../shared/dom";
import { clickLikeUser, findToolbarNextBtn } from "./auto-next";
import { toast as defaultToast } from "../ui/toast";

export interface ChoiceWatcherDeps {
  toast?: (msg: string) => void;
  now?: () => number;
  claimJump?: (key: string) => boolean;
  findNext?: () => HTMLElement | null;
  clickNext?: (el: HTMLElement) => void;
}

export interface ChoiceWatcher {
  install(): () => void;
  isWatching(): boolean;
}

const TIMEOUT_MS = 10_000;
const POLL_MS = 150;

function testResults(): HTMLElement[] {
  return $$<HTMLElement>(".test-result").filter(visible);
}

export function createChoiceWatcher(deps: ChoiceWatcherDeps = {}): ChoiceWatcher {
  const toast = deps.toast || defaultToast;
  const now = deps.now || (() => Date.now());
  const claimJump = deps.claimJump || (() => true);
  const findNext = deps.findNext || findToolbarNextBtn;
  const clickNext = deps.clickNext || clickLikeUser;

  let choiceEval: {
    at: number;
    key: string;
    baseline: Set<Element>;
    notified: boolean;
  } | null = null;

  const resultBox = () =>
    $$(".evaluate-result-container, [class*=\"evaluate-result\"]").find(visible) || null;

  const stop = (): void => {
    choiceEval = null;
  };

  const fail = (): void => {
    if (!choiceEval) return;
    if (!choiceEval.notified) {
      choiceEval.notified = true;
      toast("未检测到通过，已停止自动跳转");
    }
    stop();
  };

  const watch = (): void => {
    const run = choiceEval;
    if (!run) return;
    // 换关了 → 上一次评测的观察立即作废，不能在新关弹旧提示
    if (levelKey() !== run.key) {
      stop();
      return;
    }
    // 旧庆祝弹层路径仍然优先；交给 auto-next，避免和新面板路径重复点击。
    if (resultBox()) {
      stop();
      return;
    }

    const panels = testResults();
    const fresh = (el: Element): boolean => !run.baseline.has(el) || !el.isConnected;
    const newFailer = panels.find((el) => el.classList.contains("failer") && fresh(el));
    if (newFailer) {
      stop();
      return;
    }

    const newSuccess = panels.find((el) => el.classList.contains("success") && fresh(el));
    if (newSuccess) {
      const next = findNext();
      // 最后一关没有工具栏「下一关」；不要硬跳。
      if (!next) {
        stop();
        return;
      }
      if ((next as HTMLButtonElement).disabled === true
          || next.getAttribute("aria-disabled") === "true") {
        // 刚评测结束时按钮可能短暂禁用，下一轮再试。
        if (now() - run.at > TIMEOUT_MS) fail();
        else setTimeout(watch, POLL_MS);
        return;
      }
      if (!claimJump(run.key)) {
        stop();
        return;
      }
      clickNext(next);
      stop();
      return;
    }

    if (now() - run.at > TIMEOUT_MS) {
      fail();
      return;
    }
    setTimeout(watch, POLL_MS);
  };

  const onClick = (e: Event): void => {
    const btn = (e.target as Element | null)?.closest?.("button, [role=button], a");
    if (!btn || ((btn as HTMLElement).innerText || "").trim() !== "评测" || $(".monaco-editor")) return; // 仅限选择题
    choiceEval = {
      at: now(),
      key: levelKey(),
      baseline: new Set(testResults()),
      notified: false,
    };
    setTimeout(watch, POLL_MS);
  };

  const install = (): (() => void) => {
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  };

  return { install, isWatching: () => !!choiceEval };
}
