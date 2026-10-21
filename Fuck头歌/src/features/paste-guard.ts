/**
 * 粘贴回落保护 + 按键直通（从 main.ts 原样抽出）。
 *
 * 语义（必须与抽出前一致）：
 * - 粘贴时开 300ms 保护窗口；窗口内“疑似平台删除粘贴内容”会被原样插回，最多 3 次；
 * - 多段删除按偏移升序回插；回插前校验 expected 全值（模型被改过就放弃）；
 * - 用户主动编辑（剪切/鼠标/右键/输入法/输入事件/删除键/撤销等）立即取消保护；
 * - 插件自己派发的合成鼠标事件（isTrusted === false）不算用户编辑；
 * - Ctrl+V/C/X 在 window 捕获阶段 stopImmediatePropagation，绕过页面拦截。
 */

import type { MonacoModelLike } from "../shared/types";

export const GUARD_WINDOW_MS = 300;
export const PASTED_MAX = 3;

export interface ModelChange {
  changes: Array<{ text: string; rangeOffset: number; rangeLength: number }>;
}

export interface GuardModel extends MonacoModelLike {
  __ftHooked?: boolean;
  __ftLastValue?: string;
  onDidChangeContent?(listener: (e: ModelChange) => void): unknown;
  getPositionAt(offset: number): { lineNumber: number; column: number };
  applyEdits(edits: Array<{ range: unknown; text: string }>): unknown;
}

export type RangeCtor = new (startLine: number, startColumn: number, endLine: number, endColumn: number) => unknown;

export interface PastedEntry {
  start: number;
  len: number;
  text: string;
}

export interface PasteGuardDeps {
  /** 当前所有 Monaco 文本模型（粘贴时做快照） */
  getModels(): Array<GuardModel | MonacoModelLike>;
  /** 页面里的 Monaco.Range 构造器（按位置回插用） */
  getRange(): RangeCtor | null;
  /** 时钟 / 定时器（默认 Date.now / setTimeout，测试可注入） */
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
}

export interface KeyboardLike {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  keyCode?: number;
  which?: number;
  stopImmediatePropagation?(): void;
  preventDefault?(): void;
}

/** 用户主动编辑的按键：一旦按下就立刻取消粘贴保护 */
export function isUserEditKey(e: KeyboardLike): boolean {
  const key = e.key || "";
  const k = key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    // 撤销/剪切，以及 Monaco 常用删词/删行和弦（Ctrl+Backspace、Ctrl+Shift+K）
    return (
      k === "z" ||
      k === "x" ||
      k === "backspace" ||
      k === "delete" ||
      (k === "k" && !!e.shiftKey)
    );
  }
  if (e.altKey) return k === "backspace" || k === "delete"; // Mac 删词
  if (key === "Backspace" || key === "Delete" || key === "Enter" || key === "Tab") return true;
  return key.length === 1; // 可打印输入
}

/** before/after 的公共前后缀 → 差异范围（before 坐标） */
export function diffRange(before: string, after: string): { start: number; end: number } {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  return { start: p, end: before.length - s };
}

/** 删除区间是否命中“刚粘贴的文本”（疑似平台篡改）；最近几次粘贴逐条比对 */
export function suspectTamper(
  entries: PastedEntry[],
  dStart: number,
  dEnd: number,
  removed: string,
): boolean {
  const len = dEnd - dStart;
  if (len <= 0) return false;
  for (const p of entries) {
    if (!p.text) continue; // 不知道粘贴内容 → 不回插（宁漏勿误伤）
    if (p.start >= 0 && p.len > 0) {
      // ① 位置重合
      const pEnd = p.start + p.len;
      const ov = Math.min(dEnd, pEnd) - Math.max(dStart, p.start);
      if (ov > 0 && ov / Math.min(len, p.len) >= 0.5) return true;
    }
    const short = removed.length <= p.text.length ? removed : p.text;
    const long = removed.length <= p.text.length ? p.text : removed;
    if (short.length >= 4 && long.includes(short)) return true; // ② 内容基本一致（单字符不算）
  }
  return false;
}

