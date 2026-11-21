import type { EditorOptions } from "../shared/editor-options";
import { EDITOR_KNOWN_KEYS, EDITOR_OPTION_NAMES } from "../shared/editor-options";
import type { MonacoEditorLike, MonacoLike } from "../shared/types";

export interface EditorOptionsEntry {
  ed: MonacoEditorLike;
  editorOrig?: Record<string, unknown>;
  disposed?: boolean;
}

export interface EditorOptionsController {
  readOptions(ed: MonacoEditorLike): Record<string, unknown>;
  applyOne(entry: EditorOptionsEntry): void;
  apply(): void;
  setConfig(options: EditorOptions): void;
}

const clone = (value: unknown): unknown => {
  if (value && typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return value;
    }
  }
  return value;
};

export function createEditorOptionsController(deps: {
  getEditors(): EditorOptionsEntry[];
  getMonaco(): MonacoLike | undefined;
}): EditorOptionsController {
  let config: EditorOptions = {};

  const readOptions = (ed: MonacoEditorLike): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const EO = (deps.getMonaco()?.editor as any)?.EditorOption as Record<string, unknown> | undefined;
    for (const key of EDITOR_KNOWN_KEYS) {
      const name = EDITOR_OPTION_NAMES[key] || key;
      const opt = EO?.[name];
      if (opt === undefined) continue;
      try {
        const value = ed.getOption(opt);
        if (value !== undefined) out[key] = clone(value);
      } catch (e) {}
    }
    return out;
  };

  const patchFor = (entry: EditorOptionsEntry): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    for (const key of EDITOR_KNOWN_KEYS) {
      if (config[key] !== undefined) patch[key] = config[key];
      else if (entry.editorOrig && entry.editorOrig[key] !== undefined) {
        patch[key] = entry.editorOrig[key];
      }
    }
    return patch;
  };

  const applyOne = (entry: EditorOptionsEntry): void => {
    if (entry.disposed) return;
    try {
      entry.ed.updateOptions(patchFor(entry));
    } catch (e) {}
  };

  return {
    readOptions,
    applyOne,
    apply: (): void => deps.getEditors().forEach(applyOne),
    setConfig: (options): void => {
      config = options && typeof options === "object" ? options : {};
      deps.getEditors().forEach(applyOne);
    },
  };
}
