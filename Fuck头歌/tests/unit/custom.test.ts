// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_WALLPAPERS, activeWallpaper, contrastText, isHexColor, isImageSource, normalizeCustomConfig } from "../../src/shared/custom";
import { createCustomVisual } from "../../src/features/custom-visual";
import type { CustomConfig } from "../../src/shared/types";

const IMG = "data:image/png;base64,iVBORw0KGgo=";

const makeConfig = (patch: Partial<CustomConfig> = {}): CustomConfig => ({
  ...normalizeCustomConfig(null),
  ...patch,
  background: {
    ...normalizeCustomConfig(null).background,
    ...(patch.background || {}),
  },
  colors: { ...(patch.colors || {}) },
});

let controller: ReturnType<typeof createCustomVisual> | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-ft-bg");
  document.documentElement.removeAttribute("data-ft-custom");
  history.replaceState({}, "", "/tasks/a/b/c");
});

afterEach(() => {
  controller?.dispose();
  controller = null;
});

function mount(cfg: CustomConfig, themeOn = true, answer = true): void {
  controller = createCustomVisual({
    isThemeOn: () => themeOn,
    isAnswerPage: () => answer,
    isTopFrame: () => true,
  });
  controller.install();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "fuck-touge-bridge", type: "config", config: cfg },
      source: window,
    }),
  );
}

describe("custom config", () => {
  it("默认值", () => {
    const cfg = normalizeCustomConfig(null);
    expect(cfg.background).toEqual({ enabled: false, image: "", wallpapers: [], activeId: "", opacity: 0.4, panelOpacity: 0.8, editorOpacity: 1, fit: "cover", transition: "slide", fixed: true });
    expect(cfg.colors).toEqual({});
  });

  it("Material You 需要合法种子色", () => {
    const on = normalizeCustomConfig({ materialYou: true, materialSeed: "#2536D7" });
    expect(on.materialYou).toBe(true);
    expect(on.materialSeed).toBe("#2536d7");

    const bad = normalizeCustomConfig({ materialYou: true, materialSeed: "blue" });
    expect(bad.materialYou).toBe(false);
    expect(bad.materialSeed).toBe("");

    const off = normalizeCustomConfig({ materialYou: false, materialSeed: "#2536d7" });
    expect(off.materialYou).toBe(false);
  });

  it("收敛非法背景字段", () => {
    const cfg = normalizeCustomConfig({
      background: { enabled: true, image: "javascript:alert(1)", opacity: 9, fit: "wat", fixed: "no" },
    });
    expect(cfg.background).toEqual({ enabled: true, image: "", wallpapers: [], activeId: "", opacity: 1, panelOpacity: 0.8, editorOpacity: 1, fit: "cover", transition: "slide", fixed: true });
  });

  it("开关可以先开启、后选图", () => {
    const cfg = normalizeCustomConfig({ background: { enabled: true, image: "" } });
    expect(cfg.background.enabled).toBe(true);
    expect(cfg.background.image).toBe("");
  });

  it("编辑器选项只保留 JSON 安全值", () => {
    const cfg = normalizeCustomConfig({
      editor: {
        fontSize: 16,
        smoothScrolling: true,
        minimap: { enabled: false, size: "fit" },
        bad: () => 1,
      },
    });
    expect(cfg.editor).toEqual({
      fontSize: 16,
      smoothScrolling: true,
      minimap: { enabled: false, size: "fit" },
    });
  });

  it("保留合法图片 / fit / 颜色", () => {
    const cfg = normalizeCustomConfig({
      background: { enabled: true, image: IMG, opacity: .35, panelOpacity: .75, editorOpacity: .9, fit: "contain", fixed: false },
      colors: { bg: "#ABC", text: "#aabbcc", border: "#11223344", bad: "#fff" },
    });
    expect(cfg.background).toEqual({
      enabled: true,
      image: IMG,
      wallpapers: [{
        id: "legacy-1", name: "壁纸 1", image: IMG, kind: "image", animated: false,
        seed: "#cba6f7", mediaKey: "", crop: { x: 0, y: 0, w: 1, h: 1 }, width: 0, height: 0,
      }],
      activeId: "legacy-1",
      opacity: .35,
      panelOpacity: .75,
      editorOpacity: .9,
      fit: "contain",
      transition: "slide",
      fixed: true,
    });
    expect(cfg.colors).toEqual({ bg: "#abc", text: "#aabbcc", border: "#11223344" });
  });

  it("多壁纸：保留 activeId / seed，并最多 5 张", () => {
    const list = Array.from({ length: 7 }, (_, i) => ({
      id: `w${i + 1}`,
      name: `图 ${i + 1}`,
      image: IMG,
      animated: i === 1,
      seed: "#aabbcc",
    }));
    const cfg = normalizeCustomConfig({ background: { enabled: true, wallpapers: list, activeId: "w3" } });
    expect(cfg.background.wallpapers).toHaveLength(MAX_WALLPAPERS);
    expect(cfg.background.activeId).toBe("w3");
    expect(cfg.background.image).toBe(IMG);
    expect(activeWallpaper(cfg)?.name).toBe("图 3");
  });

  it("切换效果：保留合法值，非法值回 slide", () => {
    expect(normalizeCustomConfig({ background: { transition: "zoom" } }).background.transition).toBe("zoom");
    expect(normalizeCustomConfig({ background: { transition: "wat" } }).background.transition).toBe("slide");
  });

  it("单图旧配置迁移成壁纸列表，Material 使用当前壁纸 seed", () => {
    const cfg = normalizeCustomConfig({
      background: { enabled: true, image: IMG },
      materialYou: true,
      materialSeed: "#123456",
    });
    expect(cfg.background.wallpapers).toHaveLength(1);
    expect(cfg.background.activeId).toBe("legacy-1");
    expect(cfg.background.wallpapers[0].seed).toBe("#123456");
    expect(cfg.materialSeed).toBe("#123456");
    expect(cfg.materialYou).toBe(true);
  });

  it("hex / 图片来源 / 对比色", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("#aabbccdd")).toBe(true);
    expect(isHexColor("fff")).toBe(false);
    expect(isImageSource("https://x.test/a.png")).toBe(true);
    expect(isImageSource("data:image/webp;base64,AAAA")).toBe(true);
    expect(isImageSource("javascript:alert(1)")).toBe(false);
    expect(contrastText("#ffffff")).toBe("#11111b");
    expect(contrastText("#000000")).toBe("#ffffff");
  });
});

