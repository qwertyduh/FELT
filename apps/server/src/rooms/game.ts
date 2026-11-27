/**
 * Hand lifecycle over a RoomRecord, hybrid (P33) and online (P47). Same contract as seating.ts: no
 * I/O, `now`, ids and the shuffle's randomness are passed in (the latter defaults to
 * `crypto.randomInt`), inputs are never mutated, and an unchanged room is returned as the same
 * object. Poker rules live in the engine; this maps room intents onto it and keeps chips in step.
 *
 * Online: the shuffled deck is dealt by the engine, which also moves the streets on and settles the
 * showdown by itself. Deck and hole cards live in `game.hand.state`; see reveal.ts for what of
 * them may ever leave the server.
 *
 * Chips: after every engine step each dealt-in player's seat holds their engine stack, so at all
 * times `buy-ins - cash-outs = seat stacks + chips in the pot`.
 *
 * Time: deadlines (`turnDeadline`, `proposal.confirmAt`, `nextHandAt`) are absolute and stored in
 * the room. `tick` applies whatever is due; it is safe to call at any moment and any number of
 * times.
 *
 * Turn clock (P48, turnClock.ts): every new turn gets a full clock. When it runs out the player
 * checks if they can and folds if not; twice in a row sits them out from the next hand.
 */
import { randomInt } from 'node:crypto';
import {
  advanceStreet,
  applyAction,
  applyHostAction,
  createDeck,
  foldOut,
  leaveOutlook,
  legalActions,
  shuffle,
  startHand,
  type EngineError,
  type HandState,
  type PlayerAction,
  type RandInt,
  type Result,
  type Transition,
} from '@felt/engine';
import {
  AWARD_CONFIRM_MS,
  MAX_CHIPS,
  ROOM_LOG_LIMIT,
  type ClientEventPayload,
  type ErrorCode,
  type RoomLogEntry,
} from '@felt/protocol';
import { dealBlinds } from './blinds';
import { UNDO_DEPTH, type Game, type GameHand, type UndoEntry } from './gameSchema';
import { shownHands } from './reveal';
import type { RoomRecord } from './roomStore';
import { leaveSeat, vacate, type SeatResult } from './seating';
import { applyTopUps, dropTopUps } from './topUps';
import { TIMEOUTS_TO_SIT_OUT, freshClock, onTheClock } from './turnClock';

export const NEXT_HAND_DELAY_MS = 5_000;
/** Online, after a showdown: time to read the hands before the next deal. */
export const SHOWDOWN_DELAY_MS = 8_000;
/** Online, added per street a client still has to turn over after an all-in run-out. */
export const RUNOUT_STEP_MS = 2_000;
/** A voluntary show leaves the table at least this long to see it. */
export const SHOW_LINGER_MS = 3_000;

export interface GameContext {
  now: number;
  newId: () => string;
  /** Shuffle randomness; omitted (always, outside tests): `crypto.randomInt`. */
  randInt?: RandInt;
}

const secureRandInt: RandInt = (max) => randomInt(max);

const RUNOUT_STREETS = { 0: 3, 3: 2, 4: 1 } as const;

/** How long an ended hand stays on the table. */
export function nextHandDelay(hand: GameHand): number {
  const { mode, result } = hand.state;
  if (mode !== 'online' || !result?.showdown.length) return NEXT_HAND_DELAY_MS;
  const streets = hand.runoutFrom === undefined ? 0 : RUNOUT_STREETS[hand.runoutFrom];
  return SHOWDOWN_DELAY_MS + streets * RUNOUT_STEP_MS;
}

/**
 * An online hand that went to showdown in a step that still had board cards to come was run out:
 * the engine only does that once nobody can bet any more.
 */
