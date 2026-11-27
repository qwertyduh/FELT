/**
 * Hybrid host controls (P41): what the table is waiting for the host to do. Read from
 * `room:state`; the server checks every intent again.
 */
import type {
  ErrorPayload,
  PublicHand,
  PublicRoomState,
  PublicSeat,
  RoomLogEntry,
  UndoAction,
} from '@felt/protocol';
import { chips } from './seating';
import { streetName } from './table';

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

const MOVES: Readonly<Record<Exclude<UndoAction, 'deal'>, string>> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  bet: 'bet',
  raise: 'raise',
  all_in: 'all-in',
};

const dealt = (street: PublicHand['street']) =>
  street === 'showdown' ? 'the move to showdown' : `the ${streetName(street).toLowerCase()} deal`;

/** What an undo would take back, as in "Undo bea's call". */
export function undoName(room: PublicRoomState, hand: PublicHand): string {
  const { undo } = hand;
  if (!undo) return 'the last step';
  if (undo.action === 'deal') return dealt(hand.street);
  return `${playerName(room, undo.userId!)}'s ${MOVES[undo.action]}`;
}

export function logLine(entry: RoomLogEntry): string {
  if (entry.kind === 'adjust') {
    const sign = entry.amount > 0 ? '+' : '−';
    return `Host changed ${entry.username}'s stack by ${sign}${chips(Math.abs(entry.amount))} to ${chips(entry.stack)}: ${entry.reason}`;
  }
  if (entry.action === 'deal') return `Host undid ${dealt(entry.street)}`;
  const who = entry.username ?? 'a player';
  return `Host undid ${who}'s ${MOVES[entry.action]} (${streetName(entry.street).toLowerCase()})`;
}

/** Whether the host's correction must wait: this player's chips are still being bet. */
export function stillInHand(room: PublicRoomState, seat: PublicSeat): boolean {
  const { hand } = room;
  return (
    hand !== null &&
    hand.street !== 'ended' &&
    seat.handStatus !== null &&
    seat.handStatus !== 'folded'
  );
}

export function adjustFailure({ code }: ErrorPayload): string {
  switch (code as string) {
    case 'stale_hand':
      return 'That stack changed. Check it and try again.';
    case 'illegal_action':
      return "They can't be corrected right now: they are in the hand.";
    case 'not_seated':
      return 'That player has no seat now.';
    case 'invalid_amount':
    case 'invalid_payload':
      return "The table didn't accept that. Use plain text and a smaller change.";
    case 'room_paused':
      return 'The game is paused.';
    case 'rate_limited':
      return 'Too fast. Wait a moment.';
    case 'timeout':
      return 'No answer. Check the room log before trying again.';
    default:
      return 'Not saved. Try again.';
  }
}
