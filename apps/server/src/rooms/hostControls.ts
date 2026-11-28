/**
 * Pure host controls over a RoomRecord (P44): pause/resume, kick, blinds, transfer, end game.
 * Same contract as seating.ts: no I/O, `now` is passed in, inputs are never mutated, and an
 * unchanged room is returned as the same object. None of them is a step of the hand, so
 * `host:undo` never reverses one.
 */
import {
  AWARD_CONFIRM_MS,
  DEFAULT_SEAT_HOLD_MINUTES,
  type BlindIncreasePatch,
  type ErrorCode,
  type HostSettingsPatch,
} from '@felt/protocol';
import { heldAgain } from './absence';
import { freezeClock, restartClock, thawClock } from './blinds';
import { beingRemoved, endNow, removeMember } from './ending';
import { leave, NEXT_HAND_DELAY_MS, nextHandDelay, running } from './game';
import type { RoomRecord } from './roomStore';
import { freezeTurn, syncClock, thawTurn } from './turnClock';
import type { SeatResult } from './seating';
import { dropTopUps } from './topUps';

const done = (room: Readonly<RoomRecord>): SeatResult => ({
  room: room as RoomRecord,
  refused: null,
});
const refuse = (room: Readonly<RoomRecord>, code: ErrorCode, message: string): SeatResult => ({
  room: room as RoomRecord,
  refused: { code, message },
});

function gate(room: Readonly<RoomRecord>, userId: string): SeatResult | null {
  if (!room.admitted.includes(userId)) {
    return refuse(room, 'not_admitted', 'not admitted to this room');
  }
  if (room.hostId !== userId) return refuse(room, 'not_host', 'only the host can do that');
  if (room.status === 'ended') return refuse(room, 'room_ended', 'room has ended');
  return null;
}

/** For what only a next hand could use, or could hold this one open for good. */
const noNextHand = (room: Readonly<RoomRecord>): SeatResult | null =>
  room.ending ? refuse(room, 'illegal_action', 'the game ends after this hand') : null;

/**
 * `host:pause`. What is left of the turn clock is kept. The other stored deadlines (award window,
 * next hand) stay as they are but are ignored while paused (`nextDeadline`), also after a restart. Every move, deal, award, dispute, undo,
 * stack correction and start is refused with `room_paused`. Seats, join requests, top-ups and the
 * other host controls go on working.
 */
export function pause(room: Readonly<RoomRecord>, userId: string, now: number): SeatResult {
  const gated = gate(room, userId) ?? noNextHand(room);
  if (gated) return gated;
  if (room.status === 'paused') return done(room);
  if (room.status !== 'playing') return refuse(room, 'illegal_action', 'the game has not started');
  const { game } = room;
  return done({
    ...freezeClock(room, now),
    status: 'paused',
    ...(game?.hand ? { game: { ...game, hand: freezeTurn(game.hand, now) } } : {}),
  });
}

/**
 * `host:resume`. The blind countdown and the turn clock go on with what was left (the turn gets at
 * least a few seconds). The award window and the next deal start again in full from now, so nobody
 * loses part of their time to dispute, and a deadline that passed during the pause does not fire at
 * once.
 */
export function resume(room: Readonly<RoomRecord>, userId: string, now: number): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  if (room.status === 'playing') return done(room);
  if (room.status !== 'paused') return refuse(room, 'illegal_action', 'the game is not paused');
  const next: RoomRecord = {
    ...thawClock(room, now),
    status: 'playing',
    ...heldAgain(room, now),
  };
  const { game } = room;
  if (!game) return done(next);
  const hand = game.hand && thawTurn(next, game.hand, now);
  const proposal = hand?.proposal;
  return done({
    ...next,
    game: {
      ...game,
      nextHandAt:
        game.nextHandAt === null
          ? null
          : now + (game.hand ? nextHandDelay(game.hand) : NEXT_HAND_DELAY_MS),
      hand:
        hand && proposal && !proposal.disputed
          ? { ...hand, proposal: { ...proposal, confirmAt: now + AWARD_CONFIRM_MS } }
          : hand,
    },
  });
}

/**
 * `host:seat_hold`: how long a dropped player's seat is held. Seats already being held keep the
 * deadline they were given.
 */
export function changeSeatHold(
  room: Readonly<RoomRecord>,
  userId: string,
  minutes: number,
): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  if ((room.seatHoldMinutes ?? DEFAULT_SEAT_HOLD_MINUTES) === minutes) return done(room);
  return done({ ...room, seatHoldMinutes: minutes });
}

/**
 * `host:kick`. A player still contesting the running hand (active or all-in) is not folded: the
 * removal waits, they play the hand out, and they are removed and cashed out when it ends
 * (`finishHand` in game.ts). Anyone else goes at once: first everything `room:leave` does (cash
 * out on the ledger, drop top-ups), with the undo history emptied, then the admission goes. Coming
 * back takes a new join request (PRD 5.2), and the seating rules for a returning player apply to
 * the chips.
 */