function runout(boardBefore: number, state: HandState): Pick<GameHand, 'runoutFrom'> {
  if (state.mode !== 'online' || !state.result?.showdown.length) return {};
  return boardBefore === 0 || boardBefore === 3 || boardBefore === 4
    ? { runoutFrom: boardBefore }
    : {};
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
export function running(room: Readonly<RoomRecord>): GameHand | null {
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
    // A hand that has ended is final: nothing of it can be undone.
    game: {
      ...game,
      hand: { ...hand, proposal: null, undo: [] },
      nextHandAt: now + nextHandDelay(hand),
    },
  };
  // `vacate`: a player removed by the host is no longer admitted, but is still cashed out.
  for (const seat of next.seats.filter((s) => s.leaving)) {
    next = vacate(next, seat.userId, now);
  }
  return next;
}

function snapshot(
  state: HandState,
  move: UndoEntry['move'],
  timeout?: UndoEntry['timeout'],
): UndoEntry {
  return {
    move,
    ...(timeout ? { timeout } : {}),
    street: state.street,
    board: [...state.board],
    players: state.players.map(({ stack, bet, committed, status, hasActed, facedBet }) => ({
      stack,
      bet,
      committed,
      status,
      hasActed,
      facedBet,
    })),
    currentBet: state.currentBet,
    lastFullRaise: state.lastFullRaise,
    ...(state.raises ? { raises: state.raises.map((r) => ({ ...r, acted: [...r.acted] })) } : {}),
    currentActor: state.currentActor,
    pots: state.pots.map((p) => ({ id: p.id, amount: p.amount, eligible: [...p.eligible] })),
  };
}

/** The hand as it was at `entry`; who is in it, their seats and the blinds never change. */
function restore(state: HandState, entry: UndoEntry): HandState {
  const { move, timeout, players, raises, ...table } = entry;
  void move;
  void timeout;
  const { raises: later, ...rest } = state;
  void later;
  return {
    ...rest,
    ...table,
    ...(raises ? { raises } : {}),
    players: state.players.map((p, i) => ({ ...p, ...players[i]! })),
  };
}

const chipsIn = (state: HandState): number =>
  state.players.reduce((sum, p) => sum + p.stack + p.committed, 0);

type NewLogEntry = RoomLogEntry extends infer E
  ? E extends unknown
    ? Omit<E, 'id'>
    : never
  : never;

function logged(room: Readonly<RoomRecord>, entry: NewLogEntry): RoomRecord {
  const log = room.log ?? [];
  const id = (log.at(-1)?.id ?? 0) + 1;
  return { ...room, log: [...log, { ...entry, id } as RoomLogEntry].slice(-ROOM_LOG_LIMIT) };
}

/**
 * Store an engine step: state, stacks and, if it ended the hand, the end-of-hand bookkeeping.
 * `leaver` gives up their seat in this same step, cashed out with their stack after it.
 *
 * Chips the engine hands back to a player who had already left (folded money nobody covered)
 * follow them: onto their new seat, or else another `cash_out` line.
 *
 * `move` makes the step undoable. A step without one (someone leaving), or one that paid out to a
 * player who had left, empties the history instead: an undo must never go back past a departure,
 * or it would bring the player back or take back chips already cashed out.
 *
 * The player now on turn gets a full clock, except that somebody else leaving does not give the
 * same turn more time.
 */
function advanceTo(
  room: Readonly<RoomRecord>,
  state: HandState,
  now: number,
  {
    leaver,
    move,
    timeout,
  }: { leaver?: string; move?: UndoEntry['move']; timeout?: UndoEntry['timeout'] } = {},
): RoomRecord {
  const before = room.game!.hand!;
  let hand: GameHand = {
    ...before,
    state,
    turnSeq: (before.turnSeq ?? 0) + 1,
    ...runout(before.state.board.length, state),
  };
  const sameTurn =
    leaver !== undefined &&
    state.street === before.state.street &&
    state.currentActor === before.state.currentActor;
  if (!sameTurn) hand = freshClock(room, hand, now);
  let next: RoomRecord = { ...room, seats: syncStacks(room, hand) };
  if (leaver !== undefined) {
    next = leaveSeat(next, leaver, now).room;
    hand = { ...hand, departed: [...hand.departed, leaver] };
  }
  let paidOut = false;
  for (const id of before.departed) {
    const stackIn = (s: HandState) => s.players.find((p) => p.playerId === id)!.stack;
    const amount = stackIn(state) - stackIn(before.state);
    if (amount <= 0) continue;
    paidOut = true;
    next = next.seats.some((s) => s.userId === id)
      ? {
          ...next,
          seats: next.seats.map((s) => (s.userId === id ? { ...s, stack: s.stack + amount } : s)),
        }
      : { ...next, ledger: [...next.ledger, { t: now, userId: id, kind: 'cash_out', amount }] };
  }
  const undo =
    move && !paidOut && room.settings.mode === 'hybrid'
      ? [...(before.undo ?? []), snapshot(before.state, move, timeout)].slice(-UNDO_DEPTH)
      : [];
  next = { ...next, game: { ...room.game!, hand: { ...hand, undo } } };
  return state.street === 'ended' ? finishHand(next, now) : next;
}

