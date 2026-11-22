// @vitest-environment jsdom
import { Hct, argbFromHex } from "@material/material-color-utilities";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMaterialPalette,
  clearMaterialPalette,
  materialPalette,
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
