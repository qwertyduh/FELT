/**
 * Pure hybrid hand lifecycle over a RoomRecord (P33). Same contract as seating.ts: no I/O, `now`
 * and ids are passed in, inputs are never mutated, and an unchanged room is returned as the same
 * object. Poker rules live in the engine; this maps room intents onto it and keeps chips in step.
 *
 * Chips: after every engine step each dealt-in player's seat holds their engine stack, so at all
 * times `buy-ins - cash-outs = seat stacks + chips in the pot`.
 *
 * Time: deadlines (`proposal.confirmAt`, `nextHandAt`) are absolute and stored in the room.
 * `tick` applies whatever is due; it is safe to call at any moment and any number of times.
 */
import {
  applyAction,
  applyHostAction,
  foldOut,
  isBettingComplete,
  startHand,
  type EngineError,
  type HandState,
  type PlayerAction,
  type Result,
  type Transition,
} from '@felt/engine';
import { AWARD_CONFIRM_MS, type ClientEventPayload, type ErrorCode } from '@felt/protocol';
import type { Game, GameHand } from './gameSchema';
import type { RoomRecord } from './roomStore';
import { leaveSeat, type SeatResult } from './seating';

export const NEXT_HAND_DELAY_MS = 5_000;

export interface GameContext {
  now: number;
  newId: () => string;
}

export type GameResult = SeatResult;

const NO_GAME: Game = { button: null, hand: null, nextHandAt: null };

const done = (room: Readonly<RoomRecord>): GameResult => ({
  room: room as RoomRecord,
  refused: null,
});
const refuse = (room: Readonly<RoomRecord>, code: ErrorCode, message: string): GameResult => ({
  room: room as RoomRecord,
  refused: { code, message },
});
const engineRefusal = (room: Readonly<RoomRecord>, e: EngineError): GameResult =>
  refuse(room, e.code, e.message.slice(0, 300));

/** The hand still being played (not one that ended and is waiting for the next). */
function running(room: Readonly<RoomRecord>): GameHand | null {
  const hand = room.game?.hand;
  return hand && hand.state.street !== 'ended' ? hand : null;
}

/** The user's player in this hand, unless they gave up that seat. */
const playerOf = (hand: GameHand, userId: string) =>
  hand.departed.includes(userId)
    ? undefined
    : hand.state.players.find((p) => p.playerId === userId);

/** Seat stacks follow the engine for everyone still holding the seat they were dealt in. */
function syncStacks(room: Readonly<RoomRecord>, hand: GameHand): RoomRecord['seats'] {
  return room.seats.map((s) => {
    const p = playerOf(hand, s.userId);
    return p && p.stack !== s.stack ? { ...s, stack: p.stack } : s;
  });
}

/** The hand is over: write its ledger lines, free seats that were leaving, schedule the next. */
function finishHand(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const game = room.game!;
  const hand = game.hand!;
  const won = new Map<string, number>();
  for (const award of hand.state.result!.awards) {
    for (const [id, amount] of Object.entries(award.amounts)) {
      won.set(id, (won.get(id) ?? 0) + amount);
    }
  }
  // One line per player dealt in; `amount` is what they won from the pots (0 for a loss).
  const lines: RoomRecord['ledger'] = hand.state.players.map((p) => ({
    t: now,
    userId: p.playerId,
    kind: 'hand_result',
    amount: won.get(p.playerId) ?? 0,
    note: hand.handId,
  }));
  let next: RoomRecord = {
    ...room,
    ledger: [...room.ledger, ...lines],
    game: { ...game, hand: { ...hand, proposal: null }, nextHandAt: now + NEXT_HAND_DELAY_MS },
  };
  for (const seat of next.seats.filter((s) => s.leaving)) {
    next = leaveSeat(next, seat.userId, now).room;
  }
  return next;
}

/**
 * Store an engine step: state, stacks and, if it ended the hand, the end-of-hand bookkeeping.
 * `leaver` gives up their seat in this same step, cashed out with their stack after it.
 *
 * Chips the engine hands back to a player who had already left (folded money nobody covered)
 * follow them: onto their new seat, or else another `cash_out` line.
 */
