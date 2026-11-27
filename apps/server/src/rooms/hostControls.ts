/**
 * Pure host controls over a RoomRecord (P44): pause/resume, kick, blinds, transfer, end game.
 * Same contract as seating.ts: no I/O, `now` is passed in, inputs are never mutated, and an
 * unchanged room is returned as the same object. None of them is a step of the hand, so
 * `host:undo` never reverses one.
 */
import {
  AWARD_CONFIRM_MS,
  DEFAULT_SEAT_HOLD_MINUTES,
  type ErrorCode,
  type HostSettingsPatch,
} from '@felt/protocol';
import { heldAgain } from './absence';
import { leave, NEXT_HAND_DELAY_MS, running } from './game';
import type { GameHand } from './gameSchema';
import type { RoomRecord } from './roomStore';
import { vacate, type SeatResult } from './seating';
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

/**
 * `host:pause`. The stored deadlines (award window, next hand) stay as they are but are ignored
 * while paused (`nextDeadline`), also after a restart. Every move, deal, award, dispute, undo,
 * stack correction and start is refused with `room_paused`. Seats, join requests, top-ups and the
 * other host controls go on working.
 */
export function pause(room: Readonly<RoomRecord>, userId: string): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  if (room.status === 'paused') return done(room);
  if (room.status !== 'playing') return refuse(room, 'illegal_action', 'the game has not started');
  return done({ ...room, status: 'paused' });
}

/**
 * `host:resume`. A waiting deadline starts again in full from now, so nobody loses part of their
 * time to dispute, and a deadline that passed during the pause does not fire at once.
 */
export function resume(room: Readonly<RoomRecord>, userId: string, now: number): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  if (room.status === 'playing') return done(room);
  if (room.status !== 'paused') return refuse(room, 'illegal_action', 'the game is not paused');
  const next: RoomRecord = { ...room, status: 'playing', ...heldAgain(room, now) };
  const { game } = room;
  if (!game) return done(next);
  const proposal = game.hand?.proposal;
  return done({
    ...next,
    game: {
      ...game,
      nextHandAt: game.nextHandAt === null ? null : now + NEXT_HAND_DELAY_MS,
      hand:
        game.hand && proposal && !proposal.disputed
          ? { ...game.hand, proposal: { ...proposal, confirmAt: now + AWARD_CONFIRM_MS } }
          : game.hand,
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
 * `host:kick`. First everything `room:leave` does (fold or keep live cards, cash out on the
 * ledger, drop top-ups), with the undo history emptied, then the admission goes. Coming back takes
 * a new join request (PRD 5.2), and the seating rules for a returning player apply to the chips.
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
  next = dropTopUps(next, targetId);
  const { [targetId]: session, ...sessions } = next.sessions ?? {};
  if (session !== undefined) next = { ...next, sessions };
  const { [targetId]: mark, ...away } = next.away ?? {};
  if (mark !== undefined) next = { ...next, away };
  return done({
    ...next,
    admitted: next.admitted.filter((id) => id !== targetId),
    requests: next.requests.filter((r) => r.userId !== targetId),
    kicked: [...(next.kicked ?? []).filter((id) => id !== targetId), targetId],
  });
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
 * deal; with no hand running it applies now, which is before the next hand too.
 */
export function changeBlinds(
  room: Readonly<RoomRecord>,
  userId: string,
  { smallBlind, bigBlind }: HostSettingsPatch,
): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  const { nextBlinds, ...rest } = room;
  const same = room.settings.smallBlind === smallBlind && room.settings.bigBlind === bigBlind;
  if (running(room)) {
    if (same) return done(nextBlinds ? rest : room);
    if (nextBlinds?.smallBlind === smallBlind && nextBlinds.bigBlind === bigBlind) {
      return done(room);
    }
    return done({ ...room, nextBlinds: { smallBlind, bigBlind } });
  }
  if (same && !nextBlinds) return done(room);
  return done({ ...rest, settings: { ...room.settings, smallBlind, bigBlind } });
}

/**
 * Cancel the hand in play: everyone gets back what they put into it, so it is as if it was never
 * dealt (no `hand_result` lines). Chips owed to a player who had already left follow them: onto
 * their new seat, or else another `cash_out` line.
 */
function voidHand(room: Readonly<RoomRecord>, hand: GameHand, now: number): RoomRecord {
  let { seats } = room;
  const lines: RoomRecord['ledger'] = [];
  for (const p of hand.state.players) {
    const gone = hand.departed.includes(p.playerId);
    const seat = seats.find((s) => s.userId === p.playerId);
    // A player who left has their stack already: only what is in the pot is still theirs.
    const stack = gone ? (seat?.stack ?? 0) + p.committed : p.stack + p.committed;
    if (seat) seats = seats.map((s) => (s === seat ? { ...s, stack } : s));
    else if (p.committed > 0) {
      lines.push({ t: now, userId: p.playerId, kind: 'cash_out', amount: p.committed });
    }
  }
  return { ...room, seats, ledger: [...room.ledger, ...lines] };
}

/**
 * `host:end`. The hand in play (if any) is cancelled, players who were leaving are cashed out, and
 * everything still waiting (join and top-up requests, queued top-ups, new blinds) is dropped.
 * Seats keep their final stacks: with the ledger they are what the recap is built from.
 */
export function end(room: Readonly<RoomRecord>, userId: string, now: number): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  const hand = running(room);
  let next = hand ? voidHand(room, hand, now) : (room as RoomRecord);
  for (const seat of next.seats.filter((s) => s.leaving)) next = vacate(next, seat.userId, now);
  const { nextBlinds, game, ...rest } = next;
  void nextBlinds;
  return done({
    ...rest,
    status: 'ended',
    requests: [],
    topUpRequests: [],
    pendingTopUps: [],
    ...(game ? { game: { button: game.button, hand: null, nextHandAt: null } } : {}),
  });
}
