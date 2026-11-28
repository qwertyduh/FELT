/**
 * The ten hand ranks, best first, with an example of each (PRD 5.8), and which of them the cards a
 * player can see make now. The engine's evaluator decides that; nothing here ranks hands itself.
 * Shared by every table that has the hand-rank sheet.
 */
import {
  HandCategory,
  bestOf7,
  cardRank,
  handName,
  rankValue,
  type Card,
  type HandCategoryValue,
  type HandRank,
} from '@felt/engine';

export interface RankRow {
  category: HandCategoryValue;
  name: string;
  /** The cards that make the rank come first. */
  example: readonly Card[];
  /** How many of `example` make the rank; the rest are only there to fill the hand. */
  made: number;
}

export const RANK_ROWS: readonly RankRow[] = [
  {
    category: HandCategory.RoyalFlush,
    name: 'Royal flush',
    example: ['As', 'Ks', 'Qs', 'Js', 'Ts'],
    made: 5,
  },
  {
    category: HandCategory.StraightFlush,
    name: 'Straight flush',
    example: ['9h', '8h', '7h', '6h', '5h'],
    made: 5,
  },
  {
    category: HandCategory.FourOfAKind,
    name: 'Four of a kind',
    example: ['Qs', 'Qh', 'Qd', 'Qc', '4d'],
    made: 4,
  },
  {
    category: HandCategory.FullHouse,
    name: 'Full house',
    example: ['Ks', 'Kh', 'Kd', '7c', '7d'],
    made: 5,
  },
  { category: HandCategory.Flush, name: 'Flush', example: ['Ad', 'Jd', '8d', '6d', '2d'], made: 5 },
  {
    category: HandCategory.Straight,
    name: 'Straight',
    example: ['Ts', '9h', '8d', '7c', '6s'],
    made: 5,
  },
  {
    category: HandCategory.ThreeOfAKind,
    name: 'Three of a kind',
    example: ['8s', '8h', '8d', 'Kc', '3h'],
    made: 3,
  },
  {
    category: HandCategory.TwoPair,
    name: 'Two pair',
    example: ['Js', 'Jd', '4h', '4c', 'As'],
    made: 4,
  },
  {
    category: HandCategory.Pair,
    name: 'One pair',
    example: ['Ts', 'Th', 'Ac', '7d', '3s'],
    made: 2,
  },
  {
    category: HandCategory.HighCard,
    name: 'High card',
    example: ['As', 'Jh', '8d', '5c', '2h'],
    made: 1,
  },
];

export interface CurrentHand {
  category: HandCategoryValue;
  /** In words, e.g. "Two pair, Kings and Fives". */
  name: string;
}

const named = (rank: HandRank): CurrentHand => ({
  category: rank.category,
  name: handName(rank),
});

/**
 * The best hand made by two hole cards and the board **as it is on screen**: pass only the cards
 * shown, so a run-out is never given away. Before the flop it is a pair or a high card. Null if the
 * cards are not a hand's worth.
 */
export function currentHand(hole: readonly Card[], board: readonly Card[]): CurrentHand | null {
  const cards = [...hole, ...board];
  if (hole.length !== 2 || new Set(cards).size !== cards.length) return null;
  if (board.length === 0) {
    const [a, b] = hole.map((card) => rankValue(cardRank(card))) as [number, number];
    return named({
      category: a === b ? HandCategory.Pair : HandCategory.HighCard,
      tiebreak: [Math.max(a, b)],
    });
  }
  if (cards.length < 5 || cards.length > 7) return null;
  return named(bestOf7(cards));
}
