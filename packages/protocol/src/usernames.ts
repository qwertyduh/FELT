import { z } from 'zod';

/**
 * Username rules shared by the web client (instant feedback) and the server
 * (authoritative check). Pipeline, see docs/ARCHITECTURE.md section 6:
 *   1. normalise  (normalizeUsername)
 *   2. format     (UsernameSchema / USERNAME_PATTERN)
 *   3. reserved   (isReservedUsername)
 *   4. profanity  (server only)
 *   5. uniqueness (server only)
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/**
 * Must match the database constraint exactly:
 * supabase/migrations/20260101000000_profiles.sql  (profiles.username check,
 * `username ~ '^[A-Za-z0-9_]{3,20}$'`). This package cannot read files, so
 * there is no automated parity test: change both together.
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** Characters allowed anywhere in a username (used to pick the error message). */
const USERNAME_CHARS = /^[A-Za-z0-9_]*$/;

/**
 * Step 1 of the username pipeline: Unicode NFKC normalisation, then trim.
 * NFKC folds compatibility forms (e.g. fullwidth "ａｂｃ" becomes "abc"), so
 * such input is accepted as its ASCII equivalent. Zero-width characters are
 * NOT stripped and will fail the format check.
 */
export function normalizeUsername(raw: string): string {
  return raw.normalize('NFKC').trim();
}

export const USERNAME_ERRORS = {
  tooShort: `Username must be at least ${USERNAME_MIN} characters.`,
  tooLong: `Username must be at most ${USERNAME_MAX} characters.`,
  invalidChars: 'Username can only contain letters, numbers and underscores.',
  reserved: 'That username is reserved. Please choose another.',
} as const;

/** Returns the first format problem of an already-normalised name, or null. */
function formatError(name: string): string | null {
  if (!USERNAME_CHARS.test(name)) return USERNAME_ERRORS.invalidChars;
  if (name.length < USERNAME_MIN) return USERNAME_ERRORS.tooShort;
  if (name.length > USERNAME_MAX) return USERNAME_ERRORS.tooLong;
  return null;
}

/**
 * Normalises then validates the format. Emits exactly one issue per failure
 * (invalid characters take priority over length). Does not check the reserved
 * list; see isReservedUsername.
 */
export const UsernameSchema = z
  .string()
  .transform(normalizeUsername)
  .superRefine((name, ctx) => {
    const message = formatError(name);
    if (message) ctx.addIssue({ code: 'custom', message });
  })
  .brand<'Username'>();

export type Username = z.infer<typeof UsernameSchema>;

export const RESERVED_USERNAMES: readonly string[] = Object.freeze([
  'admin',
  'administrator',
  'root',
  'system',
  'host',
  'dealer',
  'felt',
  'support',
  'help',
  'guest',
  'moderator',
  'mod',
  'staff',
  'official',
  'null',
  'undefined',
  'anonymous',
  'everyone',
  'here',
  'me',
  'bot',
  'you',
  'server',
  'api',
]);

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_USERNAMES);

/** Reserved words shorter than this match only exactly (no affix rule). */
const AFFIX_MIN_LENGTH = 4;

/**
 * Case-insensitive, run after normalisation. A name is reserved if it equals a
 * reserved word exactly. Additionally, for reserved words of 4+ characters
 * only, a name is reserved if it is that word with leading underscores and/or
 * trailing digits/underscores added (`admin1`, `admin_`, `_felt_`, `__admin__`,
 * `host99`). This stops impersonation. Short words (me, you, mod, bot, api)
 * are exact-match only, so `you2`, `1me`, `bot_1` stay available; leading
 * digits are never stripped (`7host`, `99host` are allowed), and words that
 * merely contain a reserved word (`adminton`, `hosting`, `host_of_fun`) are
 * allowed.
 */
export function isReservedUsername(name: string): boolean {
  const lower = normalizeUsername(name).toLowerCase();
  if (RESERVED_SET.has(lower)) return true;
  const core = lower.replace(/^_+/, '').replace(/[0-9_]+$/, '');
  return core.length >= AFFIX_MIN_LENGTH && RESERVED_SET.has(core);
}

export const UsernameCheckReasonSchema = z.enum(['format', 'reserved', 'profane', 'taken']);
export type UsernameCheckReason = z.infer<typeof UsernameCheckReasonSchema>;

export const UsernameCheckResultSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true) }).strict(),
  z
    .object({
      available: z.literal(false),
      reason: UsernameCheckReasonSchema,
      message: z.string(),
    })
    .strict(),
]);
export type UsernameCheckResult = z.infer<typeof UsernameCheckResultSchema>;

/**
 * Client-side pre-check: normalise, format, reserved only. Profanity and
 * uniqueness need the server (P08/P10), so `available: true` here only means
 * "not rejected locally".
 */
export function checkUsernameLocally(raw: string): UsernameCheckResult {
  const name = normalizeUsername(raw);
  const message = formatError(name);
  if (message) return { available: false, reason: 'format', message };
  if (isReservedUsername(name)) {
    return { available: false, reason: 'reserved', message: USERNAME_ERRORS.reserved };
  }
  return { available: true };
}
