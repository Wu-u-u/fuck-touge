// @ts-nocheck
// Fuck 头歌 v2.4.7 —— 仅作用于头歌：
//   ① 允许粘贴/复制，并阻止网页篡改剪贴板
//   ② 答对后自动点掉“恭喜通过”弹层里的「下一关」/「最后一关」/「完成」
//   ③ 编辑器增强：主题（Catppuccin / GitHub 高对比）+ Maple Mono 字体 + 光标动画（默认关）
//   ④ 页面皮肤：仅答题页面内，选择题等无编辑器页面也换成主题深色（主题开启时）
import { installUIApi } from "../api";
import { installAttrCleaner } from "../features/attrs";
import { installClipboardGuard } from "../features/clipboard";
import { createPasteGuard } from "../features/paste-guard";
import { createEditorManager } from "../features/editor";
import { createThemeController } from "../features/theme/apply";
import { normalizeThemeName, THEME_CHOICES } from "../features/theme/themes";
import { createTokenizerController } from "../features/theme/tokenizer";
import { createCursorController } from "../features/cursor";
import { FONT_OPTIONS, createFontController, shouldAskFont } from "../features/font";
import { createSkinController } from "../features/theme/skin";
import { createAutoNext } from "../features/auto-next";
import { createChoiceWatcher } from "../features/choice";
import { createFontPrompt } from "../ui/prompt";

