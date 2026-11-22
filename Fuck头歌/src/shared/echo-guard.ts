/**
 * 忽略设置页自己写入产生的 storage 回显。
 *
 * chrome.storage.local.set 的 onChanged 事件可能晚于后一次 save 到达；
 * 只看 lastSaved 会把旧快照当成“外部修改”并 render()，导致滑块回跳。
 * 这里记录最近写入的 JSON 快照（2s 内视为自己），并懒清理过期项。
 */

export interface EchoGuard {
  mark(json: string): void;
  isEcho(json: string): boolean;
}

export function createEchoGuard(ttlMs = 2000, now: () => number = Date.now): EchoGuard {
  const recent = new Map<string, number>();
  const prune = (): void => {
    const t = now();
    for (const [key, at] of recent) {
      if (t - at > ttlMs) recent.delete(key);
    }
  };
  return {
    mark(json: string): void {
      prune();
      recent.set(json, now());
      if (recent.size > 20) {
        const oldest = recent.keys().next().value;
        if (typeof oldest === "string") recent.delete(oldest);
      }
    },
    isEcho(json: string): boolean {
      const at = recent.get(json);
      if (at === undefined) return false;
      if (now() - at > ttlMs) {
        recent.delete(json);
        return false;
      }
      return true;
    },
  };
}
