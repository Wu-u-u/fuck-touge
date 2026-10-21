import { describe, expect, it, vi } from "vitest";
import {
  allowWrite,
  installClipboardGuard,
  isBlankText,
  itemHasContent,
} from "../../src/features/clipboard";

const textItem = (text: string) => ({
  types: ["text/plain"],
  getType: async () => ({ text: async () => text }),
});
const htmlItem = (text: string) => ({
  types: ["text/html"],
  getType: async () => ({ text: async () => text }),
});
const imageItem = () => ({
  types: ["image/png"],
  getType: async () => ({ text: async () => "" }),
});

describe("isBlankText", () => {
  it("空串 / 空白 / 零宽 / 格式字符都算空白", () => {
    expect(isBlankText("")).toBe(true);
    expect(isBlankText(null)).toBe(true);
    expect(isBlankText(undefined)).toBe(true);
    expect(isBlankText("   \t\r\n")).toBe(true);
    expect(isBlankText("\u200b\u200c\u200d\u2060\ufeff")).toBe(true);
    expect(isBlankText("\u00ad")).toBe(true); // soft hyphen（Cf）
    expect(isBlankText("\u3000")).toBe(true); // 全角空格（Zs）
  });

  it("正常文本 / 符号 / emoji 不算空白", () => {
    expect(isBlankText("a")).toBe(false);
    expect(isBlankText("AB")).toBe(false);
    expect(isBlankText("😋")).toBe(false);
    expect(isBlankText("a b")).toBe(false);
  });
});

describe("itemHasContent / allowWrite", () => {
  it("空白 text/plain → 拦截", async () => {
    await expect(itemHasContent(textItem("   "))).resolves.toBe(false);
  });

  it("正常 text/plain → 放行", async () => {
    await expect(itemHasContent(textItem("hello"))).resolves.toBe(true);
  });

  it("纯图片 item → 放行", async () => {
    await expect(itemHasContent(imageItem())).resolves.toBe(true);
  });

  it("空 ClipboardItem（无 types）→ 拦截", async () => {
    await expect(itemHasContent({ types: [] })).resolves.toBe(false);
  });

  it("空数组 → 拦截", async () => {
    await expect(allowWrite([])).resolves.toBe(false);
  });

  it("多 item：任一有内容 → 放行；全空白 → 拦截", async () => {
    await expect(allowWrite([textItem("  "), imageItem()])).resolves.toBe(true);
    await expect(allowWrite([textItem("  "), textItem("\u200b")])).resolves.toBe(false);
  });

  it("text/html 有内容 → 放行；空白 → 拦截", async () => {
    await expect(itemHasContent(htmlItem("<b>hi</b>"))).resolves.toBe(true);
    await expect(itemHasContent(htmlItem("   "))).resolves.toBe(false);
  });
});

describe("installClipboardGuard", () => {
  it("拦截空白 writeText，放行正常 writeText", async () => {
    const writeText = vi.fn(async () => {});
    const clipboard: any = { writeText };
    installClipboardGuard({ clipboard, clipboardPrototype: null });

    await expect(clipboard.writeText("   ")).resolves.toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();

    await clipboard.writeText("AB");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("AB");
  });

  it("拦截空内容 write，放行正常文本与图片", async () => {
    const write = vi.fn(async () => {});
    const clipboard: any = { write };
    installClipboardGuard({ clipboard, clipboardPrototype: null });

    await clipboard.write([]);
    await clipboard.write([textItem("   ")]);
    expect(write).not.toHaveBeenCalled();

    const item = textItem("hello");
    await clipboard.write([item]);
    expect(write).toHaveBeenCalledWith([item]);

    await clipboard.write([imageItem()]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("原型补丁：绕实例直接调用也会拦，且不会重复包装", async () => {
    const protoWriteText = vi.fn(async () => {});
    const proto: any = { writeText: protoWriteText };
    installClipboardGuard({ clipboard: null, clipboardPrototype: proto });

    expect(proto.__ftWriteTextPatched).toBe(true);
    await expect(proto.writeText("   ")).resolves.toBeUndefined();
    expect(protoWriteText).not.toHaveBeenCalled();

    await proto.writeText("AB");
    expect(protoWriteText).toHaveBeenCalledTimes(1);

    installClipboardGuard({ clipboard: null, clipboardPrototype: proto }); // 二次安装不重复包装
    await proto.writeText("CD");
    expect(protoWriteText).toHaveBeenCalledTimes(2);
  });
});
