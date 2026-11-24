import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** The service-role client. Server-only: it bypasses RLS, so it must never reach a client. */
export type Db = SupabaseClient;

/**
 * Overall deadline for one database call. Applied per query via `.abortSignal(dbDeadline())` and
 * `.retry(false)`: postgrest-js retries GET/HEAD (3 retries, 1/2/4 s backoff) and a fetch-level
 * timeout is NOT visible to that retry loop, so without both a hung DB would take ~27 s to fail.
 * The per-fetch timeout below is only a backstop (e.g. for `auth.admin` calls).
 */
export const DB_TIMEOUT_MS = 5_000;
export const dbDeadline = (): AbortSignal => AbortSignal.timeout(DB_TIMEOUT_MS);

/**
 * Supabase client with the service role: no session persistence, no token refresh (it is not a
 * user session). When the key is missing, see `createDbFromEnv`.
 */
export function createDbClient(url: string, serviceRoleKey: string): Db {
  return createClient(url, serviceRoleKey, {
    db: { retry: false },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const timeout = AbortSignal.timeout(DB_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        return fetch(input, { ...init, signal });
      },
    },
  });
}

/** `null` when no key is configured (development / test); the username routes then answer 503. */
export function createDbFromEnv(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
}): Db | null {
  return env.SUPABASE_SERVICE_ROLE_KEY
    ? createDbClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
}
