/**
 * Card wording and what of an online hand may be on screen yet (P49). Read from `room:state`;
 * nothing here knows any rule of the game.
 */
import type { CardString, PublicHand, PublicRoomState } from '@felt/protocol';

export type Suit = 's' | 'h' | 'd' | 'c';

const RANK_NAMES: Readonly<Record<string, string>> = {
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  T: 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
  A: 'Ace',
};
const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};

export const suitOf = (card: CardString) => card[1] as Suit;
export const rankOf = (card: CardString) => (card[0] === 'T' ? '10' : card[0]!);
/** For screen readers: "Ace of spades". */
export const cardName = (card: CardString) =>
  `${RANK_NAMES[card[0]!]} of ${SUIT_NAMES[suitOf(card)]}`;

/**
 * An all-in run-out: the state already holds the whole board and the final stacks, but the table
 * does not give them away at once (`useShownRoom` lets them go; P50 animates that).
 */
export const resultHeld = (hand: PublicHand | null): boolean =>
  (hand?.outcome?.runoutFrom ?? null) !== null;

/**
 * The room as the table may show it. While a result is held: the board as it was when the betting
 * closed, everything won back in the middle and the stacks as they were then. Otherwise the room
 * itself. For display only; whatever sends something reads the real state.
 */
export function asShown(room: PublicRoomState): PublicRoomState {
  const { hand } = room;
  if (!hand?.outcome || !resultHeld(hand)) return room;
  const won = new Map<string, number>();
  let pot = 0;
  for (const award of hand.outcome.awards) {
    for (const [userId, amount] of Object.entries(award.amounts)) {
      won.set(userId, (won.get(userId) ?? 0) + amount);
      pot += amount;
    }
  }
  return {
    ...room,
    seats: room.seats.map(
      (s) => s && { ...s, stack: Math.max(0, s.stack - (won.get(s.userId) ?? 0)), bet: 0 },
    ),
    hand: {
      ...hand,
      board: hand.board.slice(0, hand.outcome.runoutFrom!),
      pots: [{ id: 'held', amount: pot, eligible: [] }],
      departedBet: 0,
    },
  };
}
