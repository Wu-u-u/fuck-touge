/** 设置页媒体加载的一次性重试队列（同 key 只重试一次，成功/取消后重置）。 */
export class MediaRetryQueue {
  private timers = new Map<string, number>();
  private attempts = new Map<string, number>();

  constructor(
    private readonly maxAttempts = 1,
    private readonly delayMs = 3000,
  ) {}

  schedule(key: string, task: () => void): boolean {
    if (this.timers.has(key)) return false;
    const attempts = this.attempts.get(key) || 0;
    if (attempts >= this.maxAttempts) return false;
    this.attempts.set(key, attempts + 1);
    const timer = window.setTimeout(() => {
      this.timers.delete(key);
      task();
    }, this.delayMs);
    this.timers.set(key, timer);
    return true;
  }

  clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.attempts.delete(key);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.attempts.clear();
  }

  /** 只保留仍存在的 mediaKey；用于配置从其他上下文变化后的清理。 */
  retain(validKeys: ReadonlySet<string>): void {
    for (const key of [...this.timers.keys()]) {
      if (!validKeys.has(key)) this.clear(key);
    }
    for (const key of [...this.attempts.keys()]) {
      if (!validKeys.has(key)) this.attempts.delete(key);
    }
  }

  pending(key: string): boolean {
    return this.timers.has(key);
  }
}
