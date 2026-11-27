import type {
  EngineError,
  EngineEvent,
  HandPlayer,
  HandResult,
  HandState,
  PlayerAction,
  Result,
  Transition,
} from './types';
import { advanceStreet } from './street';
import { computePots, deadBlindFloor, postedBlind, type ReturnedBet } from './pots';

function fail<T>(code: EngineError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

const PLAYER_ACTION_TYPES: ReadonlySet<string> = new Set([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'all_in',
]);
const BETTING_STREETS = ['preflop', 'flop', 'turn', 'river'];

/** Active = still able to act (not folded, not all-in). */
const isActive = (p: HandPlayer): boolean => p.status === 'active';

/**
 * Does this player still owe an action on the current street?
 * - folded / all-in players never do;
 * - facing a bet they have not matched: yes (call, raise or fold);
 * - otherwise (bet matched) they owe an action only if they have not acted yet AND there is
 *   at least one other active player to bet against. This is the big blind's preflop option
 *   (BB has matched the bet but has not acted) and the "everyone checks" case postflop.
 *   A lone active player facing only all-in opponents has no option (nobody can respond).
 */
function needsAction(state: HandState, p: HandPlayer): boolean {
  if (!isActive(p)) return false;
  const others = state.players.filter((o) => o !== p && o.status !== 'folded');
  if (!others.some(isActive)) {
    // Lone active player: they only owe a call if they are behind the highest REAL bet of the
    // live all-in players (not the nominal currentBet, which can exceed a short blind's chips).
    return p.bet < Math.max(0, ...others.map((o) => o.bet));
  }
  if (p.bet < state.currentBet) return true;
  return !p.hasActed;
}

/** True when nobody active still owes an action on this street (advancing is street.ts). */
export function isBettingComplete(state: HandState): boolean {
  if (!BETTING_STREETS.includes(state.street)) return true; // showdown / ended: nothing to bet
  return !state.players.some((p) => needsAction(state, p));
}

/** Next player after `fromSeat` (clockwise, wrapping, excluding `fromSeat` last) who owes an action. */
function nextToAct(state: HandState, fromSeat: number): number | null {
  const ps = state.players; // always in ascending seat order
  const after = ps.filter((p) => p.seat > fromSeat);
  const before = ps.filter((p) => p.seat <= fromSeat);
  for (const p of [...after, ...before]) if (needsAction(state, p)) return p.seat;
  return null;
}

/**
 * First seat to act on a postflop street (P21 will use this): the first active player
 * clockwise from the button. Heads-up that is the big blind (non-button). Returns null if
 * fewer than two players can act (nobody to bet against, e.g. all-in runout).
 */
export function firstToActPostflop(state: HandState): number | null {
  if (state.players.filter(isActive).length < 2) return null;
  const ps = state.players;
  const order = [
    ...ps.filter((p) => p.seat > state.button),
    ...ps.filter((p) => p.seat <= state.button),
  ];
  return order.find(isActive)?.seat ?? null;
}

/**
 * Can this player raise? A player who has not acted yet always can. A player who already
 * acted can only re-raise if the bet has grown by at least a full raise since they last
 * acted (TDA: short all-ins don't reopen betting; cumulative short all-ins that add up to a
 * full raise do).
 */
function canRaise(state: HandState, p: HandPlayer): boolean {
  if (!p.hasActed) return true;
  return state.currentBet - p.facedBet >= state.lastFullRaise;
}

/** What the player on turn may do. `bet`/`raise` amounts are street totals ("raise to"). */
export interface LegalActions {
  seat: number;
  /** Facing nothing: `check`. Otherwise the chips a `call` puts in (the whole stack at most). */
  check: boolean;
  call: number | null;
  /**
   * The sizes open to a bet or raise; `max` is all-in, and `min === max` means only all-in is left.
   * Null when the player cannot raise: too few chips, betting not reopened, or nobody left who
   * could answer.
   */
  raise: { type: 'bet' | 'raise'; min: number; max: number } | null;
}

/**
 * The choices of the current actor, or null when nobody is on turn (P40). Fold is always one of
 * them. Everything listed is accepted by `applyAction`. The one thing it accepts that is left out
 * on purpose is a raise when every opponent still in is all-in: it could only come straight back.
 */
export function legalActions(state: HandState): LegalActions | null {
  if (state.result !== null || !BETTING_STREETS.includes(state.street)) return null;
  const me = state.players.find((p) => p.seat === state.currentActor);
  if (!me || !isActive(me)) return null;
  const toCall = state.currentBet - me.bet;
  const max = me.bet + me.stack;
  const answerable = state.players.some((p) => p !== me && isActive(p));
  let raise: LegalActions['raise'] = null;
  if (answerable && max > state.currentBet && canRaise(state, me)) {
    if (state.currentBet > 0) {
      raise = { type: 'raise', min: Math.min(state.currentBet + state.lastFullRaise, max), max };
    } else if (state.street !== 'preflop') {
      raise = { type: 'bet', min: Math.min(state.bigBlind, max), max };
    }
  }
  return {
    seat: me.seat,
    check: toCall <= 0,
    call: toCall > 0 ? Math.min(toCall, me.stack) : null,
    raise,
  };
}

/**
 * Settle a hand where everyone else folded (P22). The winner's uncalled excess (over the
 * second-highest commitment) goes back as a bet_returned, as do folded chips the winner never
 * covered (see computePots); the award is only what is left. Chips move out of `committed` into
 * stacks, so committed is zeroed once the hand has ended.
 */
function settleUncontested(state: HandState, winner: HandPlayer) {
  const { players } = state;
  const { pots, returned } = computePots(
    players.map((p) => ({ playerId: p.playerId, committed: p.committed })),
    players.filter((p) => p.status === 'folded').map((p) => p.playerId),
    deadBlindFloor(state),
  );
  const back = new Map(returned.map((r: ReturnedBet) => [r.playerId, r.amount]));
  const total =
    players.reduce((s, p) => s + p.committed, 0) - returned.reduce((s, r) => s + r.amount, 0);
  const out = players.map((p) => ({
    ...p,
    bet: 0,
    committed: 0,
    stack: p.stack + (back.get(p.playerId) ?? 0) + (p.playerId === winner.playerId ? total : 0),
  }));
  const stacks: Record<string, number> = {};
  for (const p of out) stacks[p.playerId] = p.stack;
  const result: HandResult = {
    awards: [
      {
        potId: 'pot-0',
        winners: [winner.playerId],
        amounts: { [winner.playerId]: total },
        contested: false,
        handNames: {},
      },
    ],
    stacks,
    showdown: [],
  };
  return { players: out, total, returned, pots, result };
}

/** End the hand for the last player standing; `events` holds those that led here. */
function endUncontested(
  state: HandState,
  winner: HandPlayer,
  events: EngineEvent[],
): Result<Transition> {
  const settled = settleUncontested(state, winner);
  for (const r of settled.returned) {
    events.push({ type: 'bet_returned', playerId: r.playerId, amount: r.amount });
  }
  events.push(
    {
      type: 'pot_awarded',
      potId: 'pot-0',
      winners: [winner.playerId],
      amounts: { [winner.playerId]: settled.total },
      contested: false,
      handNames: {},
    },
    { type: 'hand_ended', result: settled.result },
  );
  return {
    ok: true,
    value: {
      state: {
        ...state,
        players: settled.players,
        pots: settled.pots,
        street: 'ended',
        currentActor: null,
        result: settled.result,
      },
      events,
    },
  };
}

/**
 * Apply a player action (P19 fold/check/call, P20 bet/raise/all-in). Pure; returns a new state.
 *
 * Rules (Texas Hold'em / TDA), all amounts are "raise TO" street totals:
 * - Only `currentActor` may act. Unknown player -> unknown_player; hand over -> hand_ended.
 * - check: only when bet === currentBet (else cannot_check).
 * - call: pays min(toCall, stack); nothing to call -> nothing_to_call; stack exhausted -> all_in.
 * - bet: only postflop with currentBet 0; min = bigBlind unless all-in for less.
 * - raise: min raise-to = currentBet + lastFullRaise; smaller only if it is the player's
 *   whole stack (all-in). Cannot exceed stack (bet_exceeds_stack).
 * - A raise of at least lastFullRaise is a FULL raise: it sets lastFullRaise to the raise size
 *   and reopens action (other players' hasActed reset). A shorter all-in raise raises
 *   currentBet but leaves lastFullRaise unchanged and does not reopen action to players who
 *   already acted (see canRaise); players yet to act may still raise.
 * - An all-in for <= currentBet is just a call for less and never changes lastFullRaise.
 * - One non-folded player left -> hand ends immediately (street 'ended').
 */
export function applyAction(state: HandState, action: PlayerAction): Result<Transition> {
  if (typeof state !== 'object' || state === null || !Array.isArray(state.players)) {
    return fail('invalid_state', 'state must be a hand state object');
  }
  if (typeof action !== 'object' || action === null) {
    return fail('illegal_action', 'action must be an object');
  }
  const kind: unknown = action.type;
  if (typeof kind !== 'string' || !PLAYER_ACTION_TYPES.has(kind)) {
    return fail('illegal_action', 'unknown player action type');
  }
  if (state.street === 'ended' || state.result !== null) {
    return fail('hand_ended', 'the hand has ended');
  }
  const idx = state.players.findIndex((p) => p.playerId === action.playerId);
  const me = state.players[idx];
  if (me === undefined) return fail('unknown_player', `unknown player ${action.playerId}`);
  if (!BETTING_STREETS.includes(state.street)) {
    return fail('illegal_action', `no betting on street ${state.street}`);
  }
  if (state.currentActor === null && state.mode === 'hybrid' && isBettingComplete(state)) {
    return fail('awaiting_host', 'betting is complete; waiting for the host to advance the street');
  }
  if (state.currentActor === null || state.currentActor !== me.seat || !isActive(me)) {
    return fail('not_your_turn', `it is not ${me.playerId}'s turn`);
  }

  const toCall = state.currentBet - me.bet;
  const allInTotal = me.bet + me.stack;
  /** Final street total after this action (for fold/check = unchanged). */
  let newBet = me.bet;

  switch (action.type) {
    case 'fold':
      break;
    case 'check':
      if (toCall > 0) return fail('cannot_check', 'cannot check while facing a bet');
      break;
    case 'call':
      if (toCall <= 0) return fail('nothing_to_call', 'there is nothing to call');
      newBet = Math.min(state.currentBet, allInTotal);
      break;
    case 'all_in':
      if (me.stack <= 0) return fail('illegal_action', 'no chips to wager');
      newBet = allInTotal;
      break;
    case 'bet':
    case 'raise': {
      const amount = action.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return fail('invalid_amount', 'amount must be a positive safe integer');
      }
      if (amount > allInTotal) {
        return fail('bet_exceeds_stack', `amount ${amount} exceeds stack`);
      }
      const isAllIn = amount === allInTotal;
      if (action.type === 'bet') {
        if (state.street === 'preflop' || state.currentBet !== 0) {
          return fail('illegal_action', 'cannot bet when a bet exists; use raise');
        }
        if (amount < state.bigBlind && !isAllIn) {
          return fail('bet_too_small', `minimum bet is ${state.bigBlind}`);
        }
      } else {
        if (state.currentBet === 0) return fail('illegal_action', 'nothing to raise; use bet');
        if (amount <= state.currentBet && !isAllIn) {
          return fail('raise_too_small', 'raise must exceed the current bet');
        }
        const minTo = state.currentBet + state.lastFullRaise;
        if (amount < minTo && !isAllIn) {
          return fail('raise_too_small', `minimum raise is to ${minTo}`);
        }
        if (amount <= state.currentBet) {
          // all-in for no more than the current bet is a call for less
          return fail('illegal_action', 'use call: this does not raise');
        }
      }
      newBet = amount;
      break;
    }
    default:
      return fail('illegal_action', 'unknown player action type');
  }

  const raisesBet = newBet > state.currentBet;
  if (raisesBet && !canRaise(state, me)) {
    return fail('illegal_action', 'betting was not reopened; you may only call or fold');
  }
  const raiseSize = newBet - state.currentBet;
  const isFullRaise = raisesBet && raiseSize >= state.lastFullRaise;

  const paid = newBet - me.bet;
  const folded = action.type === 'fold';
  const newStack = me.stack - paid;
  const updated: HandPlayer = {
    ...me,
    stack: newStack,
    bet: newBet,
    committed: me.committed + paid,
    status: folded ? 'folded' : newStack === 0 ? 'all_in' : 'active',
    hasActed: true,
    facedBet: raisesBet ? newBet : state.currentBet, // bet level after this action
  };
  const players = state.players.map((p, i) => {
    if (i === idx) return updated;
    // A full raise reopens the action: everyone else must respond again.
    return isFullRaise && isActive(p) ? { ...p, hasActed: false } : p;
  });

  const events: EngineEvent[] = [
    { type: 'player_acted', playerId: me.playerId, action: action.type, amount: paid },
  ];
  let next: HandState = {
    ...state,
    players,
    currentBet: raisesBet ? newBet : state.currentBet,
    lastFullRaise: isFullRaise ? raiseSize : state.lastFullRaise,
  };

  const live = players.filter((p) => p.status !== 'folded');
  const sole = live.length === 1 ? live[0] : undefined;
  if (sole !== undefined) return endUncontested({ ...next, players }, sole, events);

  next = { ...next, currentActor: nextToAct(next, me.seat) };
  // Online: the engine advances (and runs out) streets itself once betting is complete.
  // Hybrid: stays put with currentActor null until the host sends advance_street.
  if (next.mode === 'online' && next.currentActor === null) {
    const adv = advanceStreet(next);
    if (!adv.ok) return adv;
    return {
      ok: true,
      value: { state: adv.value.state, events: [...events, ...adv.value.events] },
    };
  }
  return { ok: true, value: { state: next, events } };
}