/**
 * Deal a hand to everyone seated with chips and not sitting out. Approved top-ups are added first,
 * as part of the same change: if no hand can be dealt, they stay queued.
 */
function deal(before: Readonly<RoomRecord>, ctx: GameContext): Result<RoomRecord> {
  const room = dealBlinds(applyTopUps(before, ctx.now), ctx.now);
  const { maxSeats, smallBlind, bigBlind } = room.settings;
  const last = room.game?.button ?? null;
  const seats = Array.from({ length: maxSeats }, (_, i) => {
    const s = room.seats.find((x) => x.seat === i);
    return s ? { playerId: s.userId, stack: s.stack, sittingOut: s.sittingOut } : null;
  });
  const button = last !== null && last < maxSeats ? last : null;
  const { mode } = room.settings;
  const deck = mode === 'online' ? shuffle(createDeck(), ctx.randInt ?? secureRandInt) : null;
  const r: Result<Transition> = startHand({ mode, seats, button, smallBlind, bigBlind }, deck);
  if (!r.ok) return r;
  let state = r.value.state;
  // The blinds can put everyone all-in: then there is nothing to wait for.
  if (mode === 'online' && state.currentActor === null) {
    const ran = advanceStreet(state);
    if (!ran.ok) return ran;
    state = ran.value.state;
  }
  const playing: RoomRecord = { ...room, status: 'playing' };
  const hand = freshClock(
    playing,
    {
      handId: ctx.newId(),
      turnSeq: 0,
      state,
      departed: [],
      proposal: null,
      ...runout(0, state),
    },
    ctx.now,
  );
  let next: RoomRecord = {
    ...playing,
    game: { button: state.button, hand, nextHandAt: null },
  };
  next = { ...next, seats: syncStacks(next, hand) };
  return { ok: true, value: state.street === 'ended' ? finishHand(next, ctx.now) : next };
}

/**
 * The earliest stored deadline, or null. A turn that should be timed and has no clock (a hand
 * stored before there was one) is due at once, to be given one.
 */
export function nextDeadline(room: Readonly<RoomRecord>): number | null {
  if (room.status !== 'playing' || !room.game) return null;
  const { hand, nextHandAt } = room.game;
  if (hand && onTheClock(room, hand)) return hand.turnDeadline ?? 0;
  const confirm = hand?.proposal && !hand.proposal.disputed ? hand.proposal.confirmAt : null;
  const all = [confirm, nextHandAt].filter((t): t is number => t !== null);
  return all.length ? Math.min(...all) : null;
}

/**
 * The turn has run out (PRD 5.4): check if that is free, otherwise fold. Counts against the player,
 * and `TIMEOUTS_TO_SIT_OUT` in a row sit them out. Hybrid: the host can undo it like any move.
 */
