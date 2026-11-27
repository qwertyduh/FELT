/**
 * The turn clock (P48, PRD 5.4 and 5.10): the absolute deadline of the player on turn, stored on the
 * hand (`turnDeadline`), or what was left of it while the game is paused (`turnLeftMs`). Pure, like
 * game.ts, which applies what happens when it runs out. There is a clock exactly while the room has
 * a turn timer and somebody is on turn: not when the hand has ended, the board is being run out or
 * the host is to deal or award.
 */
import type { GameHand } from './gameSchema';
import type { RoomRecord } from './roomStore';

/** This many turns in a row running out sit the player out. */
export const TIMEOUTS_TO_SIT_OUT = 2;
/** Resuming never leaves the player on turn less than this (or the whole timer, if shorter). */
export const TURN_RESUME_MIN_MS = 5_000;

const turnMs = (room: Readonly<RoomRecord>): number | null =>
  room.settings.turnTimerSeconds === null ? null : room.settings.turnTimerSeconds * 1000;

/** Whether somebody's turn is being timed in this hand. */
export function onTheClock(room: Readonly<RoomRecord>, hand: GameHand): boolean {
  return turnMs(room) !== null && hand.state.street !== 'ended' && hand.state.currentActor !== null;
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
  const ms = turnMs(room)!;
  return room.status === 'paused'
    ? { ...rest, turnLeftMs: ms }
    : { ...rest, turnDeadline: now + ms };
}

/** `host:pause`: keep what is left of the turn. */
export function freezeTurn(hand: GameHand, now: number): GameHand {
  if (hand.turnDeadline === undefined) return hand;
  return { ...noClock(hand), turnLeftMs: Math.max(0, hand.turnDeadline - now) };
}

/** `host:resume` (`room` already playing): carry on with what was left. */
export function thawTurn(room: Readonly<RoomRecord>, hand: GameHand, now: number): GameHand {
  if (!onTheClock(room, hand)) return noClock(hand);
  const full = turnMs(room)!;
  const left = Math.max(hand.turnLeftMs ?? full, Math.min(TURN_RESUME_MIN_MS, full));
  return { ...noClock(hand), turnDeadline: now + Math.min(left, full) };
}
