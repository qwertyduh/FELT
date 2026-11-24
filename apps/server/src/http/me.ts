import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/supabase';
import { authUserMissing, findUsername } from '../usernames/claim';
import { unauthorized, withDb } from '../usernames/routes';

export interface MeResponse {
  userId: string;
  isAnonymous: boolean;
  username: string | null;
}

/**
 * Authenticated (default-deny). A JWT stays valid after the user is deleted, so `sub` alone is
 * not trusted: with no profile row, the auth user must still exist, else 401.
 */
export function registerMe(app: FastifyInstance, db: Db | null): void {
  app.get(
    '/me',
    withDb(db, async (db, request, reply): Promise<MeResponse | unknown> => {
      const { userId, isAnonymous } = request.user;
      const username = await findUsername(db, userId);
      if (username === null && (await authUserMissing(db, userId))) return unauthorized(reply);
      return { userId, isAnonymous, username };
    }),
  );
}
