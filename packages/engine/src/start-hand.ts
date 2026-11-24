import { isCard } from './cards';
import type {
  Card,
  EngineError,
  EngineEvent,
  HandPlayer,
  HandState,
  Result,
  TableState,
  Transition,
} from './types';

function fail<T>(code: EngineError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/**
 * Start a new hand (P18).
 *
 * Decisions (Texas Hold'em / TDA):
 * - Eligible = seat occupied, not sitting out, stack > 0 (busted players skipped).
 * - Button: `table.button === null` (first hand) -> lowest-numbered eligible seat.
 *   Otherwise the next eligible seat clockwise (increasing index, wrapping) after the
 *   previous button seat. The previous button seat may now be empty/sat-out; we still
 *   walk from its index. No "dead button": the button always lands on a live player.
 * - Blinds: SB = next eligible after button, BB = next eligible after SB.
 *   Heads-up (2 eligible): the button is the SB and acts first preflop; the BB acts
 *   first on every later street (set up for P19/P21).
 * - Short blinds: a player posts min(blind, stack); 0 left -> `all_in`.
 *   `currentBet` is always `bigBlind` (TDA: the price to call is the full big blind even
 *   if the BB posted less) and `lastFullRaise` = bigBlind.
 * - First to act preflop: next `active` (not all-in) seat clockwise after the BB, which
 *   heads-up is the button. `currentActor` is null if no one is able to act: nobody
 *   active, or exactly one active player who already matches every other player's bet.
 * - Dealing (online): 2 rounds of one card, starting with the seat left of the button
 *   (the SB), ending with the button. `hole_cards_dealt.playerIds` is in that deal order.
 *   Requires >= 2n+5 cards (hole cards + flop/turn/river); no burn cards are modelled.
 *   Remaining deck goes in `HandState.deck`. Hybrid requires deck === null.
 * Pure: never mutates inputs. The caller writes `state.button` back to the table.
 */
export function startHand(table: TableState, deck: readonly Card[] | null): Result<Transition> {
  const { seats, smallBlind, bigBlind } = table;
  const isChips = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  if (!isChips(smallBlind) || !isChips(bigBlind) || smallBlind > bigBlind) {
    return fail('invalid_state', 'blinds must be positive integers with smallBlind <= bigBlind');
  }
  if (table.mode !== 'online' && table.mode !== 'hybrid') {
    return fail('invalid_state', 'unknown mode');
  }
  if (
    table.button !== null &&
    (!Number.isSafeInteger(table.button) || table.button < 0 || table.button >= seats.length)
  ) {
    return fail('invalid_state', 'button seat out of range');
  }
  const ids = new Set<string>();
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (s === undefined) return fail('invalid_state', `seat ${i} is missing (sparse seats)`);
    if (s === null) continue;
    if (!Number.isSafeInteger(s.stack) || s.stack < 0) {
      return fail('invalid_state', `invalid stack for ${s.playerId}`);
    }
    if (ids.has(s.playerId)) return fail('invalid_state', `duplicate player ${s.playerId}`);
    ids.add(s.playerId);
  }

  const eligible = (i: number): boolean => {
    const s = seats[i];
    return s != null && !s.sittingOut && s.stack > 0;
  };
  const eligibleSeats: number[] = [];
  for (let i = 0; i < seats.length; i++) if (eligible(i)) eligibleSeats.push(i);
  const n = eligibleSeats.length;
  if (n < 2)
    return fail('not_enough_players', 'need at least 2 players with chips who are not sitting out');

  if (table.mode === 'online') {
    if (deck === null) return fail('wrong_mode', 'online mode requires a deck');
  } else if (deck !== null) {
    return fail('wrong_mode', 'hybrid mode deals no cards; deck must be null');
  }
  if (deck !== null) {
    if (deck.length < 2 * n + 5)
      return fail('invalid_cards', `deck needs at least ${2 * n + 5} cards`);
    if (!deck.every(isCard) || new Set(deck).size !== deck.length) {
      return fail('invalid_cards', 'deck has invalid or duplicate cards');
    }
  }

  /** Next seat strictly after `from` (wrapping) satisfying `pred`; null if none. */
  const nextSeat = (from: number, pred: (i: number) => boolean): number | null => {
    for (let k = 1; k <= seats.length; k++) {
      const i = (from + k) % seats.length;
      if (pred(i)) return i;
    }
    return null;
  };

  const button =
    table.button === null
      ? (eligibleSeats[0] as number)
      : (nextSeat(table.button, eligible) as number);
  const sbSeat = n === 2 ? button : (nextSeat(button, eligible) as number);
  const bbSeat = nextSeat(sbSeat, eligible) as number;

  // Deal order: starting left of the button.
  const dealOrder: number[] = [];
  for (let cur = button, k = 0; k < n; k++) {
    cur = nextSeat(cur, eligible) as number;
    dealOrder.push(cur);
  }
  const hole = new Map<number, [Card, Card]>();
  let rest: readonly Card[] | null = null;
  if (deck !== null) {
    const first = deck.slice(0, n);
    const second = deck.slice(n, 2 * n);
    dealOrder.forEach((seat, k) => hole.set(seat, [first[k] as Card, second[k] as Card]));
    rest = deck.slice(2 * n);
  }

  const players: HandPlayer[] = eligibleSeats.map((seat) => {
    const s = seats[seat]!;
    const blind = seat === sbSeat ? smallBlind : seat === bbSeat ? bigBlind : 0;
    const posted = Math.min(blind, s.stack);
    const stack = s.stack - posted;
    return {
      playerId: s.playerId,
      seat,
      stack,
      bet: posted,
      committed: posted,
      status: stack === 0 ? 'all_in' : 'active',
      hasActed: false,
      facedBet: 0,
      hole: hole.get(seat) ?? null,
    };
  });

  const byseat = (seat: number): HandPlayer => players.find((p) => p.seat === seat) as HandPlayer;
  const sb = byseat(sbSeat);
  const bb = byseat(bbSeat);

  const isActive = (i: number): boolean =>
    players.some((p) => p.seat === i && p.status === 'active');
  const activeCount = players.filter((p) => p.status === 'active').length;
  let currentActor: number | null = null;
  if (activeCount >= 2) {
    currentActor = nextSeat(bbSeat, isActive);
  } else if (activeCount === 1) {
    const only = players.find((p) => p.status === 'active') as HandPlayer;
    const maxOther = Math.max(...players.filter((p) => p !== only).map((p) => p.bet));
    if (only.bet < maxOther) currentActor = only.seat;
  }

  const events: EngineEvent[] = [
    { type: 'hand_started', button, smallBlindSeat: sbSeat, bigBlindSeat: bbSeat },
    { type: 'blind_posted', playerId: sb.playerId, amount: sb.bet, blind: 'small' },
    { type: 'blind_posted', playerId: bb.playerId, amount: bb.bet, blind: 'big' },
  ];
  if (deck !== null) {
    events.push({
      type: 'hole_cards_dealt',
      playerIds: dealOrder.map((s) => byseat(s).playerId),
    });
  }

  const state: HandState = {
    mode: table.mode,
    street: 'preflop',
    board: [],
    players,
    button,
    smallBlindSeat: sbSeat,
    bigBlindSeat: bbSeat,
    smallBlind,
    bigBlind,
    currentBet: bigBlind,
    lastFullRaise: bigBlind,
    currentActor,
    pots: [],
    deck: rest,
    awardedPotIds: [],
    result: null,
  };
  return { ok: true, value: { state, events } };
}
