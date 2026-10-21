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