export interface PasteGuardState {
  watchUntil: number;
  undoCount: number;
  guardGen: number;
  pasted: PastedEntry[];
}

export interface PasteGuard {
  /** 注册全部事件监听；返回 dispose（测试用，主流程不调用） */
  install(): () => void;
  hookModel(model: GuardModel): void;
  snapshotModels(): void;
  openGuard(text?: string): void;
  cancelGuard(): void;
  onModelChange(model: GuardModel, e: ModelChange): void;
  getState(): PasteGuardState;
}

export function createPasteGuard(deps: PasteGuardDeps): PasteGuard {
  let watchUntil = 0;
  let undoCount = 0;
  let guardGen = 0; // 只有 cancelGuard 自增，让已排队的回插作废
  const pasted: PastedEntry[] = []; // 最近几次粘贴（新的在前）

  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms));

  const snapshotModels = (): void => {
    try {
      deps.getModels().forEach((m) => {
        try {
          (m as GuardModel).__ftLastValue = m.getValue();
        } catch (e) {}
      });
    } catch (e) {}
  };

  const rememberPaste = (text?: string): void => {
    const t = text || "";
    const head = pasted[0];
    // 同一次粘贴会先来 keydown（无文本）再来 paste（有文本）：合并成一条，别把历史挤掉
    if (head && head.start < 0 && !head.text) {
      if (t) head.text = t;
      return;
    }
    pasted.unshift({ start: -1, len: 0, text: t });
    if (pasted.length > PASTED_MAX) pasted.length = PASTED_MAX;
  };

  // 开启保护窗口（粘贴时调用）；text 为粘贴内容（拿不到就靠模型变更事件补）
  // 注意：这里不能递增 guardGen —— 连续粘贴时，上一次已排队的回插不能被新粘贴作废
  const openGuard = (text?: string): void => {
    watchUntil = now() + GUARD_WINDOW_MS;
    undoCount = 0;
    rememberPaste(text);
    snapshotModels();
  };

  // 用户主动编辑 → 立即取消保护（用户的撤销/退格绝不能被回插）
  const cancelGuard = (): void => {
    watchUntil = 0;
    undoCount = 3; // 预算置满
    guardGen++; // 已排队的回插一并作废
    pasted.length = 0;
  };

  const onModelChange = (m: GuardModel, e: ModelChange): void => {
    if (now() > watchUntil || undoCount >= 3) return; // 窗口外：不做快照（避免每次输入都 O(n)）
    const before = typeof m.__ftLastValue === "string" ? m.__ftLastValue : m.getValue();
    const after = m.getValue();
    m.__ftLastValue = after; // 快照只在保护窗口内更新

    if (pasted.length) {
      // 记录粘贴插入的位置与内容（填最新空槽）
      const slot = pasted.find((p) => p.start < 0);
      if (slot) {
        const ins = e.changes.find((c) => c.text);
        if (ins) {
          slot.start = ins.rangeOffset;
          slot.len = ins.text.length;
          if (!slot.text) slot.text = ins.text;
        }
      }
    }

    const dels = e.changes.filter((c) => !c.text && c.rangeLength > 0);
    if (!dels.length) return;
    if (after.length >= before.length) return; // 只有“纯删除”才可能是平台篡改

    const { start: dStart, end: dEnd } = diffRange(before, after);
    if (dEnd <= dStart) return;
    if (!suspectTamper(pasted, dStart, dEnd, before.slice(dStart, dEnd))) return; // 只回插疑似平台篡改

    undoCount++;
    watchUntil = now() + GUARD_WINDOW_MS; // 已确认是篡改 → 延长窗口继续守
    const gen = guardGen;
    const expected = after; // 删除后的快照：回插前模型必须仍是它
    setTimer(() => {
      if (gen !== guardGen) return; // 用户已编辑 → 作废
      try {
        // 偏移已过期（模型又被改过）就放弃，绝不把内容插到错误位置
        if (m.getValue() !== expected) return;
        // 合成 Ctrl+Z 不可靠（撤销栈可能为空/被平台清空）→ 直接把被删掉的文本插回去
        // 多段删除必须按偏移升序回插：每插回一段，后面各段的原始偏移正好被补回
        const Range = deps.getRange();
        if (!Range) return;
        dels
          .filter((c) => c.rangeOffset < dEnd && c.rangeOffset + c.rangeLength > dStart)
          .sort((a, b) => a.rangeOffset - b.rangeOffset)
          .forEach((c) => {
            const text = before.substr(c.rangeOffset, c.rangeLength);
            if (!text) return;
            const p = m.getPositionAt(c.rangeOffset);
            m.applyEdits([{ range: new Range(p.lineNumber, p.column, p.lineNumber, p.column), text }]);
          });
      } catch (err) {}
    }, 30);
  };

  const hookModel = (m: GuardModel): void => {
    if (m.__ftHooked) return;
    m.__ftHooked = true;
    m.onDidChangeContent?.((e) => onModelChange(m, e));
  };

  // 用户剪切/鼠标删除/右键菜单/输入法/输入事件都要立刻放行，
  // 不能把用户自己的编辑当成平台篡改而回插
  const cancelOnUserEdit = (e: Event): void => {
    // 插件自己派发的合成鼠标事件（isTrusted=false）不是用户编辑，不能自取消保护
    if (e && e.isTrusted === false) return;
    cancelGuard();
  };

  const cancelOnBeforeInput = (e: InputEvent): void => {
    const t = String((e as InputEvent)?.inputType || "");
    if (t === "insertFromPaste" || t === "insertFromPasteAsQuotation") return; // 粘贴本身不算用户编辑
    if (/^(?:delete|insert)/.test(t) || t === "historyUndo" || t === "historyRedo") cancelGuard();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isUserEditKey(e)) cancelGuard(); // 用户动手编辑 → 保护窗口立即关闭

    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = (e.key || "").toLowerCase();
    const code = e.keyCode || (e as any).which;
    if (key === "v" || code === 86) {
      e.stopImmediatePropagation();
      openGuard(); // 网页删除是同步的（约 10ms），窗口开 300ms 足够
    } else if (key === "c" || key === "x" || code === 67 || code === 88) {
      e.stopImmediatePropagation();
    }
  };

  const onPaste = (e: ClipboardEvent): void => {
    let text = "";
    try {
      text =
        (e.clipboardData as any)?.getData?.("text/plain") ||
        (e.clipboardData as any)?.getData?.("text") ||
        "";
    } catch (err) {}
    openGuard(text); // 同步窗口；同时重置“撤销预算”，右键粘贴也能持续受保护
    if (document.activeElement?.closest?.(".monaco-editor")) e.preventDefault();
  };

  const install = (): (() => void) => {
    const types = ["cut", "mousedown", "contextmenu", "compositionstart"];
    types.forEach((type) => {
      window.addEventListener(type, cancelOnUserEdit, true);
      document.addEventListener(type, cancelOnUserEdit, true);
    });
    window.addEventListener("beforeinput", cancelOnBeforeInput, true);
    document.addEventListener("beforeinput", cancelOnBeforeInput, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste, true);

    return () => {
      types.forEach((type) => {
        window.removeEventListener(type, cancelOnUserEdit, true);
        document.removeEventListener(type, cancelOnUserEdit, true);
      });
      window.removeEventListener("beforeinput", cancelOnBeforeInput, true);
      document.removeEventListener("beforeinput", cancelOnBeforeInput, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste, true);
    };
  };

  const getState = (): PasteGuardState => ({
    watchUntil,
    undoCount,
    guardGen,
    pasted: pasted.map((p) => ({ ...p })),
  });

  return {
    install,
    hookModel,
    snapshotModels,
    openGuard,
    cancelGuard,
    onModelChange,
    getState,
  };
}
