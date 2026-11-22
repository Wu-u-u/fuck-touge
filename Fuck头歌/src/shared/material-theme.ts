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

const argbFromRgb = (r: number, g: number, b: number): number =>
  ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;

/**
 * 从降采样后的像素里取一个“有代表性”的色相。
 * sourceColorFromImage 会偏爱小面积高饱和色（例如灰白图里的红色 logo），
 * 这里按“覆盖率 × 有限 chroma”给色相投票，避免一个很小的红点把整张图带成红色。
 */
export function seedFromPixels(pixels: Uint8ClampedArray): string | null {
  const count = Math.floor(pixels.length / 4);
  if (!count) return null;
  const step = Math.max(1, Math.ceil(count / 4096));
  const bins = Array.from({ length: 24 }, () => ({
    weight: 0,
    x: 0,
    y: 0,
    chroma: 0,
    tone: 0,
  }));
  let total = 0;
  let chromatic = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let p = 0; p < count; p += step) {
    const i = p * 4;
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    total++;
    sumR += r;
    sumG += g;
    sumB += b;
    const hct = Hct.fromInt(argbFromRgb(r, g, b));
    if (hct.tone < 8 || hct.tone > 92 || hct.chroma < 8) continue;
    chromatic++;
    const bin = Math.floor((hct.hue % 360) / 15);
    const weight = 10 + Math.min(hct.chroma, 28);
    const rad = (hct.hue * Math.PI) / 180;
    const slot = bins[bin];
    slot.weight += weight;
    slot.x += Math.cos(rad) * weight;
    slot.y += Math.sin(rad) * weight;
    slot.chroma += hct.chroma * weight;
    slot.tone += hct.tone * weight;
  }

  if (!total) return null;
  if (!chromatic || chromatic / total < 0.02) {
    return hexFromArgb(
      argbFromRgb(
        Math.round(sumR / total),
        Math.round(sumG / total),
        Math.round(sumB / total),
      ),
    );
  }

  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < bins.length; i++) {
    const prev = bins[(i + bins.length - 1) % bins.length].weight;
    const next = bins[(i + 1) % bins.length].weight;
    const score = bins[i].weight + (prev + next) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  let weight = 0;
  let x = 0;
  let y = 0;
  let chroma = 0;
  let tone = 0;
  for (const offset of [-1, 0, 1]) {
    const slot = bins[(best + offset + bins.length) % bins.length];
    weight += slot.weight;
    x += slot.x;
    y += slot.y;
    chroma += slot.chroma;
    tone += slot.tone;
  }
  if (!weight) return null;

  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const seedChroma = Math.max(34, Math.min(72, (chroma / weight) * 1.35));
  const seedTone = Math.max(40, Math.min(68, tone / weight));
  return hexFromArgb(Hct.from(hue, seedChroma, seedTone).toInt());
}

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

/** 从背景图取色：优先用覆盖率加权的色相，失败再回退 Material source color */
export async function seedFromImage(src: string): Promise<string | null> {
  let img: HTMLImageElement | null = null;
  try {
    img = new Image();
    img.decoding = "async";
    img.src = src;
    await img.decode();
    const maxSide = 96;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, w, h);
      const seed = seedFromPixels(ctx.getImageData(0, 0, w, h).data);
      if (seed) return seed;
    }
  } catch (e) {}
  try {
    if (!img) return null;
    return hexFromArgb(await sourceColorFromImage(img));
  } catch (e) {
    return null;
  }
}
