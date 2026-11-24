import { useEffect, useState } from 'react';
import { UsernameCheckResultSchema } from '@felt/protocol';
import { apiFetch } from './api';
import { rejected, verdictFromError, type Verdict } from './usernameCopy';

export type CheckState = { kind: 'idle' } | { kind: 'checking' } | { kind: 'available' } | Verdict;

export const CHECK_DEBOUNCE_MS = 400;

/**
 * Debounced availability check for an already-normalised, locally valid name (`null` = nothing
 * to check). Every change cancels the pending timer and aborts the in-flight request, and a
 * result is only used while it still matches the current name, so a late response can never
 * describe a name the player has since edited.
 */
export function useUsernameCheck(name: string | null, debounceMs = CHECK_DEBOUNCE_MS): CheckState {
  const [settled, setSettled] = useState<{ name: string; state: CheckState } | null>(null);

  useEffect(() => {
    if (name === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiFetch<unknown>(`/usernames/check?u=${encodeURIComponent(name)}`, {
        signal: controller.signal,
      })
        .then((body) => {
          if (controller.signal.aborted) return;
          const parsed = UsernameCheckResultSchema.safeParse(body);
          const state: CheckState = !parsed.success
            ? verdictFromError(undefined)
            : parsed.data.available
              ? { kind: 'available' }
              : rejected(parsed.data.reason, parsed.data.message);
          setSettled({ name, state });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setSettled({ name, state: verdictFromError(err) });
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [name, debounceMs]);

  if (name === null) return { kind: 'idle' };
  return settled?.name === name ? settled.state : { kind: 'checking' };
}
