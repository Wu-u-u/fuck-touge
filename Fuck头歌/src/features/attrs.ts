/**
 * 清理属性式拦截：只清 onpaste / oncopy / oncut。
 * 不动 ondrop / oncontextmenu（平台用它们实现正常的拖放上传与右键菜单）。
 *
 * 策略：启动清一次 + MutationObserver 增量跟进；这三个都是事件处理 IDL 属性，
 * 无论页面写标记还是 el.onpaste=fn 赋值，都体现为属性变更，观察得到。
 */

import { $$ } from "../shared/dom";

export const PASTE_ATTRS = ["onpaste", "oncopy", "oncut"] as const;
export const PASTE_ATTR_SELECTOR = PASTE_ATTRS.map((a) => `[${a}]`).join(",");

/**
 * 清掉 root 及其子树上的三个拦截属性。
 * 与现有实现一致：同时把 document / body 上的 IDL 属性置空。
 */
export function stripAttrs(root?: ParentNode | null): void {
  [document, document.body].forEach(
    (el) => el && PASTE_ATTRS.forEach((a) => { (el as any)[a] = null; }),
  );
  const el = root as Element | null | undefined;
  if (el && el.nodeType === 1) {
    PASTE_ATTRS.forEach((a) => {
      try {
        el.removeAttribute(a);
      } catch (e) {}
    });
  }
  $$(PASTE_ATTR_SELECTOR, root || document).forEach((node) =>
    PASTE_ATTRS.forEach((a) => {
      try {
        node.removeAttribute(a);
      } catch (e) {}
    }),
  );
}

/** 安装属性清理器：启动清一次 + 监听新增节点/属性变更。 */
export function installAttrCleaner(): void {
  try {
    new MutationObserver((muts) =>
      muts.forEach((m) => {
        if (m.type === "attributes") {
          // 新挂上的拦截属性 → 立即摘除
          const el = m.target as Element;
          if (el && (PASTE_ATTRS as readonly string[]).includes(m.attributeName || "")) {
            el.removeAttribute(m.attributeName as string);
          }
        } else {
          m.addedNodes?.forEach((n) => {
            if (n.nodeType === 1) stripAttrs(n as Element);
          });
        }
      }),
    ).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...PASTE_ATTRS],
    });
  } catch (e) {}
  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", () => stripAttrs(document))
    : stripAttrs(document);
}
