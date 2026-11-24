import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { restartAuth } from '../lib/auth';
import { useAuthStore } from '../lib/authStore';
import { loadMe, useMeStore } from '../lib/meStore';

function Splash({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div
      role="status"
      aria-busy={busy}
      data-testid="route-guard-splash"
      className="flex flex-1 flex-col items-center justify-center gap-4 text-center"
    >
      <p className="font-display text-4xl tracking-[0.3em] text-brass">FELT</p>
      {children}
    </div>
  );
}

const retryButton =
  'min-h-12 rounded-xl border border-brass px-5 text-base font-semibold text-brass active:brightness-90';

/**
 * Sends every signed-in user without a username to /onboarding (and users who have one away
 * from it). Waits for sign-in and /me; a failed /me shows Retry instead of redirecting.
 */
export function RouteGuard({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const authStatus = useAuthStore((s) => s.status);
  const authError = useAuthStore((s) => s.error);
  const userId = useAuthStore((s) => s.userId);
  const me = useMeStore();

  const stale = me.forUserId !== userId || me.status === 'idle';
  useEffect(() => {
    if (authStatus === 'signedIn' && userId && stale) void loadMe(userId);
  }, [authStatus, userId, stale]);

  if (authStatus === 'error') {
    return (
      <Splash>
        <p className="text-chip-red">{authError ?? 'Sign-in failed'}</p>
        <button type="button" className={retryButton} onClick={() => void restartAuth()}>
          Retry
        </button>
      </Splash>
    );
  }
  if (authStatus !== 'signedIn' || !userId || stale || me.status === 'loading') {
    return (
      <Splash busy>
        <p className="text-cream/70">Setting up your seat…</p>
      </Splash>
    );
  }
  if (me.status === 'error' || !me.me) {
    return (
      <Splash>
        <p className="text-chip-red">Couldn&apos;t load your profile.</p>
        <button
          type="button"
          className={retryButton}
          onClick={() => void loadMe(userId, { force: true })}
        >
          Retry
        </button>
      </Splash>
    );
  }

  const onOnboarding = pathname === '/onboarding';
  if (!me.me.username && !onOnboarding) return <Navigate to="/onboarding" replace />;
  if (me.me.username && onOnboarding) return <Navigate to="/" replace />;
  return <>{children}</>;
}
