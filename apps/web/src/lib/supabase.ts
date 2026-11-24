import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getWebEnv } from './env';

let client: SupabaseClient | undefined;

/** Lazy singleton. Session persists in localStorage and refreshes automatically. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const env = getWebEnv();
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // no OAuth redirects in v1 (Google deferred)
      },
    });
  }
  return client;
}