(() => {
  "use strict";
  try { window.__fuckTouge = "2.4.7"; } catch (e) {}

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ── 编辑器外观增强：类 VS Code 高对比主题 + Maple Mono 字体 ──
     开关存 localStorage；首次使用询问一次，之后用扩展弹窗随时切换 */
  const UI_THEME_KEY = "fuckTougeTheme";       // 主题开关（默认开）
  const UI_THEME_NAME = "fuckTougeThemeName";  // 选用哪套主题
  const UI_FONT_KEY = "fuckTougeFont";         // 字体开关（首次询问）
  const UI_FONT_ASKED = "fuckTougeFontAsked";  // 字体是否已询问
  const UI_CURSOR_KEY = "fuckTougeCursor";     // 光标平滑动画（默认关）
  let themeOn = true, fontOn = false, fontAsked = false, themeName = "catppuccin", cursorOn = false;
  try {
    const old = localStorage.getItem("fuckTougeUI");   // 旧版单一开关 → 平滑迁移（迁移后即删，否则会永远覆盖新开关）
    const theme = localStorage.getItem(UI_THEME_KEY) ?? (old === "off" ? "off" : "on");
    const font = localStorage.getItem(UI_FONT_KEY) ?? (old === "on" ? "on" : "off");
    themeOn = theme !== "off";
    fontOn = font === "on";
    fontAsked = !!localStorage.getItem(UI_FONT_ASKED) || old !== null;   // 旧版已拍板过字体，迁移后不再重复弹询问
    themeName = normalizeThemeName(localStorage.getItem(UI_THEME_NAME));
    cursorOn = localStorage.getItem(UI_CURSOR_KEY) === "on";
    if (old !== null) {
      // 迁移必须落盘：只删旧键的话，下次加载走 ?? 默认值 —— 用户关掉的主题会重新打开、
      // 开着的字体会被关掉。先把上面合并出的最终值写回对应新键，再删旧键；
      // 写的都是当前生效值，随时刷新都得到相同结果（幂等）
      try { localStorage.setItem(UI_THEME_KEY, themeOn ? "on" : "off"); } catch (e) {}
      try { localStorage.setItem(UI_FONT_KEY, fontOn ? "on" : "off"); } catch (e) {}
      try { localStorage.setItem(UI_FONT_ASKED, "1"); } catch (e) {}
      try { localStorage.removeItem("fuckTougeUI"); } catch (e) {}
    }
  } catch (e) {}

  // Catppuccin Mocha（深）/ Latte（浅）：社区口碑很好的配色
  /* ── 主题 / 着色控制器（模块化） ── */
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

  // 字体 / 光标控制器（模块化）
  const fontController = createFontController({
    getEditors: () => editorManager.getEditors(),
    isFontOn: () => fontOn,
    getMonaco: () => window.Monaco,
  });
  const applyFont = () => fontController.apply();

  const cursorController = createCursorController({
    getEditors: () => editorManager.getEditors(),
    isCursorOn: () => cursorOn,
    getMonaco: () => window.Monaco,
  });
  const applyCursor = () => cursorController.apply();

  const applyTheme = () => themeController.apply();

  /* ── 页面皮肤（模块化） ── */
  const skinController = createSkinController({
    isThemeOn: () => themeOn,
    getThemeName: () => themeName,
    isFontOn: () => fontOn,
  });
  const applySkin = () => skinController.apply();
  applySkin();

  // 单页应用内切换界面（主页 ↔ 答题页等）时同步开关
  const watchLocation = () => {
    try {
      ["pushState", "replaceState"].forEach(fn => {
        const orig = history[fn];
        history[fn] = function (...args) { const r = orig.apply(this, args); applySkin(); return r; };
      });
      addEventListener("popstate", applySkin);
    } catch (e) {}
  };
  watchLocation();

  const setThemeState = on => {
    themeOn = !!on;
    try { localStorage.setItem(UI_THEME_KEY, themeOn ? "on" : "off"); } catch (e) {}
    applyTheme();
    applySkin();
    if (themeOn) themeController.ensureDarkMode();
  };

  const setThemeName = name => {
    if (!THEME_CHOICES[name] || name === themeName) return;
    themeName = name;
    try { localStorage.setItem(UI_THEME_NAME, name); } catch (e) {}
    if (themeOn) applyTheme();
    applySkin();
  };

  const setFontState = on => {
    fontOn = !!on;
    fontAsked = true;
    try {
      localStorage.setItem(UI_FONT_KEY, fontOn ? "on" : "off");
      localStorage.setItem(UI_FONT_ASKED, "1");
    } catch (e) {}
    applyFont();
    applySkin();
  };

  const setCursorState = on => {
    cursorOn = !!on;
    try { localStorage.setItem(UI_CURSOR_KEY, cursorOn ? "on" : "off"); } catch (e) {}
    applyCursor();
  };

  // 多标签页同步：别的标签改了开关 → 本页只更新内存并重新应用，不回写 localStorage（避免相互覆盖）
  window.addEventListener("storage", e => {
    try {
      if (!e || !e.key) return;
      const val = e.newValue;
      if (e.key === UI_THEME_KEY) {
        themeOn = val !== "off";
        applyTheme();
        applySkin();
        if (themeOn) themeController.ensureDarkMode();
      } else if (e.key === UI_THEME_NAME) {
        if (THEME_CHOICES[val]) themeName = val;
        if (themeOn) applyTheme();
        applySkin();
      } else if (e.key === UI_FONT_KEY) {
        fontOn = val === "on";
        applyFont();
        applySkin();
      } else if (e.key === UI_FONT_ASKED) {
        fontAsked = val != null;
      } else if (e.key === UI_CURSOR_KEY) {
        cursorOn = val === "on";
        applyCursor();
      }
    } catch (err) {}
  });

  // 首次使用询问（只问一次）+ 弹窗 API（模块化，依赖显式传入）
  const fontPrompt = createFontPrompt({
    shouldAsk: () => shouldAskFont(fontAsked, fontOn),
    setFont: setFontState,
  });
  const uiState = () => ({ theme: themeOn, font: fontOn, themeName, cursor: cursorOn });
  installUIApi({
    getState: uiState,
    setThemeName,
    setTheme: setThemeState,
    setFont: setFontState,
    setCursor: setCursorState,
  });

  /* ── ① 剪贴板保护（模块化） ── */
  installClipboardGuard();

  /* ── ② 粘贴回落保护 / 按键直通（模块化） ── */
  const pasteGuard = createPasteGuard({
    getModels: () => window.Monaco?.editor?.getModels?.() ?? [],
    getRange: () => window.Monaco?.Range ?? null,
  });
  pasteGuard.install();

  /* ── 编辑器 / 主题挂钩（模块化） ── */
  const editorManager = createEditorManager({
    findElements: () => $$(".monaco-editor"),
    onModel: (m) => pasteGuard.hookModel(m),
    onMonacoReady: (M) => themeController.attach(M),
    onEditor: (entry, isFirst) => {
      if (isFirst && !themeController.hasThemeTouched()) {
        const el = $(".monaco-editor");
        if (el) themeController.observeEditorTheme(el);
      }
      entry.orig = fontController.readOptions(entry.ed);
      entry.cursorOrig = cursorController.readOptions(entry.ed);
      if (fontOn) { try { entry.ed.updateOptions(FONT_OPTIONS); } catch (e) {} }
      try { entry.ed.updateOptions(cursorController.options(entry.cursorOrig)); } catch (e) {}
    },
    onMonacoHooked: (M) => themeController.onAttached(M),
  });
  editorManager.install();

  /* ── ⑤ 清理属性式拦截（模块化） ── */
  installAttrCleaner();

  /* ── ⑥ 自动下一关 / ⑦ 选择题（模块化） ── */
  const autoNext = createAutoNext({ onTick: () => fontPrompt.maybeAsk() });
  const choiceWatcher = createChoiceWatcher();

  choiceWatcher.install();
  autoNext.install();
})();
