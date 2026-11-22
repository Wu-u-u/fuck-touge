// @vitest-environment jsdom
import { Hct, argbFromHex } from "@material/material-color-utilities";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMaterialPalette,
  clearMaterialPalette,
  materialPalette,
  seedFromPixels,
} from "../../src/shared/material-theme";

const HEX = /^#[0-9a-f]{6}$/;

afterEach(() => {
  clearMaterialPalette(document.documentElement);
});

describe("material theme", () => {
  it("从种子色生成完整深色 palette", () => {
    const p = materialPalette("#2536d7");
    expect(p).toBeTruthy();
    for (const value of Object.values(p!)) expect(value).toMatch(HEX);
    expect(p!.accent).not.toBe(p!.bg);
    expect(p!.accentFg).not.toBe(p!.accent);
  });

  it("同一个种子稳定，不同种子会变化", () => {
    const a = materialPalette("#2536d7");
    const b = materialPalette("#2536d7");
    const c = materialPalette("#e91e63");
    expect(a).toEqual(b);
    expect(c!.accent).not.toBe(a!.accent);
  });

  it("取色按覆盖率投票，不让小面积高饱和色主导", () => {
    const pixels: number[] = [];
    const add = (r: number, g: number, b: number, n: number) => {
      for (let i = 0; i < n; i++) pixels.push(r, g, b, 255);
    };
    add(128, 128, 128, 750);
    add(30, 80, 200, 200); // 20% 蓝灰
    add(240, 20, 20, 50); // 5% 很艳的红
    const seed = seedFromPixels(new Uint8ClampedArray(pixels))!;
    const h = Hct.fromInt(argbFromHex(seed));
    expect(h.hue).toBeGreaterThan(200);
    expect(h.hue).toBeLessThan(310);
  });

  it("大面积红色仍然取到红色，图片之间不串色", () => {
    const make = (base: [number, number, number], accent: [number, number, number]) => {
      const px: number[] = [];
      for (let i = 0; i < 800; i++) px.push(...base, 255);
      for (let i = 0; i < 200; i++) px.push(...accent, 255);
      return seedFromPixels(new Uint8ClampedArray(px))!;
    };
    const red = make([20, 20, 20], [240, 20, 20]);
    const blue = make([20, 20, 20], [30, 80, 200]);
    const redHue = Hct.fromInt(argbFromHex(red)).hue;
    const blueHue = Hct.fromInt(argbFromHex(blue)).hue;
    expect(redHue < 30 || redHue > 330).toBe(true);
    expect(blueHue > 200 && blueHue < 310).toBe(true);
    expect(red).not.toBe(blue);
  });

  it("空像素返回 null", () => {
    expect(seedFromPixels(new Uint8ClampedArray())).toBeNull();
  });

  it("深色表面有层次，强调色提高一档饱和度", () => {
    const p = materialPalette("#2536d7")!;
    const tone = (hex: string) => Hct.fromInt(argbFromHex(hex)).tone;
    const chroma = (hex: string) => Hct.fromInt(argbFromHex(hex)).chroma;
    expect(tone(p.panel)).toBeGreaterThan(tone(p.bg) + 2);
    expect(tone(p.panel2)).toBeGreaterThan(tone(p.panel) + 2);
    expect(tone(p.border)).toBeGreaterThan(tone(p.panel2));
    expect(chroma(p.accent)).toBeGreaterThanOrEqual(40);
  });

  it("非法种子返回 null", () => {
    expect(materialPalette("not-a-color")).toBeNull();
    expect(materialPalette("")).toBeNull();
  });

  it("apply/clear 写入并清理 CSS 变量与标记", () => {
    const root = document.documentElement;
    const palette = applyMaterialPalette(root, "#2536d7");
    expect(palette).toBeTruthy();
    expect(root.getAttribute("data-material")).toBe("on");
    expect(root.style.getPropertyValue("--bg")).toBe(palette!.bg);
    expect(root.style.getPropertyValue("--accent")).toBe(palette!.accent);
    expect(root.style.getPropertyValue("--accent-fg")).toBe(palette!.accentFg);

    clearMaterialPalette(root);
    expect(root.hasAttribute("data-material")).toBe(false);
    expect(root.style.getPropertyValue("--bg")).toBe("");
    expect(root.style.getPropertyValue("--accent")).toBe("");
  });

  it("非法种子会清掉已有 scheme", () => {
    const root = document.documentElement;
    applyMaterialPalette(root, "#2536d7");
    expect(applyMaterialPalette(root, "bad")).toBeNull();
    expect(root.hasAttribute("data-material")).toBe(false);
  });
});
