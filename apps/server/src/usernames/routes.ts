import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Db } from '../db/supabase';
import { claimUsername } from './claim';
import {
  checkUsername,
  DbUnavailableError,
  MAX_RAW_USERNAME_LENGTH,
  USERNAME_MESSAGES,
  validateUsername,
} from './service';

export const CHECK_LIMIT = { max: 30, timeWindow: '1 minute' } as const;
export const CLAIM_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

const ClaimBodySchema = z.object({ username: z.string() }).strict();

export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer')
    .send({ error: 'unauthorized', code: 'invalid' });
}

/** 503 for a missing key (`db === null`) or a failing database. Never leaks the reason. */
export function dbUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: string,
): FastifyReply {
  request.log.warn({ reason }, 'db unavailable');
  return reply.code(503).header('Retry-After', '5').send({ error: 'db_unavailable' });
}

/**
 * Runs a handler with the DB; maps a missing client and DbUnavailableError to 503. Anything else
 * propagates to Fastify's error handler (500).
 */
export function withDb(
  db: Db | null,
  handler: (db: Db, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (!db) return dbUnavailable(request, reply, 'no_service_key');
    try {
      return await handler(db, request, reply);
    } catch (err) {
      if (err instanceof DbUnavailableError) return dbUnavailable(request, reply, err.reason);
      throw err;
    }
  };
}

export async function registerUsernameRoutes(app: FastifyInstance, db: Db | null): Promise<void> {
  // In-memory store: one server instance in v1. Per-route limits (`global: false`).
  await app.register(rateLimit, {
    global: false,
    // Runs after the auth hook, so `request.user` is set; the IP is only a safety net.
    keyGenerator: (request) => request.user?.userId ?? request.ip,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'rate_limited',
      retryAfterSeconds: Math.ceil(context.ttl / 1000),
    }),
  });

  app.get(
    '/usernames/check',
    { config: { rateLimit: CHECK_LIMIT } },
    withDb(db, async (db, request, reply) => {
      const { u } = request.query as { u?: unknown };
      if (typeof u !== 'string' || u.length > MAX_RAW_USERNAME_LENGTH) {
        return reply.code(400).send({ error: 'invalid_query' });
      }
      return checkUsername(db, u);
    }),
  );

  app.post(
    '/me/username',
    { config: { rateLimit: CLAIM_LIMIT } },
    withDb(db, async (db, request, reply) => {
      const body = ClaimBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      // Steps 1-4 here. Uniqueness is NOT pre-checked: the unique index decides (409), so a
      // sequential loser and a racing loser get the same answer.
      const local = validateUsername(body.data.username);
      if (!local.ok) {
        return reply.code(422).send({
          error: 'invalid_username',
          reason: local.result.reason,
          message: local.result.message,
        });
      }

      const outcome = await claimUsername(db, request.user.userId, local.name);
      switch (outcome.kind) {
        case 'claimed':
          return reply.code(201).send({ username: local.name });
        case 'username_taken':
          return reply
            .code(409)
            .send({ error: 'username_taken', message: USERNAME_MESSAGES.taken });
        case 'username_already_set':
          return reply.code(409).send({ error: 'username_already_set' });
        case 'user_missing':
          return unauthorized(reply);
        case 'format':
          return reply.code(422).send({
            error: 'invalid_username',
            reason: 'format',
            message: 'Username format is invalid.',
          });
      }
    }),
  );
}
