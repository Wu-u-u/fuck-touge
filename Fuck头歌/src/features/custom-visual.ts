import { COLOR_DEFS, activeWallpaper, contrastText, normalizeCustomConfig } from "../shared/custom";
import { toast } from "../ui/toast";
import type { CustomConfig, Wallpaper } from "../shared/types";
import { isAnswerPage } from "./theme/skin";

const STYLE_ID = "ft-custom-visual";
const BG_ID = "ft-bg";
const BG_NEXT_ID = "ft-bg-next";
const BRIDGE_SOURCE = "fuck-touge-bridge";
const MAIN_SOURCE = "fuck-touge-main";

export interface CustomVisualDeps {
  isThemeOn(): boolean;
  isAnswerPage?(): boolean;
  isTopFrame?(): boolean;
  onConfig?(config: CustomConfig): void;
}

export interface CustomVisualController {
  install(): void;
  apply(): void;
  dispose(): void;
  getConfig(): CustomConfig;
}

const defaultTopFrame = (): boolean => {
  try {
    return window.top === window;
  } catch (e) {
    return false;
  }
};

/**
 * 背景与页面颜色（只作用于答题页 + 主题开启 + 顶层 frame）。
 * 配置来自 bridge 的 postMessage；本模块不直接碰 chrome.storage。
 */
