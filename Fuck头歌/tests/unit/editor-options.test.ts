import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_DIRECT_OPTIONS,
  EDITOR_GROUPS,
  countEditorOverrides,
  deleteEditorPath,
  getEditorPath,
  setEditorPath,
  type EditorOptions,
} from "../../src/shared/editor-options";
import { createEditorOptionsController } from "../../src/features/editor-options";
import type { MonacoEditorLike, MonacoLike } from "../../src/shared/types";

describe("editor option paths", () => {
  it("读写并清理嵌套路径", () => {
    const options: EditorOptions = {};
    setEditorPath(options, "minimap.enabled", false);
    setEditorPath(options, "scrollbar.vertical", "hidden");
    expect(getEditorPath(options, "minimap.enabled")).toBe(false);
    expect(options).toEqual({ minimap: { enabled: false }, scrollbar: { vertical: "hidden" } });
    deleteEditorPath(options, "minimap.enabled");
    expect(options).toEqual({ scrollbar: { vertical: "hidden" } });
    deleteEditorPath(options, "scrollbar.vertical");
    expect(options).toEqual({});
  });

  it("覆盖计数包含直接项和分组项", () => {
    const options: EditorOptions = {};
    expect(countEditorOverrides(options)).toBe(0);
    setEditorPath(options, EDITOR_DIRECT_OPTIONS[0].path, true);
    setEditorPath(options, EDITOR_GROUPS[0].fields[0].path, 15);
    expect(countEditorOverrides(options)).toBe(2);
  });
});

describe("editor options controller", () => {
  const OPTION = {
    smoothScrolling: 1,
    mouseWheelZoom: 2,
    fontSize: 3,
    minimap: 4,
  };
  const values: Record<number, unknown> = {
    1: false,
    2: false,
    3: 14,
    4: { enabled: true, size: "proportional" },
  };

  it("读取快照、应用配置、恢复快照", () => {
    const ed = {
      updateOptions: vi.fn(),
      getOption: (opt: unknown) => values[opt as number],
    };
    const entry = { ed: ed as unknown as MonacoEditorLike, disposed: false };
    const monaco = { editor: { EditorOption: OPTION } } as unknown as MonacoLike;
    const ctl = createEditorOptionsController({
      getEditors: () => [entry],
      getMonaco: () => monaco,
    });

    entry.editorOrig = ctl.readOptions(entry.ed) as Record<string, unknown>;
    expect(entry.editorOrig).toEqual({
      smoothScrolling: false,
      mouseWheelZoom: false,
      fontSize: 14,
      minimap: { enabled: true, size: "proportional" },
    });

    ctl.setConfig({ smoothScrolling: true, minimap: { enabled: false } });
    expect(ed.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        smoothScrolling: true,
        mouseWheelZoom: false,
        fontSize: 14,
        minimap: { enabled: false },
      }),
    );

    ctl.setConfig({});
    expect(ed.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        smoothScrolling: false,
        minimap: { enabled: true, size: "proportional" },
      }),
    );
  });

  it("已销毁的编辑器不碰", () => {
    const ed = { updateOptions: vi.fn(), getOption: () => false };
    const entry = { ed: ed as unknown as MonacoEditorLike, disposed: true };
    const ctl = createEditorOptionsController({
      getEditors: () => [entry],
      getMonaco: () => ({ editor: { EditorOption: OPTION } }) as unknown as MonacoLike,
    });
    ctl.setConfig({ smoothScrolling: true });
    expect(ed.updateOptions).not.toHaveBeenCalled();
  });
});
