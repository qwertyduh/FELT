import { createRequire } from 'node:module';
import cors from '@fastify/cors';
import { stdSerializers } from 'pino';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { Env } from './config/env';
import type { RedisLike } from './config/redis';
import { registerAuth } from './auth/plugin';
import { createRemoteKeySet, createVerifier, issuerFor, type KeySet } from './auth/verify';
import { isPlainObject, sanitizeLogObject, sanitizeValue } from './logging/sanitize';
import { registerHealth } from './http/health';
import { registerMe } from './http/me';
import { createDbFromEnv, type Db } from './db/supabase';
import { registerUsernameRoutes } from './usernames/routes';
import { attachRealtime, type Timers } from './realtime';
import { registerRoomRoutes } from './rooms/routes';
import type { RoomRedis } from './rooms/redis';
import type { RandomInt } from './rooms/code';

function hasPinoPretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export interface AppDeps {
  redis: RedisLike & Partial<RoomRedis>;
  /** Room-code RNG; tests inject a deterministic one. Defaults to crypto.randomInt. */
  randomInt?: RandomInt;
  /** Destination for log lines; tests use it to capture output. Disables the pretty transport. */
  logStream?: { write(msg: string): void };
  /** JWT key source; tests inject a local JWKS. Defaults to the remote, cached `SUPABASE_JWKS_URL`. */
  keySet?: KeySet;
  /**
   * Service-role database client. Omitted: built from `SUPABASE_SERVICE_ROLE_KEY` when set.
   * `null` (or no key): `/me` and the username routes answer 503 `db_unavailable`.
   */
  db?: Db | null;
  /** Clock/timer for socket token-expiry disconnects; tests inject fakes. */
  realtimeTimers?: Timers;
}

/**
 * No pino `redact` is used: its wildcard paths throw on Buffers nested in Fastify's error
 * payloads. `sanitizeLogObject` (via formatters.log and these serializers) handles secret keys,
 * including header names, at any depth.
 */
const LOG_ERROR_MARKER = { logSanitizeError: true };

/**
 * Error fields never logged. `rawPacket` (e.g. on ioredis/parser errors) carries raw request or
 * response bytes, which can include tokens; at trace level it would reach the logs.
 */
const DROPPED_ERROR_KEYS: ReadonlySet<string> = new Set(['rawPacket']);

/** Removes the keys at any depth of an already-sanitised (plain, acyclic, depth-capped) tree. */
function dropKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => dropKeys(v, keys));
  if (typeof value !== 'object' || value === null || !isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!keys.has(k)) out[k] = dropKeys(v, keys);
  return out;
}

export function errSerializer(e: unknown): unknown {
  try {
    const out: unknown = stdSerializers.err(e as Error);
    // Strings (`{ err: err.message }`), numbers, null etc. pass through verbatim.
    if (typeof out !== 'object' || out === null) return out;
    return dropKeys(sanitizeValue(out), DROPPED_ERROR_KEYS);
  } catch {
    return LOG_ERROR_MARKER;
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

/** Path only: query strings can carry tokens (`?access_token=`), so never log them. */
export function reqSerializer(req: unknown): unknown {
  try {
    const r = req as FastifyRequest;
    // Anything logged under `req` that is not a real request is sanitised and passed through.
    if (typeof r?.url !== 'string') return sanitizeValue(req);
    if (isPlainObject(r)) {
      const clean = sanitizeValue(req) as Record<string, unknown>;
      if (typeof clean.url === 'string') clean.url = stripQuery(clean.url);
      return clean;
    }
    return {
      method: r.method,
      url: stripQuery(r.url),
      host: r.host,
      remoteAddress: r.ip,
    };
  } catch {
    return LOG_ERROR_MARKER;
  }
}

/** Keys whose values pino hands to their own serializers (which sanitise); left raw here. */
const SERIALIZER_KEYS = ['req', 'res', 'err'];

/** `formatters.log`: sanitise everything except class instances owned by the req/res/err serializers. */
export function formatLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    const keep: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const owned =
        SERIALIZER_KEYS.includes(key) &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        !isPlainObject(value);
      (owned ? keep : rest)[key] = value;
    }
    return { ...sanitizeLogObject(rest), ...keep };
  } catch {
    return { ...LOG_ERROR_MARKER };
  }
}

function loggerOptions(
  env: Env,
  logStream?: AppDeps['logStream'],
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: env.LOG_LEVEL,
    formatters: { log: formatLogObject },
    serializers: {
      // Own enumerable fields on Errors (`token`, `nested.password`...) are sanitised too.
      err: errSerializer as never,
      // Path only: query strings can carry tokens (`?access_token=`), so never log them.
      req: reqSerializer as never,
    },
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
  const app = Fastify({
    logger: loggerOptions(env, deps.logStream),
    trustProxy: env.TRUST_PROXY,
  });

  await app.register(cors, { origin: env.WEB_ORIGIN });
  const verify = createVerifier({
    issuer: issuerFor(env.SUPABASE_URL),
    keySet: deps.keySet ?? createRemoteKeySet(env.SUPABASE_JWKS_URL),
  });
  app.decorate(
    'realtime',
    attachRealtime(app, {
      verify,
      origins: env.WEB_ORIGIN,
      ...(deps.realtimeTimers ? { timers: deps.realtimeTimers } : {}),
    }),
  );
  registerAuth(app, verify); // after CORS (preflight is answered first); default-deny from here on
  registerHealth(app, deps.redis);
  const db = deps.db !== undefined ? deps.db : createDbFromEnv(env);
  registerMe(app, db);
  await registerUsernameRoutes(app, db);
  registerRoomRoutes(app, {
    db,
    redis: deps.redis,
    webOrigin: env.WEB_ORIGIN,
    ...(deps.randomInt ? { randomInt: deps.randomInt } : {}),
  });

  // Fastify's default 404 handler logs the full URL (query string included); use the path only.
  // Same body shape as the default. Not-found handlers run unauthenticated: never return data here.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.replace(/\?.*$/s, '');
    request.log.info({ method: request.method, path }, 'route not found');
    return reply.code(404).send({
      message: `Route ${request.method}:${path} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });

  return app;
}