export function createCustomVisual(deps: CustomVisualDeps): CustomVisualController {
  const onAnswerPage = deps.isAnswerPage || (() => isAnswerPage());
  const onTopFrame = deps.isTopFrame || defaultTopFrame;
  let config: CustomConfig = normalizeCustomConfig(null);
  let retryTimer = 0;
  let currentId = "";
  let currentLayer: HTMLDivElement | null = null;
  let mediaUrl = "";
  let switchTimer = 0;
  let lastEffect = "";
  const layerWp = new Map<HTMLDivElement, Wallpaper>();

  const clearRetry = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
  };

  const scheduleRetry = (): void => {
    if (retryTimer) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      apply();
    }, 50);
  };

  const ensureStyle = (css: string): void => {
    try {
      let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head || document.documentElement)?.appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
    } catch (e) {}
  };

  const removeStyle = (): void => {
    try {
      document.getElementById(STYLE_ID)?.remove();
    } catch (e) {}
  };

  const clearSwitch = (): void => {
    if (switchTimer) {
      clearTimeout(switchTimer);
      switchTimer = 0;
    }
  };

  const removeBg = (): void => {
    clearSwitch();
    currentId = "";
    currentLayer = null;
    layerWp.clear();
    try {
      document.getElementById(BG_ID)?.remove();
      document.getElementById(BG_NEXT_ID)?.remove();
    } catch (e) {}
  };

  const createLayer = (id: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.id = id;
    el.setAttribute("aria-hidden", "true");
    return el;
  };

  const layoutLayer = (el: HTMLDivElement, wp: Wallpaper, bg: CustomConfig["background"]): void => {
    const media = el.firstElementChild as HTMLImageElement | HTMLVideoElement | null;
    if (!media) return;
    const nw = wp.width || (media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth) || 0;
    const nh = wp.height || (media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight) || 0;
    if (!nw || !nh) return; // 等 loadedmetadata / load
    const crop = wp.crop || { x: 0, y: 0, w: 1, h: 1 };
    const cw = Math.max(1, crop.w * nw);
    const ch = Math.max(1, crop.h * nh);
    const W = window.innerWidth || 1;
    const H = window.innerHeight || 1;
    let sx: number;
    let sy: number;
    if (bg.fit === "stretch") {
      sx = W / cw;
      sy = H / ch;
    } else {
      const s = bg.fit === "contain" ? Math.min(W / cw, H / ch) : Math.max(W / cw, H / ch);
      sx = sy = s;
    }
    media.style.width = `${nw * sx}px`;
    media.style.height = `${nh * sy}px`;
    media.style.left = `${(W - cw * sx) / 2 - crop.x * nw * sx}px`;
    media.style.top = `${(H - ch * sy) / 2 - crop.y * nh * sy}px`;
  };

  const createMedia = (
    wp: Wallpaper,
    bg: CustomConfig["background"],
    layer: HTMLDivElement,
    src: string,
  ): HTMLImageElement | HTMLVideoElement => {
    let media: HTMLImageElement | HTMLVideoElement;
    if (wp.kind === "video") {
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      video.preload = "auto";
      video.src = src;
      video.addEventListener("loadedmetadata", () => layoutLayer(layer, wp, bg), { once: true });
      video.play?.().catch(() => {});
      media = video;
    } else {
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.src = src;
      img.addEventListener("load", () => layoutLayer(layer, wp, bg), { once: true });
      media = img;
    }
    media.style.position = "absolute";
    media.style.left = "0";
    media.style.top = "0";
    media.style.maxWidth = "none";
    media.style.maxHeight = "none";
    media.style.userSelect = "none";
    media.style.pointerEvents = "none";
    media.style.transformOrigin = "0 0";
    return media;
  };

  const styleLayer = (el: HTMLDivElement, bg: CustomConfig["background"], wp: Wallpaper, src: string): void => {
    el.style.background = "transparent";
    el.style.opacity = String(bg.opacity);
    el.style.position = "fixed";
    el.style.inset = "0";
    el.style.overflow = "hidden";
    el.style.zIndex = "-1";
    el.style.pointerEvents = "none";
    el.style.willChange = "transform, opacity";
    const existing = el.firstElementChild;
    const sameKind = existing && (wp.kind === "video" ? existing instanceof HTMLVideoElement : existing instanceof HTMLImageElement);
    if (!sameKind) {
      const media = createMedia(wp, bg, el, src);
      el.replaceChildren(media);
    }
    layerWp.set(el, wp);
    layoutLayer(el, wp, bg);
  };

  const prefersReducedMotion = (): boolean => {
    try {
      return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    } catch (e) {
      return false;
    }
  };

  const ensureBg = (cfg: CustomConfig): void => {
    if (!document.body) {
      scheduleRetry();
      return;
    }
    const wp = activeWallpaper(cfg);
    const bg = cfg.background;
    if (!wp) {
      removeBg();
      return;
    }

    // 上一次切换还没结束：直接清掉两层，按一次新切换处理
    if (switchTimer) {
      clearSwitch();
      document.getElementById(BG_ID)?.remove();
      document.getElementById(BG_NEXT_ID)?.remove();
      currentLayer = null;
      currentId = "";
    }

    if (!currentLayer || !currentLayer.isConnected) {
      const el = createLayer(BG_ID);
      styleLayer(el, bg, wp, mediaUrl || wp.image);
      document.body.appendChild(el);
      currentLayer = el;
      currentId = wp.id;
      return;
    }

    if (currentId === wp.id) {
      styleLayer(currentLayer, bg, wp, mediaUrl || wp.image);
      return;
    }

    const old = currentLayer;
    const oldId = currentId;
    currentId = wp.id;
    const effects = [
      "fade", "wipe", "disc", "stripes", "zoom", "honeycomb",
      "vortex", "pixel", "diamond", "golden", "melt", "crt",
    ] as const;
    let effect = effects[Math.floor(Math.random() * effects.length)];
    if (effect === lastEffect) {
      effect = effects[(effects.indexOf(effect) + 1) % effects.length];
    }
    lastEffect = effect;
    if (!old.animate || prefersReducedMotion()) {
      const el = createLayer(BG_ID);
      styleLayer(el, bg, wp, mediaUrl || wp.image);
      document.body.appendChild(el);
      old.remove();
      currentLayer = el;
      return;
    }

    const next = createLayer(BG_NEXT_ID);
    styleLayer(next, bg, wp, mediaUrl || wp.image);
    next.style.opacity = "0";
    next.style.transformOrigin = "center";
    document.body.appendChild(next);
    currentLayer = next;

    try {
      const duration = 1200;
      const easing = "cubic-bezier(.22,1,.36,1)";
      const opacity = String(bg.opacity);
      const fadesIn = effect === "fade" || effect === "zoom" || effect === "vortex" || effect === "crt";
      next.style.opacity = fadesIn ? "0" : opacity;
      let oldKf: Keyframe[];
      let newKf: Keyframe[];

      const oldFade: Keyframe[] = [
        { opacity, transform: "scale(1)" },
        { opacity: 0, transform: "scale(1.03)" },
      ];

      if (effect === "fade") {
        oldKf = [{ opacity }, { opacity: 0 }];
        newKf = [{ opacity: 0 }, { opacity: bg.opacity }];
      } else if (effect === "zoom") {
        oldKf = [
          { transform: "scale(1)", opacity },
          { transform: "scale(1.08)", opacity: 0 },
        ];
        newKf = [
          { transform: "scale(.92)", opacity: 0 },
          { transform: "scale(1)", opacity },
        ];
      } else if (effect === "vortex") {
        oldKf = [
          { transform: "rotate(0deg) scale(1)", opacity },
          { transform: "rotate(-18deg) scale(.86)", opacity: 0 },
        ];
        newKf = [
          { transform: "rotate(24deg) scale(1.28)", opacity: 0 },
          { transform: "rotate(0deg) scale(1)", opacity },
        ];
      } else if (effect === "crt") {
        oldKf = [{ opacity, filter: "brightness(1)" }, { opacity: 0, filter: "brightness(2)" }];
        newKf = [
          { transform: "scaleY(.02)", opacity: 0, filter: "brightness(2.6)" },
          { transform: "scaleY(1)", opacity, filter: "brightness(1)" },
        ];
      } else if (effect === "wipe") {
        oldKf = oldFade;
        newKf = [
          { clipPath: "polygon(0 0, 0 0, 0 100%, 0 100%)" },
          { clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%)" },
        ];
      } else if (effect === "disc") {
        oldKf = oldFade;
        newKf = [
          { clipPath: "circle(0% at 50% 50%)" },
          { clipPath: "circle(75% at 50% 50%)" },
        ];
      } else if (effect === "diamond") {
        oldKf = oldFade;
        newKf = [
          { clipPath: "polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)" },
          { clipPath: "polygon(50% -10%, 110% 50%, 50% 110%, -10% 50%)" },
        ];
      } else if (effect === "golden") {
        oldKf = oldFade;
        newKf = [
          { clipPath: "circle(0% at 38% 38%)" },
          { clipPath: "circle(125% at 38% 38%)" },
        ];
      } else if (effect === "melt") {
        oldKf = oldFade;
        newKf = [
          { clipPath: "polygon(0 0, 100% 0, 100% 0, 0 0)", filter: "blur(2px)" },
          { clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%)", filter: "blur(0px)" },
        ];
      } else if (effect === "stripes") {
        oldKf = oldFade;
        next.style.maskImage = "repeating-linear-gradient(90deg, #000 0 6%, transparent 6% 12%)";
        next.style.maskSize = "220% 100%";
        newKf = [
          { maskPosition: "110% 0" },
          { maskPosition: "0% 0" },
        ];
      } else if (effect === "pixel") {
        oldKf = oldFade;
        next.style.maskImage = "linear-gradient(#000, #000)";
        next.style.maskRepeat = "repeat";
        next.style.maskSize = "8% 8%";
        newKf = [
          { maskSize: "8% 8%", maskPosition: "0 0" },
          { maskSize: "100% 100%", maskPosition: "0 0" },
        ];
      } else if (effect === "honeycomb") {
        oldKf = oldFade;
        const hex = "url(\"data:image/svg+xml," + encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='32'><path d='M14 1 26 8v16L14 31 2 24V8z' fill='white'/></svg>"
        ) + "\")";
        next.style.maskImage = hex;
        next.style.maskRepeat = "repeat";
        next.style.maskSize = "28px 32px";
        newKf = [
          { maskSize: "0px 0px" },
          { maskSize: "28px 32px" },
        ];
      } else {
        oldKf = oldFade;
        newKf = [{ opacity }, { opacity }];
      }

      // clip-path / mask 的边缘天然是硬的；给需要软边的效果加一点 blur，接近 shader 的 smoothstep
      if (["wipe", "disc", "diamond", "golden", "stripes", "pixel", "honeycomb"].includes(effect)) {
        newKf = newKf.map((kf, i) => ({ ...kf, filter: i === 0 ? "blur(1.6px)" : "blur(0px)" }));
      }

      const oldAnim = old.animate(oldKf, { duration, easing, fill: "both" });
      const nextAnim = next.animate(newKf, { duration, easing, fill: "both" });
      switchTimer = window.setTimeout(() => {
        switchTimer = 0;
        old.remove();
        nextAnim.cancel?.();
        oldAnim.cancel?.();
        next.style.transform = "none";
        next.style.opacity = opacity;
        next.style.clipPath = "";
        next.style.maskImage = "";
        next.style.maskSize = "";
        next.style.maskPosition = "";
        next.style.maskRepeat = "";
        next.style.filter = "none";
        next.id = BG_ID;
        currentLayer = next;
      }, duration + 20);
    } catch (e) {
      old.remove();
      next.style.transform = "none";
      next.style.opacity = String(bg.opacity);
      next.style.clipPath = "";
      next.style.maskImage = "";
      next.style.maskSize = "";
      next.style.maskPosition = "";
      next.style.maskRepeat = "";
      next.style.filter = "none";
      next.id = BG_ID;
      currentLayer = next;
    }

    if (oldId) toast(`已切换壁纸 · ${wp.name} 😋`);
  };

  const buildCss = (cfg: CustomConfig, withBg: boolean): string => {
    const rules: string[] = [];
    const colorLines: string[] = [];

    for (const def of COLOR_DEFS) {
      const value = cfg.colors[def.key];
      if (!value) continue;
      colorLines.push(`  ${def.cssVar}: ${value};`);
      // 让同一颜色覆盖到关联变量，避免面板/边框/链接还是旧色
      if (def.key === "panel") colorLines.push(`  --ft-panel2: ${value};`);
      if (def.key === "border") colorLines.push(`  --ft-code-border: ${value};`);
      if (def.key === "accent") {
        colorLines.push(`  --ft-link: ${value};`);
        colorLines.push(`  --ft-accent-fg: ${contrastText(value)};`);
      }
    }
    if (colorLines.length) {
      rules.push(`html[data-ft-skin] {\n${colorLines.join("\n")}\n}`);
    }

    if (withBg) {
      const panelAlpha = `${Math.round(cfg.background.panelOpacity * 100)}%`;
      const editorAlpha = `${Math.round(cfg.background.editorOpacity * 100)}%`;
      rules.push(`html[data-ft-skin][data-ft-bg] { --ft-panel-alpha: ${panelAlpha}; --ft-editor-alpha: ${editorAlpha}; }`);
      rules.push(`html[data-ft-skin][data-ft-bg] body { background: transparent !important; }`);
      rules.push(`html[data-ft-skin][data-ft-bg] :is(
  .left-panel, .task-header,
  [class*="task-header"], [class*="tab-nav"], [class*="tabs___"],
  [class*="test-case-item"], [class*="content-wrapper"], [class*="resize-y-bar"]
) { background-color: color-mix(in srgb, var(--ft-panel) var(--ft-panel-alpha), transparent) !important; }`);
      // 左侧面板内部还有 task-header / tab-nav / content-wrapper 自带底色；不清掉会三层叠加，背景几乎看不见
      rules.push(`html[data-ft-skin][data-ft-bg] .left-panel :is(
  .task-header, [class*="tab-nav"], [class*="content-wrapper"]
) { background-color: transparent !important; }`);
      rules.push(`html[data-ft-skin][data-ft-bg] :is(
  .task-header-container, [class*="test-set-container"], [class*="action-container"],
  [class*="test-header"], [class*="choose-game-item"]
) { background-color: color-mix(in srgb, var(--ft-panel2) var(--ft-panel-alpha), transparent) !important; }`);
      // 编辑器区域单独一层：容器透明，编辑器背景用 editor-alpha；文字不受影响
      rules.push(`html[data-ft-skin][data-ft-bg] :is(.right-panel, [class*="code-area-container"]) {
  background-color: transparent !important;
}`);
      rules.push(`html[data-ft-skin][data-ft-bg] :is(
  .monaco-editor, .monaco-editor .monaco-editor-background,
  .monaco-editor .margin
) {
  background-color: color-mix(in srgb, var(--ft-bg) var(--ft-editor-alpha), transparent) !important;
}`);
    }

    return rules.join("\n");
  };

  function apply(): void {
    const root = document.documentElement;
    if (!root) {
      scheduleRetry();
      return;
    }

    const active = deps.isThemeOn() && onAnswerPage() && onTopFrame();
    const activeWp = activeWallpaper(config);
    const bgOn = active && config.background.enabled && !!activeWp;
    const hasColors = active && Object.keys(config.colors).length > 0;

    if (!active) {
      clearRetry();
      root.removeAttribute("data-ft-bg");
      root.removeAttribute("data-ft-custom");
      removeStyle();
      removeBg();
      return;
    }

    if (hasColors) root.setAttribute("data-ft-custom", "");
    else root.removeAttribute("data-ft-custom");

    if (bgOn) root.setAttribute("data-ft-bg", "");
    else root.removeAttribute("data-ft-bg");

    const css = buildCss(config, bgOn);
    if (css) ensureStyle(css);
    else removeStyle();

    if (bgOn) ensureBg(config);
    else {
      clearRetry();
      removeBg();
    }
  }

  const onVisibility = (): void => {
    document.querySelectorAll<HTMLVideoElement>("#ft-bg video, #ft-bg-next video").forEach((v) => {
      try {
        if (document.hidden) v.pause();
        else v.play?.().catch(() => {});
      } catch (e) {}
    });
  };

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== window) return;
    const data = e.data as { source?: string; type?: string; config?: unknown } | null;
    if (!data || data.source !== BRIDGE_SOURCE || data.type !== "config") return;
    config = normalizeCustomConfig(data.config);
    apply();
    try {
      deps.onConfig?.(config);
    } catch (e) {}
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!e.ctrlKey || !e.altKey || e.code !== "KeyW") return;
    if (!deps.isThemeOn() || !onAnswerPage() || !onTopFrame()) return;
    if (!config.background.enabled) return;
    const wp = activeWallpaper(config);
    if (!wp) {
      toast("先添加一张壁纸 🤔");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    try {
      window.postMessage({ source: MAIN_SOURCE, type: "cycle-wallpaper" }, "*");
    } catch (err) {}
  };

  return {
    install: (): void => {
      window.addEventListener("message", onMessage);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("resize", () => {
        for (const [el, wp] of layerWp) {
          if (el.isConnected) layoutLayer(el, wp, config.background);
        }
      });
      window.addEventListener("keydown", onKeyDown, true);
      try {
        window.postMessage({ source: MAIN_SOURCE, type: "config-request" }, "*");
      } catch (e) {}
      // 页面骨架出现后补一次，避免 document_start 时 body 还不存在
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply, { once: true });
      }
    },
    apply,
    getConfig: () => config,
    dispose: (): void => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeyDown, true);
      clearRetry();
      removeStyle();
      removeBg();
    },
  };
}
