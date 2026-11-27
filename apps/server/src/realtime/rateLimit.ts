/** Token bucket with an injectable clock. Pure; one instance per socket. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  /** True if the event is allowed (and consumes a token). */
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Give back a token taken for something that turned out not to count. */
  refund(): void {
    this.tokens = Math.min(this.burst, this.tokens + 1);
  }
}

const MAX_IDLE_BUCKETS = 1000;

/**
 * One bucket per key (userId): a limit across all of a user's sockets, which the per-socket bucket
 * (reset by reconnecting) cannot give. Fully refilled buckets are dropped once the map is large.
 */
export class KeyedLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; used: number }>();
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    if (this.buckets.size >= MAX_IDLE_BUCKETS) {
      const refillMs = (this.burst / this.ratePerSec) * 1000;
      for (const [id, b] of this.buckets) if (now - b.used >= refillMs) this.buckets.delete(id);
    }
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.ratePerSec, this.burst, this.now), used: now };
      this.buckets.set(key, entry);
    }
    entry.used = now;
    return entry.bucket.take();
  }

  refund(key: string): void {
    this.buckets.get(key)?.bucket.refund();
  }
}
