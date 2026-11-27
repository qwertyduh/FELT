import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  RoomCodeSchema,
  RoomPreviewSchema,
  RoomSettingsSchema,
  type RoomPreview,
} from '@felt/protocol';
import type { Db } from '../db/supabase';
import { findUsername } from '../usernames/claim';
import { DbUnavailableError } from '../usernames/service';
import { dbUnavailable } from '../usernames/routes';
import { RoomStore, RoomStoreUnavailableError, type RoomRecord } from './roomStore';
import type { RoomRedis } from './redis';
import type { RandomInt } from './code';

export const CREATE_ROOM_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
export const PREVIEW_ROOM_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

export interface RoomRouteDeps {
  db: Db | null;
  /** Absent (or not a full client) -> every room route answers 503. */
  redis: Partial<RoomRedis> | undefined;
  webOrigin: readonly string[];
  randomInt?: RandomInt;
}

const REQUIRED: (keyof RoomRedis)[] = [
  'set',
  'get',
  'eval',
  'del',
  'expire',
  'exists',
  'sadd',
  'srem',
  'smembers',
];

function storeUnavailable(request: FastifyRequest, reply: FastifyReply, reason: string) {
  request.log.warn({ reason }, 'room store unavailable');
  return reply.code(503).header('Retry-After', '5').send({ error: 'room_store_unavailable' });
}

export function toPreview(r: RoomRecord): RoomPreview {
  return {
    code: r.code,
    mode: r.settings.mode,
    hostUsername: r.hostUsername,
    smallBlind: r.settings.smallBlind,
    bigBlind: r.settings.bigBlind,
    minBuyIn: r.settings.minBuyIn,
    maxBuyIn: r.settings.maxBuyIn,
    seatsTaken: r.seats.length,
    maxSeats: r.settings.maxSeats,
    status: r.status,
  };
}

/** Same body for malformed and unknown codes: no enumeration hints. */
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'room_not_found' });

export function registerRoomRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const redis = deps.redis;
  const store =
    redis && REQUIRED.every((m) => typeof redis[m] === 'function')
      ? new RoomStore(redis as RoomRedis, {
          log: app.log,
          ...(deps.randomInt ? { randomInt: deps.randomInt } : {}),
        })
      : null;
  const origin = deps.webOrigin[0] ?? '';

  // Rate-limit plugin is registered by registerUsernameRoutes (same instance, keyed per user).
  app.post('/rooms', { config: { rateLimit: CREATE_ROOM_LIMIT } }, async (request, reply) => {
    if (!store) return storeUnavailable(request, reply, 'no_redis');
    if (!deps.db) return dbUnavailable(request, reply, 'no_service_key');
    const body = RoomSettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        error: 'invalid_settings',
        issues: body.error.issues.slice(0, 5).map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    try {
      const username = await findUsername(deps.db, request.user.userId);
      if (username === null) return reply.code(403).send({ error: 'username_required' });
      const out = await store.create(body.data, { id: request.user.userId, username });
      if (out.kind === 'too_many_rooms') {
        return reply.code(429).header('Retry-After', '60').send({ error: 'too_many_rooms' });
      }
      if (out.kind === 'code_exhausted') {
        return reply.code(503).header('Retry-After', '5').send({ error: 'code_exhausted' });
      }
      const code = out.record.code;
      return reply.code(201).send({ code, url: `${origin}/r/${code}` });
    } catch (err) {
      if (err instanceof DbUnavailableError) return dbUnavailable(request, reply, err.reason);
      if (err instanceof RoomStoreUnavailableError) {
        return storeUnavailable(request, reply, err.reason);
      }
      throw err;
    }
  });

  app.get('/rooms/:code', { config: { rateLimit: PREVIEW_ROOM_LIMIT } }, async (request, reply) => {
    if (!store) return storeUnavailable(request, reply, 'no_redis');
    const parsed = RoomCodeSchema.safeParse((request.params as { code?: unknown }).code);
    if (!parsed.success) return notFound(reply);
    try {
      const record = await store.get(parsed.data);
      if (!record) return notFound(reply);
      return RoomPreviewSchema.parse(toPreview(record));
    } catch (err) {
      if (err instanceof RoomStoreUnavailableError) {
        return storeUnavailable(request, reply, err.reason);
      }
      throw err;
    }
  });
}
