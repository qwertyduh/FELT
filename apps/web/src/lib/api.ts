import { restartAuth } from './auth';
import { createApiFetch, type ApiCallOptions, type RefreshResult } from './apiFetch';
import { getWebEnv } from './env';
import { getSupabase } from './supabase';

export { ApiError } from './apiFetch';

/** Supabase auth errors that mean "try later", not "this refresh token is dead". */
function isTransient(err: { name?: string | undefined; status?: number | undefined }): boolean {
  return err.name === 'AuthRetryableFetchError' || !err.status || err.status >= 500;
}

let instance: ReturnType<typeof createApiFetch> | undefined;

/** Authenticated call to the FELT server REST API. */
export function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
  options?: ApiCallOptions,
): Promise<T> {
  instance ??= createApiFetch({
    baseUrl: getWebEnv().serverUrl,
    fetch: (...args) => fetch(...args),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getAccessToken: async () =>
      (await getSupabase().auth.getSession()).data.session?.access_token ?? null,
    refreshSession: async (): Promise<RefreshResult> => {
      const { data, error } = await getSupabase().auth.refreshSession();
      if (error) return isTransient(error) ? 'transient' : 'rejected';
      return data.session ? 'ok' : 'rejected';
    },
    signOut: async () => {
      // The session is unrecoverable. Sign out locally, then bootstrap a fresh anonymous user.
      await getSupabase().auth.signOut({ scope: 'local' });
      await restartAuth();
    },
  });
  return instance<T>(path, init, options);
}
