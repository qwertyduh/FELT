import { create } from 'zustand';
import { apiFetch } from './api';
import { useAuthStore } from './authStore';

export interface Me {
  userId: string;
  isAnonymous: boolean;
  username: string | null;
}

export interface MeState {
  /** The user this result belongs to; a different signed-in user invalidates it. */
  forUserId: string | null;
  status: 'idle' | 'loading' | 'ok' | 'error';
  me: Me | null;
  error: string | null;
}

export const initialMeState: MeState = { forUserId: null, status: 'idle', me: null, error: null };

export const useMeStore = create<MeState>(() => initialMeState);

let inflight: { userId: string; promise: Promise<void> } | null = null;

/**
 * Loads `GET /me` once per user. Single-flight. A cached result for the same user is reused
 * unless `force` is set; a forced refresh keeps showing the old value while it runs.
 */
export function loadMe(userId: string, { force = false } = {}): Promise<void> {
  const s = useMeStore.getState();
  if (!force && s.forUserId === userId && s.status === 'ok') return Promise.resolve();
  if (inflight?.userId === userId) return inflight.promise;

  if (s.forUserId !== userId || !s.me) {
    useMeStore.setState({ forUserId: userId, status: 'loading', me: null, error: null });
  }
  const promise = apiFetch<Me>('/me')
    .then((me) => {
      if (useAuthStore.getState().userId !== userId) return; // user changed while in flight
      useMeStore.setState({ forUserId: userId, status: 'ok', me, error: null });
    })
    .catch((err: unknown) => {
      if (useAuthStore.getState().userId !== userId) return;
      const message = err instanceof Error ? err.message : 'request failed';
      useMeStore.setState((cur) =>
        cur.me ? cur : { forUserId: userId, status: 'error', me: null, error: message },
      );
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { userId, promise };
  return promise;
}

/** Records a freshly claimed username without another round trip. */
export function setClaimedUsername(userId: string, username: string): void {
  useMeStore.setState((cur) => ({
    forUserId: userId,
    status: 'ok',
    error: null,
    me: { userId, isAnonymous: cur.me?.isAnonymous ?? true, username },
  }));
}

/** Drops the cached result so the next consumer refetches. */
export function invalidateMe(): void {
  useMeStore.setState(initialMeState);
}