function timeOut(room: Readonly<RoomRecord>, now: number): RoomRecord {
  const hand = room.game!.hand!;
  const me = hand.state.players.find((p) => p.seat === hand.state.currentActor)!;
  const action = legalActions(hand.state)?.check ? 'check' : 'fold';
  const r = applyAction(hand.state, { type: action, playerId: me.playerId });
  if (!r.ok) {
    // Not expected of a player on turn. Give the turn again rather than retry without end.
    return { ...room, game: { ...room.game!, hand: freshClock(room, hand, now) } };
  }
  const seat = room.seats.find((s) => s.userId === me.playerId)!;
  const strikes = seat.timeouts ?? 0;
  const satOut = !seat.sittingOut && strikes + 1 >= TIMEOUTS_TO_SIT_OUT;
  const struck: RoomRecord = {
    ...room,
    seats: room.seats.map((s) =>
      s === seat ? { ...s, timeouts: strikes + 1, sittingOut: s.sittingOut || satOut } : s,
    ),
  };
  return advanceTo(struck, r.value.state, now, {
    move: { action, userId: me.playerId },
    timeout: { strikes, satOut },
  });
}

/**
 * Apply the due deadline: run out the turn (or start a missing clock), confirm an undisputed award,
 * or deal the next hand. Whatever is due is read from the room as it is now, so a timer set for an
 * earlier turn does nothing to a later one.
 */
export function tick(room: Readonly<RoomRecord>, ctx: GameContext): RoomRecord {
  const due = nextDeadline(room);
  if (due === null || due > ctx.now) return room as RoomRecord;
  const game = room.game!;
  if (game.hand && onTheClock(room, game.hand)) {
    if (game.hand.turnDeadline !== undefined) return timeOut(room, ctx.now);
    return { ...room, game: { ...game, hand: freshClock(room, game.hand, ctx.now) } };
  }
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
  const move = { action: intent.type, userId };
  if (!r.ok) return engineRefusal(room, r.error);
  const was = found.hand.state;
  const now = r.value.state;
  // Acting in time ends any run of timeouts.
  const heard: RoomRecord = {
    ...room,
    seats: room.seats.map((s) => {
      if (s.userId !== userId || s.timeouts === undefined) return s;
      const { timeouts, ...seat } = s;
      void timeouts;
      return seat;
    }),
  };
  let next = advanceTo(heard, now, ctx.now, { move });
  if (now.mode === 'online' && was.street === 'river' && now.currentBet > was.currentBet) {
    // A raise leaves the betting open, so the hand is still the one in `next`.
    const hand = { ...next.game!.hand!, aggressor: userId };
    next = { ...next, game: { ...next.game!, hand } };
  }
  return done(next);
}

/** Online rooms run their own streets and showdowns. */
const hybridOnly = (room: Readonly<RoomRecord>, what: string): GameResult | null =>
  room.settings.mode === 'hybrid' ? null : refuse(room, 'wrong_mode', what);

/**
 * `hand:show` (online): turn your own cards face up once the hand has ended, whether you won it,
 * mucked at showdown or folded. Nothing but the sender's own cards, nothing once the next hand is
 * dealt. Showing twice, or what the rules already show, changes nothing. Allowed while paused: no
 * chips move.
 */
export function show(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'hand:show'>,
  ctx: GameContext,
): GameResult {
  if (!room.admitted.includes(userId)) {
    return refuse(room, 'not_admitted', 'not admitted to this room');
  }
  if (room.status === 'ended') return refuse(room, 'room_ended', 'room has ended');
  if (room.settings.mode !== 'online') {
    return refuse(room, 'wrong_mode', 'cards are only shown in online games');
  }
  const game = room.game;
  const hand = game?.hand;
  if (!game || !hand) return refuse(room, 'no_hand', 'no hand is running');
  if (hand.handId !== intent.handId) return refuse(room, 'stale_hand', 'that hand is over');
  if (hand.state.street !== 'ended') {
    return refuse(room, 'illegal_action', 'cards can be shown after the hand ends');
  }
  if (!hand.state.players.some((p) => p.playerId === userId && p.hole)) {
    return refuse(room, 'not_seated', 'you were not dealt into this hand');
  }
  if (shownHands(hand.state, hand).some((h) => h.userId === userId)) return done(room);
  return done({
    ...room,
    game: {
      ...game,
      hand: { ...hand, shown: [...(hand.shown ?? []), userId] },
      nextHandAt:
        game.nextHandAt === null ? null : Math.max(game.nextHandAt, ctx.now + SHOW_LINGER_MS),
    },
  });
}

