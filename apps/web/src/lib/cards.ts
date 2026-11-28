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
 * does not give them away at once (`useShownRoom` turns the board over street by street).
 */
export const resultHeld = (hand: PublicHand | null): boolean =>
  (hand?.outcome?.runoutFrom ?? null) !== null;

/** Board cards face up at each step of a run-out: as the betting closed, then street by street. */
export const runoutSteps = (from: 0 | 3 | 4): number[] => [
  from,
  ...[3, 4, 5].filter((n) => n > from),
];

/**
 * The room as the table may show it. While a result is held: `faceUp` board cards, everything won
 * back in the middle (pot by pot), the stacks as they were when the betting closed and the hand
 * still at showdown. The contesting hands are face up, but nothing says who won or with what.
 * Otherwise the room itself. For display only; whatever sends something reads the real state.
 */
export function asShown(room: PublicRoomState, faceUp?: number): PublicRoomState {
  const { hand } = room;
  if (!hand?.outcome || !resultHeld(hand)) return room;
  const { outcome } = hand;
  const won = new Map<string, number>();
  const pots = outcome.awards.map((award) => {
    let amount = 0;
    for (const [userId, chips] of Object.entries(award.amounts)) {
      won.set(userId, (won.get(userId) ?? 0) + chips);
      amount += chips;
    }
    return { id: award.potId, amount, eligible: [] };
  });
  return {
    ...room,
    seats: room.seats.map(
      (s) => s && { ...s, stack: Math.max(0, s.stack - (won.get(s.userId) ?? 0)), bet: 0 },
    ),
    hand: {
      ...hand,
      street: 'showdown',
      board: hand.board.slice(0, faceUp ?? outcome.runoutFrom!),
      pots,
      departedBet: 0,
      outcome: {
        ...outcome,
        hands: outcome.hands.map((h) => ({ ...h, handName: null })),
        awards: [],
      },
    },
  };
}
