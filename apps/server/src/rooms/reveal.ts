/**
 * What of an online hand's cards may leave the server, and to whom (P47). Everything returned is
 * written field by field: nothing here ever passes an engine object on.
 *
 * - To its owner only: their two hole cards (`hand:private`).
 * - To the table, once the hand has ended:
 *   - after an all-in run-out, every hand still contesting a pot;
 *   - after any other showdown, the winners of contested pots (losers are mucked);
 *   - when everyone else folded, nothing;
 *   - plus whoever chose to show (`hand:show`).
 * The deck never leaves.
 */
import type { HandResult, HandState } from '@felt/engine';
import {
  MAX_SEATS,
  type HandOutcome,
  type ServerEventPayload,
  type ShownHand,
} from '@felt/protocol';
import type { GameHand } from './gameSchema';
import type { RoomRecord } from './roomStore';

export type Revealing = Pick<GameHand, 'runoutFrom' | 'shown' | 'aggressor'>;

/** This user's own cards in the hand on the table, unless they gave up their seat during it. */
export function privateHandOf(
  room: Readonly<RoomRecord>,
  userId: string,
): ServerEventPayload<'hand:private'> | null {
  const hand = room.game?.hand;
  if (!hand || !room.admitted.includes(userId) || hand.departed.includes(userId)) return null;
  const hole = hand.state.players.find((p) => p.playerId === userId)?.hole;
  return hole ? { handId: hand.handId, holeCards: [hole[0], hole[1]] } : null;
}

/**
 * The hands face up on the table, in showing order: from the last river bettor, or else from the
 * left of the button, clockwise. Empty until an online hand has ended.
 */
export function shownHands(
  state: HandState,
  { runoutFrom, shown, aggressor }: Revealing,
): ShownHand[] {
  const { result } = state;
  if (state.mode !== 'online' || state.street !== 'ended' || !result) return [];
  const byRules = new Set(
    runoutFrom === undefined
      ? result.awards.filter((a) => a.contested).flatMap((a) => [...a.winners])
      : result.showdown.map((s) => s.playerId),
  );
  const chosen = new Set(shown ?? []);
  const lead = state.players.find((p) => p.playerId === aggressor && p.status !== 'folded');
  const first = lead?.seat ?? state.button + 1;
  const order = (seat: number) => (seat - first + MAX_SEATS) % MAX_SEATS;
  return state.players
    .filter((p) => p.hole && (byRules.has(p.playerId) || chosen.has(p.playerId)))
    .sort((a, b) => order(a.seat) - order(b.seat))
    .map((p) => ({
      userId: p.playerId,
      cards: [p.hole![0], p.hole![1]],
      handName: result.showdown.find((s) => s.playerId === p.playerId)?.handName ?? null,
      voluntary: !byRules.has(p.playerId),
    }));
}

/** Pot by pot. Hand names are the winners' only, whose cards are on show. */
export function publicAwards(result: HandResult): HandOutcome['awards'] {
  return result.awards.map((a) => ({
    potId: a.potId,
    winners: [...a.winners],
    amounts: { ...a.amounts },
    contested: a.contested,
    handNames: { ...a.handNames },
  }));
}
