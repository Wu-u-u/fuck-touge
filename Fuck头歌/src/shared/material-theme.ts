import {
  argbFromHex,
  hexFromArgb,
  sourceColorFromImage,
  themeFromSourceColor,
} from "@material/material-color-utilities";
import { isHexColor } from "./custom";

export interface MaterialPalette {
  bg: string;
  panel: string;
  panel2: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  accentFg: string;
}

const VAR_MAP: Record<keyof MaterialPalette, string> = {
  bg: "--bg",
  panel: "--panel",
  panel2: "--panel2",
  border: "--border",
  text: "--text",
  dim: "--dim",
  accent: "--accent",
  accentFg: "--accent-fg",
};

/** 用 Material 官方算法从种子色生成深色 scheme（HCT/tonal palette） */
export function materialPalette(seed: string): MaterialPalette | null {
  if (!isHexColor(seed)) return null;
  try {
    const theme = themeFromSourceColor(argbFromHex(seed));
    const s = theme.schemes.dark;
    return {
      bg: hexFromArgb(s.background),
      panel: hexFromArgb(s.surface),
      panel2: hexFromArgb(s.surfaceVariant),
      border: hexFromArgb(s.outlineVariant),
      text: hexFromArgb(s.onSurface),
      dim: hexFromArgb(s.onSurfaceVariant),
      accent: hexFromArgb(s.primary),
      accentFg: hexFromArgb(s.onPrimary),
    };
  } catch (e) {
    return null;
  }
}

export function applyMaterialPalette(root: HTMLElement, seed: string): MaterialPalette | null {
  const palette = materialPalette(seed);
  if (!palette) {
    clearMaterialPalette(root);
    return null;
  }
  for (const [key, cssVar] of Object.entries(VAR_MAP) as Array<[keyof MaterialPalette, string]>) {
    root.style.setProperty(cssVar, palette[key]);
  }
  root.setAttribute("data-material", "on");
  return palette;
}

export function clearMaterialPalette(root: HTMLElement): void {
  for (const cssVar of Object.values(VAR_MAP)) root.style.removeProperty(cssVar);
  root.removeAttribute("data-material");
}

/** 从背景图的主色生成种子；data URL / 页面内图片均可 */
export async function seedFromImage(src: string): Promise<string | null> {
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    await img.decode();
    const argb = await sourceColorFromImage(img);
    return hexFromArgb(argb);
  } catch (e) {
    return null;
  }
}
