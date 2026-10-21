/**
 * 共享类型与最小全局声明。
 * 只声明项目实际会用到的 API，避免把整个 Monaco / Chrome 类型面引入。
 */

export type ThemeName = "catppuccin" | "github";

export interface FuckTougeSettings {
  theme: boolean;
  font: boolean;
  fontAsked: boolean;
  themeName: ThemeName;
  cursor: boolean;
}

/** localStorage 的最小结构（便于单测用内存实现替代） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Monaco 文本模型的最小接口 */
export interface MonacoModelLike {
  getValue(): string;
  setValue(value: string): void;
  applyEdits?(edits: unknown[]): unknown;
  getPositionAt?(offset: number): unknown;
}

/** Monaco 编辑器实例的最小接口 */
export interface MonacoEditorLike {
  updateOptions(options: Record<string, unknown>): void;
  getOption(option: unknown): unknown;
  focus?(): void;
  dispose?(): void;
}

/** 页面注入的 window.Monaco 的最小接口 */
export interface MonacoLike {
  editor?: {
    getModels?(): MonacoModelLike[];
    onDidCreateEditor?(listener: (editor: MonacoEditorLike) => void): unknown;
    onDidCreateModel?(listener: (model: MonacoModelLike) => void): unknown;
    setTheme?(theme: string): void;
    defineTheme?(name: string, data: unknown): void;
  };
}

/** 对外（popup）暴露的设置：不含内部的 fontAsked */
export type PublicSettings = Omit<FuckTougeSettings, "fontAsked">;

/** 插件暴露给 popup 的页面 API */
export interface FuckTougeUIApi {
  get(): PublicSettings;
  set(patch: Partial<PublicSettings>): PublicSettings;
}

declare global {
  interface Window {
    __fuckTouge?: string;
    __fuckTougeUI?: FuckTougeUIApi;
    Monaco?: MonacoLike;
  }
}
