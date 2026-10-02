// ==UserScript==
// @name         允许粘贴（头歌 / 通用）
// @namespace    local.paste.unlock
// @version      1.3
// @description  拦截网页篡改剪贴板 + keydown 抢先 + 手动插入，解除禁止粘贴
// @match        *://*.educoder.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  "use strict";

  // 0) 阻止网页篡改剪贴板（头歌会在编辑器聚焦时写入一个空格覆盖你的剪贴板）
  try {
    const ncb = navigator.clipboard;
    if (ncb) {
      const origWriteText = ncb.writeText && ncb.writeText.bind(ncb);
      Object.defineProperty(ncb, "writeText", {
        configurable: true,
        writable: true,
        value(t) {
          const s = typeof t === "string" ? t : "";
          if (s.length <= 2 || s.trim() === "") {
            return Promise.reject(new DOMException("blocked by paste-unlock", "NotAllowedError"));
          }
          return origWriteText ? origWriteText(t) : Promise.resolve();
        },
      });
      Object.defineProperty(ncb, "write", {
        configurable: true,
        writable: true,
        value() {
          return Promise.reject(new DOMException("blocked by paste-unlock", "NotAllowedError"));
        },
      });
    }
  } catch (e) { /* 忽略 */ }

  const isEditable = el => el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);

  const insertText = t => {
    if (document.execCommand("insertText", false, t)) return;
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      el.setRangeText(t, s, e, "end");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: t }));
    }
  };

  // 1) 抢先接管 Ctrl+V，放行 Ctrl+C / Ctrl+X
  window.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key ? e.key.toLowerCase() : "";
    const code = e.keyCode || e.which || 0;
    if (k === "v" || code === 86) {
      e.stopImmediatePropagation();
      if (e.defaultPrevented) {
        e.preventDefault();
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(t => t && insertText(t)).catch(() => {});
        }
      }
    } else if (k === "c" || k === "x" || code === 67 || code === 88) {
      e.stopImmediatePropagation();
    }
  }, true);

  // 2) 粘贴内容由我们插入，绕过页面的 onDidPaste 删除逻辑
  window.addEventListener("paste", e => {
    if (!isEditable(document.activeElement)) return;
    const t = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (!t) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    insertText(t);
  }, true);
})();
