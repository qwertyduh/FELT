/**
 * Hybrid host controls (P41): what the table is waiting for the host to do. Read from
 * `room:state`; the server checks every intent again.
 */
import type { PublicHand, PublicRoomState } from '@felt/protocol';

export type DealStreet = 'preflop' | 'flop' | 'turn' | 'river';
export type HostStep = { kind: 'deal'; street: DealStreet } | { kind: 'award' };

/** The button that moves on from each street, and how many cards may be recorded with it. */
export const DEALS: Readonly<Record<DealStreet, { label: string; cards: number }>> = {
  preflop: { label: 'Flop dealt', cards: 3 },
  flop: { label: 'Turn dealt', cards: 1 },
  turn: { label: 'River dealt', cards: 1 },
  river: { label: 'Showdown', cards: 0 },
};

export function hostStep(room: PublicRoomState): HostStep | null {
  const { hand } = room;
  if (room.settings.mode !== 'hybrid' || room.status !== 'playing' || room.paused) return null;
  if (!hand || hand.street === 'ended' || hand.pendingAwards.length > 0) return null;
  if (hand.street === 'showdown') return { kind: 'award' };
  if (!hand.awaitingHost || hand.currentActor !== null) return null;
  return { kind: 'deal', street: hand.street };
}

export type Award = { potId: string; winners: string[] };

/**
 * The picks the award sheet opens with: those of a disputed proposal, and the only possible winner
 * of a pot only one player can win. Only eligible players are ever carried over.
 */
export function initialPicks(hand: PublicHand): Record<string, string[]> {
  return Object.fromEntries(
    hand.pots.map((pot) => {
      const before = hand.pendingAwards.find((a) => a.potId === pot.id)?.winners ?? [];
      const picks =
        pot.eligible.length === 1 ? pot.eligible : before.filter((w) => pot.eligible.includes(w));
      return [pot.id, [...picks]];
    }),
  );
}

export const playerName = (room: PublicRoomState, userId: string) =>
  room.seats.find((s) => s?.userId === userId)?.username ?? 'A player';