function advanceTo(
  room: Readonly<RoomRecord>,
  state: HandState,
  now: number,
  leaver?: string,
): RoomRecord {
  const before = room.game!.hand!;
  let hand: GameHand = { ...before, state, turnSeq: (before.turnSeq ?? 0) + 1 };
  let next: RoomRecord = { ...room, seats: syncStacks(room, hand) };
  if (leaver !== undefined) {
    next = leaveSeat(next, leaver, now).room;
    hand = { ...hand, departed: [...hand.departed, leaver] };
  }
  for (const id of before.departed) {
    const stackIn = (s: HandState) => s.players.find((p) => p.playerId === id)!.stack;
    const amount = stackIn(state) - stackIn(before.state);
    if (amount <= 0) continue;
    next = next.seats.some((s) => s.userId === id)
      ? {
          ...next,
          seats: next.seats.map((s) => (s.userId === id ? { ...s, stack: s.stack + amount } : s)),
        }
      : { ...next, ledger: [...next.ledger, { t: now, userId: id, kind: 'cash_out', amount }] };
  }
  next = { ...next, game: { ...room.game!, hand } };
  return state.street === 'ended' ? finishHand(next, now) : next;
}

/** Deal a hand to everyone seated with chips and not sitting out. */
function deal(room: Readonly<RoomRecord>, ctx: GameContext): Result<RoomRecord> {
  const { maxSeats, smallBlind, bigBlind } = room.settings;
  const last = room.game?.button ?? null;
  const seats = Array.from({ length: maxSeats }, (_, i) => {
    const s = room.seats.find((x) => x.seat === i);
    return s ? { playerId: s.userId, stack: s.stack, sittingOut: s.sittingOut } : null;
  });
  const button = last !== null && last < maxSeats ? last : null;
  const r: Result<Transition> = startHand(
    { mode: 'hybrid', seats, button, smallBlind, bigBlind },
    null,
  );
  if (!r.ok) return r;
  const state = r.value.state;
  const hand: GameHand = {
    handId: ctx.newId(),
    turnSeq: 0,
    state,
    departed: [],
    proposal: null,
  };
  const next: RoomRecord = {
    ...room,
    status: 'playing',
    game: { button: state.button, hand, nextHandAt: null },
  };
  return { ok: true, value: { ...next, seats: syncStacks(next, hand) } };
}

/** The earliest stored deadline, or null. */
export function nextDeadline(room: Readonly<RoomRecord>): number | null {
  if (room.status !== 'playing' || !room.game) return null;
  const { hand, nextHandAt } = room.game;
  const confirm = hand?.proposal && !hand.proposal.disputed ? hand.proposal.confirmAt : null;
  const all = [confirm, nextHandAt].filter((t): t is number => t !== null);
  return all.length ? Math.min(...all) : null;
}

/** Apply the due deadline: confirm an undisputed award, or deal the next hand. */
export function tick(room: Readonly<RoomRecord>, ctx: GameContext): RoomRecord {
  const due = nextDeadline(room);
  if (due === null || due > ctx.now) return room as RoomRecord;
  const game = room.game!;
  const proposal = game.hand?.proposal;
  if (proposal && !proposal.disputed) {
    let state = game.hand!.state;
    for (const award of proposal.awards) {
      const r = applyHostAction(state, { type: 'award_pot', ...award });
      if (!r.ok) {
        // Validated when proposed and the pots cannot change since; drop it rather than loop.
        return { ...room, game: { ...game, hand: { ...game.hand!, proposal: null } } };
      }
      state = r.value.state;
    }
    return advanceTo(room, state, ctx.now);
  }
  const dealt = deal(room, ctx);
  if (dealt.ok) return dealt.value;
  // Not enough players: stop here until the host starts again.
  return { ...room, game: { ...game, hand: null, nextHandAt: null } };
}

/** Checks shared by every game intent. */
function gate(room: Readonly<RoomRecord>, userId: string): GameResult | null {
  if (!room.admitted.includes(userId)) {
    return refuse(room, 'not_admitted', 'not admitted to this room');
  }
  if (room.status === 'ended') return refuse(room, 'room_ended', 'room has ended');
  if (room.status === 'paused') return refuse(room, 'room_paused', 'the game is paused');
  return null;
}

