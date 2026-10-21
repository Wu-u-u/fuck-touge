import { describe, expect, it } from "vitest";
import {
  THEME_CHOICES,
  UI_THEMES,
  normalizeThemeName,
  uiTheme,
} from "../../src/features/theme/themes";

describe("主题数据", () => {
  it("包含 4 套主题", () => {
    expect(Object.keys(UI_THEMES).sort()).toEqual([
      "catppuccin-latte",
      "catppuccin-mocha",
      "github-hc-dark",
      "github-hc-light",
    ]);
  });

  it("每套都有 base/inherit/colors/rules", () => {
    for (const [, theme] of Object.entries(UI_THEMES)) {
      expect(["vs", "vs-dark"]).toContain(theme.base);
      expect(typeof theme.inherit).toBe("boolean");
      expect(Object.keys(theme.colors).length).toBeGreaterThan(5);
      expect(theme.rules.length).toBeGreaterThan(5);
      expect(theme.colors["editor.background"]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("主题选项含深/浅变体", () => {
    expect(THEME_CHOICES.catppuccin).toEqual({
      label: "Catppuccin",
      dark: "catppuccin-mocha",
      light: "catppuccin-latte",
    });
    expect(THEME_CHOICES.github.dark).toBe("github-hc-dark");
    expect(THEME_CHOICES.github.light).toBe("github-hc-light");
  });
});

describe("normalizeThemeName", () => {
  it("合法值保留，非法值回退 catppuccin", () => {
    expect(normalizeThemeName("github")).toBe("github");
    expect(normalizeThemeName("catppuccin")).toBe("catppuccin");
    expect(normalizeThemeName("neon")).toBe("catppuccin");
    expect(normalizeThemeName(null)).toBe("catppuccin");
    expect(normalizeThemeName(undefined)).toBe("catppuccin");
  });
});

describe("uiTheme", () => {
  it("按平台主题映射深/浅变体", () => {
    expect(uiTheme("vs", "catppuccin")).toBe("catppuccin-latte");
    expect(uiTheme("vs-dark", "catppuccin")).toBe("catppuccin-mocha");
    expect(uiTheme("vs", "github")).toBe("github-hc-light");
    expect(uiTheme("vs-dark", "github")).toBe("github-hc-dark");
    expect(uiTheme("hc-black", "github")).toBe("hc-black");
  });
});
