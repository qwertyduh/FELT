import { firstToActPostflop, isBettingComplete } from './actions';
import { isCard } from './cards';
import { awardPot } from './award';
import { settleBets } from './pots';
import { resolveShowdown } from './showdown';
import type {
  Card,
  EngineError,
  EngineEvent,
  HandState,
  HostAction,
  Result,
  Street,
  Transition,
} from './types';

function fail<T>(code: EngineError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/**
 * Street progression (P21).
 *
 * PUBLIC API
 * - `applyAction(state, playerAction)` (actions.ts) is the only call the server needs after a
 *   player acts. In ONLINE mode it chains `advanceStreet` itself: when betting completes the
 *   result already sits on the next street (events: player_acted, street_advanced...).
 * - `applyHostAction(state, hostAction)` is the hybrid entry for host actions
 *   (`advance_street`, `award_pot` (award.ts)).
 * - `advanceStreet(state, hostAction?)` is the underlying step. Online: no hostAction, runs
 *   every street that needs no betting. Hybrid: requires `advance_street`, moves ONE street.
 *   The server also calls it once right after `startHand` in online mode when
 *   `currentActor` is null on a live hand (blinds put everyone all-in).
 *
 * DECISIONS
 * - No burn cards (none are modelled): flop 3, turn 1, river 1, taken in order from the front
 *   of `state.deck`, which shrinks accordingly.
 * - Hybrid never advances by itself. While betting is complete, `currentActor` is null and
 *   player actions are rejected with `awaiting_host` until the host advances. Hybrid `board`
 *   holds only the cards the host typed in: omitted `cards` leave it unchanged (so it can be
 *   shorter than the street implies). `cards` must have the street's exact count, be valid,
 *   and not duplicate each other or the board. Advancing river -> showdown takes no cards.
 * - A street's bets stay in `committed` (hand total). At each street end `settleBets` (pots.ts)
 *   returns any uncalled bet and rebuilds `pots` from `committed`, so `pots` is current at
 *   showdown (online and hybrid) for P23/P24.
 * - Run-out: if fewer than two players can still act (all-in), no betting happens on later
 *   streets; online deals everything straight to 'showdown', hybrid needs one host advance per
 *   street (flop, turn, river, then showdown) with `currentActor` staying null.
 * - After the river's betting the street becomes 'showdown'. Online: `advanceStreet` then chains `resolveShowdown` (P23), so the hand ends in the same
 *   transition. Hybrid stays on 'showdown' for the host's award_pot (P24).
 */
const NEXT: Readonly<Record<string, Street | undefined>> = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
  river: 'showdown',
};
const CARDS_FOR: Readonly<Record<string, number>> = { flop: 3, turn: 1, river: 1, showdown: 0 };

/**
 * P22: end-of-street collection. Returns any uncalled bet to its owner, clears street bets and
 * rebuilds `pots` from `committed` (see pots.ts). State only; use `settleBets` for the events.
 */
export function collectBets(state: HandState): HandState {
  return settleBets(state).state;
}

/**
 * Low-level street reset (no validation, no dealing): collects bets, clears hasActed/facedBet,
 * currentBet 0, lastFullRaise = bigBlind, actor = first postflop (null on showdown or when
 * fewer than two players can act). Exposed for tests; prefer `advanceStreet`.
 */
export function resetForStreet(
  state: HandState,
  street: Street,
  board: readonly Card[] = state.board,
): HandState {
  const { raises, ...collected } = collectBets(state);
  void raises; // a new street has no raises yet
  const next: HandState = {
    ...collected,
    street,
    board,
    currentBet: 0,
    lastFullRaise: state.bigBlind,
    players: collected.players.map((p) => ({ ...p, hasActed: false, facedBet: 0 })),
    currentActor: null,
  };
  return street === 'showdown' ? next : { ...next, currentActor: firstToActPostflop(next) };
}

function validateCards(
  state: HandState,
  cards: unknown,
  want: number,
): Result<readonly Card[] | undefined> {
  if (cards === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(cards) || cards.length !== want) {
    return fail('invalid_cards', `expected ${want} card(s) for the next street`);
  }
  if (!cards.every(isCard)) return fail('invalid_cards', 'invalid card');
  if (new Set(cards).size !== cards.length) return fail('invalid_cards', 'duplicate cards');
  if (cards.some((c) => state.board.includes(c))) {
    return fail('invalid_cards', 'card already on the board');
  }
  return { ok: true, value: cards as readonly Card[] };
}

function step(state: HandState, cards: unknown): Result<Transition> {
  const street = NEXT[state.street] as Street;
  const want = CARDS_FOR[street] as number;
  let board = state.board;
  let deck = state.deck;
  if (state.mode === 'online') {
    if (deck === null || deck.length < want) return fail('invalid_cards', 'deck exhausted');
    board = [...board, ...deck.slice(0, want)];
    deck = deck.slice(want);
  } else {
    const v = validateCards(state, cards, want);
    if (!v.ok) return v;
    if (v.value !== undefined) board = [...board, ...v.value];
  }
  const settled = settleBets(state); // bet_returned / pots_updated come before street_advanced
  const next: HandState = { ...resetForStreet(settled.state, street, board), deck };
  const ev: EngineEvent = { type: 'street_advanced', street, board };
  return { ok: true, value: { state: next, events: [...settled.events, ev] } };
}

/** See the module comment. Rejects while betting is open, at showdown/ended, and on wrong mode. */
export function advanceStreet(state: HandState, hostAction?: HostAction): Result<Transition> {
  if (typeof state !== 'object' || state === null || !Array.isArray(state.players)) {
    return fail('invalid_state', 'state must be a hand state object');
  }
  if (state.street === 'ended' || state.result !== null) {
    return fail('hand_ended', 'the hand has ended');
  }
  if (NEXT[state.street] === undefined) {
    return fail('illegal_action', `cannot advance from street ${state.street}`);
  }
  if (state.mode === 'hybrid') {
    if (hostAction?.type !== 'advance_street') {
      return fail('illegal_action', 'hybrid streets advance only via the host advance_street');
    }
  } else if (state.mode === 'online') {
    if (hostAction !== undefined) return fail('wrong_mode', 'online streets advance automatically');
  } else return fail('invalid_state', 'unknown mode');
  if (!isBettingComplete(state)) {
    return fail('betting_incomplete', 'betting on this street is not complete');
  }

  if (state.mode === 'hybrid')
    return step(state, (hostAction as HostAction & { cards?: unknown }).cards);

  const events: EngineEvent[] = [];
  let cur = state;
  do {
    const r = step(cur, undefined);
    if (!r.ok) return r;
    cur = r.value.state;
    events.push(...r.value.events);
    // Keep dealing while nobody can bet (all-in run-out) and the hand is not at showdown.
  } while (cur.street !== 'showdown' && cur.currentActor === null);
  if (cur.street === 'showdown') {
    // P23: online showdowns resolve in the same transition (hybrid awards via the host, P24).
    const res = resolveShowdown(cur);
    if (!res.ok) return res;
    return {
      ok: true,
      value: { state: res.value.state, events: [...events, ...res.value.events] },
    };
  }
  return { ok: true, value: { state: cur, events } };
}

/** Hybrid host entry point: advance_street and award_pot. */
export function applyHostAction(state: HandState, action: HostAction): Result<Transition> {
  if (typeof action !== 'object' || action === null) {
    return fail('illegal_action', 'action must be an object');
  }
  if (action.type === 'advance_street') return advanceStreet(state, action);
  if (action.type === 'award_pot') return awardPot(state, action);
  return fail('illegal_action', 'unknown host action type');
}