export function kick(
  room: Readonly<RoomRecord>,
  actorId: string,
  targetId: string,
  now: number,
): SeatResult {
  const gated = gate(room, actorId);
  if (gated) return gated;
  if (targetId === actorId) return refuse(room, 'illegal_action', 'you cannot remove yourself');
  if (!room.admitted.includes(targetId)) {
    return refuse(room, 'not_found', 'that player is not in the room');
  }
  const inPlay = running(room);
  const player =
    inPlay && !inPlay.departed.includes(targetId)
      ? inPlay.state.players.find((p) => p.playerId === targetId)
      : undefined;
  if (player && player.status !== 'folded' && room.seats.some((s) => s.userId === targetId)) {
    if (beingRemoved(room, targetId)) return done(room);
    const marked = {
      ...dropTopUps(room, targetId),
      removals: [...(room.removals ?? []), targetId],
    };
    return done(syncClock(marked, now));
  }
  let next = room as RoomRecord;
  if (room.seats.some((s) => s.userId === targetId)) {
    const left = leave(room, targetId, now);
    if (left.refused) return left;
    next = left.room;
  }
  const hand = next.game?.hand;
  if (hand?.undo?.length) {
    next = { ...next, game: { ...next.game!, hand: { ...hand, undo: [] } } };
  }
  return done(removeMember(next, targetId, now));
}

/**
 * `host:transfer`: to a connected player with a seat (the seat carries the username the room
 * preview shows, and an absent host would stall the game). Host powers move with this one change.
 */
export function transfer(
  room: Readonly<RoomRecord>,
  actorId: string,
  targetId: string,
  connected: boolean,
): SeatResult {
  const gated = gate(room, actorId);
  if (gated) return gated;
  if (targetId === actorId) return refuse(room, 'illegal_action', 'you are already the host');
  const seat = room.seats.find((s) => s.userId === targetId && !s.leaving);
  if (!seat || !room.admitted.includes(targetId)) {
    return refuse(room, 'not_seated', 'the new host must have a seat');
  }
  if (!connected) return refuse(room, 'illegal_action', 'that player is not connected');
  if (beingRemoved(room, targetId)) {
    return refuse(room, 'illegal_action', 'that player is being removed');
  }
  return done({
    ...room,
    // The old host is a member now, and may have no seat to be named by.
    names: { ...room.names, [actorId]: room.hostUsername },
    hostId: targetId,
    hostUsername: seat.username,
  });
}

/**
 * `host:settings` (blinds only). A running hand keeps its blinds and the change waits for the next
 * deal; with no hand running it applies now, which is before the next hand too. A change restarts
 * the blind increase countdown.
 */
export function changeBlinds(
  room: Readonly<RoomRecord>,
  userId: string,
  patch: HostSettingsPatch,
  now: number,
): SeatResult {
  const gated = gate(room, userId) ?? noNextHand(room);
  if (gated) return gated;
  const set = setBlinds(room, patch);
  return done(set === room ? room : restartClock(set, now));
}

/**
 * `host:blind_increase`: turn the automatic schedule on or off, or change it. A new interval (or
 * turning it on) starts a full countdown; a new multiplier alone leaves the countdown running.
 * Blinds only ever move when a hand is dealt.
 */
export function changeBlindIncrease(
  room: Readonly<RoomRecord>,
  userId: string,
  { minutes, multiplier }: BlindIncreasePatch,
  now: number,
): SeatResult {
  const gated = gate(room, userId) ?? noNextHand(room);
  if (gated) return gated;
  const { blindIncreaseMinutes, blindIncreaseMultiplier } = room.settings;
  if (minutes === blindIncreaseMinutes && multiplier === blindIncreaseMultiplier) {
    return done(room);
  }
  const next: RoomRecord = {
    ...room,
    settings: {
      ...room.settings,
      blindIncreaseMinutes: minutes,
      blindIncreaseMultiplier: multiplier,
    },
  };
  return done(minutes === blindIncreaseMinutes ? next : restartClock(next, now));
}

/** The same room when nothing changes. */
function setBlinds(
  room: Readonly<RoomRecord>,
  { smallBlind, bigBlind }: HostSettingsPatch,
): RoomRecord {
  const { nextBlinds, ...rest } = room;
  const same = room.settings.smallBlind === smallBlind && room.settings.bigBlind === bigBlind;
  if (running(room)) {
    if (same) return nextBlinds ? rest : room;
    if (nextBlinds?.smallBlind === smallBlind && nextBlinds.bigBlind === bigBlind) return room;
    return { ...room, nextBlinds: { smallBlind, bigBlind } };
  }
  if (same && !nextBlinds) return room;
  return { ...rest, settings: { ...room.settings, smallBlind, bigBlind } };
}

/**
 * An online all-in run-out still on the table: the hand has ended for the server, but clients are
 * dealing the board out and hold the result back until about the next deal (while paused that
 * deadline stands still). Reads only what `room:state` already says.
 */
function runoutOnShow(room: Readonly<RoomRecord>, now: number): boolean {
  const game = room.game;
  if (!game?.hand || game.hand.runoutFrom === undefined || game.nextHandAt === null) return false;
  return room.status === 'paused' || now < game.nextHandAt;
}

/**
 * `host:end`. With no hand being played, and no run-out on the table, the game ends at once.
 * Otherwise the hand is played to its end and nobody is refunded: no further hand is dealt and the
 * game ends once the result has been on the table for the usual pause (`tick` in game.ts). So that
 * this cannot be held open, a paused game resumes and cannot be paused again, and with the timer
 * off every turn is clocked from now; top-ups and new blinds, which only a next hand could use, are
 * dropped now. Asking again never cuts a hand or a run-out short.
 */
export function end(room: Readonly<RoomRecord>, userId: string, now: number): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  if (!running(room) && !runoutOnShow(room, now)) return done(endNow(room, now));
  if (room.ending) return done(room);
  const going = room.status === 'paused' ? resume(room, userId, now).room : (room as RoomRecord);
  const { nextBlinds, blindClock, ...rest } = going;
  void nextBlinds;
  void blindClock;
  return done(syncClock({ ...rest, ending: true, topUpRequests: [], pendingTopUps: [] }, now));
}
