import type { EditorOptions } from "./editor-options";
import type { BackgroundFit, BackgroundTransition, CustomColorKey, CustomConfig, Wallpaper, WallpaperCrop, WallpaperKind } from "./types";

/** chrome.storage.local 键；与页面 localStorage 的旧设置完全分开 */
export const CUSTOM_CONFIG_KEY = "fuckTougeCustom";

export const MAX_WALLPAPERS = 5;

export const DEFAULT_CUSTOM_CONFIG: CustomConfig = {
  version: 1,
  background: {
    enabled: false,
    image: "",
    wallpapers: [],
    activeId: "",
    opacity: 0.4,
    panelOpacity: 0.8,
    editorOpacity: 1,
    fit: "cover",
    transition: "random",
    transitionDuration: 1500,
    fixed: true,
  },
  colors: {},
  editor: {},
  materialYou: false,
  materialSeed: "",
};

export function activeWallpaper(cfg: CustomConfig): Wallpaper | null {
  const bg = cfg.background;
  return bg.wallpapers.find((w) => w.id === bg.activeId) || bg.wallpapers[0] || null;
}

export interface ColorDef {
  key: CustomColorKey;
  label: string;
  hint: string;
  cssVar: string;
  default: string;
}

/** 选项页的颜色行；default 是 Catppuccin 参考值，未勾选“覆盖”时跟随当前主题 */
export const COLOR_DEFS: ColorDef[] = [
  { key: "bg", label: "页面背景", hint: "页面最底层", cssVar: "--ft-bg", default: "#1e1e2e" },
  { key: "panel", label: "面板", hint: "任务区 / 测试结果面板", cssVar: "--ft-panel", default: "#181825" },
  { key: "border", label: "边框", hint: "面板 / 表格分割线", cssVar: "--ft-border", default: "#313244" },
  { key: "text", label: "正文", hint: "主要文字", cssVar: "--ft-text", default: "#cdd6f4" },
  { key: "dim", label: "次要文字", hint: "提示 / 行号 / 占位", cssVar: "--ft-dim", default: "#a6adc8" },
  { key: "accent", label: "强调色", hint: "按钮 / 链接 / 选中态", cssVar: "--ft-accent", default: "#89b4fa" },
  { key: "codeBg", label: "代码块背景", hint: "Markdown / 测试代码块", cssVar: "--ft-code-bg", default: "#11111b" },
  { key: "codeText", label: "代码块文字", hint: "代码块正文", cssVar: "--ft-code-text", default: "#cdd6f4" },
];

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FITS: BackgroundFit[] = ["cover", "stretch", "contain"];
const TRANSITIONS: BackgroundTransition[] = [
  "random", "fade", "wipe", "disc", "stripes", "zoom",
  "honeycomb", "vortex", "pixel", "diamond", "golden", "melt", "crt",
];

export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && HEX_RE.test(value.trim());

/** 上传的是 data:image/...，外链只接受 http(s) */
export const isImageSource = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return /^data:image\/[a-z0-9.+-]+(?:[;,])/i.test(s) || /^https?:\/\//i.test(s);
};

/** 2.7.1 起壁纸支持图片/GIF/视频；只接受本地 data URL */
export const isMediaSource = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  return /^data:(?:image|video)\/[a-z0-9.+-]+(?:[;,])/i.test(value.trim());
};

export const isMediaKey = (value: unknown): value is string =>
  typeof value === "string" && /^fuckTougeMedia:[A-Za-z0-9_-]{1,100}$/.test(value);

export const mediaStorageKey = (id: string): string => `fuckTougeMedia:${id}`;

export const wallpaperKind = (src: string): WallpaperKind =>
  /^data:video\//i.test(src) ? "video" : /^data:image\/gif/i.test(src) ? "gif" : "image";

const fullCrop: WallpaperCrop = { x: 0, y: 0, w: 1, h: 1 };

const normalizeCrop = (raw: unknown): WallpaperCrop => {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d;
  const x = num(c.x, 0);
  const y = num(c.y, 0);
  const w = Math.min(1 - x, Math.max(0.05, num(c.w, 1)));
  const h = Math.min(1 - y, Math.max(0.05, num(c.h, 1)));
  return { x, y, w, h };
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** 只保留 JSON 安全的 1-2 层值；编辑器选项都是扁平/单层对象 */
const copyEditorOptions = (raw: unknown): EditorOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EditorOptions = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") nested[k] = v;
      }
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
};

/**
 * 把 storage / postMessage 里的任意值收敛成合法配置。
 * 坏字段直接回默认，不抛异常；颜色只接受 3/6/8 位 hex。
 */
