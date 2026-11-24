import type { SupabaseClient } from '@supabase/supabase-js';
import { applySession, setAuthError, setAuthLoading } from './authStore';
import { getSupabase } from './supabase';

type AuthApi = Pick<
  SupabaseClient['auth'],
  'getSession' | 'signInAnonymously' | 'onAuthStateChange'
>;

export interface AuthControllerDeps {
  auth: AuthApi;
  /** Cross-tab mutual exclusion around "read session, else sign in". Defaults to Web Locks. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const LOCK_NAME = 'felt-auth-bootstrap';

function webLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? locks.request(LOCK_NAME, fn) : fn();
}

/**
 * Bootstraps the session: reuse the persisted one, else sign in anonymously exactly once.
 * `start()` is single-flight in-process (StrictMode, concurrent callers) and, via the lock,
 * across tabs of a fresh browser.
 */
export function createAuthController({ auth, withLock = webLock }: AuthControllerDeps) {
  let inflight: Promise<void> | null = null;
  let subscribed = false;

  function subscribe(): void {
    if (subscribed) return;
    subscribed = true;
    // Callback must stay synchronous and never call back into supabase auth (deadlock risk).
    auth.onAuthStateChange((_event, session) => applySession(session));
  }

  async function bootstrap(): Promise<void> {
    const existing = await auth.getSession();
    if (existing.error) throw existing.error;
    if (existing.data.session) {
      applySession(existing.data.session);
      return;
    }
    const { data, error } = await auth.signInAnonymously();
    if (error) throw error;
    if (!data.session) throw new Error('Anonymous sign-in returned no session');
    applySession(data.session);
  }

  function start(): Promise<void> {
    subscribe();
    inflight ??= withLock(bootstrap)
      .catch((err: unknown) => {
        setAuthError(err instanceof Error ? err.message : 'Sign-in failed');
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** Retry after an error (or re-bootstrap after a sign-out). */
  function restart(): Promise<void> {
    setAuthLoading();
    return start();
  }

  return { start, restart };
}

let controller: ReturnType<typeof createAuthController> | undefined;

function getController() {
  controller ??= createAuthController({ auth: getSupabase().auth });
  return controller;
}

function guarded(fn: (c: ReturnType<typeof createAuthController>) => Promise<void>): Promise<void> {
  try {
    return fn(getController());
  } catch (err) {
    // Env/config problems surface as an auth error instead of a blank screen.
    setAuthError(err instanceof Error ? err.message : 'Auth failed to start');
    return Promise.resolve();
  }
}

export const startAuth = () => guarded((c) => c.start());
export const restartAuth = () => guarded((c) => c.restart());
