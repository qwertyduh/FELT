/**
 * The turn clock (P48, PRD 5.4 and 5.10): the absolute deadline of the player on turn, stored on the
 * hand (`turnDeadline`), or what was left of it while the game is paused (`turnLeftMs`). Pure, like
 * game.ts, which applies what happens when it runs out. There is a clock exactly while the room has
 * a turn timer and somebody is on turn: not when the hand has ended, the board is being run out or
 * the host is to deal or award.
 *
 * With the timer off there is also one, of `FORCED_TURN_SECONDS`, on the turns of a player the host
 * is removing and on every turn of a game that is ending: nobody who simply never acts can keep
 * either from happening. `syncClock` starts or drops it when that changes in the middle of a turn.
 */
import { FORCED_TURN_SECONDS, TIMEOUTS_TO_SIT_OUT } from '@felt/protocol';
import type { GameHand } from './gameSchema';
import type { RoomRecord } from './roomStore';

export { TIMEOUTS_TO_SIT_OUT };
/**
 * Network grace: a turn runs out this long after the deadline players see, so a move made in the
 * last moment is not beaten by its own travel time.
 */
export const TURN_GRACE_MS = 1_000;
/**
 * A turn whose deadline passed while the server was down gets this long instead (or the whole
 * timer, if shorter).
 */
export const TURN_RESTART_MIN_MS = 10_000;
/** Resuming never leaves the player on turn less than this (or the whole timer, if shorter). */
export const TURN_RESUME_MIN_MS = 5_000;

/** How long the turn being waited on gets, or null when it is not timed. */
function turnMs(room: Readonly<RoomRecord>, hand: GameHand): number | null {
  const { turnTimerSeconds } = room.settings;
  if (turnTimerSeconds !== null) return turnTimerSeconds * 1000;
  const actor = hand.state.players.find((p) => p.seat === hand.state.currentActor)?.playerId;
  const forced = room.ending || (actor !== undefined && room.removals?.includes(actor));
  return forced ? FORCED_TURN_SECONDS * 1000 : null;
}

/** Whether somebody's turn is being timed in this hand. */
export function onTheClock(room: Readonly<RoomRecord>, hand: GameHand): boolean {
  return (
    turnMs(room, hand) !== null && hand.state.street !== 'ended' && hand.state.currentActor !== null
  );
}

function noClock(hand: GameHand): GameHand {
  const { turnDeadline, turnLeftMs, ...rest } = hand;
  void turnDeadline;
  void turnLeftMs;
  return rest;
}

/** The hand with a full clock for whoever is now on turn (frozen if paused), or with none. */
export function freshClock(room: Readonly<RoomRecord>, hand: GameHand, now: number): GameHand {
  const rest = noClock(hand);
  if (!onTheClock(room, hand)) return rest;
  const ms = turnMs(room, hand)!;
  return room.status === 'paused'
    ? { ...rest, turnLeftMs: ms }
    : { ...rest, turnDeadline: now + ms };
}

/**
 * After a change to whether the running turn is timed at all (a removal marked or called off, the
 * game now ending): give it a clock or take its clock away. A clock already running is left alone.
 */
export function syncClock(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const game = room.game;
  const hand = game?.hand;
  if (!game || !hand || hand.state.street === 'ended') return room as RoomRecord;
  const timed = hand.turnDeadline !== undefined || hand.turnLeftMs !== undefined;
  if (timed === onTheClock(room, hand)) return room as RoomRecord;
  const next = timed ? noClock(hand) : freshClock(room, hand, now);
  return { ...room, game: { ...game, hand: next } };
}

/** `host:pause`: keep what is left of the turn. */
export function freezeTurn(hand: GameHand, now: number): GameHand {
  if (hand.turnDeadline === undefined) return hand;
  return { ...noClock(hand), turnLeftMs: Math.max(0, hand.turnDeadline - now) };
}

/** `host:resume` (`room` already playing): carry on with what was left. */
export function thawTurn(room: Readonly<RoomRecord>, hand: GameHand, now: number): GameHand {
  if (!onTheClock(room, hand)) return noClock(hand);
  const full = turnMs(room, hand)!;
  const left = Math.max(hand.turnLeftMs ?? full, Math.min(TURN_RESUME_MIN_MS, full));
  return { ...noClock(hand), turnDeadline: now + Math.min(left, full) };
}

/**
 * A stored room as a freshly started server takes it up (once, never for a reload while the server
 * stayed up): a turn that is already overdue could not have been played, so it neither folds nor
 * strikes anyone and gets a short clock from now. Anything else is returned as it is.
 */
export function afterRestart(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const hand = room.game?.hand;
  if (room.status !== 'playing' || !hand || !onTheClock(room, hand)) return room as RoomRecord;
  if (hand.turnDeadline === undefined || hand.turnDeadline > now) return room as RoomRecord;
  const turnDeadline = now + Math.min(TURN_RESTART_MIN_MS, turnMs(room, hand)!);
  return { ...room, game: { ...room.game!, hand: { ...hand, turnDeadline } } };
}
