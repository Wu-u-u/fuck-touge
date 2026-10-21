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
    themeName = localStorage.getItem(UI_THEME_NAME) || "catppuccin";
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
  const editors = [];              // { ed, orig, disposed }：编辑器实例 + 原字体设置，便于恢复默认

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

  // 我们自己的 tokenizer 定义（WeakSet 用来区分“平台传进来的 provider”与内置定义）
  const ftJavaDefs = new WeakSet();
  const javaDef = smart => {
    const def = JAVA_MONARCH(smart);
    ftJavaDefs.add(def);
    return def;
  };

  const installTokenizer = () => {
    if (!themeOn) return;   // 主题关闭时不接管着色
    try {
      window.Monaco?.languages?.setMonarchTokensProvider?.("java", javaDef(true));
    } catch (e) {}
  };

  // 主题 开→关：把 Java 着色还原成平台原 provider；拿不到原 provider 时退回基础规则，
  // 不能把增强 tokenizer 留在页面上
  const restoreTokenizer = () => {
    if (themeOn) return;
    try {
      const L = window.Monaco?.languages;
      if (!L) return;
      L.setMonarchTokensProvider?.("java", L.__ftJavaPlatformDef || javaDef(false));
    } catch (e) {}
  };

  const applyTheme = () => {
    try { window.Monaco?.editor?.__ftOrigSetTheme?.(themeOn ? uiTheme(platformTheme) : platformTheme); } catch (e) {}
    if (themeOn) installTokenizer(); else restoreTokenizer();
  };

  const applyFont = () => {
    editors.forEach(({ ed, orig, disposed }) => {
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
    editors.forEach(({ ed, cursorOrig, disposed }) => {
      if (disposed) return;                    // 已销毁的编辑器不再碰
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
    if (themeOn) ensureDarkMode();
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
        if (themeOn) ensureDarkMode();
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

    if (!M.languages.__ftMonarchHooked && typeof M.languages.setMonarchTokensProvider === "function") {
      // 内置 Java 语法是异步装载的，会覆盖我们装的，这里全部接管
      M.languages.__ftMonarchHooked = true;
      const origMonarch = M.languages.setMonarchTokensProvider.bind(M.languages);
      M.languages.__ftOrigMonarch = origMonarch;
      M.languages.setMonarchTokensProvider = (id, def) => {
        if (id !== "java") return origMonarch(id, def);
        if (!ftJavaDefs.has(def)) M.languages.__ftJavaPlatformDef = def;   // 记下平台原 provider，关主题时还原
        return origMonarch(id, themeOn ? javaDef(true) : def);
      };
    }

    const registerEditor = ed => {
      if (!ed || editors.some(e => e.ed === ed)) return;
      if (!editors.length && !themeTouched) {             // 页面没调过 setTheme → 从编辑器 class 判断深浅
        const el = $(".monaco-editor");
        if (el) platformTheme = el.classList.contains("vs-dark") ? "vs-dark" : "vs";
      }
      const orig = readOrigOptions(ed);
      const entry = { ed, orig: orig.font, cursorOrig: orig.cursor, disposed: false };
      editors.push(entry);
      try {                                                 // 编辑器销毁后立刻从数组里移除，避免越积越多
        ed.onDidDispose?.(() => {
          entry.disposed = true;
          const i = editors.indexOf(entry);
          if (i >= 0) editors.splice(i, 1);
        });
      } catch (e) {}
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

  const hookMonaco = M => {
    if (!M?.editor) return;
    M.editor.getModels?.().forEach(pasteGuard.hookModel);
    if (!M.__ftCreateHooked && M.editor.onDidCreateModel) {
      M.__ftCreateHooked = true;
      M.editor.onDidCreateModel(pasteGuard.hookModel);
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
