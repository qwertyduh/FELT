/**
 * `POST /recaps` (host, ended room) freezes a recap into `shared_recaps`; `GET /recaps/:slug` is
 * public. The table has no client policies: this server, with the service role, is its only reader
 * and writer, so a recap can be had only by its slug and only until it expires.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CreateRecapRequestSchema,
  RECAP_TTL_DAYS,
  RecapSlugSchema,
  SharedRecapSchema,
  type CreateRecapResponse,
  type SharedRecap,
  type SharedRecapResponse,
} from '@felt/protocol';
import { dbDeadline, type Db } from '../db/supabase';
import { DbUnavailableError } from '../usernames/service';
import { withDb } from '../usernames/routes';
import type { RoomRegistry } from '../rooms/roomRegistry';
import type { RoomRecord } from '../rooms/roomStore';
import { RoomStoreUnavailableError } from '../rooms/redis';
import { sharedRecap } from './sessionRecap';

export const CREATE_RECAP_LIMIT = { max: 5, timeWindow: '1 minute' } as const;
/** Per IP: nobody is signed in here. */
export const READ_RECAP_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

export const newRecapSlug = (): string => randomBytes(16).toString('base64url');

export interface RecapRouteDeps {
  db: Db | null;
  /** Null without Redis: sharing answers 503. */
  registry: RoomRegistry | null;
  now?: () => number;
}

/** Register after the rate-limit plugin (registerUsernameRoutes). */
export function registerRecapRoutes(app: FastifyInstance, deps: RecapRouteDeps): void {
  const now = deps.now ?? Date.now;

  app.post(
    '/recaps',
    { config: { rateLimit: CREATE_RECAP_LIMIT } },
    withDb(deps.db, async (db, request, reply) => {
      const unavailable = () =>
        reply.code(503).header('Retry-After', '5').send({ error: 'room_store_unavailable' });
      if (!deps.registry) return unavailable();
      const body = CreateRecapRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const { code, rate } = body.data;
      const { userId } = request.user;

      let room: Readonly<RoomRecord>;
      try {
        const actor = await deps.registry.get(code);
        if (!actor) return reply.code(404).send({ error: 'room_not_found' });
        // Read in turn with the room's changes; nothing is changed.
        room = await actor.enqueue((current) => ({ room: current, result: current }));
      } catch (err) {
        if (err instanceof RoomStoreUnavailableError) {
          request.log.warn({ reason: err.reason }, 'room store unavailable');
          return unavailable();
        }
        throw err;
      }
      if (room.hostId !== userId || !room.admitted.includes(userId)) {
        return reply.code(403).send({ error: 'not_host' });
      }
      if (room.status !== 'ended') return reply.code(409).send({ error: 'room_not_ended' });

      let payload: SharedRecap;
      try {
        payload = sharedRecap(room, rate);
      } catch (err) {
        if (err instanceof RangeError) return reply.code(422).send({ error: 'rate_too_large' });
        throw err;
      }
      if (payload.players.length === 0) return reply.code(409).send({ error: 'nothing_to_share' });

      const slug = newRecapSlug();
      const expiresAt = now() + RECAP_TTL_DAYS * 24 * 60 * 60_000;
      const { error } = await db
        .from('shared_recaps')
        .insert({
          id: slug,
          room_code: code,
          payload,
          created_by: userId,
          expires_at: new Date(expiresAt).toISOString(),
        })
        .retry(false)
        .abortSignal(dbDeadline());
      if (error) throw new DbUnavailableError(error.code || 'insert_failed');
      return reply.code(201).send({ slug, expiresAt } satisfies CreateRecapResponse);
    }),
  );

  app.get(
    '/recaps/:slug',
    // `warn`: the request log would put the slug, which is the key to the recap, into the logs.
    { config: { public: true, rateLimit: READ_RECAP_LIMIT }, logLevel: 'warn' },
    withDb(deps.db, async (db, request, reply) => {
      reply.header('Cache-Control', 'no-store');
      // One answer for malformed, unknown and expired.
      const notFound = () => reply.code(404).send({ error: 'recap_not_found' });
      const slug = RecapSlugSchema.safeParse((request.params as { slug?: unknown }).slug);
      if (!slug.success) return notFound();
      const { data, error } = await db
        .from('shared_recaps')
        .select('payload, expires_at')
        .eq('id', slug.data)
        // The purge runs hourly: expiry is decided here, not by whether the row is still there.
        .gt('expires_at', new Date(now()).toISOString())
        .retry(false)
        .abortSignal(dbDeadline())
        .maybeSingle();
      if (error) throw new DbUnavailableError(error.code || 'query_failed');
      if (!data) return notFound();
      const recap = SharedRecapSchema.safeParse(data.payload);
      const expiresAt = Date.parse(String(data.expires_at));
      if (!recap.success || !Number.isFinite(expiresAt)) {
        request.log.error('stored recap is invalid');
        return notFound();
      }
      return { recap: recap.data, expiresAt } satisfies SharedRecapResponse;
    }),
  );
}
