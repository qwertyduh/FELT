/**
 * What this device remembers about asking to join a room, so a reload neither forgets a pending
 * request nor re-creates an expired one. The server stays the authority; storage may be blocked.
 * Deadlines are epoch ms on this device's clock.
 */
import { DENY_COOLDOWN_MS } from '@felt/protocol';

export type JoinMemory =
  { kind: 'pending'; requestId: string; deadline: number } | { kind: 'denied'; until: number };

const key = (userId: string, code: string) => `felt:join:${userId}:${code}`;

function parse(value: unknown): JoinMemory | null {
  const v = value as Partial<Record<string, unknown>> | null;
  if (v?.kind === 'denied' && typeof v.until === 'number') {
    // No cooldown is longer than the real one, whatever storage claims.
    return { kind: 'denied', until: Math.min(v.until, Date.now() + DENY_COOLDOWN_MS) };
  }
  if (v?.kind === 'pending' && typeof v.requestId === 'string' && typeof v.deadline === 'number') {
    return { kind: 'pending', requestId: v.requestId, deadline: v.deadline };
  }
  return null;
}

export function readJoinMemory(userId: string, code: string): JoinMemory | null {
  try {
    return parse(JSON.parse(localStorage.getItem(key(userId, code)) ?? 'null'));
  } catch {
    return null;
  }
}

/** False when storage refused, so its silence about this room means nothing. */
export function writeJoinMemory(userId: string, code: string, memory: JoinMemory | null): boolean {
  try {
    if (memory === null) localStorage.removeItem(key(userId, code));
    else localStorage.setItem(key(userId, code), JSON.stringify(memory));
    return true;
  } catch {
    // Private mode or blocked storage: this visit still works.
    return false;
  }
}
