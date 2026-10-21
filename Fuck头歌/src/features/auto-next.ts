/**
 * 自动下一关（从 main.ts 原样抽出）：
 * - 庆祝弹层出现 → 找可见的「下一关/最后一关/完成」→ 200ms 后模拟完整鼠标序列点击；
 * - 双路径互斥 claimJump（同一关 5s 内只认领一次）、换关重置、sessionStorage 落地提示；
 * - MutationObserver（200ms 节流）+ 1s interval。
 */

import { $$, levelKey, normText, visible } from "../shared/dom";
import { toast as defaultToast } from "../ui/toast";

export { levelKey };

export const JUMP_KEY = "fuckTougeAutoJumpAt";
export const JUMP_MSG: Record<string, string> = {
  next: "已为您自动跳转至下一关 😋",
  last: "已经是最后一关了 😋",
};

// 弹层按钮文案 → 类型：普通关「下一关」；最后一关「最后一关」；最后的测试关是「完成」
export const NEXT_LABELS: Record<string, "next" | "last"> = {
  下一关: "next",
  最后一关: "last",
  完成: "last",
};

export interface AutoNextDeps {
  toast?: (msg: string) => void;
  onTick?: () => void;
  now?: () => number;
}

export interface AutoNextController {
  install(): () => void;
  autoNext(): void;
  claimJump(key: string): boolean;
  resetClaim(): void;
  getClaim(): { key: string; at: number };
}

export function findNextBtn(box: ParentNode): { el: HTMLElement; kind: "next" | "last" } | null {
  for (const el of $$<HTMLElement>("a, button, [role=button]", box)) {
    const kind = NEXT_LABELS[normText(el.innerText)];
    if (kind && visible(el)) return { el, kind };
  }
  return null;
}

/** 完整鼠标序列，兼容只监听 pointer/mousedown 的组件 */
export function clickLikeUser(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
  } catch (e) {}
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  try {
    el.dispatchEvent(new PointerEvent("pointerup", opts));
  } catch (e) {}
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

export function createAutoNext(deps: AutoNextDeps = {}): AutoNextController {
  const toast = deps.toast || defaultToast;
  const now = deps.now || (() => Date.now());
  const jumpClaim = { key: "", at: 0 };
  let jumpTimer = 0;

  // 整页刷新场景：落地后补一条提示（"时间戳|类型"，兼容只有时间戳的旧格式）
  try {
    const [atStr, kind] = String(sessionStorage.getItem(JUMP_KEY) || "").split("|");
    const at = Number(atStr);
    if (at && now() - at < 15000) {
      sessionStorage.removeItem(JUMP_KEY);
      const msg = JUMP_MSG[kind] || JUMP_MSG.next;
      const t = setInterval(() => document.body && (clearInterval(t), toast(msg)), 100);
      setTimeout(() => clearInterval(t), 10000);
    }
  } catch (e) {}

  const jumpNotice = (kind: string): void => {
    toast(JUMP_MSG[kind] || JUMP_MSG.next);
    try {
      sessionStorage.setItem(JUMP_KEY, now() + "|" + (kind || "next"));
      if (jumpTimer) clearTimeout(jumpTimer); // 连续跳转时，别让旧的清除定时器误删新标记
      jumpTimer = setTimeout(() => sessionStorage.removeItem(JUMP_KEY), 5000);
    } catch (e) {}
  };

  // 双路径互斥：结果弹层 / 选择题页面按钮，同一关只允许认领一次（防止连跳两关）
  const claimJump = (key: string): boolean => {
    const t = now();
    if (jumpClaim.key !== key) {
      jumpClaim.key = key;
      jumpClaim.at = 0;
    } // 换关了 → 重新允许
    if (jumpClaim.at && t - jumpClaim.at < 5000) return false; // 已被另一条路径认领
    jumpClaim.at = t;
    return true;
  };

  const autoNext = (): void => {
    const boxes = $$<HTMLElement>(".evaluate-result-container");
    const box = boxes.find(visible) as (HTMLElement & {
      __ftClicked?: boolean;
      __ftSeenAt?: number;
      __ftLastToast?: boolean;
    }) | undefined;
    if (!box) {
      // 无可见弹层时重置标记（兼容弹层被复用的情况）
      boxes.forEach((b: any) => {
        b.__ftClicked = false;
        b.__ftSeenAt = 0;
        b.__ftLastToast = false;
      });
      return;
    }
    if (box.__ftClicked) return;

    box.__ftSeenAt = box.__ftSeenAt || now();
    const next = findNextBtn(box);

    if (!next) {
      // 弹层出现 9 秒还没有按钮 → 保守提示（不一定是最后一关）
      if (!box.__ftLastToast && now() - (box.__ftSeenAt || 0) > 9000) {
        box.__ftLastToast = true;
        toast("未检测到跳转按钮");
      }
      return;
    }

    if ((next.el as any).disabled === true || next.el.getAttribute("aria-disabled") === "true") {
      if (!box.__ftLastToast && now() - (box.__ftSeenAt || 0) > 10000) {
        box.__ftLastToast = true;
        toast("跳转按钮未激活，请手动点击「下一关」"); // 不再静默放弃
      }
      return; // 按钮还没激活（评测刚结束时短暂禁用）→ 下一轮再点
    }

    box.__ftClicked = true;
    const key = levelKey();
    setTimeout(() => {
      if (!next.el.isConnected) {
        box.__ftClicked = false;
        return;
      } // SPA 重渲染换掉了按钮 → 下一轮重新找
      if (levelKey() !== key) return; // 已换关 → 放弃本次点击
      if (!claimJump(key)) return; // 另一条路径已认领 → 只跳一次
      clickLikeUser(next.el);
      jumpNotice(next.kind);
    }, 200);
  };

  const install = (): (() => void) => {
    // document 在 document_start 时必然存在（documentElement 可能还没有）
    let autoNextAt = 0;
    const observer = new MutationObserver(() => {
      // 页面 DOM 变动很频繁，节流后再查弹层
      const t = now();
      if (t < autoNextAt) return;
      autoNextAt = t + 200;
      autoNext();
    });
    observer.observe(document, { childList: true, subtree: true });
    const interval = setInterval(() => {
      autoNext();
      deps.onTick?.();
    }, 1000); // 属性清理交由 attrs 模块的 MutationObserver，不再每秒全量扫
    return () => {
      observer.disconnect();
      clearInterval(interval);
    };
  };

  return {
    install,
    autoNext,
    claimJump,
    resetClaim: () => {
      jumpClaim.key = "";
      jumpClaim.at = 0;
    },
    getClaim: () => ({ ...jumpClaim }),
  };
}
