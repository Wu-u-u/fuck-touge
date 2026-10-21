/**
 * Java 着色增强：自定义 Monaco 的 Java tokenizer，并接管 setMonarchTokensProvider。
 * 语义与 main.ts 原实现一致：主题开启时装 smart 规则，关闭时还原平台 provider。
 */

import type { MonacoLike } from "../../shared/types";

export type JavaMonarchDef = Record<string, unknown>;

export const JAVA_MONARCH = (smart: boolean): JavaMonarchDef => ({
  defaultToken: "",
  tokenPostfix: ".java",
  tokenizer: {
    root: [
      [/[ \t\r\n]+/, ""],
      [/\/\*\*(?!\/)/, "comment.doc", "@docComment"],
      [/\/\*/, "comment", "@comment"],
      [/\/\/.*$/, "comment"],
      [/@[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*/, "annotation"],
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/"/, "string", "@string"],
      [/'([^'\\]|\\.)*$/, "string.invalid"],
      [/'/, "string", "@char"],
      [/0[xX][0-9a-fA-F_]+[Ll]?/, "number.hex"],
      [/0[bB][01_]+[Ll]?/, "number.hex"],
      [/[0-9][0-9_]*\.[0-9_]*([eE][+-]?[0-9]+)?[fFdD]?/, "number.float"],
      [/\.[0-9][0-9_]*([eE][+-]?[0-9]+)?[fFdD]?/, "number.float"],
      [/[0-9][0-9_]*([eE][+-]?[0-9]+[fFdD]?|[fFdD])/, "number.float"],
      [/[0-9][0-9_]*[Ll]?/, "number"],
      ...(smart ? [
        [/(?:if|else|for|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|throws|instanceof|assert|yield)\b/, "keyword.control"],
        [/(?:boolean|byte|char|double|float|int|long|short|void|var)\b/, "keyword.primitive"],
        [/(?:true|false|null)\b/, "keyword.constant"],
        [/(?:class|interface|enum|extends|implements|record|sealed|permits)\b/, "keyword.declaration"],
        [/(?:package|import)\b/, "keyword.import"],
        [/(?:abstract|public|private|protected|static|final|synchronized|volatile|transient|native|strictfp|this|super|new)\b/, "keyword"],
        [/[A-Z][A-Z0-9_]+/, "constant"],
        [/[A-Z][A-Za-z0-9_$]*/, "type.identifier"],
        [/[a-z_$][\w$]*(?=\s*\()/, "function"],
        [/[a-z_$][\w$]*/, "identifier"],
      ] : [
        [/(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|true|false|null|var|record|sealed|permits|yield)\b/, "keyword"],
        [/[A-Za-z_$][\w$]*/, "identifier"],
      ]),
      [/[{}()\[\]]/, "delimiter"],
      [/[;,.]/, "delimiter"],
      [/[+\-*/%=!<>&|^~?:]+/, "delimiter.java"],
      [/@/, "delimiter.java"],
    ],
    comment: [
      [/\*\//, "comment", "@pop"],
      [/./, "comment"],
    ],
    docComment: [
      [/\*\//, "comment.doc", "@pop"],
      [/./, "comment.doc"],
    ],
    string: [
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
      [/[^\\"]+/, "string"],
    ],
    char: [
      [/\\./, "string.escape"],
      [/'/, "string", "@pop"],
      [/[^\\']+/, "string"],
    ],
  },
});

// 我们自己的 tokenizer 定义（WeakSet 用来区分“平台传进来的 provider”与内置定义）
const ftJavaDefs = new WeakSet<object>();

export const javaDef = (smart: boolean): JavaMonarchDef => {
  const def = JAVA_MONARCH(smart);
  ftJavaDefs.add(def);
  return def;
};

export const isOurJavaDef = (def: unknown): boolean =>
  !!def && typeof def === "object" && ftJavaDefs.has(def as object);

export interface TokenizerDeps {
  getMonaco(): MonacoLike | undefined;
  isThemeOn(): boolean;
  timers?: { setTimeout(fn: () => void, ms: number): unknown };
}

export interface TokenizerController {
  installHook(M: MonacoLike): void;
  install(): void;
  restore(): void;
  scheduleRetries(): void;
}

export function createTokenizerController(deps: TokenizerDeps): TokenizerController {
  const timers = deps.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms) };

  const install = (): void => {
    if (!deps.isThemeOn()) return; // 主题关闭时不接管着色
    try {
      deps.getMonaco()?.languages?.setMonarchTokensProvider?.("java", javaDef(true));
    } catch (e) {}
  };

  // 主题 开→关：把 Java 着色还原成平台原 provider；拿不到原 provider 时退回基础规则，
  // 不能把增强 tokenizer 留在页面上
  const restore = (): void => {
    if (deps.isThemeOn()) return;
    try {
      const L = deps.getMonaco()?.languages;
      if (!L) return;
      L.setMonarchTokensProvider?.("java", (L as any).__ftJavaPlatformDef || javaDef(false));
    } catch (e) {}
  };

  const installHook = (M: MonacoLike): void => {
    const L = M.languages;
    if (!L || (L as any).__ftMonarchHooked || typeof L.setMonarchTokensProvider !== "function") return;
    // 内置 Java 语法是异步装载的，会覆盖我们装的，这里全部接管
    (L as any).__ftMonarchHooked = true;
    const origMonarch = L.setMonarchTokensProvider!.bind(L);
    (L as any).__ftOrigMonarch = origMonarch;
    L.setMonarchTokensProvider = (id: string, def: unknown) => {
      if (id !== "java") return origMonarch(id, def);
      if (!isOurJavaDef(def)) (L as any).__ftJavaPlatformDef = def; // 记下平台原 provider，关主题时还原
      return origMonarch(id, deps.isThemeOn() ? javaDef(true) : def);
    };
  };

  // 内置 Java 语法异步装载，装完会覆盖我们 → 启动后重试几次
  const scheduleRetries = (): void => {
    [400, 1200, 2500].forEach((ms) => {
      timers.setTimeout(() => {
        if (deps.isThemeOn()) install();
      }, ms);
    });
  };

  return { installHook, install, restore, scheduleRetries };
}
