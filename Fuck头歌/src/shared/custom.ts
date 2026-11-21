import type { EditorOptions } from "./editor-options";
import type { BackgroundFit, CustomColorKey, CustomConfig } from "./types";

/** chrome.storage.local 键；与页面 localStorage 的旧设置完全分开 */
export const CUSTOM_CONFIG_KEY = "fuckTougeCustom";

export const DEFAULT_CUSTOM_CONFIG: CustomConfig = {
  version: 1,
  background: {
    enabled: false,
    image: "",
    opacity: 0.4,
    panelOpacity: 0.8,
    editorOpacity: 1,
    fit: "cover",
    fixed: true,
  },
  colors: {},
  editor: {},
  materialYou: false,
  materialSeed: "",
};

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

export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && HEX_RE.test(value.trim());

/** 上传的是 data:image/...，外链只接受 http(s) */
export const isImageSource = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return /^data:image\/[a-z0-9.+-]+(?:[;,])/i.test(s) || /^https?:\/\//i.test(s);
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

  const image = isImageSource(bgRaw.image) ? String(bgRaw.image).trim() : "";
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
  const fixed = typeof bgRaw.fixed === "boolean" ? bgRaw.fixed : true;

  const colorsRaw = (src.colors && typeof src.colors === "object"
    ? src.colors
    : {}) as Record<string, unknown>;
  const colors: Partial<Record<CustomColorKey, string>> = {};
  for (const def of COLOR_DEFS) {
    const value = colorsRaw[def.key];
    if (isHexColor(value)) colors[def.key] = value.trim().toLowerCase();
  }

  const materialSeed = isHexColor(src.materialSeed) ? String(src.materialSeed).trim().toLowerCase() : "";
  const materialYou = src.materialYou === true && !!materialSeed;

  return {
    version: 1,
    background: { enabled, image, opacity, panelOpacity, editorOpacity, fit, fixed },
    colors,
    editor: copyEditorOptions(src.editor),
    materialYou,
    materialSeed,
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
