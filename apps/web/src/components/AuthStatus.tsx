import { useEffect } from 'react';
import { restartAuth } from '../lib/auth';
import { useAuthStore } from '../lib/authStore';
import { loadMe, useMeStore } from '../lib/meStore';

export function AuthStatus() {
  const status = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => s.userId);
  const isAnonymous = useAuthStore((s) => s.isAnonymous);
  const error = useAuthStore((s) => s.error);
  const meStatus = useMeStore((s) => s.status);
  const meOwner = useMeStore((s) => s.forUserId);
  const me = useMeStore((s) => s.me);
  const meError = useMeStore((s) => s.error);

  useEffect(() => {
    if (status === 'signedIn' && userId) void loadMe(userId); // no-op when already cached
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
        {meOwner === userId && me
          ? me.username
            ? `@${me.username}`
            : 'no username yet'
          : meOwner === userId && meStatus === 'error'
            ? `Couldn't load profile (${meError})`
            : 'Loading profile…'}
      </p>
    </div>
  );
}
