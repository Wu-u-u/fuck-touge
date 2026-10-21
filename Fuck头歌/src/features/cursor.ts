/**
 * 光标手感：开启 = 柔和闪烁 + 平滑移动；关闭 = 按原值还原。
 * （此版本 cursorSmoothCaretAnimation 只有开/关，打字时也会滑）
 */

import type { MonacoEditorLike, MonacoLike } from "../shared/types";

export interface CursorSnapshot {
  blinking?: unknown;
  caret?: unknown;
}

export type CursorOptions = {
  cursorBlinking?: unknown;
  cursorSmoothCaretAnimation?: unknown;
};

/** 读取原光标行为：关闭时必须按原值还原，而不是把 cursorBlinking 永远留在 smooth */
export function readCursorOptions(ed: MonacoEditorLike, monaco?: MonacoLike): CursorSnapshot | null {
  try {
    const EO = (monaco?.editor as any)?.EditorOption;
    if (!EO) return null;
    return {
      blinking: EO.cursorBlinking ? ed.getOption(EO.cursorBlinking) : undefined,
      caret: EO.cursorSmoothCaretAnimation ? ed.getOption(EO.cursorSmoothCaretAnimation) : undefined,
    };
  } catch (e) {
    return null;
  }
}

/** 生成 updateOptions 参数：优先保留页面原来支持的光标选项 */
export function buildCursorOptions(
  orig: CursorSnapshot | null | undefined,
  on: boolean,
  monaco?: MonacoLike,
): CursorOptions {
  const EO = (monaco?.editor as any)?.EditorOption;
  if (!orig || !EO?.cursorBlinking) return {};
  const opts: CursorOptions = { cursorBlinking: on ? "smooth" : orig.blinking };
  if (EO.cursorSmoothCaretAnimation) opts.cursorSmoothCaretAnimation = on ? true : orig.caret;
  return opts;
}

export interface CursorControllerDeps {
  getEditors(): Array<{ ed: MonacoEditorLike; cursorOrig?: unknown; disposed: boolean }>;
  isCursorOn(): boolean;
  getMonaco(): MonacoLike | undefined;
}

export interface CursorController {
  readOptions(ed: MonacoEditorLike): CursorSnapshot | null;
  options(orig: unknown): CursorOptions;
  apply(): void;
}

export function createCursorController(deps: CursorControllerDeps): CursorController {
  const options = (orig: unknown): CursorOptions =>
    buildCursorOptions(orig as CursorSnapshot | null, deps.isCursorOn(), deps.getMonaco());

  return {
    readOptions: (ed) => readCursorOptions(ed, deps.getMonaco()),
    options,
    apply: () => {
      deps.getEditors().forEach(({ ed, cursorOrig, disposed }) => {
        if (disposed) return; // 已销毁的编辑器不再碰
        try {
          ed.updateOptions(options(cursorOrig));
        } catch (e) {}
      });
    },
  };
}
