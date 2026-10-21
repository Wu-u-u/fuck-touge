import { afterEach, describe, expect, it, vi } from "vitest";
import { $, $$, levelKey, normText, visible } from "../../src/shared/dom";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("$ / $$", () => {
  it("在指定 root 内查询（命中/未命中）", () => {
    const el = { id: "hit" } as unknown as Element;
    const root = {
      querySelector: (sel: string) => (sel === ".hit" ? el : null),
      querySelectorAll: () => [el],
    } as unknown as ParentNode;

    expect($(".hit", root)).toBe(el);
    expect($(".miss", root)).toBeNull();
    expect($$(".hit", root)).toEqual([el]);
  });
});

describe("visible", () => {
  const box = (width: number, height: number) =>
    ({ getBoundingClientRect: () => ({ width, height }) }) as unknown as Element;

  it("宽或高为 0 → 不可见", () => {
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    expect(visible(box(0, 10))).toBe(false);
    expect(visible(box(10, 0))).toBe(false);
  });

  it("display:none 或 visibility:hidden → 不可见", () => {
    vi.stubGlobal("getComputedStyle", () => ({ display: "none", visibility: "visible" }));
    expect(visible(box(10, 10))).toBe(false);

    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "hidden" }));
    expect(visible(box(10, 10))).toBe(false);
  });

  it("正常元素 → 可见", () => {
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    expect(visible(box(10, 10))).toBe(true);
  });
});

describe("normText", () => {
  it("去掉空白与零宽字符", () => {
    expect(normText(" 下一 关\u200b\u200d\ufeff\t")).toBe("下一关");
  });

  it("null / undefined / 空串 → 空串", () => {
    expect(normText(null)).toBe("");
    expect(normText(undefined)).toBe("");
    expect(normText("")).toBe("");
  });

  it("普通文本原样保留", () => {
    expect(normText("已经是最后一关了 😋")).toBe("已经是最后一关了😋");
  });
});

describe("levelKey", () => {
  it("拼接 pathname + search + hash", () => {
    expect(levelKey({ pathname: "/tasks/a/b/c", search: "?x=1", hash: "#h" })).toBe(
      "/tasks/a/b/c?x=1#h",
    );
  });
});
