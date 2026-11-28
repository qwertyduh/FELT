/**
 * What a host's decision does once it takes effect: removing a member and ending the game. Both
 * happen at once when no hand stands in the way (hostControls.ts) and otherwise when the running
 * hand is over (game.ts): the host has no way to take a hand, or a player's chips in it, away.
 * Same contract as seating.ts: no I/O, `now` is passed in, inputs are never mutated.
 */
import type { RoomRecord } from './roomStore';
import { vacate } from './seating';
import { dropTopUps } from './topUps';

/** The host is removing this user when the running hand ends. */
export const beingRemoved = (room: Readonly<RoomRecord>, userId: string): boolean =>
  room.removals?.includes(userId) ?? false;

/** Nothing is pending for this user any more. */
export function removalSettled(room: Readonly<RoomRecord>, userId: string): RoomRecord {
  if (!beingRemoved(room, userId)) return room as RoomRecord;
  const { removals, ...rest } = room;
  const left = removals!.filter((id) => id !== userId);
  return left.length ? { ...rest, removals: left } : rest;
}

/**
 * Cash out whatever seat they still hold, drop everything waiting for them and take away their
 * admission. Coming back takes a new join request (PRD 5.2).
 */
export function removeMember(room: Readonly<RoomRecord>, userId: string, now: number): RoomRecord {
  let next = removalSettled(dropTopUps(vacate(room, userId, now), userId), userId);
  const { [userId]: session, ...sessions } = next.sessions ?? {};
  if (session !== undefined) next = { ...next, sessions };
  const { [userId]: mark, ...away } = next.away ?? {};
  if (mark !== undefined) next = { ...next, away };
  return {
    ...next,
    admitted: next.admitted.filter((id) => id !== userId),
    requests: next.requests.filter((r) => r.userId !== userId),
    kicked: [...(next.kicked ?? []).filter((id) => id !== userId), userId],
  };
}

/**
 * End the game, with no hand being played. Players who were leaving are cashed out and everything
 * still waiting (join and top-up requests, queued top-ups, new blinds, the blind countdown) is
 * dropped. Seats keep their final stacks: with the ledger they are what the recap is built from.
 */
export function endNow(room: Readonly<RoomRecord>, now: number): RoomRecord {
  let next = room as RoomRecord;
  for (const seat of next.seats.filter((s) => s.leaving)) next = vacate(next, seat.userId, now);
  const { nextBlinds, blindClock, game, ending, removals, ...rest } = next;
  void nextBlinds;
  void blindClock;
  void ending;
  void removals;
  return {
    ...rest,
    status: 'ended',
    requests: [],
    topUpRequests: [],
    pendingTopUps: [],
    ...(game ? { game: { button: game.button, hand: null, nextHandAt: null } } : {}),
  };
}