describe("custom visual", () => {
  it("背景开启：生成 fixed 图层 + 半透明面板 CSS", () => {
    mount(makeConfig({ background: { enabled: true, image: IMG, opacity: .4, fit: "cover", fixed: true } }));
    const layer = document.getElementById("ft-bg") as HTMLDivElement;
    expect(layer).toBeTruthy();
    expect(layer.style.position).toBe("fixed");
    expect(layer.style.opacity).toBe("0.4");
    const media = layer.firstElementChild as HTMLImageElement;
    expect(media.tagName).toBe("IMG");
    expect(media.src).toContain("data:image/png");
    expect(document.documentElement.getAttribute("data-ft-bg")).toBe("");
    const css = document.getElementById("ft-custom-visual")!.textContent || "";
    expect(css).toContain("color-mix");
    expect(css).toContain("--ft-panel-alpha: 80%");
    expect(css).toContain("--ft-editor-alpha: 100%");
    expect(css).toContain(".monaco-editor");
    expect(css).toContain("background-color: transparent !important");
    expect(css).toContain("background: transparent !important");
    expect(css).toContain(".left-panel :is(");
  });

  it("fit 三态 + 滚动层", () => {
    mount(makeConfig({ background: { enabled: true, image: IMG, opacity: .4, fit: "stretch", fixed: false } }));
    const layer = document.getElementById("ft-bg") as HTMLDivElement;
    expect(layer.style.position).toBe("fixed");
    expect(layer.firstElementChild?.tagName).toBe("IMG");

    controller!.apply();
    // 重新发配置，切成 contain；图层仍在，媒体节点复用
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "fuck-touge-bridge",
          type: "config",
          config: makeConfig({ background: { enabled: true, image: IMG, opacity: .4, fit: "contain", fixed: true } }),
        },
        source: window,
      }),
    );
    expect(document.getElementById("ft-bg")?.firstElementChild?.tagName).toBe("IMG");
  });

  it("编辑器区域独立透明度：容器透明、Monaco 背景单独 alpha", () => {
    mount(makeConfig({
      background: { enabled: true, image: IMG, opacity: .4, panelOpacity: .8, editorOpacity: .7, fit: "cover", fixed: true },
    }));
    const css = document.getElementById("ft-custom-visual")!.textContent || "";
    expect(css).toContain("--ft-editor-alpha: 70%");
    expect(css).toContain(".right-panel");
    expect(css).toContain(".monaco-editor .monaco-editor-background");
    expect(css).toContain(".right-panel, [class*=\"code-area-container\"]");
  });

  it("颜色覆盖写入 CSS 变量，并处理强调色前景", () => {
    mount(makeConfig({ colors: { bg: "#202020", accent: "#ff8800", panel: "#181818" } }));
    const css = document.getElementById("ft-custom-visual")!.textContent || "";
    expect(css).toContain("--ft-bg: #202020");
    expect(css).toContain("--ft-accent: #ff8800");
    expect(css).toContain("--ft-link: #ff8800");
    expect(css).toContain("--ft-panel2: #181818");
    expect(document.documentElement.getAttribute("data-ft-custom")).toBe("");
    expect(document.getElementById("ft-bg")).toBeNull();
  });

  it("主题关闭 / 非答题页 → 清理", () => {
    mount(makeConfig({ background: { enabled: true, image: IMG, opacity: .4, fit: "cover", fixed: true } }));
    expect(document.getElementById("ft-bg")).toBeTruthy();
    controller!.dispose();

    mount(makeConfig({ background: { enabled: true, image: IMG, opacity: .4, fit: "cover", fixed: true } }), false);
    expect(document.getElementById("ft-bg")).toBeNull();
    expect(document.documentElement.hasAttribute("data-ft-bg")).toBe(false);

    controller!.dispose();
    mount(makeConfig({ background: { enabled: true, image: IMG, opacity: .4, fit: "cover", fixed: true } }), true, false);
    expect(document.getElementById("ft-bg")).toBeNull();
    expect(document.getElementById("ft-custom-visual")).toBeNull();
  });

  it("空图片不启用背景", () => {
    mount(makeConfig({ background: { enabled: true, image: "", opacity: .4, fit: "cover", fixed: true } }));
    expect(document.getElementById("ft-bg")).toBeNull();
    expect(document.documentElement.hasAttribute("data-ft-bg")).toBe(false);
  });
});
