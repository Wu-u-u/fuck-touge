/**
 * 页面生命周期小工具：pagehide 时执行清理/落盘。
 * 带 bfcache 判断：persisted 的 pagehide 表示页面可能被复用，不执行一次性清理。
 */

export function runOnPageHide(task: () => void, target: EventTarget = window): () => void {
  const onHide = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) return;
    task();
  };
  target.addEventListener("pagehide", onHide);
  return () => target.removeEventListener("pagehide", onHide);
}
