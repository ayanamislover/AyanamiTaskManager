// 令牌桶限流与长轮询名额。全在内存里：中继是单进程，重启清零无所谓。

type Bucket = { tokens: number; updatedAt: number };

/** 桶数量上限。超过就清掉已经回满的桶；来源地址被伪造成海量不同值时也撑不爆内存。 */
const MAX_BUCKETS = 10_000;

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 取一个令牌。成功返回 0，否则返回需要等待的秒数（向上取整，至少 1）。 */
  take(key: string): number {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_BUCKETS) this.sweep(now);
      bucket = { tokens: this.ratePerSecond, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(this.ratePerSecond, bucket.tokens + elapsed * this.ratePerSecond);
      bucket.updatedAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.ratePerSecond));
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.ratePerSecond;
      if (refilled >= this.ratePerSecond) this.buckets.delete(key);
    }
    // 全部都在活跃用：最旧的先走。Map 按插入顺序迭代。
    while (this.buckets.size >= MAX_BUCKETS) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }
}

/** 长轮询名额：每枚 token 与全局各有上限。acquire 成功后必须 release 恰好一次。 */
export class WaiterGate {
  private global = 0;
  private readonly perToken = new Map<string, number>();

  constructor(
    private readonly maxPerToken: number,
    private readonly maxGlobal: number,
  ) {}

  acquire(tokenId: string): boolean {
    const mine = this.perToken.get(tokenId) ?? 0;
    if (mine >= this.maxPerToken || this.global >= this.maxGlobal) return false;
    this.perToken.set(tokenId, mine + 1);
    this.global++;
    return true;
  }

  release(tokenId: string): void {
    const mine = this.perToken.get(tokenId) ?? 0;
    if (mine <= 1) this.perToken.delete(tokenId);
    else this.perToken.set(tokenId, mine - 1);
    this.global = Math.max(0, this.global - 1);
  }

  get active(): number {
    return this.global;
  }
}
