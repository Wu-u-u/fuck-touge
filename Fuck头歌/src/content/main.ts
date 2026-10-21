// Fuck 头歌 v2.5.0 —— 仅作用于头歌：
//   ① 允许粘贴/复制，并阻止网页篡改剪贴板
//   ② 答对后自动点掉“恭喜通过”弹层里的「下一关」/「最后一关」/「完成」
//   ③ 编辑器增强：主题（Catppuccin / GitHub 高对比）+ Maple Mono 字体 + 光标动画（默认关）
//   ④ 页面皮肤：仅答题页面内，选择题等无编辑器页面也换成主题深色（主题开启时）
import { installUIApi } from "../api";
import { installAttrCleaner } from "../features/attrs";
import { createAutoNext } from "../features/auto-next";
import { createChoiceWatcher } from "../features/choice";
import { installClipboardGuard } from "../features/clipboard";
import { createCursorController } from "../features/cursor";
import { createEditorManager } from "../features/editor";
import { createFontController, FONT_OPTIONS, shouldAskFont } from "../features/font";
import { createPasteGuard } from "../features/paste-guard";
import { createThemeController } from "../features/theme/apply";
import { createSkinController } from "../features/theme/skin";
import { THEME_CHOICES } from "../features/theme/themes";
import { createTokenizerController } from "../features/theme/tokenizer";
import { DEFAULT_SETTINGS, SETTINGS_KEYS, readSettings, writeSettings } from "../shared/store";
import type { PublicSettings, ThemeName } from "../shared/types";
import { createFontPrompt } from "../ui/prompt";

(() => {
  "use strict";
  try {
    window.__fuckTouge = "2.5.0";
  } catch (e) {}

  const $ = (sel: string, root: ParentNode = document): any => root.querySelector(sel);
  const $$ = (sel: string, root: ParentNode = document): any[] => [...root.querySelectorAll(sel)];
  let s = DEFAULT_SETTINGS;
  try {
    s = readSettings(localStorage);
  } catch (e) {}
  let themeOn = s.theme, fontOn = s.font, fontAsked = s.fontAsked, themeName = s.themeName, cursorOn = s.cursor;
  const tokenizer = createTokenizerController({
    getMonaco: () => window.Monaco,
    isThemeOn: () => themeOn,
  });
  const themeController = createThemeController({
    getMonaco: () => window.Monaco,
    isThemeOn: () => themeOn,
    getThemeName: () => themeName,
    tokenizer,
  });
  const fontController = createFontController({
    getEditors: () => editorManager.getEditors(),
    isFontOn: () => fontOn,
    getMonaco: () => window.Monaco,
  });
  const applyFont = (): void => fontController.apply();

  const cursorController = createCursorController({
    getEditors: () => editorManager.getEditors(),
    isCursorOn: () => cursorOn,
    getMonaco: () => window.Monaco,
  });
  const applyCursor = (): void => cursorController.apply();

  const applyTheme = (): void => themeController.apply();
  const skinController = createSkinController({
    isThemeOn: () => themeOn,
    getThemeName: () => themeName,
    isFontOn: () => fontOn,
  });
  const applySkin = (): void => skinController.apply();
  applySkin();

  // 单页应用内切换界面（主页 ↔ 答题页等）时同步开关
  try {
    (["pushState", "replaceState"] as const).forEach((fn) => {
      const orig: any = (history as any)[fn];
      (history as any)[fn] = function (...args: any[]) {
        const r = orig.apply(history, args);
        applySkin();
        return r;
      };
    });
    addEventListener("popstate", applySkin);
  } catch (e) {}

  const setThemeState = (on: boolean): void => {
    themeOn = !!on;
    try {
      writeSettings(localStorage, { theme: themeOn });
    } catch (e) {}
    applyTheme();
    applySkin();
    if (themeOn) themeController.ensureDarkMode();
  };

  const setThemeName = (name?: string): void => {
    if (!name) return;
    const key = name as ThemeName;
    if (!THEME_CHOICES[key] || key === themeName) return;
    themeName = key;
    try {
      writeSettings(localStorage, { themeName: key });
    } catch (e) {}
    if (themeOn) applyTheme();
    applySkin();
  };

  const setFontState = (on: boolean): void => {
    fontOn = !!on;
    fontAsked = true;
    try {
      writeSettings(localStorage, { font: fontOn });
    } catch (e) {}
    applyFont();
    applySkin();
  };

  const setCursorState = (on: boolean): void => {
    cursorOn = !!on;
    try {
      writeSettings(localStorage, { cursor: cursorOn });
    } catch (e) {}
    applyCursor();
  };

  // 多标签页同步：别的标签改了开关 → 本页只更新内存并重新应用，不回写 localStorage（避免相互覆盖）
  window.addEventListener("storage", (e: StorageEvent): void => {
    try {
      if (!e || !e.key) return;
      const val = e.newValue;
      if (e.key === SETTINGS_KEYS.theme) {
        themeOn = val !== "off";
        applyTheme();
        applySkin();
        if (themeOn) themeController.ensureDarkMode();
      } else if (e.key === SETTINGS_KEYS.themeName) {
        const key = val as ThemeName;
        if (val && THEME_CHOICES[key]) themeName = key;
        if (themeOn) applyTheme();
        applySkin();
      } else if (e.key === SETTINGS_KEYS.font) {
        fontOn = val === "on";
        applyFont();
        applySkin();
      } else if (e.key === SETTINGS_KEYS.fontAsked) {
        fontAsked = val != null;
      } else if (e.key === SETTINGS_KEYS.cursor) {
        cursorOn = val === "on";
        applyCursor();
      }
    } catch (err) {}
  });
  const fontPrompt = createFontPrompt({
    shouldAsk: (): boolean => shouldAskFont(fontAsked, fontOn),
    setFont: setFontState,
  });
  const uiState = (): PublicSettings => ({ theme: themeOn, font: fontOn, themeName, cursor: cursorOn });
  installUIApi({
    getState: uiState,
    setThemeName,
    setTheme: setThemeState,
    setFont: setFontState,
    setCursor: setCursorState,
  });
  installClipboardGuard();
  const pasteGuard = createPasteGuard({
    getModels: () => window.Monaco?.editor?.getModels?.() ?? [],
    getRange: () => (window.Monaco as any)?.Range ?? null,
  });
  pasteGuard.install();
  const editorManager = createEditorManager({
    findElements: () => $$(".monaco-editor"),
    onModel: (m): void => pasteGuard.hookModel(m as any),
    onMonacoReady: (M): void => themeController.attach(M),
    onEditor: (entry, isFirst): void => {
      if (isFirst && !themeController.hasThemeTouched()) {
        const el = $(".monaco-editor");
        if (el) themeController.observeEditorTheme(el);
      }
      entry.orig = fontController.readOptions(entry.ed);
      entry.cursorOrig = cursorController.readOptions(entry.ed);
      if (fontOn) {
        try {
          entry.ed.updateOptions(FONT_OPTIONS);
        } catch (e) {}
      }
      try {
        entry.ed.updateOptions(cursorController.options(entry.cursorOrig));
      } catch (e) {}
    },
    onMonacoHooked: (M): void => themeController.onAttached(M),
  });
  editorManager.install();
  installAttrCleaner();
  const autoNext = createAutoNext({ onTick: (): void => fontPrompt.maybeAsk() });
  const choiceWatcher = createChoiceWatcher();

  choiceWatcher.install();
  autoNext.install();
})();
