/**
 * 字体增强：字体选项、应用/恢复、原选项快照与 remeasureFonts。
 * 首次字体询问的 UI 在 ui/prompt.ts（D3），这里只提供“是否需要询问”的纯判断，避免重复。
 */

import type { MonacoEditorLike, MonacoLike } from "../shared/types";

export const FONT_OPTIONS = {
  fontFamily: "'Maple Mono NF CN', 'Maple Mono Web', 'Maple Mono', monospace",
  fontLigatures: true,
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true },
};

/** 是否需要首次询问字体（与 ui/prompt.ts 配合） */
export const shouldAskFont = (fontAsked: boolean, fontOn: boolean): boolean => !fontAsked && !fontOn;

export interface FontSnapshot {
  fontFamily?: unknown;
  fontLigatures?: unknown;
  bracketPairColorization?: unknown;
}

/** 读取字体相关的原值（用于关闭字体时恢复默认） */
export function readFontOptions(ed: MonacoEditorLike, monaco?: MonacoLike): FontSnapshot {
  try {
    const EO = (monaco?.editor as any)?.EditorOption;
    if (!EO) return {};
    return {
      fontFamily: ed.getOption(EO.fontFamily),
      fontLigatures: ed.getOption(EO.fontLigatures),
      bracketPairColorization: ed.getOption(EO.bracketPairColorization),
    };
  } catch (e) {
    return {};
  }
}

export interface FontControllerDeps {
  getEditors(): Array<{ ed: MonacoEditorLike; orig?: unknown; disposed: boolean }>;
  isFontOn(): boolean;
  getMonaco(): MonacoLike | undefined;
}

export interface FontController {
  readOptions(ed: MonacoEditorLike): FontSnapshot;
  apply(): void;
}

export function createFontController(deps: FontControllerDeps): FontController {
  return {
    readOptions: (ed) => readFontOptions(ed, deps.getMonaco()),
    apply: () => {
      deps.getEditors().forEach(({ ed, orig, disposed }) => {
        if (disposed) return; // 已销毁的编辑器不再碰
        try {
          ed.updateOptions(deps.isFontOn() ? FONT_OPTIONS : (orig as Record<string, unknown>));
        } catch (e) {}
      });
      if (deps.isFontOn()) {
        try {
          document.fonts?.ready?.then(() => (deps.getMonaco()?.editor as any)?.remeasureFonts?.());
        } catch (e) {}
      }
    },
  };
}
