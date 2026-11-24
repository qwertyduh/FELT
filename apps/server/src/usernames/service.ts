import {
  UsernameSchema,
  USERNAME_ERRORS,
  isReservedUsername,
  type UsernameCheckResult,
} from '@felt/protocol';
import { dbDeadline, type Db } from '../db/supabase';
import { isProfane } from './profanity';

/** Raw input longer than this is rejected before any normalisation work (also the route cap). */
export const MAX_RAW_USERNAME_LENGTH = 64;

export const USERNAME_MESSAGES = {
  profane: "That username isn't allowed. Please choose another.",
  taken: 'That username is already taken.',
} as const;

/** The database could not be reached or answered with an unexpected error. */
export class DbUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('db unavailable');
    this.name = 'DbUnavailableError';
  }
}

export type LocalCheck =
  | { ok: true; name: string }
  | { ok: false; result: Extract<UsernameCheckResult, { available: false }> };

/** Pipeline steps 1-4 (normalise, format, reserved, profane). Pure: no database. */
export function validateUsername(raw: string): LocalCheck {
  if (raw.length > MAX_RAW_USERNAME_LENGTH) {
    return fail('format', USERNAME_ERRORS.tooLong);
  }
  const parsed = UsernameSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('format', parsed.error.issues[0]?.message ?? USERNAME_ERRORS.invalidChars);
  }
  const name: string = parsed.data;
  if (isReservedUsername(name)) return fail('reserved', USERNAME_ERRORS.reserved);
  if (isProfane(name)) return fail('profane', USERNAME_MESSAGES.profane);
  return { ok: true, name };
}

function fail(reason: 'format' | 'reserved' | 'profane' | 'taken', message: string): LocalCheck {
  return { ok: false, result: { available: false, reason, message } };
}

/** Step 5: case-insensitive (citext) lookup on the normalised name. Throws DbUnavailableError. */
export async function isUsernameTaken(db: Db, name: string): Promise<boolean> {
  const { data, error } = await db
    .from('profiles')
    .select('id')
    .eq('username', name)
    .limit(1)
    .retry(false)
    .abortSignal(dbDeadline());
  if (error) throw new DbUnavailableError(error.code || 'query_failed');
  return (data?.length ?? 0) > 0;
}

/** The full pipeline for `GET /usernames/check`. */
export async function checkUsername(db: Db, raw: string): Promise<UsernameCheckResult> {
  const local = validateUsername(raw);
  if (!local.ok) return local.result;
  if (await isUsernameTaken(db, local.name)) {
    return { available: false, reason: 'taken', message: USERNAME_MESSAGES.taken };
  }
  return { available: true };
}
