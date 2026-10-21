/**
 * 页面 API：window.__fuckTougeUI（给扩展弹窗用）。
 * set 只处理传入字段、按 themeName → theme → font → cursor 的顺序分发，
 * 返回更新后的状态；与原先 main.ts 内的实现一致。
 */

import type { FuckTougeUIApi, PublicSettings } from "./shared/types";

export interface UIApiDeps {
  getState(): PublicSettings;
  setTheme(on: boolean): void;
  setThemeName(name: string | undefined): void;
  setFont(on: boolean): void;
  setCursor(on: boolean): void;
}

export function installUIApi(deps: UIApiDeps): void {
  try {
    const api: FuckTougeUIApi = {
      get: deps.getState,
      set: (next) => {
        if (next && typeof next === "object") {
          if ("themeName" in next) deps.setThemeName(next.themeName);
          if ("theme" in next) deps.setTheme(!!next.theme);
          if ("font" in next) deps.setFont(!!next.font);
          if ("cursor" in next) deps.setCursor(!!next.cursor);
        }
        return deps.getState();
      },
    };
    window.__fuckTougeUI = api;
  } catch (e) {}
}
