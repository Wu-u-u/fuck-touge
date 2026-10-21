/**
 * 剪贴板守卫：拦截平台的“篡改写入”（全空白 / 零宽 / 空 ClipboardItem），
 * 正常文本、富文本与图片一律放行；被拦时静默 resolve，避免页面出现 unhandledrejection。
 *
 * 依赖显式传入（默认取浏览器全局），便于单测；行为与原先 main.ts 内的实现一致。
 */

export type ClipboardFn = (...args: any[]) => Promise<void>;

export interface ClipboardTarget {
  writeText?: ClipboardFn;
  write?: ClipboardFn;
}

export interface PatchableClipboard extends ClipboardTarget {
  __ftWriteTextPatched?: boolean;
  __ftWritePatched?: boolean;
}

export interface ClipboardGuardDeps {
  /** 传 null 表示不处理实例；不传则使用 navigator.clipboard */
  clipboard?: PatchableClipboard | null;
  /** 传 null 表示不处理原型；不传则使用 window.Clipboard.prototype */
  clipboardPrototype?: PatchableClipboard | null;
}

/** 全空白/零宽/空串 → true（清空剪贴板也算篡改） */
export const isBlankText = (t: unknown): boolean => {
  const s = String(t == null ? "" : t);
  // Cf = 零宽/方向控制/软连字符等格式字符；Zs = 各类空格；\s 兜底
  return !s.replace(/[\p{Cf}\p{Zs}\s]/gu, "").length;
};

/**
 * ClipboardItem 是否有可放行的内容：
 * 空白 text/plain 但同一 item 还带 image/png 等非文本类型时，放行整次写入；纯空白文本仍然拦。
 */
export const itemHasContent = (it: any): Promise<boolean> => {
  try {
    if (it && typeof it.text === "string") {
      return Promise.resolve(!isBlankText(it.text)); // 测试替身/旧式对象
    }
    if (it && typeof it.getType === "function" && it.types) {
      const types = [...it.types]
        .map((t: unknown) => String(t).split(";")[0].trim().toLowerCase())
        .filter(Boolean);
      if (!types.length) return Promise.resolve(false); // 空 ClipboardItem
      if (types.some((t: string) => !t.startsWith("text/"))) return Promise.resolve(true); // 图片等非文本 → 放行
      const textType = types.includes("text/plain")
        ? "text/plain"
        : types.includes("text/html")
          ? "text/html"
          : "";
      if (!textType) return Promise.resolve(true); // 其它类型 → 放行
      return it
        .getType(textType)
        .then((b: any) => b.text())
        .then((t: string) => !isBlankText(t))
        .catch(() => false);
    }
  } catch (e) {}
  return Promise.resolve(false);
};

export const allowWrite = (items: unknown): Promise<boolean> => {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return Promise.resolve(false);
  return Promise.all(list.map(itemHasContent)).then((oks) => oks.some(Boolean));
};

// 原型补丁：页面绕过实例直接用 Clipboard.prototype.writeText / write 时也拦得住。
const patchPrototype = (proto: PatchableClipboard | null | undefined): void => {
  if (!proto) return;
  if (typeof proto.writeText === "function" && !proto.__ftWriteTextPatched) {
    const pOrig = proto.writeText;
    Object.defineProperty(proto, "writeText", {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: any[]) {
        if (isBlankText(args[0])) return Promise.resolve();
        return pOrig.apply(this, args);
      },
    });
    try {
      proto.__ftWriteTextPatched = true;
    } catch (e) {}
  }
  if (typeof proto.write === "function" && !proto.__ftWritePatched) {
    const pWrite = proto.write;
    Object.defineProperty(proto, "write", {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: any[]) {
        return allowWrite(args[0]).then((ok) => (ok ? pWrite.apply(this, args) : undefined));
      },
    });
    try {
      proto.__ftWritePatched = true;
    } catch (e) {}
  }
};

/**
 * 安装剪贴板守卫。
 * 不传 deps 时与原先行为完全一致：实例 patch navigator.clipboard，原型 patch window.Clipboard.prototype；
 * 原型补丁放在实例判断之外（navigator.clipboard 缺失时也要装）。
 */
export function installClipboardGuard(deps: ClipboardGuardDeps = {}): void {
  try {
    const cb =
      deps.clipboard !== undefined
        ? deps.clipboard
        : (() => {
            try {
              return (navigator as any).clipboard || null;
            } catch (e) {
              return null;
            }
          })();

    if (cb) {
      let origWriteText: ClipboardFn | null = null;
      try {
        origWriteText = cb.writeText?.bind(cb) ?? null;
      } catch (e) {}
      try {
        if (origWriteText) {
          Object.defineProperty(cb, "writeText", {
            configurable: true,
            writable: true,
            value: (...args: any[]) =>
              isBlankText(args[0]) ? Promise.resolve() : origWriteText!.apply(cb, args),
          });
        }
      } catch (e) {}
      try {
        if (typeof cb.write === "function") {
          const write = cb.write.bind(cb);
          Object.defineProperty(cb, "write", {
            configurable: true,
            writable: true,
            value: (...args: any[]) =>
              allowWrite(args[0]).then((ok) => (ok ? write.apply(cb, args) : undefined)),
          });
        }
      } catch (e) {}
    }

    const proto =
      deps.clipboardPrototype !== undefined
        ? deps.clipboardPrototype
        : (() => {
            try {
              return (window as any).Clipboard?.prototype || null;
            } catch (e) {
              return null;
            }
          })();
    patchPrototype(proto);
  } catch (e) {}
}
