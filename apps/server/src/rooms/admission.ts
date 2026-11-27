/**
 * Pure admission rules over a RoomRecord (join requests, expiry, deny cooldown). No I/O and no
 * timers: `now` is passed in, inputs are never mutated, and an unchanged room is returned as the
 * same object (so the actor persists nothing).
 */
import {
  DENY_COOLDOWN_MS,
  JOIN_REQUEST_TTL_MS,
  type ErrorCode,
  type ServerEventPayload,
} from '@felt/protocol';
import type { RoomRecord } from './roomStore';

export { DENY_COOLDOWN_MS, JOIN_REQUEST_TTL_MS };
/** Matches the `host:inbox` schema bound. */
export const MAX_PENDING_JOINS = 50;

export type JoinRecord = RoomRecord['requests'][number];

export const findJoin = (room: Readonly<RoomRecord>, userId: string): JoinRecord | undefined =>
  room.requests.find((r) => r.kind === 'join' && r.userId === userId);

/** Drops join requests whose deadline has been reached. Expiry never starts a cooldown. */
export function pruneExpired(
  room: Readonly<RoomRecord>,
  now: number,
): { room: RoomRecord; expired: JoinRecord[] } {
  const expired = room.requests.filter((r) => r.kind === 'join' && r.expiresAt <= now);
  if (expired.length === 0) return { room: room as RoomRecord, expired };
  return {
    room: { ...room, requests: room.requests.filter((r) => !expired.includes(r)) },
    expired,
  };
}

export function nextExpiry(room: Readonly<RoomRecord>): number | null {
  const deadlines = room.requests.filter((r) => r.kind === 'join').map((r) => r.expiresAt);
  return deadlines.length ? Math.min(...deadlines) : null;
}

/** Epoch ms until which `userId` may not ask again, or null. */
export function cooldownUntil(
  room: Readonly<RoomRecord>,
  userId: string,
  now: number,
): number | null {
  const denied = room.denied;
  const until = denied && Object.hasOwn(denied, userId) ? denied[userId] : undefined;
  return until !== undefined && until > now ? until : null;
}

function liveDenials(room: Readonly<RoomRecord>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(room.denied ?? {}).filter(([, until]) => until > now));
}

export type JoinOutcome =
  | { kind: 'created'; request: JoinRecord }
  | { kind: 'pending'; request: JoinRecord }
  | { kind: 'admitted' }
  | { kind: 'cooldown'; until: number }
  | { kind: 'refused'; code: ErrorCode; message: string };

export function requestJoin(
  room: Readonly<RoomRecord>,
  who: { userId: string; username: string; requestId: string },
  now: number,
): { room: RoomRecord; outcome: JoinOutcome } {
  const same = (outcome: JoinOutcome) => ({ room: room as RoomRecord, outcome });
  if (room.status === 'ended') {
    return same({ kind: 'refused', code: 'room_ended', message: 'room has ended' });
  }
  if (room.admitted.includes(who.userId)) return same({ kind: 'admitted' });
  const until = cooldownUntil(room, who.userId, now);
  if (until !== null) return same({ kind: 'cooldown', until });
  const existing = findJoin(room, who.userId);
  if (existing) return same({ kind: 'pending', request: existing });
  if (room.requests.filter((r) => r.kind === 'join').length >= MAX_PENDING_JOINS) {
    return same({ kind: 'refused', code: 'rate_limited', message: 'too many pending requests' });
  }
  const request: JoinRecord = {
    requestId: who.requestId,
    userId: who.userId,
    username: who.username,
    kind: 'join',
    requestedAt: now,
    expiresAt: now + JOIN_REQUEST_TTL_MS,
  };
  return {
    room: { ...room, requests: [...room.requests, request], denied: liveDenials(room, now) },
    outcome: { kind: 'created', request },
  };
}

export function cancelJoin(
  room: Readonly<RoomRecord>,
  userId: string,
): { room: RoomRecord; removed: boolean } {
  const existing = findJoin(room, userId);
  if (!existing) return { room: room as RoomRecord, removed: false };
  return {
    room: { ...room, requests: room.requests.filter((r) => r !== existing) },
    removed: true,
  };
}

export type DecideOutcome =
  | { kind: 'decided'; request: JoinRecord; retryAfter?: number }
  | { kind: 'refused'; code: ErrorCode; message: string };

/** The host's answer. `actorId` is checked here so authorisation happens inside the room queue. */
export function decideJoin(
  room: Readonly<RoomRecord>,
  actorId: string,
  requestId: string,
  approve: boolean,
  now: number,
): { room: RoomRecord; outcome: DecideOutcome } {
  const refuse = (code: ErrorCode, message: string) => ({
    room: room as RoomRecord,
    outcome: { kind: 'refused' as const, code, message },
  });
  if (!room.admitted.includes(actorId)) return refuse('not_admitted', 'not admitted to this room');
  if (room.hostId !== actorId) return refuse('not_host', 'only the host can do that');
  if (room.status === 'ended') return refuse('room_ended', 'room has ended');
  const request = room.requests.find((r) => r.kind === 'join' && r.requestId === requestId);
  if (!request || request.expiresAt <= now) {
    return refuse('request_expired', 'request is no longer pending');
  }
  const requests = room.requests.filter((r) => r !== request);
  const denied = liveDenials(room, now);
  delete denied[request.userId];
  if (approve) {
    const admitted = room.admitted.includes(request.userId)
      ? room.admitted
      : [...room.admitted, request.userId];
    return {
      room: { ...room, requests, denied, admitted },
      outcome: { kind: 'decided', request },
    };
  }
  const retryAfter = now + DENY_COOLDOWN_MS;
  denied[request.userId] = retryAfter;
  return {
    room: { ...room, requests, denied },
    outcome: { kind: 'decided', request, retryAfter },
  };
}

/** Host-only snapshot. Top-up requests arrive with P43. */
export function hostInbox(
  room: Readonly<RoomRecord>,
  now: number,
): ServerEventPayload<'host:inbox'> {
  return {
    joinRequests: room.requests
      .filter((r) => r.kind === 'join' && r.expiresAt > now)
      .slice(0, MAX_PENDING_JOINS)
      .map(({ requestId, userId, username, expiresAt }) => ({
        requestId,
        userId,
        username,
        expiresAt,
      })),
    topUpRequests: [],
  };
}
