/**
 * 设置页保存队列：260ms 合并写入，关闭/隐藏页面前可立即 flush。
 * 抽成纯模块便于单测，避免只能靠 Edge 手工验证。
 */

import { runOnPageHide } from "./page-lifecycle";

export interface SaveQueue {
  /** 安排一次延迟保存；多次调用只保留最后一次 */
  schedule(): void;
  /** 有 pending 时立即执行并清掉定时器；返回是否真的保存了 */
  flush(): boolean;
  /** 取消 pending，不执行保存 */
  cancel(): void;
  pending(): boolean;
}

export function createSaveQueue(save: () => void, delay = 260): SaveQueue {
  let timer = 0;
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };
  const flush = (): boolean => {
    if (!timer) return false;
    cancel();
    save();
    return true;
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      save();
    }, delay);
  };
  return { schedule, flush, cancel, pending: () => timer !== 0 };
}

/** pagehide 时 flush 未落盘的保存；返回取消监听的函数。 */
export function flushOnPageHide(queue: SaveQueue, target: EventTarget = window): () => void {
  return runOnPageHide(() => queue.flush(), target);
}
