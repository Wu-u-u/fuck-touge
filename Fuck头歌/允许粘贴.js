// Fuck 头歌 v2.3 —— 仅作用于头歌：
//   ① 允许粘贴/复制，并阻止网页篡改剪贴板
//   ② 答对后自动点掉“恭喜通过”弹层里的「下一关」/「最后一关」/「完成」
//   ③ 编辑器增强：主题（Catppuccin / GitHub 高对比）+ Maple Mono 字体 + 光标动画（默认关）
(() => {
  "use strict";
  try { window.__fuckTouge = "2.3"; } catch (e) {}

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };

  /* ── 轻提示 ── */
  const toast = msg => {
    try {
      const el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText =
        "position:fixed;top:26px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "padding:10px 18px;border-radius:10px;background:rgba(17,17,17,.86);color:#fff;" +
        "font-size:18px;line-height:1;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
        "transition:opacity .5s;";
      (document.body || document.documentElement).appendChild(el);
      setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 600); }, 2600);
    } catch (e) {}
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
    const old = localStorage.getItem("fuckTougeUI");   // 旧版单一开关 → 平滑迁移
    themeOn = localStorage.getItem(UI_THEME_KEY) !== "off" && old !== "off";
    fontOn = localStorage.getItem(UI_FONT_KEY) === "on" || old === "on";
    fontAsked = !!localStorage.getItem(UI_FONT_ASKED);
    themeName = localStorage.getItem(UI_THEME_NAME) || "catppuccin";
    cursorOn = localStorage.getItem(UI_CURSOR_KEY) === "on";
  } catch (e) {}

  let platformTheme = "vs-dark";   // 平台请求的主题：vs=浅色 / vs-dark=深色
  let themeTouched = false;        // 平台是否主动调过 setTheme
  // Catppuccin Mocha（深）/ Latte（浅）：社区口碑很好的配色
  const UI_THEMES = {
    "catppuccin-mocha": {
      base: "vs-dark", inherit: true,
      colors: {
        "editor.background": "#1e1e2e",
        "editor.lineHighlightBackground": "#2a2a3c",
        "editorLineNumber.foreground": "#585b70",
        "editorLineNumber.activeForeground": "#cba6f7",
        "editor.selectionBackground": "#585b7066",
        "editorCursor.foreground": "#f5e0dc",
        "editorIndentGuide.background1": "#313244",
        "editorIndentGuide.activeBackground1": "#585b70",
        "editorBracketHighlight.foreground1": "#f38ba8",
        "editorBracketHighlight.foreground2": "#fab387",
        "editorBracketHighlight.foreground3": "#a6e3a1",
        "editorBracketHighlight.foreground4": "#89b4fa",
        "editorBracketHighlight.foreground5": "#cba6f7",
        "editorBracketHighlight.foreground6": "#94e2d5",
        "editorWidget.background": "#181825",
        "editorSuggestWidget.background": "#181825",
        "editorSuggestWidget.selectedBackground": "#313244",
      },
      rules: [
        { token: "", foreground: "cdd6f4" },
        { token: "comment", foreground: "6c7086", fontStyle: "italic" },
        { token: "comment.doc", foreground: "7f849c", fontStyle: "italic" },
        { token: "keyword", foreground: "cba6f7" },
        { token: "keyword.control", foreground: "f38ba8" },
        { token: "keyword.primitive", foreground: "89dceb" },
        { token: "keyword.constant", foreground: "fab387" },
        { token: "keyword.declaration", foreground: "f9e2af" },
        { token: "keyword.package", foreground: "f5c2e7" },
        { token: "keyword.import", foreground: "f5c2e7" },
        { token: "keyword.class", foreground: "f9e2af" },
        { token: "keyword.interface", foreground: "f9e2af" },
        { token: "keyword.enum", foreground: "f9e2af" },
        { token: "keyword.extends", foreground: "f9e2af" },
        { token: "keyword.implements", foreground: "f9e2af" },
        { token: "keyword.new", foreground: "f5c2e7" },
        { token: "keyword.this", foreground: "f38ba8" },
        { token: "keyword.super", foreground: "f38ba8" },
        { token: "keyword.if", foreground: "f38ba8" },
        { token: "keyword.else", foreground: "f38ba8" },
        { token: "keyword.for", foreground: "f38ba8" },
        { token: "keyword.while", foreground: "f38ba8" },
        { token: "keyword.do", foreground: "f38ba8" },
        { token: "keyword.switch", foreground: "f38ba8" },
        { token: "keyword.case", foreground: "f38ba8" },
        { token: "keyword.default", foreground: "f38ba8" },
        { token: "keyword.break", foreground: "f38ba8" },
        { token: "keyword.continue", foreground: "f38ba8" },
        { token: "keyword.return", foreground: "f38ba8" },
        { token: "keyword.try", foreground: "f38ba8" },
        { token: "keyword.catch", foreground: "f38ba8" },
        { token: "keyword.finally", foreground: "f38ba8" },
        { token: "keyword.throw", foreground: "f38ba8" },
        { token: "keyword.throws", foreground: "f38ba8" },
        { token: "keyword.instanceof", foreground: "f38ba8" },
        { token: "keyword.true", foreground: "fab387" },
        { token: "keyword.false", foreground: "fab387" },
        { token: "keyword.null", foreground: "fab387" },
        { token: "keyword.void", foreground: "89dceb" },
        { token: "keyword.int", foreground: "89dceb" },
        { token: "keyword.long", foreground: "89dceb" },
        { token: "keyword.short", foreground: "89dceb" },
        { token: "keyword.byte", foreground: "89dceb" },
        { token: "keyword.float", foreground: "89dceb" },
        { token: "keyword.double", foreground: "89dceb" },
        { token: "keyword.char", foreground: "89dceb" },
        { token: "keyword.boolean", foreground: "89dceb" },
        { token: "string", foreground: "a6e3a1" },
        { token: "string.escape", foreground: "f5c2e7" },
        { token: "number", foreground: "fab387" },
        { token: "number.hex", foreground: "fab387" },
        { token: "number.float", foreground: "fab387" },
        { token: "annotation", foreground: "f5c2e7" },
        { token: "delimiter", foreground: "9399b2" },
        { token: "delimiter.java", foreground: "89dceb" },
        { token: "type", foreground: "f9e2af" },
        { token: "type.identifier", foreground: "f9e2af" },
        { token: "function", foreground: "89b4fa" },
        { token: "variable", foreground: "cdd6f4" },
        { token: "variable.predefined", foreground: "f38ba8" },
        { token: "constant", foreground: "fab387" },
        { token: "identifier", foreground: "cdd6f4" },
        { token: "tag", foreground: "cba6f7" },
      ],
    },
    "catppuccin-latte": {
      base: "vs", inherit: true,
      colors: {
        "editor.background": "#eff1f5",
        "editor.lineHighlightBackground": "#e6e9ef",
        "editorLineNumber.foreground": "#9ca0b0",
        "editorLineNumber.activeForeground": "#8839ef",
        "editor.selectionBackground": "#acb0be66",
        "editorCursor.foreground": "#dc8a78",
        "editorIndentGuide.background1": "#dce0e8",
        "editorIndentGuide.activeBackground1": "#9ca0b0",
        "editorBracketHighlight.foreground1": "#d20f39",
        "editorBracketHighlight.foreground2": "#fe640b",
        "editorBracketHighlight.foreground3": "#40a02b",
        "editorBracketHighlight.foreground4": "#1e66f5",
        "editorBracketHighlight.foreground5": "#8839ef",
        "editorBracketHighlight.foreground6": "#179299",
        "editorWidget.background": "#e6e9ef",
        "editorSuggestWidget.background": "#e6e9ef",
        "editorSuggestWidget.selectedBackground": "#ccd0da",
      },
      rules: [
        { token: "", foreground: "4c4f69" },
        { token: "comment", foreground: "9ca0b0", fontStyle: "italic" },
        { token: "comment.doc", foreground: "8c8fa1", fontStyle: "italic" },
        { token: "keyword", foreground: "8839ef" },
        { token: "keyword.control", foreground: "d20f39" },
        { token: "keyword.primitive", foreground: "04a5e5" },
        { token: "keyword.constant", foreground: "fe640b" },
        { token: "keyword.declaration", foreground: "df8e1d" },
        { token: "keyword.package", foreground: "ea76cb" },
        { token: "keyword.import", foreground: "ea76cb" },
        { token: "keyword.class", foreground: "df8e1d" },
        { token: "keyword.interface", foreground: "df8e1d" },
        { token: "keyword.enum", foreground: "df8e1d" },
        { token: "keyword.extends", foreground: "df8e1d" },
        { token: "keyword.implements", foreground: "df8e1d" },
        { token: "keyword.new", foreground: "ea76cb" },
        { token: "keyword.this", foreground: "d20f39" },
        { token: "keyword.super", foreground: "d20f39" },
        { token: "keyword.if", foreground: "d20f39" },
        { token: "keyword.else", foreground: "d20f39" },
        { token: "keyword.for", foreground: "d20f39" },
        { token: "keyword.while", foreground: "d20f39" },
        { token: "keyword.do", foreground: "d20f39" },
        { token: "keyword.switch", foreground: "d20f39" },
        { token: "keyword.case", foreground: "d20f39" },
        { token: "keyword.default", foreground: "d20f39" },
        { token: "keyword.break", foreground: "d20f39" },
        { token: "keyword.continue", foreground: "d20f39" },
        { token: "keyword.return", foreground: "d20f39" },
        { token: "keyword.try", foreground: "d20f39" },
        { token: "keyword.catch", foreground: "d20f39" },
        { token: "keyword.finally", foreground: "d20f39" },
        { token: "keyword.throw", foreground: "d20f39" },
        { token: "keyword.throws", foreground: "d20f39" },
        { token: "keyword.instanceof", foreground: "d20f39" },
        { token: "keyword.true", foreground: "fe640b" },
        { token: "keyword.false", foreground: "fe640b" },
        { token: "keyword.null", foreground: "fe640b" },
        { token: "keyword.void", foreground: "04a5e5" },
        { token: "keyword.int", foreground: "04a5e5" },
        { token: "keyword.long", foreground: "04a5e5" },
        { token: "keyword.short", foreground: "04a5e5" },
        { token: "keyword.byte", foreground: "04a5e5" },
        { token: "keyword.float", foreground: "04a5e5" },
        { token: "keyword.double", foreground: "04a5e5" },
        { token: "keyword.char", foreground: "04a5e5" },
        { token: "keyword.boolean", foreground: "04a5e5" },
        { token: "string", foreground: "40a02b" },
        { token: "string.escape", foreground: "ea76cb" },
        { token: "number", foreground: "fe640b" },
        { token: "number.hex", foreground: "fe640b" },
        { token: "number.float", foreground: "fe640b" },
        { token: "annotation", foreground: "ea76cb" },
        { token: "delimiter", foreground: "8c8fa1" },
        { token: "delimiter.java", foreground: "04a5e5" },
        { token: "type", foreground: "df8e1d" },
        { token: "type.identifier", foreground: "df8e1d" },
        { token: "function", foreground: "1e66f5" },
        { token: "variable", foreground: "4c4f69" },
        { token: "variable.predefined", foreground: "d20f39" },
        { token: "constant", foreground: "fe640b" },
        { token: "identifier", foreground: "4c4f69" },
        { token: "tag", foreground: "8839ef" },
      ],
    },
    // GitHub Dark High Contrast（GitHub 官方主题，社区安装量第一；下同）
    "github-hc-dark": {
      base: "vs-dark", inherit: true,
      colors: {
        "editor.background": "#0a0c10",
        "editor.lineHighlightBackground": "#9ea7b31a",
        "editorLineNumber.foreground": "#9ea7b3",
        "editorLineNumber.activeForeground": "#f0f3f6",
        "editor.selectionBackground": "#ffffff",
        "editor.selectionForeground": "#0a0c10",
        "editorCursor.foreground": "#71b7ff",
        "editorIndentGuide.background1": "#bdc4cc26",
        "editorIndentGuide.activeBackground1": "#bdc4cc66",
        "editorBracketHighlight.foreground1": "#91cbff",
        "editorBracketHighlight.foreground2": "#4ae168",
        "editorBracketHighlight.foreground3": "#f7c843",
        "editorBracketHighlight.foreground4": "#ffb1af",
        "editorBracketHighlight.foreground5": "#ffadd4",
        "editorBracketHighlight.foreground6": "#dbb7ff",
        "editorWidget.background": "#272b33",
        "editorSuggestWidget.background": "#272b33",
        "editorSuggestWidget.selectedBackground": "#3a4047",
      },
      rules: [
        { token: "", foreground: "f0f3f6" },
        { token: "comment", foreground: "bdc4cc" },
        { token: "comment.doc", foreground: "bdc4cc" },
        { token: "keyword", foreground: "ff9492" },
        { token: "keyword.control", foreground: "ff9492" },
        { token: "keyword.declaration", foreground: "ff9492" },
        { token: "keyword.package", foreground: "ff9492" },
        { token: "keyword.import", foreground: "ff9492" },
        { token: "keyword.primitive", foreground: "91cbff" },
        { token: "keyword.constant", foreground: "91cbff" },
        { token: "string", foreground: "addcff" },
        { token: "string.escape", foreground: "ff9492" },
        { token: "number", foreground: "91cbff" },
        { token: "number.hex", foreground: "91cbff" },
        { token: "number.float", foreground: "91cbff" },
        { token: "annotation", foreground: "ffb757" },
        { token: "delimiter", foreground: "bdc4cc" },
        { token: "delimiter.java", foreground: "f0f3f6" },
        { token: "type", foreground: "ffb757" },
        { token: "type.identifier", foreground: "ffb757" },
        { token: "function", foreground: "dbb7ff" },
        { token: "variable", foreground: "ffb757" },
        { token: "variable.predefined", foreground: "ff9492" },
        { token: "constant", foreground: "91cbff" },
        { token: "identifier", foreground: "f0f3f6" },
        { token: "tag", foreground: "72f088" },
      ],
    },
    // GitHub Light High Contrast
    "github-hc-light": {
      base: "vs", inherit: true,
      colors: {
        "editor.background": "#ffffff",
        "editor.lineHighlightBackground": "#e7ecf0",
        "editorLineNumber.foreground": "#88929d",
        "editorLineNumber.activeForeground": "#0e1116",
        "editor.selectionBackground": "#0e1116",
        "editor.selectionForeground": "#ffffff",
        "editorCursor.foreground": "#0349b4",
        "editorIndentGuide.background1": "#88929d33",
        "editorIndentGuide.activeBackground1": "#88929d80",
        "editorBracketHighlight.foreground1": "#0349b4",
        "editorBracketHighlight.foreground2": "#055d20",
        "editorBracketHighlight.foreground3": "#744500",
        "editorBracketHighlight.foreground4": "#a0111f",
        "editorBracketHighlight.foreground5": "#971368",
        "editorBracketHighlight.foreground6": "#622cbc",
        "editorWidget.background": "#ffffff",
        "editorSuggestWidget.background": "#ffffff",
        "editorSuggestWidget.selectedBackground": "#e7ecf0",
      },
      rules: [
        { token: "", foreground: "0e1116" },
        { token: "comment", foreground: "66707b" },
        { token: "comment.doc", foreground: "66707b" },
        { token: "keyword", foreground: "a0111f" },
        { token: "keyword.control", foreground: "a0111f" },
        { token: "keyword.declaration", foreground: "a0111f" },
        { token: "keyword.package", foreground: "a0111f" },
        { token: "keyword.import", foreground: "a0111f" },
        { token: "keyword.primitive", foreground: "023b95" },
        { token: "keyword.constant", foreground: "023b95" },
        { token: "string", foreground: "032563" },
        { token: "string.escape", foreground: "a0111f" },
        { token: "number", foreground: "023b95" },
        { token: "number.hex", foreground: "023b95" },
        { token: "number.float", foreground: "023b95" },
        { token: "annotation", foreground: "702c00" },
        { token: "delimiter", foreground: "4b535d" },
        { token: "delimiter.java", foreground: "0e1116" },
        { token: "type", foreground: "702c00" },
        { token: "type.identifier", foreground: "702c00" },
        { token: "function", foreground: "622cbc" },
        { token: "variable", foreground: "702c00" },
        { token: "variable.predefined", foreground: "a0111f" },
        { token: "constant", foreground: "023b95" },
        { token: "identifier", foreground: "0e1116" },
        { token: "tag", foreground: "024c1a" },
      ],
    },
  };
  // 可选主题：每套都有深/浅变体，跟随平台显示模式自动切换
  const THEME_CHOICES = {
    catppuccin: { label: "Catppuccin", dark: "catppuccin-mocha", light: "catppuccin-latte" },
    github: { label: "GitHub 高对比", dark: "github-hc-dark", light: "github-hc-light" },
  };
  if (!THEME_CHOICES[themeName]) themeName = "catppuccin";
  const uiTheme = name => {
    const t = THEME_CHOICES[themeName] || THEME_CHOICES.catppuccin;
    return name === "vs" ? t.light : name === "vs-dark" ? t.dark : name;
  };
  const editors = [];              // { ed, orig }：编辑器实例 + 原字体设置，便于恢复默认

  // 读取原值：字体项用于恢复默认；光标项单独存，避免两类设置互相覆盖
  const readOrigOptions = ed => {
    try {
      const EO = window.Monaco?.editor?.EditorOption;
      if (!EO) return { font: {}, cursor: false };
      return {
        font: {
          fontFamily: ed.getOption(EO.fontFamily),
          fontLigatures: ed.getOption(EO.fontLigatures),
          bracketPairColorization: ed.getOption(EO.bracketPairColorization),
        },
        cursor: EO.cursorSmoothCaretAnimation ? ed.getOption(EO.cursorSmoothCaretAnimation) : false,
      };
    } catch (e) { return { font: {}, cursor: false }; }
  };

  /* Java 着色增强：自定义 Monaco 的 Java tokenizer ——
     这个版本的 Monaco 不支持语义着色，用语法规则启发式区分 类名/方法/常量/变量 */
  const JAVA_MONARCH = smart => ({
    defaultToken: "",
    tokenPostfix: ".java",
    tokenizer: {
      root: [
        [/[ \t\r\n]+/, ""],
        [/\/\*\*(?!\/)/, "comment.doc", "@docComment"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
        [/@[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*/, "annotation"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/'/, "string", "@char"],
        [/0[xX][0-9a-fA-F_]+[Ll]?/, "number.hex"],
        [/0[bB][01_]+[Ll]?/, "number.hex"],
        [/[0-9][0-9_]*\.[0-9_]*([eE][+-]?[0-9]+)?[fFdD]?/, "number.float"],
        [/\.[0-9][0-9_]*([eE][+-]?[0-9]+)?[fFdD]?/, "number.float"],
        [/[0-9][0-9_]*([eE][+-]?[0-9]+[fFdD]?|[fFdD])/, "number.float"],
        [/[0-9][0-9_]*[Ll]?/, "number"],
        ...(smart ? [
          [/(?:if|else|for|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|throws|instanceof|assert|yield)\b/, "keyword.control"],
          [/(?:boolean|byte|char|double|float|int|long|short|void|var)\b/, "keyword.primitive"],
          [/(?:true|false|null)\b/, "keyword.constant"],
          [/(?:class|interface|enum|extends|implements|record|sealed|permits)\b/, "keyword.declaration"],
          [/(?:package|import)\b/, "keyword.import"],
          [/(?:abstract|public|private|protected|static|final|synchronized|volatile|transient|native|strictfp|this|super|new)\b/, "keyword"],
          [/[A-Z][A-Z0-9_]+/, "constant"],
          [/[A-Z][A-Za-z0-9_$]*/, "type.identifier"],
          [/[a-z_$][\w$]*(?=\s*\()/, "function"],
          [/[a-z_$][\w$]*/, "identifier"],
        ] : [
          [/(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|true|false|null|var|record|sealed|permits|yield)\b/, "keyword"],
          [/[A-Za-z_$][\w$]*/, "identifier"],
        ]),
        [/[{}()\[\]]/, "delimiter"],
        [/[;,.]/, "delimiter"],
        [/[+\-*/%=!<>&|^~?:]+/, "delimiter.java"],
        [/@/, "delimiter.java"],
      ],
      comment: [
        [/\*\//, "comment", "@pop"],
        [/./, "comment"],
      ],
      docComment: [
        [/\*\//, "comment.doc", "@pop"],
        [/./, "comment.doc"],
      ],
      string: [
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
        [/[^\\"]+/, "string"],
      ],
      char: [
        [/\\./, "string.escape"],
        [/'/, "string", "@pop"],
        [/[^\\']+/, "string"],
      ],
    },
  });

  const installTokenizer = () => {
    try {
      window.Monaco?.languages?.setMonarchTokensProvider?.("java", JAVA_MONARCH(themeOn));
    } catch (e) {}
  };

  const applyTheme = () => {
    try { window.Monaco?.editor?.__ftOrigSetTheme?.(themeOn ? uiTheme(platformTheme) : platformTheme); } catch (e) {}
    installTokenizer();
  };

  const applyFont = () => {
    editors.forEach(({ ed, orig }) => {
      try { ed.updateOptions(fontOn ? UI_OPTIONS : orig); } catch (e) {}
    });
    if (fontOn) { try { document.fonts?.ready?.then(() => window.Monaco?.editor?.remeasureFonts?.()); } catch (e) {} }
  };

  // 光标手感：闪烁统一用柔和档；平滑移动跟随开关（此版本只有开/关，打字时也会滑）
  const cursorOptions = orig => {
    const EO = window.Monaco?.editor?.EditorOption;
    const opts = { cursorBlinking: "smooth" };
    if (EO?.cursorSmoothCaretAnimation) opts.cursorSmoothCaretAnimation = cursorOn ? true : orig;
    return opts;
  };

  const applyCursor = () => {
    editors.forEach(({ ed, cursorOrig }) => {
      try { ed.updateOptions(cursorOptions(cursorOrig)); } catch (e) {}
    });
  };

  // “默认深色”：启用时若平台是白背景，就点它自己的设置切到黑色背景（一次性、尽力而为）
  const ensureDarkMode = () => {
    if (platformTheme !== "vs") return;
    try {
      $$("i").find(e => String(e.className).includes("icon-shezhi9"))?.click();
      setTimeout(() => {
        try {
          const item = $(".tpi-code-setting .ant-select-selection-item");
          if (!item || (item.getAttribute("title") || item.innerText).indexOf("白色背景") < 0) return;
          const sel = $(".tpi-code-setting .ant-select-selector");
          sel?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          sel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          setTimeout(() => {
            const opt = $$(".ant-select-item")
              .find(o => (o.innerText || "").trim() === "黑色背景");
            if (!opt) return;
            opt.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            setTimeout(() => $$("i").find(e => String(e.className).includes("icon-shezhi9"))?.click(), 500);   // 收起设置面板
          }, 300);
        } catch (e) {}
      }, 400);
    } catch (e) {}
  };

  const setThemeState = on => {
    themeOn = !!on;
    try { localStorage.setItem(UI_THEME_KEY, themeOn ? "on" : "off"); } catch (e) {}
    applyTheme();
    if (themeOn) ensureDarkMode();
  };

  const setThemeName = name => {
    if (!THEME_CHOICES[name] || name === themeName) return;
    themeName = name;
    try { localStorage.setItem(UI_THEME_NAME, name); } catch (e) {}
    if (themeOn) applyTheme();
  };

  const setFontState = on => {
    fontOn = !!on;
    fontAsked = true;
    try {
      localStorage.setItem(UI_FONT_KEY, fontOn ? "on" : "off");
      localStorage.setItem(UI_FONT_ASKED, "1");
    } catch (e) {}
    applyFont();
  };

  const setCursorState = on => {
    cursorOn = !!on;
    try { localStorage.setItem(UI_CURSOR_KEY, cursorOn ? "on" : "off"); } catch (e) {}
    applyCursor();
  };

  // 页面可能先创建编辑器、后暴露 window.Monaco —— 用 DOM 的 React fiber 反查已有实例
  const findEditors = () => {
    const found = [];
    $$(".monaco-editor").forEach(el => {
      let node = el;
      while (node) {
        const key = Object.keys(node).find(k => k.startsWith("__reactFiber$"));
        if (key) {
          let f = node[key], d = 0;
          while (f && d < 80) {
            let hook = f.memoizedState, h = 0;
            while (hook && h < 50) {
              const v = hook.memoizedState;
              if (v?.current?.instance?.updateOptions) { found.push(v.current.instance); return; }
              hook = hook.next; h++;
            }
            f = f.return; d++;
          }
          return;
        }
        node = node.parentElement;
      }
    });
    return found;
  };

  // 挂钩：接管 setTheme（记录平台主题 + 按开关映射）；登记编辑器实例（新旧都收）
  const hookEditorUI = M => {
    if (!M?.editor || M.editor.__ftUIHooked) return;
    M.editor.__ftUIHooked = true;

    if (!M.editor.__ftThemesDefined) {
      M.editor.__ftThemesDefined = true;
      Object.entries(UI_THEMES).forEach(([name, theme]) => { try { M.editor.defineTheme(name, theme); } catch (e) {} });
    }

    const origSetTheme = M.editor.setTheme.bind(M.editor);
    M.editor.__ftOrigSetTheme = origSetTheme;
    M.editor.setTheme = name => {
      themeTouched = true;
      platformTheme = name;
      return origSetTheme(themeOn ? uiTheme(name) : name);
    };

    if (!M.languages.__ftMonarchHooked) {   // 内置 Java 语法是异步装载的，会覆盖我们装的，这里全部接管
      M.languages.__ftMonarchHooked = true;
      const origMonarch = M.languages.setMonarchTokensProvider.bind(M.languages);
      M.languages.setMonarchTokensProvider = (id, def) =>
        origMonarch(id, id === "java" && themeOn ? JAVA_MONARCH(true) : def);
    }

    const registerEditor = ed => {
      if (!ed || editors.some(e => e.ed === ed)) return;
      if (!editors.length && !themeTouched) {             // 页面没调过 setTheme → 从编辑器 class 判断深浅
        const el = $(".monaco-editor");
        if (el) platformTheme = el.classList.contains("vs-dark") ? "vs-dark" : "vs";
      }
      const orig = readOrigOptions(ed);
      editors.push({ ed, orig: orig.font, cursorOrig: orig.cursor });
      if (fontOn) { try { ed.updateOptions(UI_OPTIONS); } catch (e) {} }
      try { ed.updateOptions(cursorOptions(orig.cursor)); } catch (e) {}
    };

    M.editor.onDidCreateEditor?.(registerEditor);   // 之后创建的编辑器
    findEditors().forEach(registerEditor);          // 页面在我们挂钩之前已创建的编辑器

    if (themeOn) {
      try { origSetTheme(uiTheme(platformTheme)); } catch (e) {}
      installTokenizer();
      [400, 1200, 2500].forEach(ms => setTimeout(() => { if (themeOn) installTokenizer(); }, ms));   // 内置 Java 语法异步装载，装完会覆盖我们
    }
    if (themeOn && !M.editor.__ftDarkChecked) {     // 主题默认开启 → 首次进页面尝试切到黑色背景
      M.editor.__ftDarkChecked = true;
      setTimeout(ensureDarkMode, 600);
    }
  };

  // 首次使用询问（只问一次）
  const showUIPrompt = () => {
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
    const mkBtn = (text, primary) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "border:0;border-radius:8px;padding:6px 16px;font-size:13px;cursor:pointer;margin-right:8px;" +
        (primary ? "background:#1677ff;color:#fff;" : "background:#333;color:#ddd;");
      return b;
    };
    const done = on => {
      setFontState(on);
      wrap.remove();
    };
    const yes = mkBtn("启用", true), no = mkBtn("暂不", false);
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    wrap.append(yes, no);
    (document.body || document.documentElement).appendChild(wrap);
  };

  const maybeAskUI = () => {
    try {
      if (fontAsked || fontOn) return;       // 字体问过一次 / 已开启就不再打扰
      if (!$(".monaco-editor")) return;      // 只在有编辑器的页面询问
      showUIPrompt();
    } catch (e) {}
  };

  // 给扩展弹窗用的接口
  try {
    const uiState = () => ({ theme: themeOn, font: fontOn, themeName, cursor: cursorOn });
    window.__fuckTougeUI = {
      get: uiState,
      set: next => {                 // 只处理传入的字段，避免误改其它状态
        if (next && typeof next === "object") {
          if ("themeName" in next) setThemeName(next.themeName);
          if ("theme" in next) setThemeState(!!next.theme);
          if ("font" in next) setFontState(!!next.font);
          if ("cursor" in next) setCursorState(!!next.cursor);
        }
        return uiState();
      },
    };
  } catch (e) {}

  /* ── ① 剪贴板保护：头歌会在编辑器聚焦时往剪贴板写入一个空格 ── */
  try {
    const cb = navigator.clipboard;
    if (cb) {
      const writeText = cb.writeText.bind(cb);
      Object.defineProperty(cb, "writeText", {
        configurable: true,
        value: t => (String(t).length > 2 && String(t).trim() !== "")
          ? writeText(t)
          : Promise.reject(new DOMException("blocked", "NotAllowedError")),
      });
      Object.defineProperty(cb, "write", {
        configurable: true,
        value: () => Promise.reject(new DOMException("blocked", "NotAllowedError")),
      });
    }
  } catch (e) {}

  /* ── ② 粘贴回落保护：网页会删掉刚粘贴的内容，检测到删除后撤销回来 ── */
  let watchUntil = 0, undoCount = 0;

  const modelChange = e => {
    if (Date.now() > watchUntil || undoCount >= 3) return;
    if (!e.changes.some(c => !c.text && c.rangeLength > 0)) return;
    undoCount++;
    watchUntil = Date.now() + 300;
    setTimeout(() => {
      const ta = document.activeElement?.closest?.(".monaco-editor")
        ? document.activeElement
        : $(".monaco-editor textarea.inputarea");
      if (!ta) return;
      ta.focus();
      const k = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" });
      Object.defineProperty(k, "keyCode", { get: () => 90 });
      ta.dispatchEvent(k);
    }, 30);
  };

  const hookModel = m => {
    if (m.__ftHooked) return;
    m.__ftHooked = true;
    m.onDidChangeContent(modelChange);
  };

  const hookMonaco = M => {
    if (!M?.editor) return;
    M.editor.getModels?.().forEach(hookModel);
    if (!M.__ftCreateHooked && M.editor.onDidCreateModel) {
      M.__ftCreateHooked = true;
      M.editor.onDidCreateModel(hookModel);
    }
    hookEditorUI(M);
  };

  let monaco = window.Monaco;                 // 兼容脚本在页面之后运行的情况
  try {
    Object.defineProperty(window, "Monaco", {
      configurable: true,
      get: () => monaco,
      set(v) { monaco = v; try { hookMonaco(v); } catch (e) {} },   // 异常不能外泄到页面
    });
  } catch (e) {}
  try { hookMonaco(monaco); } catch (e) {}
  const hookTimer = setInterval(() => {
    try { hookMonaco(window.Monaco); } catch (e) {}
    if (monaco && document.readyState === "complete") clearInterval(hookTimer);
  }, 1000);
  setTimeout(() => clearInterval(hookTimer), 60000);

  /* ── ③ 按键直通：Ctrl+V 不被页面拦截；Ctrl+C / Ctrl+X 放行 ── */
  window.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = (e.key || "").toLowerCase(), code = e.keyCode || e.which;
    if (key === "v" || code === 86) {
      e.stopImmediatePropagation();
      watchUntil = Date.now() + 300;   // 网页删除是同步的（约 10ms），窗口开 300ms 足够，且避免误撤销用户自己的删除
      undoCount = 0;
    } else if (key === "c" || key === "x" || code === 67 || code === 88) {
      e.stopImmediatePropagation();
    }
  }, true);

  /* ── ④ 阻止浏览器“默认粘贴插入”：否则 Monaco 会把内容当成打字输入、触发自动缩进 ── */
  window.addEventListener("paste", e => {
    watchUntil = Date.now() + 300;    // 同步窗口；同时重置“撤销预算”，右键粘贴也能持续受保护
    undoCount = 0;
    if (document.activeElement?.closest?.(".monaco-editor")) e.preventDefault();
  }, true);

  /* ── ⑤ 清理属性式拦截 ── */
  const stripAttrs = () => {
    const attrs = ["onpaste", "oncopy", "oncut", "ondrop", "oncontextmenu"];
    [document, document.body].forEach(el => el && attrs.forEach(a => (el[a] = null)));
    $$("[onpaste],[oncopy],[oncut],[ondrop],[oncontextmenu]")
      .forEach(el => attrs.forEach(a => el.removeAttribute(a)));
  };
  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", stripAttrs)
    : stripAttrs();

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

  // 弹层按钮文案 → 类型：普通关「下一关」；最后一关「最后一关」；最后的测试关是「完成」
  const NEXT_LABELS = { "下一关": "next", "最后一关": "last", "完成": "last" };
  const normText = s => String(s || "").replace(/[\s\u200b-\u200d\ufeff]/g, "");
  const findNextBtn = box => {
    for (const el of $$("a, button, [role=button]", box)) {
      const kind = NEXT_LABELS[normText(el.innerText)];
      if (kind) return { el, kind };
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

    if (!next) {                                 // 弹层出现 3 秒还没有按钮 → 保守提示
      if (!box.__ftLastToast && Date.now() - box.__ftSeenAt > 3000) {
        box.__ftLastToast = true;
        toast("已经是最后一关了 😋");
      }
      return;
    }

    if (next.el.disabled === true || next.el.getAttribute("aria-disabled") === "true") {
      if (Date.now() - box.__ftSeenAt > 10000) box.__ftClicked = true;   // 一直不激活就放弃，避免无限等
      return;                                    // 按钮还没激活（评测刚结束时短暂禁用）→ 下一轮再点
    }

    box.__ftClicked = true;
    setTimeout(() => {
      clickLikeUser(next.el);
      jumpNotice(next.kind);
    }, 200);
  };

  /* ── ⑦ 选择题：手动点「评测」且评测结束后，自动点页面自带的「下一关」（仅选择题页）── */
  let choiceEval = null;   // { seenDisabled, t0 }

  const evalButton = () => $$("button, [role=button]").find(b => (b.innerText || "").trim() === "评测");
  const pageNextButton = () => $$("a, button, [role=button]").find(el =>
    visible(el) && (el.innerText || "").trim() === "下一关" && !el.closest(".evaluate-result-container"));

  const watchChoiceEval = () => {
    if (!choiceEval) return;
    const btn = evalButton();
    if (btn?.disabled) choiceEval.seenDisabled = true;
    const finished = btn && !btn.disabled && (choiceEval.seenDisabled || Date.now() - choiceEval.t0 > 1500);
    if (finished) {
      choiceEval = null;
      setTimeout(() => {
        const next = pageNextButton();
        if (!next) {                       // 最后一关：页面上没有「下一关」按钮
          toast("已经是最后一关了 😋");
          return;
        }
        next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        jumpNotice();
      }, 300);
      return;
    }
    if (Date.now() - choiceEval.t0 > 30000) { choiceEval = null; return; }
    setTimeout(watchChoiceEval, 250);
  };

  document.addEventListener("click", e => {
    const btn = e.target?.closest?.("button, [role=button], a");
    if (!btn || (btn.innerText || "").trim() !== "评测" || $(".monaco-editor")) return;   // 仅限选择题
    choiceEval = { seenDisabled: false, t0: Date.now() };
    setTimeout(watchChoiceEval, 250);
  }, true);

  // document 在 document_start 时必然存在（documentElement 可能还没有）
  let autoNextAt = 0;
  new MutationObserver(() => {                 // 页面 DOM 变动很频繁，节流后再查弹层
    const now = Date.now();
    if (now < autoNextAt) return;
    autoNextAt = now + 200;
    autoNext();
  }).observe(document, { childList: true, subtree: true });
  setInterval(() => { autoNext(); maybeAskUI(); stripAttrs(); }, 1000);
})();
