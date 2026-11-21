// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contrastText, isHexColor, isImageSource, normalizeCustomConfig } from "../../src/shared/custom";
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
    expect(cfg.background).toEqual({ enabled: false, image: "", opacity: 0.4, panelOpacity: 0.8, editorOpacity: 1, fit: "cover", fixed: true });
    expect(cfg.colors).toEqual({});
  });

  it("收敛非法背景字段", () => {
    const cfg = normalizeCustomConfig({
      background: { enabled: true, image: "javascript:alert(1)", opacity: 9, fit: "wat", fixed: "no" },
    });
    expect(cfg.background).toEqual({ enabled: true, image: "", opacity: 1, panelOpacity: 0.8, editorOpacity: 1, fit: "cover", fixed: true });
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
    expect(cfg.background).toEqual({ enabled: true, image: IMG, opacity: .35, panelOpacity: .75, editorOpacity: .9, fit: "contain", fixed: false });
    expect(cfg.colors).toEqual({ bg: "#abc", text: "#aabbcc", border: "#11223344" });
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
    expect(layer.style.backgroundSize).toBe("cover");
    expect(layer.style.opacity).toBe("0.4");
    expect(layer.style.backgroundImage).toContain("data:image/png");
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
    expect(layer.style.position).toBe("absolute");
    expect(layer.style.backgroundSize).toBe("100% 100%");
    expect(document.getElementById("ft-custom-visual")!.textContent).toContain("position: relative");

    controller!.apply();
    // 重新发配置，切成 contain
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
    expect(layer.style.backgroundSize).toBe("contain");
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
