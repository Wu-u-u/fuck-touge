/**
 * DOM / 文本小工具。
 * 语义与现有 content script 内的实现完全一致（D2 只做可复用模块，不改变行为）。
 */

export const $ = <T extends Element = Element>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

export const $$ = <T extends Element = Element>(sel: string, root: ParentNode = document): T[] =>
  [...root.querySelectorAll<T>(sel)];

export const visible = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
};

/** 文案归一化：去掉所有空白与零宽字符（用于按钮文字匹配） */
export const normText = (s: string | null | undefined): string =>
  String(s || "").replace(/[\s\u200b-\u200d\ufeff]/g, "");

/** 关卡标识：SPA 换关时路由会变，用于「只跳一次」的认领判断 */
export const levelKey = (
  loc: Pick<Location, "pathname" | "search" | "hash"> = location,
): string => loc.pathname + loc.search + loc.hash;