/** `host:advance_street`. */
export function advance(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'host:advance_street'>,
  ctx: GameContext,
): GameResult {
  const gated =
    hostGate(room, userId) ?? hybridOnly(room, 'online games deal the streets themselves');
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
  const move = { action: 'deal' as const, userId: null };
  return r.ok
    ? done(advanceTo(room, r.value.state, ctx.now, { move }))
    : engineRefusal(room, r.error);
}

/**
 * `host:force_fold`: with the turn timer off, the game waits on a disconnected player until the
 * host folds for them (PRD 5.10). It must be their turn in the very state the host saw. Like a
 * departure it empties the undo history, so it is never taken back.
 */
export function forceFold(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'host:force_fold'>,
  connected: boolean,
  ctx: GameContext,
): GameResult {
  const gated = hostGate(room, userId);
  if (gated) return gated;
  const found = current(room, intent.handId);
  if ('refused' in found) return found.refused;
  const { hand } = found;
  if (intent.turnSeq !== (hand.turnSeq ?? 0)) {
    return refuse(room, 'stale_hand', 'the table has moved on');
  }
  if (room.settings.turnTimerSeconds !== null) {
    return refuse(room, 'illegal_action', 'only when the turn timer is off');
  }
  const player = playerOf(hand, intent.userId);
  if (!player || player.seat !== hand.state.currentActor) {
    return refuse(room, 'stale_hand', 'it is not their turn');
  }
  if (connected) return refuse(room, 'illegal_action', 'that player is connected');
  const r = applyAction(hand.state, { type: 'fold', playerId: intent.userId });
  if (!r.ok) return engineRefusal(room, r.error);
  const seat = room.seats.find((s) => s.userId === intent.userId)!;
  return done(
    logged(advanceTo(room, r.value.state, ctx.now), {
      kind: 'force_fold',
      at: ctx.now,
      username: seat.username,
      street: hand.state.street,
    }),
  );
}

/**
 * `host:undo` (hybrid): take back the last move or deal of the running hand. `turnSeq` goes up,
 * never back, so nothing sent for an earlier state can land. A pending award must be stopped
 * (disputed) first; a disputed one is dropped. A hand that has ended cannot be undone.
 */
export function undo(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'host:undo'>,
  ctx: GameContext,
): GameResult {
  const gated = hostGate(room, userId);
  if (gated) return gated;
  if (room.settings.mode !== 'hybrid') {
    return refuse(room, 'wrong_mode', 'only hybrid games can be undone');
  }
  const found = current(room, intent.handId);
  if ('refused' in found) return found.refused;
  const { hand } = found;
  if (intent.turnSeq !== (hand.turnSeq ?? 0)) {
    return refuse(room, 'stale_hand', 'the table has moved on');
  }
  if (hand.proposal && !hand.proposal.disputed) {
    return refuse(room, 'illegal_action', 'stop the pending award first');
  }
  const entry = hand.undo?.at(-1);
  if (!entry) return refuse(room, 'illegal_action', 'there is nothing to undo');
  const state = restore(hand.state, entry);
  // Every way chips leave or join a hand empties the history; never restore one that disagrees.
  if (
    entry.players.length !== hand.state.players.length ||
    chipsIn(state) !== chipsIn(hand.state)
  ) {
    return refuse(room, 'invalid_state', 'that step can no longer be undone');
  }
  // Whoever is on turn again gets a full clock.
  const restored: GameHand = freshClock(
    room,
    {
      ...hand,
      state,
      turnSeq: (hand.turnSeq ?? 0) + 1,
      proposal: null,
      undo: hand.undo!.slice(0, -1),
    },
    ctx.now,
  );
  // Taking back a timeout takes back its strike, and the sitting out it caused.
  const { timeout } = entry;
  const seats = syncStacks(room, restored).map((s) =>
    timeout && s.userId === entry.move.userId && !s.leaving
      ? { ...s, timeouts: timeout.strikes, sittingOut: timeout.satOut ? false : s.sittingOut }
      : s,
  );
  const next: RoomRecord = {
    ...room,
    seats,
    game: { ...room.game!, hand: restored },
  };
  const mover = room.seats.find((s) => s.userId === entry.move.userId);
  return done(
    logged(next, {
      kind: 'undo',
      at: ctx.now,
      action: entry.move.action,
      username: mover?.username ?? null,
      street: entry.move.action === 'deal' ? hand.state.street : entry.street,
    }),
  );
}

