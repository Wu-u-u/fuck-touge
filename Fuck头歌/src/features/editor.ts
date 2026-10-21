/**
 * Monaco 发现 / 挂钩 / 编辑器注册表（从 main.ts 原样抽出）。
 * - window.Monaco setter + 1s 轮询（60s 超时）
 * - onDidCreateEditor / onDidCreateModel + fiber 反查已存在的编辑器
 * - 编辑器注册表（dispose 自动移除），字体/光标快照由上层填充
 */

import { $$ } from "../shared/dom";
import type { MonacoEditorLike, MonacoLike, MonacoModelLike } from "../shared/types";

export interface EditorEntry {
  ed: MonacoEditorLike;
  disposed: boolean;
  /** 字体快照（上层填充） */
  orig?: unknown;
  /** 光标快照（上层填充） */
  cursorOrig?: unknown;
}

export interface EditorManagerDeps {
  onModel?(model: MonacoModelLike): void;
  onMonacoReady?(M: MonacoLike): void;
  onEditor?(entry: EditorEntry, isFirst: boolean): void;
  onMonacoHooked?(M: MonacoLike): void;
  findElements?(): Element[];
}

export interface EditorManager {
  install(): void;
  hook(M: MonacoLike | undefined): void;
  getEditors(): EditorEntry[];
}

/** 页面可能先创建编辑器、后暴露 window.Monaco —— 用 DOM 的 React fiber 反查已有实例 */
export function findEditorInstances(elements: Iterable<Element>): MonacoEditorLike[] {
  const found: MonacoEditorLike[] = [];
  for (const el of elements) {
    let node: Element | null = el;
    search: while (node) {
      const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
      if (key) {
        let f: any = (node as any)[key];
        let d = 0;
        while (f && d < 80) {
          let hook = f.memoizedState;
          let h = 0;
          while (hook && h < 50) {
            const v = hook.memoizedState;
            if (v?.current?.instance?.updateOptions) {
              found.push(v.current.instance);
              break search;
            }
            hook = hook.next;
            h++;
          }
          f = f.return;
          d++;
        }
        break search; // 找到 fiber 但没有实例 → 这个元素到此为止（与原实现一致）
      }
      node = node.parentElement;
    }
  }
  return found;
}

export function createEditorManager(deps: EditorManagerDeps = {}): EditorManager {
  const editors: EditorEntry[] = [];
  const findElements = deps.findElements || (() => $$(".monaco-editor"));
  const registered = new WeakSet<object>();
  const createHooked = new WeakSet<object>();

  const register = (ed: MonacoEditorLike): void => {
    if (!ed || editors.some((e) => e.ed === ed)) return;
    const entry: EditorEntry = { ed, disposed: false };
    editors.push(entry);
    try {
      ed.onDidDispose?.(() => {
        entry.disposed = true;
        const i = editors.indexOf(entry);
        if (i >= 0) editors.splice(i, 1);
      });
    } catch (e) {}
    try {
      deps.onEditor?.(entry, editors.length === 1);
    } catch (e) {}
  };

  const hook = (M?: MonacoLike): void => {
    if (!M?.editor) return;
    M.editor.getModels?.().forEach((m) => {
      try {
        deps.onModel?.(m);
      } catch (e) {}
    });
    if (deps.onModel && !createHooked.has(M) && M.editor.onDidCreateModel) {
      createHooked.add(M);
      M.editor.onDidCreateModel(deps.onModel);
    }
    deps.onMonacoReady?.(M);
    if (!registered.has(M.editor)) {
      registered.add(M.editor);
      M.editor.onDidCreateEditor?.(register); // 之后创建的编辑器
      findEditorInstances(findElements()).forEach(register); // 页面在我们挂钩之前已创建的编辑器
      deps.onMonacoHooked?.(M);
    }
  };

  const install = (): void => {
    let monaco: MonacoLike | undefined = (window as any).Monaco; // 兼容脚本在页面之后运行的情况
    try {
      Object.defineProperty(window, "Monaco", {
        configurable: true,
        get: () => monaco,
        set(v) {
          monaco = v;
          try {
            hook(v);
          } catch (e) {} // 异常不能外泄到页面
        },
      });
    } catch (e) {}
    try {
      hook(monaco);
    } catch (e) {}
    const timer = setInterval(() => {
      try {
        hook((window as any).Monaco);
      } catch (e) {}
      if (monaco && document.readyState === "complete") clearInterval(timer);
    }, 1000);
    setTimeout(() => clearInterval(timer), 60000);
  };

  return { install, hook, getEditors: () => editors };
}
