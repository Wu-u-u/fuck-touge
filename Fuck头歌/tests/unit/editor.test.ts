// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorManager, findEditorInstances } from "../../src/features/editor";

function makeFiber(instance?: any) {
  return {
    memoizedState: instance
      ? { memoizedState: { current: { instance } }, next: null }
      : { memoizedState: {}, next: null },
    return: null,
  };
}

function makeElement(fiber?: any, parentElement: any = null) {
  const el: any = { parentElement };
  if (fiber) el.__reactFiber$test = fiber;
  return el;
}

function makeInstance() {
  return { updateOptions: vi.fn(), getOption: vi.fn() };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("findEditorInstances", () => {
  it("通过 fiber 找到编辑器实例", () => {
    const instance = makeInstance();
    const el = makeElement(makeFiber(instance));
    expect(findEditorInstances([el])).toEqual([instance]);
  });

  it("自身没有 fiber 时沿 parentElement 上溯", () => {
    const instance = makeInstance();
    const parent = makeElement(makeFiber(instance));
    const child = makeElement(undefined, parent);
    expect(findEditorInstances([child])).toEqual([instance]);
  });

  it("fiber 链里没有 updateOptions 实例 → 空数组", () => {
    const el = makeElement(makeFiber());
    expect(findEditorInstances([el])).toEqual([]);
  });
});

describe("编辑器注册表", () => {
  function makeManager(extra: any = {}) {
    const registered: Array<{ entry: any; isFirst: boolean }> = [];
    let createCb: ((ed: any) => void) | null = null;
    const M: any = {
      editor: {
        getModels: () => [],
        onDidCreateModel: vi.fn(),
        onDidCreateEditor: (fn: any) => {
          createCb = fn;
        },
      },
    };
    const manager = createEditorManager({
      findElements: () => [],
      onEditor: (entry, isFirst) => registered.push({ entry, isFirst }),
      ...extra,
    });
    return { manager, M, registered, getCreateCb: () => createCb };
  }

  it("onDidCreateEditor + 已有编辑器都会登记，首个 isFirst=true", () => {
    const instance = makeInstance();
    const existing = makeInstance();
    let createCb: any = null;
    const M: any = {
      editor: {
        getModels: () => [],
        onDidCreateModel: vi.fn(),
        onDidCreateEditor: (fn: any) => {
          createCb = fn;
        },
      },
    };
    const registered: Array<{ entry: any; isFirst: boolean }> = [];
    const manager = createEditorManager({
      findElements: () => [makeElement(makeFiber(existing))],
      onEditor: (entry, isFirst) => registered.push({ entry, isFirst }),
    });
    manager.hook(M);
    createCb(instance);
    expect(manager.getEditors().map((e) => e.ed)).toEqual([existing, instance]);
    expect(registered.map((r) => r.isFirst)).toEqual([true, false]);
  });

  it("重复挂钩不会重复登记", () => {
    const instance = makeInstance();
    let createCb: any = null;
    const M: any = {
      editor: {
        getModels: () => [],
        onDidCreateModel: vi.fn(),
        onDidCreateEditor: (fn: any) => {
          createCb = fn;
        },
      },
    };
    const registered: any[] = [];
    const manager = createEditorManager({
      findElements: () => [],
      onEditor: (entry) => registered.push(entry),
    });
    manager.hook(M);
    manager.hook(M);
    createCb(instance);
    createCb(instance);
    expect(registered).toHaveLength(1);
    expect(manager.getEditors()).toHaveLength(1);
  });

  it("编辑器 dispose 后从注册表移除并标记 disposed", () => {
    let createCb: any = null;
    let disposeCb: any = null;
    const instance: any = {
      updateOptions: vi.fn(),
      onDidDispose: (fn: any) => {
        disposeCb = fn;
      },
    };
    const M: any = {
      editor: {
        getModels: () => [],
        onDidCreateModel: vi.fn(),
        onDidCreateEditor: (fn: any) => {
          createCb = fn;
        },
      },
    };
    const manager = createEditorManager({ findElements: () => [] });
    manager.hook(M);
    createCb(instance);
    expect(manager.getEditors()).toHaveLength(1);
    disposeCb();
    expect(manager.getEditors()).toHaveLength(0);
  });

  it("模型：已有 model + onDidCreateModel 只注册一次", () => {
    const model = {};
    const onDidCreateModel = vi.fn();
    const onModel = vi.fn();
    const M: any = {
      editor: { getModels: () => [model], onDidCreateModel },
    };
    const manager = createEditorManager({ findElements: () => [], onModel });
    manager.hook(M);
    manager.hook(M);
    expect(onModel).toHaveBeenCalledWith(model);
    expect(onDidCreateModel).toHaveBeenCalledTimes(1);
  });
});

describe("install", () => {
  it("安装 window.Monaco setter，并轮询延迟加载", () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const manager = createEditorManager({ findElements: () => [], onMonacoReady: ready });
    const first: any = { editor: {} };
    (window as any).Monaco = first;

    manager.install();
    expect(ready).toHaveBeenCalledWith(first);

    vi.advanceTimersByTime(1000);
    expect(ready.mock.calls.length).toBeGreaterThanOrEqual(2);

    const second: any = { editor: {} };
    (window as any).Monaco = second;
    expect(ready).toHaveBeenCalledWith(second);
  });
});
