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

  const inject = () => {
    const root = document.head || document.documentElement;
    if (!root) { setTimeout(inject, 10); return; }
    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);
  };
  inject();
})();
