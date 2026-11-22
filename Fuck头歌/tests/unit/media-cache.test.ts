import { describe, expect, it } from "vitest";
import { dataUrlToBlob, getCachedMedia, putCachedMedia, staleMediaKeys } from "../../src/features/media-cache";

describe("media cache", () => {
  it("decodes base64 data URL to Blob", async () => {
    const blob = await dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("image/png");
    expect(blob?.size).toBe(8);
  });

  it("bad source returns null", async () => {
    expect(await dataUrlToBlob("not-a-data-url")).toBeNull();
  });

  it("without IndexedDB falls back gracefully", async () => {
    expect(await getCachedMedia("fuckTougeMedia:test")).toBeNull();
    expect(await putCachedMedia("fuckTougeMedia:test", new Blob(["x"]))).toBe(false);
  });
});

describe("staleMediaKeys", () => {
  it("只返回不在有效列表里的字符串 key", () => {
    expect(staleMediaKeys(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
    expect(staleMediaKeys(["fuckTougeMedia:1"], new Set(["fuckTougeMedia:1"]))).toEqual([]);
    expect(staleMediaKeys([1, null, "a"], ["a"])).toEqual([]);
  });
});
