import { createRequire } from 'node:module';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Env } from './config/env';
import type { RedisLike } from './config/redis';
import { registerHealth } from './http/health';

function hasPinoPretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Fastify's default `req` serializer omits headers, so these paths are a safety net for any
 * object that does get logged with headers (e.g. `log.info({ req: { headers } })`, custom serializers).
 * pino wildcards match exactly one level, hence the explicit variants.
 */
export const REDACT_PATHS = [
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.*.headers.authorization',
  '*.*.headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.headers["set-cookie"]',
  'headers["set-cookie"]',
];

export interface AppDeps {
  redis: RedisLike;
  /** Destination for log lines; tests use it to capture output. Disables the pretty transport. */
  logStream?: { write(msg: string): void };
}

function loggerOptions(
  env: Env,
  logStream?: AppDeps['logStream'],
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    ...(logStream ? { stream: logStream } : {}),
    // pretty output only in development (optional dependency); JSON everywhere else
    ...(!logStream && env.NODE_ENV === 'development' && hasPinoPretty()
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

export async function buildApp(env: Env, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions(env, deps.logStream) });

  await app.register(cors, { origin: env.WEB_ORIGIN });
  registerHealth(app, deps.redis);

  return app;
}
