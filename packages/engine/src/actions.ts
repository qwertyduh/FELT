import type {
  Pot,
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
import { computePots } from './pots';

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

/**
 * Settle a hand where everyone else folded (P22). The winner's uncalled excess (over the
 * second-highest commitment) goes back as a bet_returned; the award is only the contested pot.
 * Chips move out of `committed` into stacks, so committed is zeroed once the hand has ended.
 */
function settleUncontested(
  players: readonly HandPlayer[],
  winner: HandPlayer,
): { players: HandPlayer[]; result: HandResult; total: number; returned: number; pots: Pot[] } {
  const { pots, returned } = computePots(
    players.map((p) => ({ playerId: p.playerId, committed: p.committed })),
    players.filter((p) => p.status === 'folded').map((p) => p.playerId),
  );
  const back = returned.find((r) => r.playerId === winner.playerId)?.amount ?? 0;
  const total = players.reduce((s, p) => s + p.committed, 0) - back;
  const out = players.map((p) => ({
    ...p,
    bet: 0,
    committed: 0,
    stack: p.playerId === winner.playerId ? p.stack + total + back : p.stack,
  }));
  const stacks: Record<string, number> = {};
  for (const p of out) stacks[p.playerId] = p.stack;
  return {
    players: out,
    total,
    returned: back,
    pots,
    result: {
      awards: [
        { potId: 'pot-0', winners: [winner.playerId], amounts: { [winner.playerId]: total } },
      ],
      stacks,
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
  let players = state.players.map((p, i) => {
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
  if (sole !== undefined) {
    const settled = settleUncontested(players, sole);
    players = settled.players;
    if (settled.returned > 0) {
      events.push({ type: 'bet_returned', playerId: sole.playerId, amount: settled.returned });
    }
    events.push(
      {
        type: 'pot_awarded',
        potId: 'pot-0',
        winners: [sole.playerId],
        amounts: { [sole.playerId]: settled.total },
      },
      { type: 'hand_ended', result: settled.result },
    );
    next = {
      ...next,
      players,
      pots: settled.pots,
      street: 'ended',
      currentActor: null,
      result: settled.result,
    };
    return { ok: true, value: { state: next, events } };
  }

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
