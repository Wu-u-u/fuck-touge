import { describe, expect, it } from "vitest";
import { TRANSITION_EFFECTS, coverTransform, effectParams } from "../../src/features/wallpaper-shader";

describe("coverTransform", () => {
  it("cover 全图：横向铺满、纵向裁掉上下", () => {
    const t = coverTransform({ width: 4000, height: 3000 }, { width: 4000, height: 3000 }, { width: 1920, height: 1080 });
    expect(t).not.toBeNull();
    expect(t!.scale[0]).toBeCloseTo(1, 6);
    expect(t!.offset[0]).toBeCloseTo(0, 6);
    expect(t!.scale[1]).toBeCloseTo(0.75, 6);
    expect(t!.offset[1]).toBeCloseTo(0.125, 6);
  });

  it("cover + 左半裁剪：横向 UV 只取 0..0.5", () => {
    const t = coverTransform(
      { width: 4000, height: 3000, crop: { x: 0, y: 0, w: 0.5, h: 1 } },
      { width: 4000, height: 3000 },
      { width: 1920, height: 1080 },
    );
    expect(t!.scale[0]).toBeCloseTo(0.5, 6);
    expect(t!.offset[0]).toBeCloseTo(0, 6);
    expect(t!.scale[1]).toBeCloseTo(0.375, 6);
    expect(t!.offset[1]).toBeCloseTo(0.3125, 6);
  });

  it("尺寸无效时返回 null", () => {
    expect(coverTransform({}, { width: 0, height: 0 }, { width: 1920, height: 1080 })).toBeNull();
  });
});

describe("effectParams", () => {
  it("wipe 方向覆盖四个方向，中心在画面内", () => {
    const dirs = new Set<number>();
    for (let i = 0; i < 40; i++) dirs.add(effectParams("wipe").direction);
    expect([...dirs].sort()).toEqual([0, 1, 2, 3]);
    const disc = effectParams("disc");
    expect(disc.centerX).toBeGreaterThanOrEqual(0.32);
    expect(disc.centerX).toBeLessThanOrEqual(0.68);
    expect(disc.centerY).toBeGreaterThanOrEqual(0.32);
    expect(disc.centerY).toBeLessThanOrEqual(0.68);
  });

  it("每种效果都有参数，cellSize 对 pixel/diamond 有效", () => {
    for (const effect of TRANSITION_EFFECTS) {
      const p = effectParams(effect);
      expect(p.smoothness).toBe(0.3);
      expect(p.stripeCount).toBe(12);
      expect(Number.isFinite(p.angle)).toBe(true);
    }
    expect(effectParams("pixel").cellSize).toBe(0.04);
    expect(effectParams("diamond").cellSize).toBe(0.07);
  });
});
