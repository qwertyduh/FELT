import { createRequire } from 'node:module';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Env } from './config/env';
import { registerHealth } from './http/health';

function hasPinoPretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function loggerOptions(env: Env): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    // pretty output only in development (optional dependency); JSON everywhere else
    ...(env.NODE_ENV === 'development' && hasPinoPretty()
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  };
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions(env) });

  await app.register(cors, { origin: env.WEB_ORIGIN });
  registerHealth(app);

  return app;
}
