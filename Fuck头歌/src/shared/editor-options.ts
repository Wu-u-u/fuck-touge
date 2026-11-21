/**
 * 编辑器选项：UI 分组、路径读写、Monaco 白名单。
 * 只管理这里列出的常用选项；字体/光标/主题继续由原有开关负责。
 */

export type EditorOptions = Record<string, unknown>;

export type EditorFieldType = "bool" | "number" | "select" | "text";

export interface EditorOptionField {
  path: string;
  label: string;
  hint?: string;
  type: EditorFieldType;
  options?: Array<{ value: string; label: string }>;
  numeric?: boolean; // select 的 value 需要转成 number
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export interface EditorOptionGroup {
  id: string;
  label: string;
  fields: EditorOptionField[];
}

export const EDITOR_DIRECT_OPTIONS: EditorOptionField[] = [
  {
    path: "smoothScrolling",
    label: "平滑滚动",
    hint: "滚轮滚动更柔和；关闭则按平台原样",
    type: "bool",
  },
  {
    path: "mouseWheelZoom",
    label: "Ctrl + 滚轮缩放",
    hint: "开启后按住 Ctrl 滚动可缩放编辑器字号",
    type: "bool",
  },
];

const select = (values: Array<[string, string]>) =>
  values.map(([value, label]) => ({ value, label }));

export const EDITOR_GROUPS: EditorOptionGroup[] = [
  {
    id: "layout",
    label: "布局与字体",
    fields: [
      { path: "fontSize", label: "字体大小", type: "number", min: 10, max: 32, step: 1 },
      { path: "lineHeight", label: "行高", hint: "0 = 自动", type: "number", min: 0, max: 60, step: 1 },
      { path: "letterSpacing", label: "字间距", type: "number", min: 0, max: 5, step: 0.5 },
      {
        path: "fontWeight",
        label: "字体粗细",
        type: "text",
        placeholder: "normal / bold / 500",
      },
      {
        path: "tabSize",
        label: "Tab 宽度",
        type: "select",
        numeric: true,
        options: select([["2", "2"], ["4", "4"], ["8", "8"]]),
      },
      {
        path: "wordWrap",
        label: "自动换行",
        type: "select",
        options: select([
          ["off", "关闭"],
          ["on", "按视口"],
          ["wordWrapColumn", "按列宽"],
          ["bounded", "视口/列宽取小"],
        ]),
      },
      { path: "wordWrapColumn", label: "换行列宽", type: "number", min: 40, max: 200, step: 1 },
      {
        path: "wrappingIndent",
        label: "换行缩进",
        type: "select",
        options: select([
          ["none", "无"],
          ["same", "同层"],
          ["indent", "缩进"],
          ["deepIndent", "深缩进"],
        ]),
      },
      { path: "insertSpaces", label: "Tab 转空格", type: "bool" },
      { path: "detectIndentation", label: "自动识别缩进", type: "bool" },
      { path: "trimAutoWhitespace", label: "删除行尾空格", type: "bool" },
    ],
  },
  {
    id: "display",
    label: "显示",
    fields: [
      { path: "minimap.enabled", label: "小地图", type: "bool" },
      {
        path: "minimap.size",
        label: "小地图大小",
        type: "select",
        options: select([
          ["proportional", "按比例"],
          ["fill", "填满"],
          ["fit", "适配"],
        ]),
      },
      {
        path: "lineNumbers",
        label: "行号",
        type: "select",
        options: select([
          ["on", "显示"],
          ["off", "隐藏"],
          ["relative", "相对"],
          ["interval", "间隔"],
        ]),
      },
      {
        path: "renderWhitespace",
        label: "空白字符",
        type: "select",
        options: select([
          ["none", "不显示"],
          ["selection", "选区"],
          ["trailing", "行尾"],
          ["all", "全部"],
        ]),
      },
      {
        path: "renderLineHighlight",
        label: "当前行高亮",
        type: "select",
        options: select([
          ["none", "关闭"],
          ["gutter", "行号槽"],
          ["line", "整行"],
          ["all", "整行+行号槽"],
        ]),
      },
      { path: "glyphMargin", label: "左侧图标槽", type: "bool" },
      { path: "folding", label: "代码折叠", type: "bool" },
      {
        path: "showFoldingControls",
        label: "折叠按钮",
        type: "select",
        options: select([
          ["always", "始终显示"],
          ["mouseover", "悬停显示"],
        ]),
      },
      { path: "stickyScroll.enabled", label: "粘性滚动", type: "bool" },
      {
        path: "stickyScroll.maxLineCount",
        label: "粘性滚动行数",
        type: "number",
        min: 1,
        max: 20,
        step: 1,
      },
      { path: "guides.indentation", label: "缩进参考线", type: "bool" },
      {
        path: "renderFinalNewline",
        label: "末尾空行",
        type: "select",
        options: select([
          ["on", "显示"],
          ["off", "隐藏"],
          ["dimmed", "淡显"],
        ]),
      },
      { path: "renderControlCharacters", label: "控制字符", type: "bool" },
    ],
  },
  {
    id: "cursor",
    label: "光标与选区",
    fields: [
      {
        path: "cursorStyle",
        label: "光标形状",
        type: "select",
        options: select([
          ["line", "竖线"],
          ["line-thin", "细竖线"],
          ["block", "方块"],
          ["block-outline", "空心方块"],
          ["underline", "下划线"],
          ["underline-thin", "细下划线"],
        ]),
      },
      { path: "cursorWidth", label: "光标宽度", type: "number", min: 0, max: 10, step: 1 },
      { path: "selectionHighlight", label: "选中相同内容高亮", type: "bool" },
      {
        path: "occurrencesHighlight",
        label: "相同符号高亮",
        type: "select",
        options: select([
          ["off", "关闭"],
          ["singleFile", "当前文件"],
          ["multiFile", "多文件"],
        ]),
      },
      { path: "roundedSelection", label: "圆角选区", type: "bool" },
    ],
  },
  {
    id: "editing",
    label: "代码辅助",
    fields: [
      { path: "formatOnPaste", label: "粘贴时格式化", type: "bool" },
      {
        path: "autoClosingBrackets",
        label: "自动闭合括号",
        type: "select",
        options: select([
          ["languageDefined", "按语言"],
          ["always", "总是"],
          ["beforeWhitespace", "空白前"],
          ["never", "从不"],
        ]),
      },
      {
        path: "autoClosingQuotes",
        label: "自动闭合引号",
        type: "select",
        options: select([
          ["languageDefined", "按语言"],
          ["always", "总是"],
          ["beforeWhitespace", "空白前"],
          ["never", "从不"],
        ]),
      },
      {
        path: "autoSurround",
        label: "选中后自动包裹",
        type: "select",
        options: select([
          ["languageDefined", "按语言"],
          ["quotes", "引号"],
          ["brackets", "括号"],
          ["never", "从不"],
        ]),
      },
      {
        path: "autoIndent",
        label: "自动缩进",
        type: "select",
        options: select([
          ["full", "完整"],
          ["advanced", "进阶"],
          ["brackets", "括号"],
          ["keep", "保持"],
          ["none", "关闭"],
        ]),
      },
      {
        path: "tabCompletion",
        label: "Tab 补全",
        type: "select",
        options: select([
          ["off", "关闭"],
          ["on", "开启"],
          ["onlySnippets", "仅代码片段"],
        ]),
      },
      { path: "quickSuggestions", label: "快速建议", type: "bool" },
      { path: "suggestOnTriggerCharacters", label: "触发字符建议", type: "bool" },
      { path: "parameterHints.enabled", label: "参数提示", type: "bool" },
      {
        path: "inlayHints.enabled",
        label: "内联提示",
        type: "select",
        options: select([
          ["on", "显示"],
          ["off", "关闭"],
          ["offUnlessPressed", "按住时关闭"],
          ["onUnlessPressed", "按住时显示"],
        ]),
      },
      { path: "codeLens", label: "CodeLens", type: "bool" },
      { path: "hover.enabled", label: "悬停提示", type: "bool" },
      { path: "links", label: "链接可点击", type: "bool" },
      { path: "colorDecorators", label: "颜色预览块", type: "bool" },
      {
        path: "lightbulb.enabled",
        label: "灯泡提示",
        type: "select",
        options: select([
          ["on", "显示"],
          ["off", "关闭"],
          ["onCode", "仅代码"],
        ]),
      },
      { path: "contextmenu", label: "右键菜单", type: "bool" },
      {
        path: "multiCursorModifier",
        label: "多光标修饰键",
        type: "select",
        options: select([
          ["alt", "Alt"],
          ["ctrlCmd", "Ctrl/Cmd"],
        ]),
      },
    ],
  },
  {
    id: "scroll",
    label: "滚动与留白",
    fields: [
      { path: "scrollBeyondLastLine", label: "滚过最后一行", type: "bool" },
      {
        path: "scrollbar.vertical",
        label: "垂直滚动条",
        type: "select",
        options: select([
          ["auto", "自动"],
          ["visible", "常显"],
          ["hidden", "隐藏"],
        ]),
      },
      {
        path: "scrollbar.horizontal",
        label: "水平滚动条",
        type: "select",
        options: select([
          ["auto", "自动"],
          ["visible", "常显"],
          ["hidden", "隐藏"],
        ]),
      },
      { path: "scrollbar.verticalScrollbarSize", label: "垂直滚动条宽度", type: "number", min: 6, max: 24, step: 1 },
      { path: "scrollbar.horizontalScrollbarSize", label: "水平滚动条高度", type: "number", min: 6, max: 24, step: 1 },
      { path: "padding.top", label: "顶部留白", type: "number", min: 0, max: 30, step: 1 },
      { path: "padding.bottom", label: "底部留白", type: "number", min: 0, max: 30, step: 1 },
    ],
  },
];

/** 控制器只需要顶层键；嵌套对象整体交给 updateOptions */
export const EDITOR_KNOWN_KEYS: string[] = [
  ...new Set(
    [...EDITOR_DIRECT_OPTIONS, ...EDITOR_GROUPS.flatMap((g) => g.fields)]
      .map((f) => f.path.split(".")[0]),
  ),
];

/** Monaco EditorOption 的字段名；默认与顶层键同名 */
export const EDITOR_OPTION_NAMES: Record<string, string> = {
  minimap: "minimap",
  stickyScroll: "stickyScroll",
  parameterHints: "parameterHints",
  inlayHints: "inlayHints",
  hover: "hover",
  lightbulb: "lightbulb",
  scrollbar: "scrollbar",
  padding: "padding",
  guides: "guides",
  quickSuggestions: "quickSuggestions",
};

export const getEditorPath = (options: EditorOptions, path: string): unknown => {
  let cur: unknown = options;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
};

export const setEditorPath = (options: EditorOptions, path: string, value: unknown): void => {
  const parts = path.split(".");
  let cur: Record<string, unknown> = options;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
};

export const deleteEditorPath = (options: EditorOptions, path: string): void => {
  const parts = path.split(".");
  const stack: Array<{ obj: Record<string, unknown>; key: string }> = [];
  let cur: Record<string, unknown> = options;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    stack.push({ obj: cur, key: parts[i] });
    cur = next as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]];
  // 删掉空壳，保持配置干净
  for (let i = stack.length - 1; i >= 0; i--) {
    const { obj, key } = stack[i];
    const child = obj[key];
    if (child && typeof child === "object" && Object.keys(child).length === 0) delete obj[key];
    else break;
  }
};

export const countEditorOverrides = (options: EditorOptions): number =>
  [...EDITOR_DIRECT_OPTIONS, ...EDITOR_GROUPS.flatMap((g) => g.fields)].filter(
    (f) => getEditorPath(options, f.path) !== undefined,
  ).length;
