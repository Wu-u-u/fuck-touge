import { describe, expect, it, vi } from "vitest";
import { resetVideoElement } from "../../src/shared/media-preview";

describe("resetVideoElement", () => {
  it("pause、移除 src、load 都执行", () => {
    const video = {
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLVideoElement;
    resetVideoElement(video);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.load).toHaveBeenCalledTimes(1);
  });

  it("pause/load 抛错也不影响移除 src", () => {
    const video = {
      pause: () => { throw new Error("pause"); },
      removeAttribute: vi.fn(),
      load: () => { throw new Error("load"); },
    } as unknown as HTMLVideoElement;
    expect(() => resetVideoElement(video)).not.toThrow();
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
  });
});
