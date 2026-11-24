import { isCard } from './cards';
import { bestOf7, compareHands, handName } from './hand';
import type { BestHand } from './hand';
import type {
  Card,
  EngineError,
  EngineEvent,
  HandPlayer,
  HandResult,
  HandState,
  PotAward,
  Result,
  ShowdownEntry,
  Transition,
} from './types';

function fail<T>(code: EngineError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/**
 * Online showdown and award (P23). Called by `advanceStreet` the moment the hand reaches street
 * 'showdown' (so `applyAction` ends the hand in the same transition); also exported for direct
 * use. Hybrid is rejected (`wrong_mode`): the host awards pots there (P24).
 *
 * Preconditions: street 'showdown', `state.pots` fresh from the last street end (settleBets has
 * already returned uncalled bets to stacks, so awards never re-add returned chips), 5 board
 * cards, hole cards present.
 *
 * RULES
 * - Pots are awarded in order (pot-0 main, then side pots). Eligible = the pot's eligible ids
 *   that are not folded (a folded player never wins).
 * - A pot with a single eligible player goes to them without evaluating hands (and without
 *   showing). Otherwise each eligible player's best 5 of hole + board is compared; all players
 *   tied for the best share the pot.
 * - Split: floor(amount / winners) each. ODD CHIP (TDA / standard): the remainder chips are
 *   handed out one at a time to the winners in seat order starting with the first winner
 *   clockwise from the button (the seat left of the button, i.e. closest to the small blind in
 *   a ring game; heads-up that is the big blind), wrapping around. The button itself is last.
 *   This is applied to each pot independently.
 * - `showdown` lists, in seat order, every player eligible for at least one pot that had 2+
 *   eligible players (they had to show). Sole-eligible players of every pot they are in do not
 *   show. Uncontested (all-fold) hands never reach here and have `showdown: []`.
 * - Result: street 'ended', currentActor null, bets and `committed` zeroed (chips are in
 *   stacks), `pots` kept as awarded, `result.stacks` = final stack per player.
 */
export function resolveShowdown(state: HandState): Result<Transition> {
  if (typeof state !== 'object' || state === null || !Array.isArray(state.players)) {
    return fail('invalid_state', 'state must be a hand state object');
  }
  if (state.street === 'ended' || state.result !== null) {
    return fail('hand_ended', 'the hand has ended');
  }
  if (state.mode !== 'online') return fail('wrong_mode', 'hybrid pots are awarded by the host');
  if (state.street !== 'showdown') return fail('illegal_action', 'the hand is not at showdown');
  if (!Array.isArray(state.board) || state.board.length !== 5) {
    return fail('invalid_state', 'showdown needs 5 board cards');
  }
  if (!Array.isArray(state.pots)) return fail('invalid_state', 'pots must be an array');
  // Corrupt-state guards: return errors instead of letting bestOf7/arithmetic throw or misaward.
  const seenCards = new Set<string>();
  const takeCard = (c: unknown): boolean => {
    if (!isCard(c) || seenCards.has(c)) return false;
    seenCards.add(c);
    return true;
  };
  if (!state.board.every(takeCard)) return fail('invalid_cards', 'invalid or duplicate board card');
  const ids = new Set<string>();
  for (const p of state.players) {
    if (typeof p !== 'object' || p === null) return fail('invalid_state', 'invalid player');
    ids.add(p.playerId);
    if (p.hole === null) continue;
    if (!Array.isArray(p.hole) || p.hole.length !== 2 || !p.hole.every(takeCard)) {
      return fail('invalid_cards', `invalid or duplicate hole card for ${p.playerId}`);
    }
  }
  if (ids.size !== state.players.length) return fail('invalid_state', 'duplicate player ids');
  for (const pot of state.pots) {
    if (typeof pot !== 'object' || pot === null || !Array.isArray(pot.eligible)) {
      return fail('invalid_state', 'invalid pot');
    }
    if (!Number.isSafeInteger(pot.amount) || pot.amount < 0) {
      return fail('invalid_state', `pot ${pot.id} has an invalid amount`);
    }
    if (
      new Set(pot.eligible).size !== pot.eligible.length ||
      !pot.eligible.every((e: string) => ids.has(e))
    ) {
      return fail('invalid_state', `pot ${pot.id} has duplicate or unknown eligible players`);
    }
  }

  const byId = new Map<string, HandPlayer>(state.players.map((p) => [p.playerId, p]));
  const best = new Map<string, BestHand>();
  const evalPlayer = (p: HandPlayer): BestHand | null => {
    const cached = best.get(p.playerId);
    if (cached) return cached;
    if (p.hole === null) return null;
    const b = bestOf7([...p.hole, ...state.board] as Card[]);
    best.set(p.playerId, b);
    return b;
  };
  // Clockwise from the button: seats after the button first, the button last.
  const clockwise = (a: HandPlayer, b: HandPlayer): number => {
    const k = (p: HandPlayer) => (p.seat > state.button ? p.seat - state.button : p.seat + 1000);
    return k(a) - k(b);
  };

  const won = new Map<string, number>();
  const awards: PotAward[] = [];
  const shown = new Set<string>();
  for (const pot of state.pots) {
    const elig = pot.eligible
      .map((id: string) => byId.get(id))
      .filter(
        (p: HandPlayer | undefined): p is HandPlayer => p !== undefined && p.status !== 'folded',
      );
    if (elig.length === 0) return fail('invalid_state', `pot ${pot.id} has no eligible player`);

    let winners: HandPlayer[];
    const handNames: Record<string, string> = {};
    const contested = elig.length > 1;
    if (!contested) {
      winners = elig;
    } else {
      let top: BestHand | null = null;
      winners = [];
      for (const p of elig) {
        const h = evalPlayer(p);
        if (h === null) return fail('invalid_state', `player ${p.playerId} has no hole cards`);
        shown.add(p.playerId);
        const c = top === null ? 1 : compareHands(h, top);
        if (c > 0) {
          top = h;
          winners = [p];
        } else if (c === 0) winners.push(p);
      }
      for (const w of winners) handNames[w.playerId] = handName(best.get(w.playerId) as BestHand);
    }
    winners = [...winners].sort(clockwise);
    const share = Math.floor(pot.amount / winners.length);
    const odd = pot.amount - share * winners.length;
    const amounts: Record<string, number> = {};
    winners.forEach((w, i) => {
      amounts[w.playerId] = share + (i < odd ? 1 : 0);
      won.set(w.playerId, (won.get(w.playerId) ?? 0) + (amounts[w.playerId] as number));
    });
    awards.push({
      potId: pot.id,
      winners: winners.map((w) => w.playerId),
      amounts,
      contested,
      handNames,
    });
  }

  const players: HandPlayer[] = state.players.map((p) => ({
    ...p,
    bet: 0,
    committed: 0,
    stack: p.stack + (won.get(p.playerId) ?? 0),
  }));
  const stacks: Record<string, number> = {};
  for (const p of players) stacks[p.playerId] = p.stack;
  const showdown: ShowdownEntry[] = state.players
    .filter((p) => shown.has(p.playerId))
    .map((p) => {
      const h = best.get(p.playerId) as BestHand;
      return {
        playerId: p.playerId,
        hole: p.hole as readonly [Card, Card],
        handName: handName(h),
        category: h.category,
      };
    });
  const result: HandResult = { awards, stacks, showdown };
  const events: EngineEvent[] = [
    ...awards.map((a): EngineEvent => ({
      type: 'pot_awarded',
      potId: a.potId,
      winners: a.winners,
      amounts: a.amounts,
      contested: a.contested,
      handNames: a.handNames,
    })),
    { type: 'hand_ended', result },
  ];
  return {
    ok: true,
    value: {
      state: { ...state, players, street: 'ended', currentActor: null, result },
      events,
    },
  };
}