export function normalizeCustomConfig(raw: unknown): CustomConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bgRaw = (src.background && typeof src.background === "object"
    ? src.background
    : {}) as Record<string, unknown>;

  const legacyImage = isMediaSource(bgRaw.image) ? String(bgRaw.image).trim() : "";
  const legacySeed = isHexColor(src.materialSeed) ? String(src.materialSeed).trim().toLowerCase() : "";
  // 开关可以独立于图片存在：先开启，再选择图片（旧配置也兼容）
  const enabled = bgRaw.enabled === true;
  const opacity =
    typeof bgRaw.opacity === "number" && Number.isFinite(bgRaw.opacity)
      ? clamp01(bgRaw.opacity)
      : DEFAULT_CUSTOM_CONFIG.background.opacity;
  const panelOpacity =
    typeof bgRaw.panelOpacity === "number" && Number.isFinite(bgRaw.panelOpacity)
      ? Math.min(1, Math.max(0.5, bgRaw.panelOpacity))
      : DEFAULT_CUSTOM_CONFIG.background.panelOpacity;
  const editorOpacity =
    typeof bgRaw.editorOpacity === "number" && Number.isFinite(bgRaw.editorOpacity)
      ? Math.min(1, Math.max(0.5, bgRaw.editorOpacity))
      : DEFAULT_CUSTOM_CONFIG.background.editorOpacity;
  const fit = FITS.includes(bgRaw.fit as BackgroundFit)
    ? (bgRaw.fit as BackgroundFit)
    : DEFAULT_CUSTOM_CONFIG.background.fit;
  const transition = TRANSITIONS.includes(bgRaw.transition as BackgroundTransition)
    ? (bgRaw.transition as BackgroundTransition)
    : DEFAULT_CUSTOM_CONFIG.background.transition;
  const transitionDuration =
    typeof bgRaw.transitionDuration === "number" && Number.isFinite(bgRaw.transitionDuration)
      ? Math.min(4000, Math.max(500, Math.round(bgRaw.transitionDuration)))
      : DEFAULT_CUSTOM_CONFIG.background.transitionDuration;
  const fixed = true; // 2.7 起始终固定

  const wallpapers: Wallpaper[] = [];
  const listRaw = Array.isArray(bgRaw.wallpapers) ? bgRaw.wallpapers : [];
  for (let i = 0; i < listRaw.length && wallpapers.length < MAX_WALLPAPERS; i++) {
    const w = (listRaw[i] && typeof listRaw[i] === "object" ? listRaw[i] : {}) as Record<string, unknown>;
    const image = isMediaSource(w.image) ? String(w.image).trim() : "";
    const mediaKey = isMediaKey(w.mediaKey) ? w.mediaKey : "";
    if (!image && !mediaKey) continue;
    const seed = isHexColor(w.seed) ? String(w.seed).trim().toLowerCase() : (legacySeed || "#cba6f7");
    const id = typeof w.id === "string" && w.id.trim() ? w.id.trim().slice(0, 80) : `wp-${i + 1}`;
    const name = typeof w.name === "string" && w.name.trim() ? w.name.trim().slice(0, 60) : `壁纸 ${wallpapers.length + 1}`;
    const kind = w.kind === "video" || w.kind === "gif" || w.kind === "image" ? w.kind : wallpaperKind(image || "");
    const width = typeof w.width === "number" && w.width > 0 ? w.width : 0;
    const height = typeof w.height === "number" && w.height > 0 ? w.height : 0;
    wallpapers.push({ id, name, image, mediaKey, kind, animated: kind !== "image", seed, crop: normalizeCrop(w.crop), width, height });
  }
  // 旧版单图迁移成第一张壁纸
  if (!wallpapers.length && legacyImage) {
    wallpapers.push({
      id: "legacy-1",
      name: "壁纸 1",
      image: legacyImage,
      mediaKey: "",
      kind: wallpaperKind(legacyImage),
      animated: /^data:image\/gif/i.test(legacyImage),
      seed: legacySeed || "#cba6f7",
      crop: { ...fullCrop },
      width: 0,
      height: 0,
    });
  }
  const activeId = wallpapers.some((w) => w.id === bgRaw.activeId)
    ? String(bgRaw.activeId)
    : (wallpapers[0]?.id || "");
  const active = wallpapers.find((w) => w.id === activeId) || null;
  const image = active?.image || "";
  const materialSeed = active?.seed || legacySeed;
  const materialYou = src.materialYou === true && !!materialSeed;

  const colorsRaw = (src.colors && typeof src.colors === "object"
    ? src.colors
    : {}) as Record<string, unknown>;
  const colors: Partial<Record<CustomColorKey, string>> = {};
  for (const def of COLOR_DEFS) {
    const value = colorsRaw[def.key];
    if (isHexColor(value)) colors[def.key] = value.trim().toLowerCase();
  }

  return {
    version: 1,
    background: { enabled, image, wallpapers, activeId, opacity, panelOpacity, editorOpacity, fit, transition, transitionDuration, fixed },
    colors,
    editor: copyEditorOptions(src.editor),
    materialYou,
    materialSeed,
  };
}

/** 配置里是否仍有这个 mediaKey 的壁纸（bridge 校验 media-request 用） */
export const configHasMediaKey = (cfg: CustomConfig, key: string): boolean =>
  cfg.background.wallpapers.some((w) => w.mediaKey === key);

/** MAIN world 只需要当前壁纸；有 mediaKey 时只传 key，媒体走页面 IDB */
export function pageViewConfig(cfg: CustomConfig): CustomConfig {
  const active = activeWallpaper(cfg);
  const view = active
    ? { ...active, image: active.mediaKey ? "" : active.image }
    : null;
  return {
    ...cfg,
    materialSeed: active?.seed || cfg.materialSeed,
    background: {
      ...cfg.background,
      image: view?.image || "",
      wallpapers: view ? [view] : [],
    },
  };
}

/** 根据强调色亮度挑一个可读的前景色（按钮文字） */
export function contrastText(hex: string): string {
  if (!isHexColor(hex)) return "#1e1e2e";
  let s = hex.slice(1);
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 8) s = s.slice(0, 6);
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const luminance = r * 0.299 + g * 0.587 + b * 0.114;
  return luminance > 160 ? "#11111b" : "#ffffff";
}