function hostGate(room: Readonly<RoomRecord>, userId: string): GameResult | null {
  const gated = gate(room, userId);
  if (gated) return gated;
  return room.hostId === userId ? null : refuse(room, 'not_host', 'only the host can do that');
}

/** The hand an intent is about, or why it no longer applies. */
function current(
  room: Readonly<RoomRecord>,
  handId: string,
): { hand: GameHand } | { refused: GameResult } {
  const hand = room.game?.hand;
  if (!hand) return { refused: refuse(room, 'no_hand', 'no hand is running') };
  if (hand.handId !== handId) {
    return { refused: refuse(room, 'stale_hand', 'that hand is over') };
  }
  if (hand.state.street === 'ended') {
    return { refused: refuse(room, 'hand_ended', 'the hand has ended') };
  }
  return { hand };
}

/** `host:start`: the first hand, or a restart after play stopped for lack of players. */
export function start(room: Readonly<RoomRecord>, userId: string, ctx: GameContext): GameResult {
  const gated = hostGate(room, userId);
  if (gated) return gated;
  if (room.settings.mode !== 'hybrid') {
    return refuse(room, 'wrong_mode', 'online dealing is not available yet');
  }
  if (running(room) || (room.game?.nextHandAt ?? null) !== null) {
    return refuse(room, 'illegal_action', 'the game is already running');
  }
  const dealt = deal({ ...room, game: room.game ?? NO_GAME }, ctx);
  return dealt.ok ? done(dealt.value) : engineRefusal(room, dealt.error);
}

/** `game:act`. Only the player on turn is accepted (the engine enforces it). */
export function act(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'game:act'>,
  ctx: GameContext,
): GameResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  const found = current(room, intent.handId);
  if ('refused' in found) return found.refused;
  if (!playerOf(found.hand, userId)) {
    return refuse(room, 'not_seated', 'you are not in this hand');
  }
  if (intent.turnSeq !== (found.hand.turnSeq ?? 0)) {
    return refuse(room, 'stale_hand', 'the table has moved on');
  }
  const action: PlayerAction =
    intent.type === 'bet' || intent.type === 'raise'
      ? { type: intent.type, playerId: userId, amount: intent.amount }
      : { type: intent.type, playerId: userId };
  const r = applyAction(found.hand.state, action);
  return r.ok ? done(advanceTo(room, r.value.state, ctx.now)) : engineRefusal(room, r.error);
}

/** `host:advance_street`. */
export function advance(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'host:advance_street'>,
  ctx: GameContext,
): GameResult {
  const gated = hostGate(room, userId);
  if (gated) return gated;
  const found = current(room, intent.handId);
  if ('refused' in found) return found.refused;
  if (found.hand.state.street !== intent.street) {
    return refuse(room, 'stale_hand', 'that street has already been dealt');
  }
  if (intent.turnSeq !== (found.hand.turnSeq ?? 0)) {
    return refuse(room, 'stale_hand', 'the table has moved on');
  }
  const r = applyHostAction(found.hand.state, {
    type: 'advance_street',
    ...(intent.cards ? { cards: intent.cards } : {}),
  });
  return r.ok ? done(advanceTo(room, r.value.state, ctx.now)) : engineRefusal(room, r.error);
}

