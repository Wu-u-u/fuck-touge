import {
  Hct,
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

const tonal = (hue: number, chroma: number, tone: number): string =>
  hexFromArgb(
    Hct.from(
      hue,
      Math.max(0, Math.min(120, chroma)),
      Math.max(0, Math.min(100, tone)),
    ).toInt(),
  );

/**
 * 用 Material 官方算法从种子色生成深色 scheme。
 * 官方 dark scheme 的 background 与 surface 同 tone，卡片会糊成一片；
 * 这里保留色相，只把表面拉开 4~5 tone、强调色提高一档 chroma。
 */
export function materialPalette(seed: string): MaterialPalette | null {
  if (!isHexColor(seed)) return null;
  try {
    const theme = themeFromSourceColor(argbFromHex(seed));
    const s = theme.schemes.dark;
    const primary = Hct.fromInt(s.primary);
    const surfaceChroma = Math.min(16, Math.max(6, primary.chroma * 0.16));
    const accentChroma =
      primary.chroma < 10 ? primary.chroma : Math.max(44, primary.chroma * 1.2);
    return {
      bg: tonal(primary.hue, surfaceChroma, 7),
      panel: tonal(primary.hue, surfaceChroma + 1.5, 11),
      panel2: tonal(primary.hue, surfaceChroma + 3, 16),
      border: tonal(primary.hue, surfaceChroma + 4, 28),
      text: hexFromArgb(s.onSurface),
      dim: hexFromArgb(s.onSurfaceVariant),
      accent: tonal(primary.hue, accentChroma, 74),
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
