// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WALLPAPERS, activeWallpaper, contrastText, isHexColor, isImageSource, normalizeCustomConfig, pageViewConfig } from "../../src/shared/custom";
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
    expect(cfg.background).toEqual({ enabled: false, image: "", wallpapers: [], activeId: "", opacity: 0.4, panelOpacity: 0.8, editorOpacity: 1, fit: "cover", transition: "random", transitionDuration: 1500, fixed: true });
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
    expect(cfg.background).toEqual({ enabled: true, image: "", wallpapers: [], activeId: "", opacity: 1, panelOpacity: 0.8, editorOpacity: 1, fit: "cover", transition: "random", transitionDuration: 1500, fixed: true });
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
      transition: "random",
      transitionDuration: 1500,
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

  it("切换效果：保留合法值（含固定效果），旧值/非法值回 random", () => {
    expect(normalizeCustomConfig({ background: { transition: "zoom" } }).background.transition).toBe("zoom");
    expect(normalizeCustomConfig({ background: { transition: "crt" } }).background.transition).toBe("crt");
    expect(normalizeCustomConfig({ background: { transition: "slide" } }).background.transition).toBe("random");
    expect(normalizeCustomConfig({ background: { transition: "wat" } }).background.transition).toBe("random");
  });

  it("过渡效果/时长经过 JSON 序列化后仍保留（持久化 round-trip）", () => {
    const cfg = normalizeCustomConfig({ background: { transition: "golden", transitionDuration: 2200 } });
    const round = normalizeCustomConfig(JSON.parse(JSON.stringify(cfg)));
    expect(round.background.transition).toBe("golden");
    expect(round.background.transitionDuration).toBe(2200);
  });

  it("过渡时长：默认 1500ms，限制在 500–4000ms", () => {
    expect(normalizeCustomConfig({}).background.transitionDuration).toBe(1500);
    expect(normalizeCustomConfig({ background: { transitionDuration: 800 } }).background.transitionDuration).toBe(800);
    expect(normalizeCustomConfig({ background: { transitionDuration: 100 } }).background.transitionDuration).toBe(500);
    expect(normalizeCustomConfig({ background: { transitionDuration: 9999 } }).background.transitionDuration).toBe(4000);
    expect(normalizeCustomConfig({ background: { transitionDuration: "1500" } }).background.transitionDuration).toBe(1500);
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

describe("page view", () => {
  it("mediaKey 壁纸只传 key，不带 data URL", () => {
    const cfg = normalizeCustomConfig({
      materialSeed: "#123456",
      background: {
        enabled: true,
        activeId: "a",
        wallpapers: [
          { id: "a", name: "A", mediaKey: "fuckTougeMedia:a", kind: "video", seed: "#654321", width: 1920, height: 1080 },
          { id: "b", name: "B", mediaKey: "fuckTougeMedia:b", kind: "image" },
        ],
      },
    });
    const view = pageViewConfig(cfg);
    expect(view.background.wallpapers).toHaveLength(1);
    expect(view.background.wallpapers[0].mediaKey).toBe("fuckTougeMedia:a");
    expect(view.background.image).toBe("");
    expect(view.materialSeed).toBe("#654321");
  });

  it("无 mediaKey 的旧壁纸仍带 image", () => {
    const cfg = normalizeCustomConfig({
      background: {
        enabled: true,
        activeId: "legacy",
        wallpapers: [{ id: "legacy", name: "旧图", image: "data:image/png;base64,AA", kind: "image" }],
      },
    });
    const view = pageViewConfig(cfg);
    expect(view.background.wallpapers[0].image).toContain("data:image/png");
    expect(view.background.image).toContain("data:image/png");
  });

  it("没有壁纸时返回空列表", () => {
    const view = pageViewConfig(normalizeCustomConfig({ background: { enabled: true } }));
    expect(view.background.wallpapers).toEqual([]);
    expect(view.background.image).toBe("");
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

  it("主题关闭 / 离开答题页通知 bridge 释放媒体，恢复后重建图层", () => {
    let theme = true;
    let answer = true;
    controller = createCustomVisual({
      isThemeOn: () => theme,
      isAnswerPage: () => answer,
      isTopFrame: () => true,
    });
    controller.install();
    const post = vi.spyOn(window, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "fuck-touge-bridge",
          type: "config",
          config: makeConfig({ background: { enabled: true, image: IMG, opacity: .4, fit: "cover", fixed: true } }),
        },
        source: window,
      }),
    );
    post.mockClear();

    theme = false;
    controller.apply();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ source: "fuck-touge-main", type: "media-release" }),
      "*",
    );
    expect(document.getElementById("ft-bg")).toBeNull();

    theme = true;
    controller.apply();
    expect(document.getElementById("ft-bg")).toBeTruthy();

    post.mockClear();
    answer = false;
    controller.apply();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ source: "fuck-touge-main", type: "media-release" }),
      "*",
    );
  });

  it("mediaKey 壁纸在主题重开后重新请求媒体并恢复图层", async () => {
    const wp = {
      id: "wp-test", name: "测试", image: "", mediaKey: "fuckTougeMedia:wp-test",
      kind: "image" as const, animated: false, seed: "#ffffff",
      crop: { x: 0, y: 0, w: 1, h: 1 }, width: 10, height: 10,
    };
    let theme = true;
    controller = createCustomVisual({
      isThemeOn: () => theme,
      isAnswerPage: () => true,
      isTopFrame: () => true,
    });
    controller.install();
    const post = vi.spyOn(window, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "fuck-touge-bridge",
        type: "config",
        config: makeConfig({ background: { enabled: true, image: "", wallpapers: [wp], activeId: wp.id, opacity: .4, fit: "cover" } }),
      },
      source: window,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "media-request", key: wp.mediaKey }), "*");

    // 模拟 bridge 返回媒体
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "fuck-touge-bridge", type: "media-url", key: wp.mediaKey, url: "blob:test-media" },
      source: window,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("ft-bg")).toBeTruthy();
    post.mockClear();

    theme = false;
    controller.apply();
    expect(document.getElementById("ft-bg")).toBeNull();
    theme = true;
    controller.apply();
    await new Promise((r) => setTimeout(r, 0));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "media-request", key: wp.mediaKey }), "*");
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "fuck-touge-bridge", type: "media-url", key: wp.mediaKey, url: "blob:test-media-2" },
      source: window,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("ft-bg")).toBeTruthy();
  });

  it("SPA 离开 /tasks 再返回：media-release 后自动恢复 mediaKey 图层", async () => {
    const wp = {
      id: "wp-spa", name: "SPA", image: "", mediaKey: "fuckTougeMedia:wp-spa",
      kind: "image" as const, animated: false, seed: "#ffffff",
      crop: { x: 0, y: 0, w: 1, h: 1 }, width: 10, height: 10,
    };
    controller = createCustomVisual({
      isThemeOn: () => true,
      isAnswerPage: () => /^\/tasks\//.test(location.pathname),
      isTopFrame: () => true,
    });
    controller.install();
    const post = vi.spyOn(window, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "fuck-touge-bridge",
        type: "config",
        config: makeConfig({ background: { enabled: true, image: "", wallpapers: [wp], activeId: wp.id, opacity: .4, fit: "cover" } }),
      },
      source: window,
    }));
    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "fuck-touge-bridge", type: "media-url", key: wp.mediaKey, url: "blob:spa-1" },
      source: window,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("ft-bg")).toBeTruthy();
    post.mockClear();

    history.pushState({}, "", "/");
    controller.apply();
    await new Promise((r) => setTimeout(r, 0));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "media-release" }), "*");
    expect(document.getElementById("ft-bg")).toBeNull();

    history.pushState({}, "", "/tasks/a/b/c");
    controller.apply();
    await new Promise((r) => setTimeout(r, 0));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "media-request", key: wp.mediaKey }), "*");
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "fuck-touge-bridge", type: "media-url", key: wp.mediaKey, url: "blob:spa-2" },
      source: window,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("ft-bg")).toBeTruthy();
  });

  it("空图片不启用背景", () => {
    mount(makeConfig({ background: { enabled: true, image: "", opacity: .4, fit: "cover", fixed: true } }));
    expect(document.getElementById("ft-bg")).toBeNull();
    expect(document.documentElement.hasAttribute("data-ft-bg")).toBe(false);
  });
});
