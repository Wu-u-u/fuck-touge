import { COLOR_DEFS, activeWallpaper, contrastText, normalizeCustomConfig } from "../shared/custom";
import { dataUrlToBlob, getCachedMedia, putCachedMedia, pruneCachedMedia } from "./media-cache";
import { toast } from "../ui/toast";
import type { CustomConfig, Wallpaper } from "../shared/types";
import { isAnswerPage } from "./theme/skin";
import { pickTransitionEffect, releaseShaderRenderer, startShaderTransition, type ShaderTransitionHandle, type TransitionEffect } from "./wallpaper-shader";

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
  let cleanupTimer = 0;
  let currentId = "";
  let currentLayer: HTMLDivElement | null = null;
  let mediaUrl = "";
  const mediaUrls = new Map<string, string>();
  const mediaPending = new Map<string, { promise: Promise<string | null>; resolve: (url: string | null) => void; timer: number }>();
  const mediaWarned = new Set<string>();
  let configSeq = 0;
  let switchTimer = 0;
  let lastEffect: TransitionEffect | "" = "";
  let switchSeq = 0;
  let activeShader: ShaderTransitionHandle | null = null;
  // WeakMap：旧图层移除后自动释放，不需要每次切换手动 delete
  const layerWp = new WeakMap<HTMLDivElement, Wallpaper>();

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
    switchSeq++;
    if (activeShader) {
      activeShader.cancel();
      activeShader = null;
    }
    try {
      document.getElementById("ft-bg-shader")?.remove();
    } catch (e) {}
  };

  const removeBg = (): void => {
    clearSwitch();
    currentId = "";
    currentLayer = null;
    mediaUrl = "";
    try {
      document.getElementById(BG_ID)?.remove();
      document.getElementById(BG_NEXT_ID)?.remove();
    } catch (e) {}
    releaseShaderRenderer();
    // 关闭背景/离开答题页后不再需要页面 object URL；重新开启时从 IDB 再取
    for (const url of mediaUrls.values()) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    mediaUrls.clear();
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

  const getMediaUrl = async (key: string): Promise<string | null> => {
    const ready = mediaUrls.get(key);
    if (ready) return ready;
    const blob = await getCachedMedia(key);
    if (blob) {
      const url = URL.createObjectURL(blob);
      mediaUrls.set(key, url);
      return url;
    }
    const pending = mediaPending.get(key);
    if (pending) return pending.promise;

    let resolve: (url: string | null) => void = () => {};
    const promise = new Promise<string | null>((r) => { resolve = r; });
    const timer = window.setTimeout(() => {
      const p = mediaPending.get(key);
      if (!p) return;
      mediaPending.delete(key);
      p.resolve(null);
    }, 30_000);
    mediaPending.set(key, { promise, resolve, timer });
    try {
      window.postMessage({ source: MAIN_SOURCE, type: "media-request", key }, "*");
    } catch (e) {
      clearTimeout(timer);
      mediaPending.delete(key);
      resolve(null);
    }
    return promise;
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
    } else if (existing) {
      const currentSrc = (existing as HTMLImageElement | HTMLVideoElement).src;
      if (currentSrc !== src) {
        (existing as HTMLImageElement | HTMLVideoElement).src = src;
        if (existing instanceof HTMLVideoElement) existing.play?.().catch(() => {});
      }
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
    const oldWp = layerWp.get(old);
    currentId = wp.id;
    const effect = pickTransitionEffect(bg.transition, lastEffect);
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

    const seq = ++switchSeq;
    switchTimer = window.setTimeout(() => {}, 2600);

    const animateCss = (): void => {
    try {
      const duration = 1500;
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
        const dir = Math.random() < .5 ? 1 : -1;
        oldKf = [
          { transform: "rotate(0deg) scale(1)", opacity },
          { transform: `rotate(${-18 * dir}deg) scale(.86)`, opacity: 0 },
        ];
        newKf = [
          { transform: `rotate(${24 * dir}deg) scale(1.28)`, opacity: 0 },
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
        const starts = [
          "polygon(0 0, 0 0, 0 100%, 0 100%)",
          "polygon(100% 0, 100% 0, 100% 100%, 100% 100%)",
          "polygon(0 0, 100% 0, 100% 0, 0 0)",
          "polygon(0 100%, 100% 100%, 100% 100%, 0 100%)",
        ];
        newKf = [
          { clipPath: starts[Math.floor(Math.random() * starts.length)] },
          { clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%)" },
        ];
      } else if (effect === "disc") {
        oldKf = oldFade;
        const cx = 32 + Math.random() * 36;
        const cy = 32 + Math.random() * 36;
        newKf = [
          { clipPath: `circle(0% at ${cx}% ${cy}%)` },
          { clipPath: `circle(130% at ${cx}% ${cy}%)` },
        ];
      } else if (effect === "diamond") {
        oldKf = oldFade;
        newKf = [
          { clipPath: "polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)" },
          { clipPath: "polygon(50% -10%, 110% 50%, 50% 110%, -10% 50%)" },
        ];
      } else if (effect === "golden") {
        oldKf = oldFade;
        const cx = 32 + Math.random() * 36;
        const cy = 32 + Math.random() * 36;
        newKf = [
          { clipPath: `circle(0% at ${cx}% ${cy}%)` },
          { clipPath: `circle(150% at ${cx}% ${cy}%)` },
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

    const oldMedia = old.firstElementChild as HTMLImageElement | HTMLVideoElement | null;
    const newMedia = next.firstElementChild as HTMLImageElement | HTMLVideoElement | null;
    if (bg.fit === "cover" && oldMedia && newMedia && oldWp) {
      void startShaderTransition({
        oldMedia,
        newMedia,
        oldWallpaper: oldWp,
        newWallpaper: wp,
        effect,
        duration: 1500,
        isCurrent: () => seq === switchSeq,
      }).then((handle) => {
        if (seq !== switchSeq) {
          handle?.cancel();
          return;
        }
        if (!handle) {
          animateCss();
          return;
        }
        activeShader = handle;
        // canvas 输出已包含旧图，隐藏旧层避免低不透明度时叠加两次
        old.style.visibility = "hidden";
        handle.canvas.style.opacity = String(bg.opacity);
        document.body.appendChild(handle.canvas);
        void handle.done.then(() => {
          if (activeShader !== handle) return;
          activeShader = null;
          clearSwitch();
          handle.canvas.remove();
          old.remove();
          next.style.opacity = String(bg.opacity);
          next.style.transform = "none";
          next.style.clipPath = "";
          next.style.maskImage = "";
          next.style.maskSize = "";
          next.style.maskPosition = "";
          next.style.maskRepeat = "";
          next.style.filter = "none";
          next.id = BG_ID;
          currentLayer = next;
          if (oldId) toast(`已切换壁纸 · ${wp.name} 😋`);
        });
      }).catch(() => {
        if (seq !== switchSeq) return;
        old.style.visibility = "";
        animateCss();
      });
      return;
    }

    animateCss();
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
    const mediaReady = !!activeWp && (!activeWp.mediaKey || !!mediaUrl || !!activeWp.image);
    const bgOn = active && config.background.enabled && !!activeWp && mediaReady;
    const bgPresent = bgOn || (active && config.background.enabled && !!activeWp && !!currentLayer);
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

    if (bgPresent) root.setAttribute("data-ft-bg", "");
    else root.removeAttribute("data-ft-bg");

    const css = buildCss(config, bgOn);
    if (css) ensureStyle(css);
    else removeStyle();

    if (bgOn) ensureBg(config);
    else if (!active || !config.background.enabled || !activeWp) {
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

  const handleConfig = async (raw: unknown): Promise<void> => {
    const seq = ++configSeq;
    const cfg = normalizeCustomConfig(raw);
    config = cfg;
    try {
      deps.onConfig?.(cfg);
    } catch (e) {}

    const wp = activeWallpaper(cfg);
    if (!wp || !cfg.background.enabled) {
      mediaUrl = "";
      apply();
      return;
    }
    if (!wp.mediaKey) {
      mediaUrl = wp.image || "";
      apply();
      return;
    }

    // 先保留旧图层，等媒体从 IndexedDB / bridge 就绪后再切
    mediaUrl = "";
    apply();
    const url = await getMediaUrl(wp.mediaKey);
    if (seq !== configSeq) return;
    mediaUrl = url || "";
    if (!url && !mediaWarned.has(wp.mediaKey)) {
      mediaWarned.add(wp.mediaKey);
      toast("壁纸文件读取失败，请重新选择 😢");
    }
    apply();
  };

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== window) return;
    const data = e.data as { source?: string; type?: string; config?: unknown; key?: string; data?: string; url?: string; keys?: unknown } | null;
    if (!data || data.source !== BRIDGE_SOURCE) return;

    if (data.type === "media-cleanup" && Array.isArray(data.keys)) {
      const valid = new Set(data.keys.filter((k): k is string => typeof k === "string"));
      if (cleanupTimer) clearTimeout(cleanupTimer);
      // 延迟到过渡结束再删，避免旧图层还在用 blob URL
      cleanupTimer = window.setTimeout(() => {
        cleanupTimer = 0;
        for (const [key, pending] of mediaPending) {
          if (valid.has(key)) continue;
          clearTimeout(pending.timer);
          pending.resolve(null);
          mediaPending.delete(key);
        }
        for (const [key, url] of mediaUrls) {
          if (valid.has(key)) continue;
          try { URL.revokeObjectURL(url); } catch (e) {}
          mediaUrls.delete(key);
        }
        void pruneCachedMedia(valid);
      }, 5000);
      return;
    }

    if ((data.type === "media" || data.type === "media-missing" || data.type === "media-url") && typeof data.key === "string") {
      const key = data.key;
      const pending = mediaPending.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      mediaPending.delete(key);
      if (data.type === "media-missing") {
        pending.resolve(null);
        return;
      }
      if (data.type === "media-url" && typeof data.url === "string") {
        // bridge 的 blob URL 同源可用；后台再落一次页面 IDB，刷新后直接命中
        mediaUrls.set(key, data.url);
        pending.resolve(data.url);
        void fetch(data.url)
          .then((r) => r.blob())
          .then((blob) => putCachedMedia(key, blob))
          .catch(() => {});
        return;
      }
      if (typeof data.data !== "string") {
        pending.resolve(null);
        return;
      }
      void (async () => {
        const blob = await dataUrlToBlob(data.data!);
        if (!blob) {
          pending.resolve(null);
          return;
        }
        await putCachedMedia(key, blob);
        const url = URL.createObjectURL(blob);
        mediaUrls.set(key, url);
        pending.resolve(url);
      })();
      return;
    }

    if (data.type !== "config") return;
    void handleConfig(data.config);
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
        for (const id of [BG_ID, BG_NEXT_ID]) {
          const el = document.getElementById(id) as HTMLDivElement | null;
          const wp = el ? layerWp.get(el) : null;
          if (el && wp && el.isConnected) layoutLayer(el, wp, config.background);
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
      if (cleanupTimer) clearTimeout(cleanupTimer);
      cleanupTimer = 0;
      for (const url of mediaUrls.values()) {
        try { URL.revokeObjectURL(url); } catch (e) {}
      }
      mediaUrls.clear();
      removeStyle();
      removeBg();
    },
  };
}
