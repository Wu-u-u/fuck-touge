/**
 * 桥接层延迟 revoke 的小工具。
 * 同一 key 只保留一个 timer；key 重新有效/被请求时可 cancel，
 * 避免“删除→5s 内重新添加/使用”时旧 timer 把新 URL revoke 掉。
 */
export class DelayedRevoker {
  private timers = new Map<string, number>();

  constructor(
    private readonly onFire: (key: string) => void,
    private readonly delayMs = 5000,
  ) {}

  schedule(key: string): void {
    if (this.timers.has(key)) return;
    const timer = window.setTimeout(() => {
      this.timers.delete(key);
      this.onFire(key);
    }, this.delayMs);
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  pending(key: string): boolean {
    return this.timers.has(key);
  }
}
