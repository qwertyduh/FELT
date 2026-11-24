import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { restartAuth } from '../lib/auth';
import { useAuthStore } from '../lib/authStore';

interface Me {
  userId: string;
  isAnonymous: boolean;
  username: string | null;
}

type MeState = { kind: 'idle' } | { kind: 'ok'; me: Me } | { kind: 'error'; message: string };

export function AuthStatus() {
  const status = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => s.userId);
  const isAnonymous = useAuthStore((s) => s.isAnonymous);
  const error = useAuthStore((s) => s.error);
  const [me, setMe] = useState<MeState>({ kind: 'idle' });

  useEffect(() => {
    if (status !== 'signedIn' || !userId) return;
    let cancelled = false;
    apiFetch<Me>('/me')
      .then((res) => !cancelled && setMe({ kind: 'ok', me: res }))
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = err instanceof Error ? err.message : 'request failed';
        setMe({ kind: 'error', message: code });
      });
    return () => {
      cancelled = true;
    };
  }, [status, userId]);

  if (status === 'loading') {
    return (
      <p data-testid="auth-status" className="text-sm opacity-70">
        Signing in…
      </p>
    );
  }
  if (status === 'error') {
    return (
      <div data-testid="auth-status" className="flex items-center gap-3 text-sm">
        <span className="text-red-400">{error ?? 'Sign-in failed'}</span>
        <button
          type="button"
          className="min-h-11 rounded-md border border-current px-3"
          onClick={() => void restartAuth()}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div data-testid="auth-status" className="text-sm">
      <p>
        {isAnonymous ? 'Guest' : 'Signed in'} ·{' '}
        <span data-testid="auth-user-id">{userId?.slice(0, 8)}</span>
      </p>
      <p data-testid="auth-me" className="opacity-70">
        {me.kind === 'ok'
          ? me.me.username
            ? `@${me.me.username}`
            : 'no username yet'
          : me.kind === 'error'
            ? `Couldn't load profile (${me.message})`
            : 'Loading profile…'}
      </p>
    </div>
  );
}
