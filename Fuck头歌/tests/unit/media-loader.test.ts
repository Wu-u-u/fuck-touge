// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitLoadedMedia, shouldPersistFetchedMedia } from "../../src/shared/media-loader";

const original = URL.revokeObjectURL;

afterEach(() => {
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: original });
});

describe("commitLoadedMedia", () => {
  it("壁纸仍存在时写入缓存", () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    const cache = new Map<string, string>();
    expect(commitLoadedMedia("k", "blob:alive", true, cache)).toBe("blob:alive");
    expect(cache.get("k")).toBe("blob:alive");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("加载期间壁纸被删除：不缓存并 revoke blob URL", () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    const cache = new Map<string, string>();
    expect(commitLoadedMedia("k", "blob:stale", false, cache)).toBe("");
    expect(cache.size).toBe(0);
    expect(revoke).toHaveBeenCalledWith("blob:stale");
  });

  it("stale data URL 不调用 revoke", () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    const cache = new Map<string, string>();
    expect(commitLoadedMedia("k", "data:image/png;base64,x", false, cache)).toBe("");
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("shouldPersistFetchedMedia", () => {
  it("key 仍在页面 URL map 中才落缓存", () => {
    const urls = new Map([["k", "blob:x"]]);
    expect(shouldPersistFetchedMedia("k", urls)).toBe(true);
    urls.delete("k");
    expect(shouldPersistFetchedMedia("k", urls)).toBe(false);
  });
});
