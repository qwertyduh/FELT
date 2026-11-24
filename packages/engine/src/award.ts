import { splitPot } from './showdown';
import type {
  EngineError,
  EngineEvent,
  HandPlayer,
  HandResult,
  HandState,
  HostAction,
  PotAward,
  Result,
  Transition,
} from './types';

function fail<T>(code: EngineError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/**
 * Hybrid award (P24): `applyHostAction(state, { type: 'award_pot', potId, winners })`.
 *
 * The host decides who won each pot from the real cards on the table; the engine only checks
 * the award is legal and moves chips.
 *
 * RULES / DECISIONS
 * - Hybrid only (`wrong_mode` online) and only at street 'showdown', where `state.pots` are fresh
 *   (settleBets ran at the street end). Earlier streets return `illegal_action`; an ended hand
 *   returns `hand_ended`. Hands that end by everyone folding already ended in P19.
 * - Pots may be awarded in ANY order (the host's choice). Each pot exactly once
 *   (`pot_already_awarded`); unknown id -> `unknown_pot`.
 * - `winners` must be a non-empty, duplicate-free list of playerIds, each in THAT pot's
 *   `eligible` list and not folded (`invalid_winners`). A pot with a single eligible player
 *   therefore only accepts that player. The host still awards it explicitly (no auto-award);
 *   a UI should pre-fill single-eligible pots.
 * - Split: floor(amount / n) each, odd chips one at a time clockwise from the seat left of the
 *   button (same helper as online showdown, `splitPot`).
 * - In-flight winnings go to winners' stacks immediately and the pot id joins `awardedPotIds`
 *   (detail kept in `pendingAwards`). `pots` keep their amounts and `result` stays null, so at
 *   every step: sum(stacks) + sum(unawarded pot amounts) is constant.
 * - When the last pot is awarded: street 'ended', currentActor null, bets and `committed`
 *   zeroed, `result` = { awards (awarded order), stacks, showdown: [] } and a `hand_ended` event.
 * - Events per award: `pot_awarded` (contested = pot had 2+ eligible; handNames {}), then
 *   `hand_ended` on the last one.
 */
export function awardPot(
  state: HandState,
  action: Extract<HostAction, { type: 'award_pot' }>,
): Result<Transition> {
  if (typeof state !== 'object' || state === null || !Array.isArray(state.players)) {
    return fail('invalid_state', 'state must be a hand state object');
  }
  if (state.street === 'ended' || state.result !== null) {
    return fail('hand_ended', 'the hand has ended');
  }
  if (state.mode !== 'hybrid') return fail('wrong_mode', 'online pots are awarded automatically');
  if (state.street !== 'showdown') return fail('illegal_action', 'pots are awarded at showdown');
  if (!Array.isArray(state.pots) || !Array.isArray(state.awardedPotIds)) {
    return fail('invalid_state', 'pots and awardedPotIds must be arrays');
  }
  const prior: readonly PotAward[] = state.pendingAwards ?? [];
  if (!Array.isArray(prior)) return fail('invalid_state', 'pendingAwards must be an array');

  const ids = new Set<string>();
  for (const p of state.players) {
    if (typeof p !== 'object' || p === null) return fail('invalid_state', 'invalid player');
    ids.add(p.playerId);
  }
  if (ids.size !== state.players.length) return fail('invalid_state', 'duplicate player ids');
  const potIds = new Set<string>();
  for (const pot of state.pots) {
    if (typeof pot !== 'object' || pot === null || !Array.isArray(pot.eligible)) {
      return fail('invalid_state', 'invalid pot');
    }
    if (potIds.has(pot.id)) return fail('invalid_state', `duplicate pot id ${pot.id}`);
    potIds.add(pot.id);
    if (!Number.isSafeInteger(pot.amount) || pot.amount < 0) {
      return fail('invalid_state', `pot ${pot.id} has an invalid amount`);
    }
  }
  if (state.pots.length === 0) return fail('invalid_state', 'no pots to award');

  if (typeof action !== 'object' || action === null) {
    return fail('illegal_action', 'action must be an object');
  }
  const { potId, winners } = action as { potId: unknown; winners: unknown };
  if (typeof potId !== 'string') return fail('unknown_pot', 'potId must be a string');
  const pot = state.pots.find((p) => p.id === potId);
  if (pot === undefined) return fail('unknown_pot', `no pot ${potId}`);
  if (state.awardedPotIds.includes(potId)) {
    return fail('pot_already_awarded', `pot ${potId} was already awarded`);
  }
  if (!Array.isArray(winners) || winners.length === 0) {
    return fail('invalid_winners', 'pick at least one winner');
  }
  if (!winners.every((w) => typeof w === 'string') || new Set(winners).size !== winners.length) {
    return fail('invalid_winners', 'winners must be unique player ids');
  }
  const byId = new Map<string, HandPlayer>(state.players.map((p) => [p.playerId, p]));
  const picked: HandPlayer[] = [];
  for (const w of winners as string[]) {
    const p = byId.get(w);
    if (p === undefined || !pot.eligible.includes(w) || p.status === 'folded') {
      return fail('invalid_winners', `${w} is not eligible for ${potId}`);
    }
    picked.push(p);
  }

  const split = splitPot(pot.amount, picked, state.button);
  const award: PotAward = {
    potId,
    winners: split.order.map((w) => w.playerId),
    amounts: split.amounts,
    contested: pot.eligible.length > 1,
    handNames: {},
  };
  const awards = [...prior, award];
  const awardedPotIds = [...state.awardedPotIds, potId];
  const done = state.pots.every((p) => awardedPotIds.includes(p.id));
  const events: EngineEvent[] = [
    {
      type: 'pot_awarded',
      potId,
      winners: award.winners,
      amounts: award.amounts,
      contested: award.contested,
      handNames: award.handNames,
    },
  ];
  const credited: HandPlayer[] = state.players.map((p) => ({
    ...p,
    stack: p.stack + (award.amounts[p.playerId] ?? 0),
  }));
  if (!done) {
    return {
      ok: true,
      value: {
        state: { ...state, players: credited, awardedPotIds, pendingAwards: awards },
        events,
      },
    };
  }
  const players = credited.map((p) => ({ ...p, bet: 0, committed: 0 }));
  const stacks: Record<string, number> = {};
  for (const p of players) stacks[p.playerId] = p.stack;
  const result: HandResult = { awards, stacks, showdown: [] };
  events.push({ type: 'hand_ended', result });
  return {
    ok: true,
    value: {
      state: {
        ...state,
        players,
        awardedPotIds,
        pendingAwards: awards,
        street: 'ended',
        currentActor: null,
        result,
      },
      events,
    },
  };
}
