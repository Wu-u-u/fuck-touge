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

describe("IndexedDB open retry", () => {
  it("首次 open 失败后下一次会重试并成功", async () => {
    const blobs = new Map<string, Blob>([["key", new Blob(["x"])]]);
    let opens = 0;
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({
        objectStore: () => ({
          get: (key: string) => {
            const req: any = {};
            setTimeout(() => {
              req.result = blobs.get(key);
              req.onsuccess?.();
            }, 0);
            return req;
          },
        }),
      }),
    };
    (globalThis as any).indexedDB = {
      open: () => {
        opens++;
        const req: any = {};
        setTimeout(() => {
          if (opens === 1) req.onerror?.();
          else {
            req.result = fakeDb;
            req.onsuccess?.();
          }
        }, 0);
        return req;
      },
    };
    try {
      expect(await getCachedMedia("key")).toBeNull();
      expect(opens).toBe(1);
      const blob = await getCachedMedia("key");
      expect(opens).toBe(2);
      expect(blob?.size).toBe(1);
    } finally {
      delete (globalThis as any).indexedDB;
    }
  });
});
