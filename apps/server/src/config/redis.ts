import { Redis } from 'ioredis';

export interface RedisLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/** The slice of the Redis client the HTTP layer depends on; tests can fake it. */
export interface RedisLike {
  ping(): Promise<unknown>;
  /** ioredis connection state. When present, anything other than 'ready' counts as down. */
  readonly status?: string;
}

/** Exponential backoff: 200ms, 400ms ... capped at 5s. Retries forever. */
export function retryDelay(attempt: number): number {
  return Math.min(200 * 2 ** (attempt - 1), 5000);
}

/**
 * Create the Redis client. It does not connect until `connectRedis` is called.
 * Connection errors are logged, never thrown, so a Redis outage cannot crash the process.
 */
export function createRedis(url: string, log?: RedisLogger): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    retryStrategy: retryDelay,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  let lastError = '';
  redis.on('error', (err: Error) => {
    // Log only on change, so an outage doesn't flood the log on every retry.
    if (err.message !== lastError) {
      lastError = err.message;
      log?.warn({ err: err.message }, 'redis error');
    }
  });
  redis.on('ready', () => {
    lastError = '';
    log?.info({}, 'redis ready');
  });
  return redis;
}

/** Start connecting in the background. Never rejects. */
export function connectRedis(redis: Redis): void {
  redis.connect().catch(() => {
    // already reported through the 'error' event; retryStrategy keeps trying
  });
}

/** Gracefully close; falls back to a hard disconnect if QUIT fails or hangs. */
export async function closeRedis(redis: Redis, timeoutMs = 1000): Promise<void> {
  if (redis.status === 'end') return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      redis.quit(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('quit timeout')), timeoutMs);
      }),
    ]);
  } catch {
    redis.disconnect();
  } finally {
    clearTimeout(timer);
  }
}
