/**
 * Pure disconnect rules over a RoomRecord (P45, PRD 5.2 and 5.10): who is away, when a held seat
 * is given up and when an absent host is replaced. Same contract as seating.ts: no I/O, `now` and
 * connectivity are passed in, inputs are never mutated, an unchanged room is returned as the same
 * object. Deadlines are absolute epoch ms in the record.
 *
 * Seats: after the hold, an away player's seat is released as `room:leave` would (cash-out on the
 * ledger, or a refund in the lobby). Never while they are dealt into the running hand, folded or
 * not: the hand waits for them (or for `host:force_fold`) and the seat goes when it ends. Nothing
 * is released while the game is paused or once it has ended.
 *
 * Host: away for `HOST_FAILOVER_MS`, the role goes to the longest-seated connected player, paused
 * or not. With nobody to take it the host stays until somebody can. It does not come back by itself
 * when the old host returns.
 */
import { DEFAULT_SEAT_HOLD_MINUTES, HOST_FAILOVER_MS } from '@felt/protocol';
import { running } from './game';
import { transfer } from './hostControls';
import type { RoomRecord } from './roomStore';
import { vacate } from './seating';

export type IsConnected = (userId: string) => boolean;
type Marks = NonNullable<RoomRecord['away']>;

const holdMs = (room: Readonly<RoomRecord>): number =>
  (room.seatHoldMinutes ?? DEFAULT_SEAT_HOLD_MINUTES) * 60_000;

/**
 * Mark everyone whose absence matters (seated players and the host) and has no connection, and
 * unmark everyone else. An existing mark keeps its deadlines.
 */
export function trackAbsence(
  room: Readonly<RoomRecord>,
  isConnected: IsConnected,
  now: number,
): RoomRecord {
  const tracked = new Set(
    room.status === 'ended'
      ? []
      : [room.hostId, ...room.seats.filter((s) => !s.leaving).map((s) => s.userId)].filter(
          (id) => room.admitted.includes(id) && !isConnected(id),
        ),
  );
  const old: Marks = room.away ?? {};
  const had = Object.keys(old);
  if (had.length === tracked.size && had.every((id) => tracked.has(id))) {
    return room as RoomRecord;
  }
  const away: Marks = Object.fromEntries(
    [...tracked].map((id) => [id, old[id] ?? { since: now, releaseAt: now + holdMs(room) }]),
  );
  return { ...room, away };
}

/** `room:enter`: the user is back, and `session` (if named) now holds the room for them. */
export function arrived(
  room: Readonly<RoomRecord>,
  userId: string,
  session: string | undefined,
): RoomRecord {
  let next = room as RoomRecord;
  if (next.away?.[userId]) {
    const { [userId]: back, ...away } = next.away;
    void back;
    next = { ...next, away };
  }
  if (next.sessions?.[userId] !== session) {
    const { [userId]: old, ...sessions } = next.sessions ?? {};
    void old;
    next = {
      ...next,
      sessions: session === undefined ? sessions : { ...sessions, [userId]: session },
    };
  }
  return next;
}

/**
 * The visit that took the room never got into it: whoever held it before (`from`) holds it again.
 * Left alone if somebody else has taken it since.
 */
export function sessionBack(
  room: Readonly<RoomRecord>,
  userId: string,
  from: string | undefined,
  taken: string | undefined,
): RoomRecord {
  if (from === taken || room.sessions?.[userId] !== taken) return room as RoomRecord;
  const { [userId]: old, ...sessions } = room.sessions ?? {};
  void old;
  return {
    ...room,
    sessions: from === undefined ? sessions : { ...sessions, [userId]: from },
  };
}

/** After a pause, seats are held for the full time again. */
export function heldAgain(room: Readonly<RoomRecord>, now: number): Pick<RoomRecord, 'away'> {
  if (!room.away) return {};
  const releaseAt = now + holdMs(room);
  return {
    away: Object.fromEntries(
      Object.entries(room.away).map(([id, mark]) => [id, { ...mark, releaseAt }]),
    ),
  };
}

/** Seats being held that may be given up when their time comes, with that time. */
function releasable(room: Readonly<RoomRecord>, isConnected: IsConnected) {
  if (room.status !== 'lobby' && room.status !== 'playing') return [];
  const hand = running(room);
  const dealtIn = (userId: string) =>
    hand !== null &&
    !hand.departed.includes(userId) &&
    hand.state.players.some((p) => p.playerId === userId);
  return room.seats.flatMap((s) => {
    const mark = room.away?.[s.userId];
    return mark && !s.leaving && !isConnected(s.userId) && !dealtIn(s.userId)
      ? [{ userId: s.userId, at: mark.releaseAt }]
      : [];
  });
}

/**
 * Who would take over now: the longest-seated connected player. Seats are stored in the order they
 * were taken (`sit` appends; nothing reorders them), so that is the first one that qualifies.
 */
export function successor(room: Readonly<RoomRecord>, isConnected: IsConnected): string | null {
  const seat = room.seats.find(
    (s) =>
      !s.leaving &&
      s.userId !== room.hostId &&
      room.admitted.includes(s.userId) &&
      isConnected(s.userId),
  );
  return seat?.userId ?? null;
}

/** When the absent host is to be replaced, or null (here, or nobody to replace them with). */
function failoverAt(room: Readonly<RoomRecord>, isConnected: IsConnected): number | null {
  const mark = room.away?.[room.hostId];
  if (!mark || room.status === 'ended' || isConnected(room.hostId)) return null;
  return successor(room, isConnected) === null ? null : mark.since + HOST_FAILOVER_MS;
}

/** The earliest stored deadline that can act as things stand, or null. */
export function nextAbsenceDeadline(
  room: Readonly<RoomRecord>,
  isConnected: IsConnected,
): number | null {
  const all = releasable(room, isConnected).map((r) => r.at);
  const failover = failoverAt(room, isConnected);
  if (failover !== null) all.push(failover);
  return all.length ? Math.min(...all) : null;
}

/** Do whatever is due. Safe to call at any moment and any number of times. */
export function applyAbsence(
  room: Readonly<RoomRecord>,
  isConnected: IsConnected,
  now: number,
): RoomRecord {
  let next = trackAbsence(room, isConnected, now);
  const failover = failoverAt(next, isConnected);
  if (failover !== null && failover <= now) {
    const r = transfer(next, next.hostId, successor(next, isConnected)!, true);
    if (!r.refused) next = r.room;
  }
  for (const { userId, at } of releasable(next, isConnected)) {
    if (at <= now) next = vacate(next, userId, now);
  }
  return trackAbsence(next, isConnected, now);
}
