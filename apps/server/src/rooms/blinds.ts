/**
 * Automatic blind increases over a RoomRecord. Pure, same contract as seating.ts.
 *
 * `blindClock.at` is an absolute deadline. Nothing happens when it passes: the next hand dealt
 * takes one level (never more, however long ago it was) and starts a full countdown from then.
 * So a running hand never changes, and no timer is needed.
 */
import { MAX_CHIPS, type BlindMultiplier, type PublicRoomState } from '@felt/protocol';
import type { RoomRecord } from './roomStore';

type Blinds = { smallBlind: number; bigBlind: number };

/** Rounded up to whole chips and capped; both rise alike, so small <= big still holds. */
export function raised({ smallBlind, bigBlind }: Blinds, multiplier: BlindMultiplier): Blinds {
  const up = (n: number) => Math.max(n, Math.min(Math.ceil(n * multiplier), MAX_CHIPS));
  return { smallBlind: up(smallBlind), bigBlind: up(bigBlind) };
}

const intervalMs = (minutes: number): number => minutes * 60_000;

/**
 * A hand is being dealt: take up the host's pending blinds, or else the level that has come due.
 * The first hand starts the clock. Blinds the host chose are never raised in the same deal.
 */
export function dealBlinds(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const { nextBlinds, blindClock, ...rest } = room;
  let settings = nextBlinds ? { ...room.settings, ...nextBlinds } : room.settings;
  const minutes = settings.blindIncreaseMinutes;
  if (minutes === null) return { ...rest, settings };
  if (blindClock && blindClock.at > now) return { ...rest, settings, blindClock };
  if (blindClock && !nextBlinds) {
    settings = { ...settings, ...raised(settings, settings.blindIncreaseMultiplier) };
  }
  return { ...rest, settings, blindClock: { at: now + intervalMs(minutes) } };
}

/** A full countdown from now; none if the schedule is off or no hand has been dealt yet. */
export function restartClock(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const { blindClock, ...rest } = room;
  void blindClock;
  const minutes = room.settings.blindIncreaseMinutes;
  if (minutes === null || (room.status !== 'playing' && room.status !== 'paused')) return rest;
  const at = now + intervalMs(minutes);
  return { ...rest, blindClock: room.status === 'paused' ? { at, pausedAt: now } : { at } };
}

export function freezeClock(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const { blindClock } = room;
  return blindClock ? { ...room, blindClock: { at: blindClock.at, pausedAt: now } } : room;
}

/** Go on with the time that was left (none: the next hand takes the level). */
export function thawClock(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const { blindClock } = room;
  if (blindClock?.pausedAt === undefined) return room;
  return { ...room, blindClock: { at: now + Math.max(0, blindClock.at - blindClock.pausedAt) } };
}

type Upcoming = Pick<
  PublicRoomState,
  'nextBlindIncreaseAt' | 'blindIncreaseLeftMs' | 'nextBlindLevel'
>;

/** What `room:state` says about the next increase; nothing once the blinds are at the cap. */
export function upcomingIncrease(room: Readonly<RoomRecord>): Upcoming {
  const clock = room.status === 'ended' ? undefined : room.blindClock;
  if (!clock) return { nextBlindIncreaseAt: null };
  const from = room.nextBlinds ?? room.settings;
  const level = raised(from, room.settings.blindIncreaseMultiplier);
  if (level.smallBlind === from.smallBlind && level.bigBlind === from.bigBlind) {
    return { nextBlindIncreaseAt: null };
  }
  return {
    ...(clock.pausedAt === undefined
      ? { nextBlindIncreaseAt: clock.at }
      : { nextBlindIncreaseAt: null, blindIncreaseLeftMs: Math.max(0, clock.at - clock.pausedAt) }),
    nextBlindLevel: level,
  };
}
