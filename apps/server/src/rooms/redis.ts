/** The slice of ioredis the room layer uses; tests inject an in-memory fake. */
export interface RoomRedis {
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<'OK' | null>;
  /** Overwrite an existing key only (never resurrects an expired room); null when it is gone. */
  set(key: string, value: string, ex: 'EX', seconds: number, xx: 'XX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

export const REDIS_TIMEOUT_MS = 2_000;

/** Redis failed, timed out or is not configured. Mapped to 503 `room_store_unavailable`. */
export class RoomStoreUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('room store unavailable');
    this.name = 'RoomStoreUnavailableError';
  }
}

/** Bounds a Redis call so a dead connection cannot hang a request. */
export async function bounded<T>(op: () => Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RoomStoreUnavailableError('timeout')), ms);
      }),
    ]);
  } catch (err) {
    if (err instanceof RoomStoreUnavailableError) throw err;
    throw new RoomStoreUnavailableError(err instanceof Error ? err.name : 'redis_error');
  } finally {
    clearTimeout(timer);
  }
}
