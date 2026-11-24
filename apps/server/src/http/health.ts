import type { FastifyInstance } from 'fastify';
import type { RedisLike } from '../config/redis';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  redis: 'ok' | 'down';
}

export const REDIS_PING_TIMEOUT_MS = 500;

async function redisIsUp(redis: RedisLike): Promise<boolean> {
  // Fail fast without queueing a command while the client knows it is disconnected.
  if (redis.status !== undefined && redis.status !== 'ready') return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), REDIS_PING_TIMEOUT_MS);
      }),
    ]);
    return reply === 'PONG';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness probe: always 200; `status` is "degraded" when Redis is unreachable. */
export function registerHealth(app: FastifyInstance, redis: RedisLike): void {
  app.get('/health', async (): Promise<HealthResponse> => {
    const up = await redisIsUp(redis);
    return { status: up ? 'ok' : 'degraded', uptime: process.uptime(), redis: up ? 'ok' : 'down' };
  });
}
