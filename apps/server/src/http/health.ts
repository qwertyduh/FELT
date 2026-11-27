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

export interface ReadyResponse {
  status: 'ready' | 'not_ready';
  redis: 'ok' | 'down';
  db: 'ok' | 'missing';
}

/**
 * `/health`, liveness: always 200; `status` is "degraded" when Redis is unreachable.
 * `/ready`, readiness (the deploy health check): 503 while the server cannot do its job, so a
 * broken deploy never replaces a working one. `dbMissing`: a required database client is absent.
 */
export function registerHealth(
  app: FastifyInstance,
  redis: RedisLike,
  opts: { dbMissing?: boolean } = {},
): void {
  app.get('/health', { config: { public: true } }, async (): Promise<HealthResponse> => {
    const up = await redisIsUp(redis);
    return { status: up ? 'ok' : 'degraded', uptime: process.uptime(), redis: up ? 'ok' : 'down' };
  });
  app.get('/ready', { config: { public: true } }, async (_request, reply) => {
    const up = await redisIsUp(redis);
    const ready = up && !opts.dbMissing;
    const body: ReadyResponse = {
      status: ready ? 'ready' : 'not_ready',
      redis: up ? 'ok' : 'down',
      db: opts.dbMissing ? 'missing' : 'ok',
    };
    return reply.code(ready ? 200 : 503).send(body);
  });
}