/**
 * A player gives up their hand without waiting for their turn (P33: they leave the table). Only a
 * player who can still act (`active`) on a betting street may be folded; an all-in player's hand
 * stays live to showdown.
 *
 * - Chips the others have put in against stay in the pot (posted blinds always do). The part of
 *   the leaver's bet above what anyone else committed was never called: it goes straight back
 *   (`bet_returned`), as in P22.
 * - If that leaves no live player at the current bet, `currentBet` drops to the highest live
 *   player's bet (never below the big blind preflop), so nobody is asked to call a bet that is
 *   gone. The min-raise becomes the step up to that bet from the next live bet below it (at least
 *   the big blind).
 */
export function foldOut(state: HandState, playerId: string): Result<Transition> {
  if (typeof state !== 'object' || state === null || !Array.isArray(state.players)) {
    return fail('invalid_state', 'state must be a hand state object');
  }
  if (state.street === 'ended' || state.result !== null) {
    return fail('hand_ended', 'the hand has ended');
  }
  const me = state.players.find((p) => p.playerId === playerId);
  if (me === undefined) return fail('unknown_player', `unknown player ${playerId}`);
  if (!BETTING_STREETS.includes(state.street)) {
    return fail('illegal_action', `no folding on street ${state.street}`);
  }
  if (!isActive(me)) return fail('illegal_action', 'only a player who can still act may fold');

  const covered = Math.max(
    postedBlind(state, me),
    ...state.players.filter((p) => p !== me).map((p) => p.committed),
  );
  const back = Math.max(0, me.committed - covered); // always part of this street's bet
  const gone: HandPlayer = {
    ...me,
    status: 'folded',
    hasActed: true,
    facedBet: state.currentBet,
    stack: me.stack + back,
    bet: me.bet - back,
    committed: me.committed - back,
  };
  let players = state.players.map((p) => (p === me ? gone : p));
  const events: EngineEvent[] = [{ type: 'player_acted', playerId, action: 'fold', amount: 0 }];
  if (back > 0) events.push({ type: 'bet_returned', playerId, amount: back });

  const live = players.filter((p) => p.status !== 'folded');
  const sole = live.length === 1 ? live[0] : undefined;
  if (sole !== undefined) return endUncontested({ ...state, players }, sole, events);

  const bets = live.map((p) => p.bet);
  const floor = state.street === 'preflop' ? state.bigBlind : 0;
  const currentBet = Math.min(state.currentBet, Math.max(floor, ...bets));
  let { lastFullRaise } = state;
  if (currentBet < state.currentBet) {
    const below = Math.max(0, ...bets.filter((b) => b < currentBet));
    lastFullRaise = Math.max(state.bigBlind, Math.min(lastFullRaise, currentBet - below));
    players = players.map((p) => ({ ...p, facedBet: Math.min(p.facedBet, currentBet) }));
  }

  const folded: HandState = { ...state, players, currentBet, lastFullRaise };
  // The player on turn may be the leaver, or may no longer owe anything.
  const turn = players.find((p) => p.seat === state.currentActor);
  const next: HandState = {
    ...folded,
    currentActor:
      turn === undefined
        ? null
        : needsAction(folded, turn)
          ? turn.seat
          : nextToAct(folded, turn.seat),
  };
  if (next.mode === 'online' && next.currentActor === null) {
    const adv = advanceStreet(next);
    if (!adv.ok) return adv;
    return {
      ok: true,
      value: { state: adv.value.state, events: [...events, ...adv.value.events] },
    };
  }
  return { ok: true, value: { state: next, events } };
}
