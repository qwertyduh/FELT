import { DB_TIMEOUT_MS, dbDeadline, type Db } from '../db/supabase';
import { DbUnavailableError } from './service';

export type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'username_taken' }
  | { kind: 'username_already_set' }
  | { kind: 'user_missing' }
  | { kind: 'format' };

interface PgError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * Names of the real constraints (checked against the migration):
 *   profiles_pkey            primary key on id        -> the user already has a username
 *   profiles_username_key    unique on username       -> somebody else has the name
 *   profiles_username_format check on username        -> defence in depth
 * PostgREST puts the constraint in `message` and the column in `details`
 * ("Key (username)=(bob) already exists."); either identifies it.
 */
export function classifyInsertError(error: PgError): ClaimOutcome {
  // Classify on the constraint name in `message` ONLY. `details` echoes the user's value
  // ("Key (username)=(profiles_pkey) already exists."), so it must never be pattern-matched
  // loosely; the anchored fallback below is only for a message without the constraint name.
  const message = error.message ?? '';
  const details = error.details ?? '';
  switch (error.code) {
    case '23505':
      if (/unique constraint "profiles_pkey"/.test(message))
        return { kind: 'username_already_set' };
      if (/unique constraint "profiles_username_key"/.test(message))
        return { kind: 'username_taken' };
      if (!/unique constraint "/.test(message)) {
        if (/^Key \(id\)=/.test(details)) return { kind: 'username_already_set' };
        if (/^Key \(username\)=/.test(details)) return { kind: 'username_taken' };
      }
      throw new DbUnavailableError('23505_unknown_constraint');
    case '23503':
      return { kind: 'user_missing' };
    case '23514':
      return { kind: 'format' };
    default:
      throw new DbUnavailableError(error.code || 'insert_failed');
  }
}

/** INSERT with the service role. The unique index is the final arbiter of the race. */
export async function claimUsername(db: Db, userId: string, name: string): Promise<ClaimOutcome> {
  const { error } = await db
    .from('profiles')
    .insert({ id: userId, username: name })
    .retry(false)
    .abortSignal(dbDeadline());
  if (error) return classifyInsertError(error);
  return { kind: 'claimed' };
}

/** The claimed username, or null when the user has no profile row. */
export async function findUsername(db: Db, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from('profiles')
    .select('username')
    .eq('id', userId)
    .retry(false)
    .abortSignal(dbDeadline())
    .maybeSingle();
  if (error) throw new DbUnavailableError(error.code || 'query_failed');
  return typeof data?.username === 'string' ? data.username : null;
}

/** True when the auth user is gone (deleted) although its JWT is still valid. */
export async function authUserMissing(db: Db, userId: string): Promise<boolean> {
  // Bounded twice: the client's per-fetch timeout and this race (auth-js has no abort option).
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new DbUnavailableError('auth_lookup_timeout')), DB_TIMEOUT_MS).unref(),
  );
  const { data, error } = await Promise.race([db.auth.admin.getUserById(userId), deadline]);
  if (error) {
    if (error.status === 404 || error.code === 'user_not_found') return true;
    throw new DbUnavailableError(error.code || 'auth_lookup_failed');
  }
  return !data.user;
}
