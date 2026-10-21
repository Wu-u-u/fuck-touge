import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  readSettings,
  writeSettings,
} from "../../src/shared/store";
import type { StorageLike } from "../../src/shared/types";

function makeStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const calls = { set: 0, remove: 0 };
  const storage: StorageLike = {
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      calls.set++;
      data.set(key, value);
    },
    removeItem: (key) => {
      calls.remove++;
      data.delete(key);
    },
  };
  return { storage, data, calls };
}

describe("readSettings", () => {
  it("空存储 → 默认值，且不写任何键", () => {
    const { storage, calls } = makeStorage();
    expect(readSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(calls.set).toBe(0);
    expect(calls.remove).toBe(0);
  });

  it("旧键 off → 主题/字体关闭，落盘新键并删除旧键", () => {
    const { storage, data, calls } = makeStorage({ [SETTINGS_KEYS.legacy]: "off" });
    const settings = readSettings(storage);

    expect(settings.theme).toBe(false);
    expect(settings.font).toBe(false);
    expect(settings.fontAsked).toBe(true);
    expect(settings.themeName).toBe("catppuccin");

    expect(data.get(SETTINGS_KEYS.theme)).toBe("off");
    expect(data.get(SETTINGS_KEYS.font)).toBe("off");
    expect(data.get(SETTINGS_KEYS.fontAsked)).toBe("1");
    expect(data.has(SETTINGS_KEYS.legacy)).toBe(false);
    expect(calls.set).toBe(3);
    expect(calls.remove).toBe(1);
  });

  it("旧键 on → 主题/字体开启", () => {
    const { storage, data } = makeStorage({ [SETTINGS_KEYS.legacy]: "on" });
    const settings = readSettings(storage);

    expect(settings.theme).toBe(true);
    expect(settings.font).toBe(true);
    expect(settings.fontAsked).toBe(true);
    expect(data.get(SETTINGS_KEYS.theme)).toBe("on");
    expect(data.get(SETTINGS_KEYS.font)).toBe("on");
    expect(data.has(SETTINGS_KEYS.legacy)).toBe(false);
  });

  it("连续两次读取结果一致，迁移只写一次（幂等）", () => {
    const { storage, calls } = makeStorage({ [SETTINGS_KEYS.legacy]: "on" });
    const first = readSettings(storage);
    const writesAfterFirst = calls.set;
    const removesAfterFirst = calls.remove;

    const second = readSettings(storage);

    expect(second).toEqual(first);
    expect(calls.set).toBe(writesAfterFirst);
    expect(calls.remove).toBe(removesAfterFirst);
  });

  it("新键优先于旧键", () => {
    const { storage, data } = makeStorage({
      [SETTINGS_KEYS.legacy]: "off",
      [SETTINGS_KEYS.theme]: "on",
      [SETTINGS_KEYS.font]: "on",
    });
    const settings = readSettings(storage);

    expect(settings.theme).toBe(true);
    expect(settings.font).toBe(true);
    expect(data.get(SETTINGS_KEYS.theme)).toBe("on");
    expect(data.get(SETTINGS_KEYS.font)).toBe("on");
    expect(data.has(SETTINGS_KEYS.legacy)).toBe(false);
  });

  it("无效存储值回退到默认语义", () => {
    const { storage } = makeStorage({
      [SETTINGS_KEYS.theme]: "wat",
      [SETTINGS_KEYS.font]: "yes",
      [SETTINGS_KEYS.fontAsked]: "",
      [SETTINGS_KEYS.themeName]: "neon",
      [SETTINGS_KEYS.cursor]: "1",
    });

    expect(readSettings(storage)).toEqual({
      theme: true,
      font: false,
      fontAsked: false,
      themeName: "catppuccin",
      cursor: false,
    });
  });
});

describe("writeSettings", () => {
  it("局部更新只写传入字段", () => {
    const { storage, data, calls } = makeStorage();
    const settings = writeSettings(storage, { cursor: true });

    expect(settings.cursor).toBe(true);
    expect(settings.theme).toBe(true); // 未触碰的字段保持默认
    expect(data.get(SETTINGS_KEYS.cursor)).toBe("on");
    expect(data.has(SETTINGS_KEYS.theme)).toBe(false);
    expect(calls.set).toBe(1);
  });

  it("写字体时同步 fontAsked = 1（与 setFontState 一致）", () => {
    const { storage, data } = makeStorage();
    const settings = writeSettings(storage, { font: true });

    expect(settings.font).toBe(true);
    expect(settings.fontAsked).toBe(true);
    expect(data.get(SETTINGS_KEYS.font)).toBe("on");
    expect(data.get(SETTINGS_KEYS.fontAsked)).toBe("1");
  });

  it("写入合法主题名", () => {
    const { storage, data } = makeStorage();
    const settings = writeSettings(storage, { themeName: "github" });

    expect(settings.themeName).toBe("github");
    expect(data.get(SETTINGS_KEYS.themeName)).toBe("github");
  });

  it("无效主题名忽略、不落盘（与 setThemeName 早退一致）", () => {
    const { storage, data, calls } = makeStorage();
    const settings = writeSettings(storage, { themeName: "neon" as never });

    expect(settings.themeName).toBe("catppuccin");
    expect(data.has(SETTINGS_KEYS.themeName)).toBe(false);
    expect(calls.set).toBe(0);
  });

  it("写入后再次读取与返回值一致", () => {
    const { storage } = makeStorage();
    const written = writeSettings(storage, {
      theme: false,
      font: true,
      themeName: "github",
      cursor: true,
    });

    expect(readSettings(storage)).toEqual(written);
  });
});
