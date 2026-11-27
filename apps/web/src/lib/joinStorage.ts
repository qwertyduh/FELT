/**
 * What this device remembers about asking to join a room, so a reload neither forgets a pending
 * request nor re-creates an expired one. The server stays the authority; storage may be blocked.
 * Deadlines are epoch ms on this device's clock.
 */
export type JoinMemory =
  { kind: 'pending'; requestId: string; deadline: number } | { kind: 'denied'; until: number };

const key = (userId: string, code: string) => `felt:join:${userId}:${code}`;

function parse(value: unknown): JoinMemory | null {
  const v = value as Partial<Record<string, unknown>> | null;
  if (v?.kind === 'denied' && typeof v.until === 'number')
    return { kind: 'denied', until: v.until };
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

export function writeJoinMemory(userId: string, code: string, memory: JoinMemory | null): void {
  try {
    if (memory === null) localStorage.removeItem(key(userId, code));
    else localStorage.setItem(key(userId, code), JSON.stringify(memory));
  } catch {
    // Private mode or blocked storage: this visit still works.
  }
}
