/**
 * 顶部轻提示：固定居中小黑条，2.6s 后淡出，再 600ms 移除。
 * 与现有实现保持一致（创建/移除方式、样式、时序均不变）。
 */
export function toast(msg: string): void {
  try {
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText =
      "position:fixed;top:26px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "padding:10px 18px;border-radius:10px;background:rgba(17,17,17,.86);color:#fff;" +
      "font-size:18px;line-height:1;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
      "transition:opacity .5s;";
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 600);
    }, 2600);
  } catch (e) {}
}