type Award = ClientEventPayload<'host:award'>['awards'][number];
const awardKey = (awards: readonly Award[]): string =>
  JSON.stringify(
    awards.map((a) => [a.potId, [...a.winners].sort()]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
  );

/** A new or newly disputed proposal is a change to the hand, so it moves `turnSeq`. */
const withProposal = (
  room: Readonly<RoomRecord>,
  hand: GameHand,
  proposal: GameHand['proposal'],
): RoomRecord => ({
  ...room,
  game: { ...room.game!, hand: { ...hand, proposal, turnSeq: (hand.turnSeq ?? 0) + 1 } },
});

/**
 * `host:award`: propose the whole result (every pot at once). Nothing moves until it has stood
 * for the dispute window. Sending the result already pending changes nothing (no timer reset).
 * Anything else must quote the current `turnSeq`, which proposing and disputing both bump: so a
 * late duplicate cannot undo a dispute, and a stale screen cannot replace a newer proposal.
 */
export function proposeAward(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'host:award'>,
  ctx: GameContext,
): GameResult {
  const gated = hostGate(room, userId);
  if (gated) return gated;
  const found = current(room, intent.handId);
  if ('refused' in found) return found.refused;
  const { hand } = found;
  const old = hand.proposal;
  if (old && !old.disputed && awardKey(old.awards) === awardKey(intent.awards)) return done(room);
  if (intent.turnSeq !== (hand.turnSeq ?? 0)) {
    return refuse(room, 'stale_hand', 'the table has moved on');
  }
  // Dry run on the engine: winners eligible, pots known, none twice.
  let state = hand.state;
  for (const award of intent.awards) {
    const r = applyHostAction(state, { type: 'award_pot', ...award });
    if (!r.ok) return engineRefusal(room, r.error);
    state = r.value.state;
  }
  if (state.street !== 'ended') {
    return refuse(room, 'invalid_winners', 'choose the winners of every pot');
  }
  const proposal = {
    awards: intent.awards.map((a) => ({ potId: a.potId, winners: [...a.winners] })),
    confirmAt: ctx.now + AWARD_CONFIRM_MS,
    disputed: false,
  };
  return done(withProposal(room, hand, proposal));
}

/**
 * `host:dispute`: any seated player, or the host (to correct a mis-tap), blocks the pending result
 * until the host proposes again.
 */
export function dispute(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'host:dispute'>,
): GameResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  if (room.hostId !== userId && !room.seats.some((s) => s.userId === userId)) {
    return refuse(room, 'not_seated', 'only seated players can dispute');
  }
  const found = current(room, intent.handId);
  if ('refused' in found) return found.refused;
  const { proposal } = found.hand;
  if (!proposal) return refuse(room, 'illegal_action', 'there is no award to dispute');
  if (proposal.disputed) return done(room);
  return done(withProposal(room, found.hand, { ...proposal, disputed: true }));
}

/**
 * Whether a leaver's cards stay in play: all-in, at showdown, or nothing left to bet (an all-in
 * run-out), so they cannot be made to forfeit a hand they have already paid to see through.
 */
function handStaysLive(state: HandState, seat: number, status: string): boolean {
  if (status === 'all_in' || state.street === 'showdown') return true;
  const canAct = state.players.filter((p) => p.status === 'active').length;
  return canAct < 2 && state.currentActor !== seat && isBettingComplete(state);
}

/**
 * `room:leave`, also during a hand. Standard rule: leaving folds your hand at once; chips others
 * have bet against stay in the pot, and you take the rest, including any uncalled part of your bet
 * (engine `foldOut`). If your cards stay live (see above)
 * the seat is kept until the hand ends and is then cashed out. Players who are not in the running
 * hand, or have folded, leave immediately.
 */
export function leave(room: Readonly<RoomRecord>, userId: string, now: number): GameResult {
  const hand = running(room);
  const player = hand ? playerOf(hand, userId) : undefined;
  const seated = room.seats.find((s) => s.userId === userId);
  // `leaveSeat` also does the gate checks and the not-seated refusal.
  if (!hand || !player || !seated) return leaveSeat(room, userId, now);
  if (!room.admitted.includes(userId) || room.status === 'ended') {
    return leaveSeat(room, userId, now);
  }
  if (seated.leaving) return done(room);

  let state = hand.state;
  if (player.status !== 'folded') {
    if (handStaysLive(state, player.seat, player.status)) {
      return done({
        ...room,
        seats: room.seats.map((s) =>
          s === seated ? { ...s, sittingOut: true, leaving: true } : s,
        ),
      });
    }
    const r = foldOut(state, userId);
    if (!r.ok) return engineRefusal(room, r.error);
    state = r.value.state;
  }
  return done(advanceTo(room, state, now, userId));
}