/**
 * `host:adjust_stack` (hybrid, once the game has started): correct a seated player's stack by a
 * signed amount, with a ledger `adjust` line and a room log entry.
 *
 * Not while the player is still contesting the running hand (active or all-in): their stack is
 * part of the betting. Between hands, before they are dealt in, or after they fold is fine; after
 * they fold, the hand's undo history goes, so an undo cannot reverse the correction.
 */
export function adjustStack(
  room: Readonly<RoomRecord>,
  userId: string,
  intent: ClientEventPayload<'host:adjust_stack'>,
  ctx: GameContext,
): GameResult {
  const gated = hostGate(room, userId);
  if (gated) return gated;
  if (room.settings.mode !== 'hybrid') {
    return refuse(room, 'wrong_mode', 'stacks can only be corrected in hybrid games');
  }
  if (room.status !== 'playing') {
    return refuse(room, 'illegal_action', 'the game has not started');
  }
  const seat = room.seats.find((s) => s.userId === intent.userId);
  if (!seat) return refuse(room, 'not_seated', 'that player has no seat');
  if (seat.stack !== intent.stack) return refuse(room, 'stale_hand', 'that stack has changed');
  const hand = running(room);
  const player = hand ? playerOf(hand, seat.userId) : undefined;
  if (player && player.status !== 'folded') {
    return refuse(room, 'illegal_action', 'that player is still in this hand');
  }
  const stack = seat.stack + intent.amount;
  if (stack < 0 || (intent.amount > 0 && stack > MAX_CHIPS)) {
    return refuse(room, 'invalid_amount', `a stack must stay between 0 and ${MAX_CHIPS}`);
  }
  const line: RoomRecord['ledger'][number] = {
    t: ctx.now,
    userId: seat.userId,
    kind: 'adjust',
    amount: intent.amount,
    note: intent.reason,
  };
  let next: RoomRecord = {
    ...room,
    seats: room.seats.map((s) => (s === seat ? { ...s, stack } : s)),
    ledger: [...room.ledger, line],
  };
  if (hand && player) {
    const players = hand.state.players.map((p) => (p === player ? { ...p, stack } : p));
    const corrected: GameHand = { ...hand, state: { ...hand.state, players }, undo: [] };
    next = { ...next, game: { ...next.game!, hand: corrected } };
  }
  return done(
    logged(next, {
      kind: 'adjust',
      at: ctx.now,
      username: seat.username,
      amount: intent.amount,
      stack,
      reason: intent.reason,
    }),
  );
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
  const gated = hostGate(room, userId) ?? hybridOnly(room, 'online pots are awarded automatically');
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
  const gated = gate(room, userId) ?? hybridOnly(room, 'there is no award to dispute online');
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
 * `room:leave`, also during a hand. Standard rule: leaving folds your hand at once; chips others
 * have bet against stay in the pot, and you take the rest, including any uncalled part of your bet
 * (engine `foldOut`). If your cards stay live
 * (engine `leaveOutlook`) the seat is kept until the hand ends and is then cashed out. Players who are not in the running
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
    if (leaveOutlook(state, userId)?.staysLive) {
      return done({
        ...dropTopUps(room, userId),
        // As for any departure: no undo goes back past it.
        game: { ...room.game!, hand: { ...hand, undo: [] } },
        seats: room.seats.map((s) =>
          s === seated ? { ...s, sittingOut: true, leaving: true } : s,
        ),
      });
    }
    const r = foldOut(state, userId);
    if (!r.ok) return engineRefusal(room, r.error);
    state = r.value.state;
  }
  return done(advanceTo(room, state, now, { leaver: userId }));
}
