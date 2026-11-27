import type { HandPlayer, HandState, Pot, Transition, EngineEvent } from './types';

/**
 * Side pots (P22). Pure layering algorithm, cites standard Texas Hold'em pot rules.
 *
 * INPUT: `contributions` = total chips each player has committed over the WHOLE hand
 * (`HandPlayer.committed`), `folded` = ids of players who folded (set or array).
 *
 * RULES
 * - Layering: take the distinct committed levels of the NON-folded players, ascending. Layer k
 *   holds, from EVERY player (folded included), min(committed, level_k) - level_(k-1). A folded
 *   player's chips stay in every layer they reached, but a folded player is never eligible.
 * - Eligible for a layer = non-folded players whose committed >= that layer's level. Eligible
 *   sets are therefore strictly nested (non-increasing as the pot index grows).
 * - Folded chips above the highest non-folded level (dead money nobody matched; only possible
 *   when a folded player out-committed every live player) join the TOP layer so every pot has
 *   an eligible player and chips are conserved.
 * - Merging: adjacent layers have distinct levels, so their eligible sets always differ. Two
 *   layers with an identical eligible set cannot occur; a folded player's partial layer is
 *   absorbed into the layer of the next live level rather than creating its own pot. No merge
 *   step is needed. Zero-amount layers are dropped. Ids are "pot-0", "pot-1", ... in order.
 * - UNCALLED BET: if exactly ONE non-folded player has the highest commitment, the excess over
 *   the second-highest commitment among ALL players (folded included) was never matched; it is
 *   returned to that player and is not part of any pot. Ties for the top, or a folded player
 *   holding the top, return nothing.
 *
 * - Degenerate: if no live player has committed anything but folded players have, all of that
 *   dead money forms one pot with every live player eligible.
 *
 * FINAL SETTLEMENT (`deadFloor` given: no betting can follow). Folded chips above the highest live
 * commitment were never covered by anyone still in the hand, so they go back to their owners
 * instead of joining the top layer. `deadFloor(id)` is the part of a folded player's chips that
 * stays in the pot regardless (a posted blind). Only reachable when players leave out of turn
 * (`foldOut`) or fold without facing a bet.
 *
 * Throws RangeError on malformed input (non-integer / negative chips, duplicate ids, nobody
 * live). This is a programming error, not a game outcome.
 */
export interface Contribution {
  playerId: string;
  /** Whole-hand committed chips (non-negative safe integer). */
  committed: number;
}

export interface ReturnedBet {
  playerId: string;
  amount: number;
}

export interface PotsResult {
  pots: Pot[];
  returned: ReturnedBet[];
}

export function computePots(
  contributions: readonly Contribution[],
  folded: ReadonlySet<string> | readonly string[],
  deadFloor?: (playerId: string) => number,
): PotsResult {
  const foldedSet: ReadonlySet<string> = Array.isArray(folded)
    ? new Set(folded as readonly string[])
    : (folded as ReadonlySet<string>);
  const seen = new Set<string>();
  for (const c of contributions) {
    if (!Number.isSafeInteger(c.committed) || c.committed < 0) {
      throw new RangeError(`invalid committed amount for ${c.playerId}`);
    }
    if (seen.has(c.playerId)) throw new RangeError(`duplicate player ${c.playerId}`);
    seen.add(c.playerId);
  }
  const live = contributions.filter((c) => !foldedSet.has(c.playerId));
  if (live.length === 0) throw new RangeError('at least one non-folded player is required');

  // Uncalled bet.
  const returned: ReturnedBet[] = [];
  const adjusted = new Map<string, number>(contributions.map((c) => [c.playerId, c.committed]));
  const sorted = [...contributions].sort((a, b) => b.committed - a.committed);
  const top = sorted[0] as Contribution;
  const second = sorted[1]?.committed ?? 0;
  if (top.committed > second && !foldedSet.has(top.playerId)) {
    const amount = top.committed - second;
    returned.push({ playerId: top.playerId, amount });
    adjusted.set(top.playerId, second);
  }

  if (deadFloor) {
    const topLive = Math.max(...live.map((c) => adjusted.get(c.playerId) as number));
    for (const c of contributions) {
      if (!foldedSet.has(c.playerId)) continue;
      const v = adjusted.get(c.playerId) as number;
      const keep = Math.max(topLive, deadFloor(c.playerId));
      if (v <= keep) continue;
      returned.push({ playerId: c.playerId, amount: v - keep });
      adjusted.set(c.playerId, keep);
    }
  }

  const levels = [
    ...new Set(live.map((c) => adjusted.get(c.playerId) as number).filter((v) => v > 0)),
  ].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  levels.forEach((level, i) => {
    const isTop = i === levels.length - 1;
    let amount = 0;
    for (const c of contributions) {
      const v = adjusted.get(c.playerId) as number;
      amount += isTop ? Math.max(0, v - prev) : Math.max(0, Math.min(v, level) - prev);
    }
    const eligible = live
      .filter((c) => (adjusted.get(c.playerId) as number) >= level)
      .map((c) => c.playerId);
    if (amount > 0) pots.push({ id: `pot-${pots.length}`, amount, eligible });
    prev = level;
  });
  if (levels.length === 0) {
    // Degenerate: only folded players put chips in (no live commitment to layer on). Keep the
    // dead money in one pot every live player is eligible for, so chips are conserved.
    const dead = [...adjusted.values()].reduce((a, b) => a + b, 0);
    if (dead > 0) pots.push({ id: 'pot-0', amount: dead, eligible: live.map((c) => c.playerId) });
  }
  return { pots, returned };
}

