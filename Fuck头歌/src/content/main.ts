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
import { createFontPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";

(() => {
  "use strict";
  try { window.__fuckTouge = "2.4.7"; } catch (e) {}

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };

  /* ── 编辑器外观增强：类 VS Code 高对比主题 + Maple Mono 字体 ──
     开关存 localStorage；首次使用询问一次，之后用扩展弹窗随时切换 */
  const UI_THEME_KEY = "fuckTougeTheme";       // 主题开关（默认开）
  const UI_THEME_NAME = "fuckTougeThemeName";  // 选用哪套主题
  const UI_FONT_KEY = "fuckTougeFont";         // 字体开关（首次询问）
  const UI_FONT_ASKED = "fuckTougeFontAsked";  // 字体是否已询问
  const UI_CURSOR_KEY = "fuckTougeCursor";     // 光标平滑动画（默认关）
  const UI_OPTIONS = {
    fontFamily: "'Maple Mono NF CN', 'Maple Mono Web', 'Maple Mono', monospace",
    fontLigatures: true,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true },
  };
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

  // 读取原值：字体项用于恢复默认；光标项单独存（闪烁样式 + 平滑动画），避免两类设置互相覆盖
  const readOrigOptions = ed => {
    try {
      const EO = window.Monaco?.editor?.EditorOption;
      if (!EO) return { font: {}, cursor: null };
      return {
        font: {
          fontFamily: ed.getOption(EO.fontFamily),
          fontLigatures: ed.getOption(EO.fontLigatures),
          bracketPairColorization: ed.getOption(EO.bracketPairColorization),
        },
        cursor: {   // 备份原光标行为：光标开关关闭时按原值还原，而不是把 cursorBlinking 永远留在 smooth
          blinking: EO.cursorBlinking ? ed.getOption(EO.cursorBlinking) : undefined,
          caret: EO.cursorSmoothCaretAnimation ? ed.getOption(EO.cursorSmoothCaretAnimation) : undefined,
        },
      };
    } catch (e) { return { font: {}, cursor: null }; }
  };

  const applyTheme = () => themeController.apply();

  const applyFont = () => {
    editorManager.getEditors().forEach(({ ed, orig, disposed }) => {
      if (disposed) return;                    // 已销毁的编辑器不再碰
      try { ed.updateOptions(fontOn ? UI_OPTIONS : orig); } catch (e) {}
    });
    if (fontOn) { try { document.fonts?.ready?.then(() => window.Monaco?.editor?.remeasureFonts?.()); } catch (e) {} }
  };

  // 光标手感：开启 = 柔和闪烁 + 平滑移动（此版本只有开/关，打字时也会滑）；
  // 关闭 = 按 readOrigOptions 备份的原值还原（以前强制 smooth 且从不还原，会一直顶掉页面自己的光标设置）
  const cursorOptions = orig => {
    const EO = window.Monaco?.editor?.EditorOption;
    if (!orig || !EO?.cursorBlinking) return {};
    const opts = { cursorBlinking: cursorOn ? "smooth" : orig.blinking };
    if (EO.cursorSmoothCaretAnimation) opts.cursorSmoothCaretAnimation = cursorOn ? true : orig.caret;
    return opts;
  };

  const applyCursor = () => {
    editorManager.getEditors().forEach(({ ed, cursorOrig, disposed }) => {
      if (disposed) return;                    // 已销毁的编辑器不再碰
      try { ed.updateOptions(cursorOptions(cursorOrig)); } catch (e) {}
    });
  };

  /* ── 页面皮肤：把平台的浅色骨架（含左侧任务区）换成主题深色 ──
     无编辑器的页面（选择题等）同样生效；随 主题/主题名/字体 开关即时切换 */
  const SKIN_CSS = `
html[data-ft-skin] { color-scheme: dark; background: var(--ft-bg) !important; }
html[data-ft-skin="catppuccin"] {
  --ft-bg: #1e1e2e; --ft-panel: #181825; --ft-panel2: #11111b; --ft-border: #313244;
  --ft-text: #cdd6f4; --ft-dim: #a6adc8; --ft-link: #89b4fa; --ft-accent: #89b4fa; --ft-accent-fg: #1e1e2e;
  --ft-sel: rgba(137, 180, 250, .35); --ft-hover: rgba(255, 255, 255, .05);
  --ft-code-bg: #11111b; --ft-code-border: #313244; --ft-code-text: #cdd6f4;
  --ft-kw: #cba6f7; --ft-typ: #f9e2af; --ft-str: #a6e3a1; --ft-com: #6c7086; --ft-num: #fab387; --ft-fun: #89b4fa; --ft-pun: #9399b2;
}
html[data-ft-skin="github"] {
  --ft-bg: #0a0c10; --ft-panel: #0f1216; --ft-panel2: #0a0c10; --ft-border: #2b323b;
  --ft-text: #f0f3f6; --ft-dim: #bdc4cc; --ft-link: #71b7ff; --ft-accent: #71b7ff; --ft-accent-fg: #0a0c10;
  --ft-sel: rgba(113, 183, 255, .35); --ft-hover: rgba(255, 255, 255, .06);
  --ft-code-bg: #12151b; --ft-code-border: #2b323b; --ft-code-text: #f0f3f6;
  --ft-kw: #ff9492; --ft-typ: #ffb757; --ft-str: #addcff; --ft-com: #bdc4cc; --ft-num: #91cbff; --ft-fun: #dbb7ff; --ft-pun: #bdc4cc;
}
html[data-ft-skin] ::selection { background: var(--ft-sel); }
html[data-ft-skin] body { background: var(--ft-bg) !important; color: var(--ft-text); }
html[data-ft-skin] .task-header-container { background: var(--ft-panel2) !important; }
html[data-ft-skin] .task-header { background: var(--ft-panel) !important; color: var(--ft-text); }
html[data-ft-skin] .task-header :is(h1, h2, h3) { color: var(--ft-text); }
html[data-ft-skin] [class*="tab-nav"] { background: var(--ft-panel) !important; border-color: var(--ft-border); }
html[data-ft-skin] [class*="tab-nav"] a { color: var(--ft-dim); }
html[data-ft-skin] [class*="tab-nav"] a:hover, html[data-ft-skin] [class*="tab-nav"] a[class*="active"] { color: var(--ft-text); }
html[data-ft-skin] .left-panel { background: var(--ft-panel) !important; color: var(--ft-text); }
html[data-ft-skin] .left-panel :is(h1, h2, h3, h4, h5, h6) { color: var(--ft-text); }
html[data-ft-skin] .left-panel :is(p, li, td, th, dl, dd) { color: var(--ft-text); }
html[data-ft-skin] .left-panel a { color: var(--ft-link); }
html[data-ft-skin] .left-panel hr { border-color: var(--ft-border); background: var(--ft-border); }
html[data-ft-skin] .left-panel :is(table, th, td) { border-color: var(--ft-border); }
html[data-ft-skin] .left-panel th { background: var(--ft-code-bg); }
html[data-ft-skin] .left-panel blockquote { color: var(--ft-dim); border-left-color: var(--ft-border); }
html[data-ft-skin] :is(.right-panel, [class*="code-area-container"]) { background: var(--ft-bg) !important; color: var(--ft-text); }
html[data-ft-skin] :is([class*="test-set-container"], [class*="action-container"]) { background: var(--ft-panel2) !important; color: var(--ft-text); }
html[data-ft-skin] ul.choose-container { background: transparent !important; }
html[data-ft-skin] [class*="resize-y-bar"] { background: var(--ft-border) !important; }
html[data-ft-skin] [class*="scrollbarTrack"] { background: transparent !important; }
html[data-ft-skin] [class*="scrollbarThumb"] { background: var(--ft-border) !important; }
html[data-ft-skin] [class*="test-header"] { background: var(--ft-panel2) !important; }
html[data-ft-skin] [class*="test-case-item"] { background: var(--ft-panel) !important; }
html[data-ft-skin] [class*="choose-game-item"] { background: var(--ft-panel2) !important; }
html[data-ft-skin] [class*="ghost-link"] { background: transparent !important; }
html[data-ft-skin] .right-panel :is(h1, h2, h3, h4, h5, h6, p, li) { color: var(--ft-text); }
html[data-ft-skin] .right-panel a { color: var(--ft-link); }
html[data-ft-skin] ul.choose-container :is(p, span, div) { color: var(--ft-text); }
html[data-ft-skin] ul.choose-container p.order { color: var(--ft-dim); }
html[data-ft-skin] .ant-radio-wrapper { color: var(--ft-text); }
html[data-ft-skin] .ant-radio-inner { background: transparent; border-color: var(--ft-border); }
html[data-ft-skin] .ant-radio-wrapper:hover .ant-radio-inner { border-color: var(--ft-accent); }
html[data-ft-skin] .ant-radio-wrapper-checked .ant-radio-inner { border-color: var(--ft-accent); }
html[data-ft-skin] .ant-radio-checked .ant-radio-inner::after { background: var(--ft-accent); }
html[data-ft-skin] :is([class*="mdBody"], .markdown-body) :is(p, li, td, th, h1, h2, h3, h4, h5, h6) { color: var(--ft-text); }
html[data-ft-skin] :is([class*="mdBody"], .markdown-body) a { color: var(--ft-link); }
html[data-ft-skin] :is([class*="mdBody"], .markdown-body) :is(table, th, td) { border-color: var(--ft-border); }
html[data-ft-skin] :is([class*="mdBody"], .markdown-body) th { background: var(--ft-code-bg); }
html[data-ft-skin] pre.prettyprint, html[data-ft-skin] :is([class*="mdBody"], .markdown-body) pre {
  background: var(--ft-code-bg) !important; color: var(--ft-code-text) !important;
  border: 1px solid var(--ft-code-border) !important; border-radius: 6px;
}
html[data-ft-skin] pre.prettyprint code { background: transparent !important; border: 0 !important; padding: 0; color: inherit; }
html[data-ft-skin] :is(.left-panel, [class*="mdBody"], .markdown-body) code {
  background: var(--ft-code-bg); color: var(--ft-code-text); border: 1px solid var(--ft-code-border); border-radius: 4px; padding: 1px 5px;
}
html[data-ft-skin] .prettyprint :is(.kwd, .tag) { color: var(--ft-kw); }
html[data-ft-skin] .prettyprint .typ { color: var(--ft-typ); }
html[data-ft-skin] .prettyprint :is(.str, .atv) { color: var(--ft-str); }
html[data-ft-skin] .prettyprint .com { color: var(--ft-com); font-style: italic; }
html[data-ft-skin] .prettyprint :is(.dec, .atn) { color: var(--ft-fun); }
html[data-ft-skin] .prettyprint .lit { color: var(--ft-num); }
html[data-ft-skin] .prettyprint .pln { color: var(--ft-code-text); }
html[data-ft-skin] .prettyprint :is(.pun, .opn, .clo) { color: var(--ft-pun); }
html[data-ft-skin] [class*="btn-run"] { background: var(--ft-accent) !important; border-color: var(--ft-accent) !important; color: var(--ft-accent-fg) !important; }
html[data-ft-skin] [class*="btn-run"][disabled] { opacity: .55; }
html[data-ft-skin] [class*="ghost-link"] { color: var(--ft-link) !important; border-color: var(--ft-link) !important; }
html[data-ft-skin] pre.prettyprint ol.linenums li { background: transparent; }
html[data-ft-skin] .ant-btn { background: var(--ft-panel); border-color: var(--ft-border); color: var(--ft-text); }
html[data-ft-skin] .ant-btn:hover { background: var(--ft-code-bg); border-color: var(--ft-accent); color: var(--ft-accent); }
html[data-ft-skin] [class*="tabs___"] { background: var(--ft-panel) !important; border-color: var(--ft-border); }
html[data-ft-skin] [class*="tabs___"] :is(div, span, a, button) { color: var(--ft-text); }
html[data-ft-skin] .ant-table { background: transparent; color: var(--ft-text); }
html[data-ft-skin] .ant-table-thead > tr > th { background: var(--ft-panel) !important; color: var(--ft-text) !important; border-color: var(--ft-border) !important; }
html[data-ft-skin] .ant-table-tbody > tr > td { border-color: var(--ft-border); color: var(--ft-text); }
html[data-ft-skin] tr.ant-table-placeholder { background: transparent !important; }
html[data-ft-skin] .ant-table-placeholder > td, html[data-ft-skin] .ant-table-placeholder:hover > td { background: transparent !important; color: var(--ft-dim); }
html[data-ft-skin] :is(.ant-skeleton-avatar, .ant-skeleton-title, .ant-skeleton-paragraph > li) { background: rgba(255, 255, 255, .08) !important; }
html[data-ft-skin] [class*="content-wrapper"] div[style*="background: rgb(255, 255, 255)"] { background: transparent !important; }
html[data-ft-skin] .ant-table-tbody > tr:hover > td { background: var(--ft-hover) !important; }
html[data-ft-skin] .ant-empty-description { color: var(--ft-dim); }
html[data-ft-skin] .ant-pagination-item { background: transparent; border-color: var(--ft-border); }
html[data-ft-skin] .ant-pagination-item > a { color: var(--ft-text); }
html[data-ft-skin] .ant-pagination-item-active { background: var(--ft-accent); border-color: var(--ft-accent); }
html[data-ft-skin] .ant-pagination-item-active > a { color: var(--ft-accent-fg); }
html[data-ft-skin] .ant-pagination-item-link { background: transparent; border-color: var(--ft-border); color: var(--ft-text); }
html[data-ft-skin] .ant-pagination-disabled .ant-pagination-item-link { color: var(--ft-dim); opacity: .5; }
html[data-ft-font] :is(pre, code, kbd, samp, ol.linenums),
html[data-ft-font] :is(body, .left-panel, .right-panel, [class*="mdBody"], .markdown-body, [class*="task-header"],
  [class*="task-header-container"], [class*="tab-nav"], [class*="action-container"], [class*="test-set-container"],
  [class*="choose-container"], [class*="content-wrapper"]) :is(p, li, dd, dt, td, th, blockquote, h1, h2, h3, h4, h5, h6,
  a, strong, em, b, label, button, span:not([class*="icon"]):not(.anticon)) { font-family: 'Maple Mono NF CN', 'Maple Mono Web', 'Maple Mono', Consolas, 'Courier New', monospace !important; }
`;

  const isAnswerPage = () => /^\/tasks\/[^/]+\/[^/]+\/[^/]+/.test(location.pathname);   // 答题页（…/tasks/课程/关卡组/关卡）

  const HEAD_WAIT_MS = 5000;   // 等 <head> 的上限：等不到再退回 documentElement
  let skinStyle = null;        // 在途（还没挂上）的样式节点；挂上/放弃后置回 null，页面删掉时可重建
  const attachSkinStyle = () => {
    const pending = skinStyle;
    skinStyle = null;
    if (!pending) return;
    try {
      const root = document.head || document.documentElement;
      if (root && !pending.isConnected) root.appendChild(pending);
    } catch (e) { /* 挂载失败就放弃，下次 applySkin 发现缺样式会重建 */ }
  };
  // 皮肤样式：document_start 时 <head> 可能还没出现，直接挂 documentElement 虽然也生效，
  // 但页面骨架载入后容易被整体替换掉——所以等 head 出现（MutationObserver，另设超时上限），
  // 上限 HEAD_WAIT_MS 内没等到再退回 documentElement，保证样式最终一定挂上
  const injectSkinStyle = () => {
    if (skinStyle || $("#ft-skin-style")) return;   // 已挂上 / 已在途就不重复注入
    const style = document.createElement("style");
    style.id = "ft-skin-style";
    style.textContent = SKIN_CSS;
    skinStyle = style;
    if (document.head) { attachSkinStyle(); return; }
    let mo = null;
    const cap = setTimeout(() => {
      try { mo?.disconnect(); } catch (e) {}
      attachSkinStyle();
    }, HEAD_WAIT_MS);
    try {
      mo = new MutationObserver(() => {
        if (!document.head) return;
        clearTimeout(cap);
        try { mo.disconnect(); } catch (e) {}
        attachSkinStyle();
      });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) {
      clearTimeout(cap);
      attachSkinStyle();
    }
  };
  const applySkin = () => {
    const el = document.documentElement;
    if (!el) { setTimeout(applySkin, 10); return; }   // document_start 早期可能还没有 <html>
    const on = isAnswerPage();                        // 皮肤只作用于答题页，主页/目录保持平台原样
    themeOn && on ? el.setAttribute("data-ft-skin", themeName === "github" ? "github" : "catppuccin")
                  : el.removeAttribute("data-ft-skin");
    fontOn && on ? el.setAttribute("data-ft-font", "") : el.removeAttribute("data-ft-font");
    if (on && (themeOn || fontOn)) injectSkinStyle();   // 去重/等 head/超时兜底都在这里面
  };
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
    shouldAsk: () => !fontAsked && !fontOn,
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
      const orig = readOrigOptions(entry.ed);
      entry.orig = orig.font;
      entry.cursorOrig = orig.cursor;
      if (fontOn) { try { entry.ed.updateOptions(UI_OPTIONS); } catch (e) {} }
      try { entry.ed.updateOptions(cursorOptions(orig.cursor)); } catch (e) {}
    },
    onMonacoHooked: (M) => themeController.onAttached(M),
  });
  editorManager.install();

  /* ── ⑤ 清理属性式拦截（模块化） ── */
  installAttrCleaner();

  /* ── ⑥ 自动下一关 ──
     触发：出现可见的“通过”庆祝弹层（.evaluate-result-container；失败只会弹报错提示，不会出现它）
     动作：只点弹层内部 文字完全等于「下一关」的按钮；页面工具栏上的「下一关」永远不会被碰
     备注：“恭喜您通过本关”是弹层里的图片、不是文字，所以这里不做文案匹配 */
  const JUMP_KEY = "fuckTougeAutoJumpAt";
  const JUMP_MSG = {
    next: "已为您自动跳转至下一关 😋",
    last: "已经是最后一关了 😋",
  };

  // 整页刷新场景：落地后补一条提示（"时间戳|类型"，兼容只有时间戳的旧格式）
  try {
    const [atStr, kind] = String(sessionStorage.getItem(JUMP_KEY) || "").split("|");
    const at = Number(atStr);
    if (at && Date.now() - at < 15000) {
      sessionStorage.removeItem(JUMP_KEY);
      const msg = JUMP_MSG[kind] || JUMP_MSG.next;
      const t = setInterval(() => document.body && (clearInterval(t), toast(msg)), 100);
      setTimeout(() => clearInterval(t), 10000);
    }
  } catch (e) {}

  let jumpTimer = 0;
  const jumpNotice = kind => {
    toast(JUMP_MSG[kind] || JUMP_MSG.next);
    try {
      sessionStorage.setItem(JUMP_KEY, Date.now() + "|" + (kind || "next"));
      clearTimeout(jumpTimer);                     // 连续跳转时，别让旧的清除定时器误删新标记
      jumpTimer = setTimeout(() => sessionStorage.removeItem(JUMP_KEY), 5000);
    } catch (e) {}
  };

  // 关卡标识：SPA 换关时路由会变 → 用来判断“是不是已经跳到别的关卡了”
  const levelKey = () => location.pathname + location.search + location.hash;

  // 双路径互斥：结果弹层 / 选择题页面按钮，同一关只允许认领一次（防止连跳两关）
  const jumpClaim = { key: "", at: 0 };
  const claimJump = key => {
    const now = Date.now();
    if (jumpClaim.key !== key) { jumpClaim.key = key; jumpClaim.at = 0; }   // 换关了 → 重新允许
    if (jumpClaim.at && now - jumpClaim.at < 5000) return false;             // 已被另一条路径认领
    jumpClaim.at = now;
    return true;
  };

  // 弹层按钮文案 → 类型：普通关「下一关」；最后一关「最后一关」；最后的测试关是「完成」
  const NEXT_LABELS = { "下一关": "next", "最后一关": "last", "完成": "last" };
  const normText = s => String(s || "").replace(/[\s\u200b-\u200d\ufeff]/g, "");
  const findNextBtn = box => {
    for (const el of $$("a, button, [role=button]", box)) {
      const kind = NEXT_LABELS[normText(el.innerText)];
      if (kind && visible(el)) return { el, kind };
    }
    return null;
  };
  const clickLikeUser = el => {                // 完整鼠标序列，兼容只监听 pointer/mousedown 的组件
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  };

  const autoNext = () => {
    const boxes = $$(".evaluate-result-container");
    const box = boxes.find(visible);
    if (!box) {                                  // 无可见弹层时重置标记（兼容弹层被复用的情况）
      boxes.forEach(b => { b.__ftClicked = false; b.__ftSeenAt = 0; b.__ftLastToast = false; });
      return;
    }
    if (box.__ftClicked) return;

    box.__ftSeenAt = box.__ftSeenAt || Date.now();
    const next = findNextBtn(box);

    if (!next) {                                 // 弹层出现 9 秒还没有按钮 → 保守提示（不一定是最后一关）
      if (!box.__ftLastToast && Date.now() - box.__ftSeenAt > 9000) {
        box.__ftLastToast = true;
        toast("未检测到跳转按钮");
      }
      return;
    }

    if (next.el.disabled === true || next.el.getAttribute("aria-disabled") === "true") {
      if (!box.__ftLastToast && Date.now() - box.__ftSeenAt > 10000) {
        box.__ftLastToast = true;
        toast("跳转按钮未激活，请手动点击「下一关」");   // 不再静默放弃
      }
      return;                                    // 按钮还没激活（评测刚结束时短暂禁用）→ 下一轮再点
    }

    box.__ftClicked = true;
    const key = levelKey();
    setTimeout(() => {
      if (!next.el.isConnected) { box.__ftClicked = false; return; }   // SPA 重渲染换掉了按钮 → 下一轮重新找
      if (levelKey() !== key) return;                                  // 已换关 → 放弃本次点击
      if (!claimJump(key)) return;                                     // 另一条路径已认领 → 只跳一次
      clickLikeUser(next.el);
      jumpNotice(next.kind);
    }, 200);
  };

  /* ── ⑦ 选择题：手动点「评测」后等结果；只有平台弹庆祝弹层（=通过）才跳关，否则只提示 ── */
  let choiceEval = null;   // { at: 评测开始时间戳, key: 关卡标识 }；null = 未在观察

  const resultBox = () => $$(".evaluate-result-container, [class*=\"evaluate-result\"]").find(visible) || null;

  const watchChoiceEval = () => {
    if (!choiceEval) return;
    // 换关了 → 上一次评测的观察立即作废，不能在新关弹旧提示
    if (levelKey() !== choiceEval.key) { choiceEval = null; return; }
    // 平台只在“通过”（含部分正确）时弹庆祝弹层，失败没有任何可判定信号；
    // 因此：看到弹层 → 交给弹层路径跳关；一段时间内没有弹层 → 视为未通过，只提示不跳关。
    if (resultBox()) { choiceEval = null; return; }
    if (Date.now() - choiceEval.at > 3000) {
      choiceEval = null;
      toast("未检测到通过，已停止自动跳转");
      return;
    }
    setTimeout(watchChoiceEval, 150);
  };

  document.addEventListener("click", e => {
    const btn = e.target?.closest?.("button, [role=button], a");
    if (!btn || (btn.innerText || "").trim() !== "评测" || $(".monaco-editor")) return;   // 仅限选择题
    choiceEval = { at: Date.now(), key: levelKey() };
    setTimeout(watchChoiceEval, 150);
  }, true);

  // document 在 document_start 时必然存在（documentElement 可能还没有）
  let autoNextAt = 0;
  new MutationObserver(() => {                 // 页面 DOM 变动很频繁，节流后再查弹层
    const now = Date.now();
    if (now < autoNextAt) return;
    autoNextAt = now + 200;
    autoNext();
  }).observe(document, { childList: true, subtree: true });
  setInterval(() => { autoNext(); fontPrompt.maybeAsk(); }, 1000);   // 属性清理交由上面的 MutationObserver，不再每秒全量扫
})();
