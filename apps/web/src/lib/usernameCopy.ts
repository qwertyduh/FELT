import type { UsernameCheckReason } from '@felt/protocol';
import { ApiError } from './apiFetch';

/** Why a name can't be used, or why we couldn't find out. */
export type Verdict =
  | { kind: 'rejected'; reason: UsernameCheckReason; message: string }
  | {
      kind: 'error';
      error: 'rate_limited' | 'unavailable' | 'network' | 'unknown';
      message: string;
    }
  | { kind: 'already_set' };

/** Friendly copy per rejection. Format messages come from the shared schema, so they pass through. */
export function rejectionCopy(reason: UsernameCheckReason, formatMessage?: string): string {
  switch (reason) {
    case 'format':
      return formatMessage ?? 'Use 3 to 20 letters, numbers or underscores.';
    case 'reserved':
      return 'That name is reserved. Try another.';
    case 'profane':
      return "That name isn't allowed. Try another.";
    case 'taken':
      return 'Someone already has that name. Try another.';
  }
}

export function rejected(reason: UsernameCheckReason, formatMessage?: string): Verdict {
  return { kind: 'rejected', reason, message: rejectionCopy(reason, formatMessage) };
}

function retryAfter(body: unknown): number | null {
  if (body && typeof body === 'object') {
    const n = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  return null;
}

const REASONS: readonly string[] = ['format', 'reserved', 'profane', 'taken'];

/** Maps a failed check or claim request to what we tell the player. */
export function verdictFromError(err: unknown): Verdict {
  if (!(err instanceof ApiError)) {
    return { kind: 'error', error: 'unknown', message: 'Something went wrong. Try again.' };
  }
  if (err.status === 0) {
    return {
      kind: 'error',
      error: 'network',
      message: "Can't reach the server. Check your connection and try again.",
    };
  }
  if (err.status === 429) {
    const secs = retryAfter(err.body);
    return {
      kind: 'error',
      error: 'rate_limited',
      message: secs
        ? `Too many tries. Wait ${secs} ${secs === 1 ? 'second' : 'seconds'} and try again.`
        : 'Too many tries. Wait a moment and try again.',
    };
  }
  if (err.status === 503) {
    return {
      kind: 'error',
      error: 'unavailable',
      message: "We can't check names right now. Try again in a moment.",
    };
  }
  if (err.status === 409 && err.code === 'username_already_set') return { kind: 'already_set' };
  if (err.status === 409 && err.code === 'username_taken') return rejected('taken');
  if (err.status === 422) {
    const b = err.body as { reason?: unknown; message?: unknown } | undefined;
    if (typeof b?.reason === 'string' && REASONS.includes(b.reason)) {
      return rejected(
        b.reason as UsernameCheckReason,
        typeof b.message === 'string' ? b.message : undefined,
      );
    }
  }
  return { kind: 'error', error: 'unknown', message: 'Something went wrong. Try again.' };
}