/** The blind `player` posted this hand (0 for everyone else). */
export function postedBlind(state: HandState, player: HandPlayer): number {
  if (player.seat === state.bigBlindSeat) return state.bigBlind;
  return player.seat === state.smallBlindSeat ? state.smallBlind : 0;
}

/**
 * `computePots`' dead-money floor for a final settlement. A posted blind is dead money for a last
 * player standing, even one who never put a chip in. Not if that player is all-in, or if several
 * are still in: then nobody takes more of a blind than they covered.
 */
export function deadBlindFloor(state: HandState): (playerId: string) => number {
  const live = state.players.filter((p) => p.status !== 'folded');
  const open = live.length === 1 && live[0]!.status === 'active';
  return (id) => {
    const p = state.players.find((x) => x.playerId === id);
    return open && p ? postedBlind(state, p) : 0;
  };
}

const potsEqual = (a: readonly Pot[], b: readonly Pot[]): boolean =>
  a.length === b.length &&
  a.every((p, i) => {
    const q = b[i] as Pot;
    return (
      p.id === q.id &&
      p.amount === q.amount &&
      p.eligible.length === q.eligible.length &&
      p.eligible.every((e, j) => e === q.eligible[j])
    );
  });

/**
 * INTENDED: `state.pots` is rebuilt only at street end (and at an uncontested hand end), so a
 * player who folds mid-street stays in `pots[].eligible` until that street is collected. Consumers
 * (P23 award, P24 host award validation) must read/validate `pots` at showdown only.
 *
 * Settle the hand's money from `committed`: return any uncalled bet to its owner (stack up,
 * committed down; emits `bet_returned`), zero the street bets, and rebuild `state.pots` from
 * the (adjusted) commitments (emits `pots_updated` only when they changed). Idempotent.
 * A returned player keeps status 'all_in' if they were (they still cannot act this hand).
 */
export function settleBets(state: HandState): Transition {
  const { pots, returned } = computePots(
    state.players.map((p) => ({ playerId: p.playerId, committed: p.committed })),
    state.players.filter((p) => p.status === 'folded').map((p) => p.playerId),
    state.street === 'river' ? deadBlindFloor(state) : undefined, // nothing can be bet after it
  );
  const back = new Map(returned.map((r) => [r.playerId, r.amount]));
  const players: HandPlayer[] = state.players.map((p) => {
    const amt = back.get(p.playerId) ?? 0;
    return { ...p, bet: 0, stack: p.stack + amt, committed: p.committed - amt };
  });
  const events: EngineEvent[] = returned.map((r) => ({
    type: 'bet_returned',
    playerId: r.playerId,
    amount: r.amount,
  }));
  if (!potsEqual(pots, state.pots)) events.push({ type: 'pots_updated', pots });
  return { state: { ...state, players, pots }, events };
}
