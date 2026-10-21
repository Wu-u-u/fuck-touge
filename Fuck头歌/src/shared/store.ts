import type { FuckTougeSettings, StorageLike, ThemeName } from "./types";

/** localStorage 键（与现有实现保持一致） */
export const SETTINGS_KEYS = {
  theme: "fuckTougeTheme",
  themeName: "fuckTougeThemeName",
  font: "fuckTougeFont",
  fontAsked: "fuckTougeFontAsked",
  cursor: "fuckTougeCursor",
  legacy: "fuckTougeUI",
} as const;

export const DEFAULT_SETTINGS: FuckTougeSettings = {
  theme: true,
  font: false,
  fontAsked: false,
  themeName: "catppuccin",
  cursor: false,
};

const isThemeName = (value: unknown): value is ThemeName =>
  value === "catppuccin" || value === "github";

/**
 * 读取设置，并把旧版单一开关 fuckTougeUI 迁移到新键。
 *
 * 迁移语义与现有实现一致：
 * - 新键优先，旧键只在对应新键不存在时兜底（off → 主题/字体关闭；on → 都开启）；
 * - 旧版用户已经拍板过字体（迁移后不再弹首次询问）；
 * - 迁移落盘 theme/font/fontAsked 后删除旧键，连续读取只在第一次写入（幂等）。
 */
export function readSettings(storage: StorageLike): FuckTougeSettings {
  const legacy = storage.getItem(SETTINGS_KEYS.legacy);
  const theme = storage.getItem(SETTINGS_KEYS.theme) ?? (legacy === "off" ? "off" : "on");
  const font = storage.getItem(SETTINGS_KEYS.font) ?? (legacy === "on" ? "on" : "off");
  const themeName = storage.getItem(SETTINGS_KEYS.themeName);

  const settings: FuckTougeSettings = {
    theme: theme !== "off",
    font: font === "on",
    fontAsked: Boolean(storage.getItem(SETTINGS_KEYS.fontAsked)) || legacy !== null,
    themeName: isThemeName(themeName) ? themeName : "catppuccin",
    cursor: storage.getItem(SETTINGS_KEYS.cursor) === "on",
  };

  if (legacy !== null) {
    storage.setItem(SETTINGS_KEYS.theme, settings.theme ? "on" : "off");
    storage.setItem(SETTINGS_KEYS.font, settings.font ? "on" : "off");
    storage.setItem(SETTINGS_KEYS.fontAsked, "1");
    storage.removeItem(SETTINGS_KEYS.legacy);
  }
  return settings;
}

/**
 * 局部写入设置（只写 patch 里出现的字段），返回写入后的完整设置。
 *
 * 与现有 setter 对齐：
 * - 写 font 时同步把 fontAsked 置为已询问（setFontState 的行为）；
 * - 无效主题名忽略、不落盘（setThemeName 对未知名字早退的行为）。
 */
export function writeSettings(
  storage: StorageLike,
  patch: Partial<FuckTougeSettings>,
): FuckTougeSettings {
  const next: FuckTougeSettings = { ...readSettings(storage) };

  if ("theme" in patch) {
    next.theme = Boolean(patch.theme);
    storage.setItem(SETTINGS_KEYS.theme, next.theme ? "on" : "off");
  }
  if ("font" in patch) {
    next.font = Boolean(patch.font);
    next.fontAsked = true;
    storage.setItem(SETTINGS_KEYS.font, next.font ? "on" : "off");
    storage.setItem(SETTINGS_KEYS.fontAsked, "1");
  }
  if ("fontAsked" in patch) {
    next.fontAsked = Boolean(patch.fontAsked);
    if (next.fontAsked) storage.setItem(SETTINGS_KEYS.fontAsked, "1");
    else storage.removeItem(SETTINGS_KEYS.fontAsked);
  }
  if ("themeName" in patch && isThemeName(patch.themeName)) {
    next.themeName = patch.themeName;
    storage.setItem(SETTINGS_KEYS.themeName, next.themeName);
  }
  if ("cursor" in patch) {
    next.cursor = Boolean(patch.cursor);
    storage.setItem(SETTINGS_KEYS.cursor, next.cursor ? "on" : "off");
  }
  return next;
}
