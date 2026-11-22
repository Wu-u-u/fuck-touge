// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseObjectUrls } from "../../src/shared/object-url";

const original = URL.revokeObjectURL;

afterEach(() => {
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: original });
});

describe("releaseObjectUrls", () => {
  it("只 revoke blob: URL，跳过 data URL/普通字符串", () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    expect(releaseObjectUrls(["blob:a", "data:image/png;base64,x", "blob:b"])).toBe(2);
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(["blob:a", "blob:b"]);
  });

  it("空集合返回 0", () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    expect(releaseObjectUrls([])).toBe(0);
    expect(revoke).not.toHaveBeenCalled();
  });
});
