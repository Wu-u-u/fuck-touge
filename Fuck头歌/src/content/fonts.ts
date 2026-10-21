// @ts-nocheck
// 把内置的 Maple Mono 字体注入页面（在隔离世界运行，可使用扩展资源）
// 内置版只覆盖英文/代码符号；中文想替换请自行安装 “Maple Mono NF CN” 字体
// 字体栈优先用本机安装的字体；没有则用内置的 “Maple Mono Web”
(() => {
  const base = chrome.runtime.getURL("fonts/");
  const css = [
    ["MapleMono-Regular.woff2", 400, "normal"],
    ["MapleMono-Bold.woff2", 700, "normal"],
    ["MapleMono-Italic.woff2", 400, "italic"],
  ].map(([file, weight, style]) =>
    `@font-face{font-family:"Maple Mono Web";font-style:${style};font-weight:${weight};` +
    `font-display:swap;src:url("${base}${file}") format("woff2");}`
  ).join("");

  const style = document.createElement("style");
  style.textContent = css;

  // document_start 时 <head> 可能还没出现：等它出现再挂到 head（MutationObserver，另设超时上限），
  // 上限内没等到再退回 documentElement —— 样式只在本脚本内挂这一次，避免重复
  let attached = false;
  const attach = root => {
    if (attached || !root) return false;
    try { root.appendChild(style); attached = true; } catch (e) {}
    return attached;
  };
  const HEAD_WAIT_MS = 5000;
  const inject = () => {
    if (attach(document.head)) return;
    let mo = null;
    const cap = setTimeout(() => {
      try { mo?.disconnect(); } catch (e) {}
      attach(document.documentElement);
    }, HEAD_WAIT_MS);
    try {
      mo = new MutationObserver(() => {
        if (!document.head) return;
        clearTimeout(cap);
        try { mo.disconnect(); } catch (e) {}
        attach(document.head);
      });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) {
      clearTimeout(cap);
      attach(document.documentElement);
    }
  };
  inject();
})();
