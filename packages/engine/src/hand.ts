import { cardRank, cardSuit, isCard, rankValue } from './cards';
import type { Card, Rank } from './types';

/**
 * Hand categories, weakest to strongest. Numeric so categories compare with
 * `<`. The PRD (5.8) lists the royal flush as its own rank above the straight
 * flush, so it is its own category here (ace-high straight flush only).
 */
export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  FourOfAKind: 7,
  StraightFlush: 8,
  RoyalFlush: 9,
} as const;
export type HandCategoryValue = (typeof HandCategory)[keyof typeof HandCategory];

/**
 * A comparable hand strength. `tiebreak` holds rank values (2..14) in order of
 * significance; arrays within one category always have the same length.
 * - HighCard/Flush: 5 ranks high to low. Pair: [pair, k1, k2, k3].
 * - TwoPair: [high pair, low pair, kicker]. Trips: [trips, k1, k2].
 * - Straight/StraightFlush: [high card] (the wheel is [5]). Royal: [14].
 * - FullHouse: [trips, pair]. Quads: [quads, kicker].
 */
export interface HandRank {
  category: HandCategoryValue;
  tiebreak: readonly number[];
}

/** Result of `bestOf7`: the rank plus the five cards that make it. */
export interface BestHand extends HandRank {
  /** The five cards forming the best hand. */
  cards: readonly Card[];
}

const BASE = 15; // rank values are 2..14, so base 15 packs a tiebreak uniquely

/** Validates cards: valid strings, no duplicates. Throws RangeError (programmer error, like `shuffle`). */
function validate(cards: readonly Card[], min: number, max: number): void {
  if (!Array.isArray(cards) || cards.length < min || cards.length > max) {
    const want = min === max ? String(min) : `${min} to ${max}`;
    throw new RangeError(
      `expected ${want} cards, got ${Array.isArray(cards) ? cards.length : 'non-array'}`,
    );
  }
  const seen = new Set<string>();
  for (const c of cards) {
    if (!isCard(c)) throw new RangeError(`invalid card: ${String(c)}`);
    if (seen.has(c)) throw new RangeError(`duplicate card: ${c}`);
    seen.add(c);
  }
}

/**
 * Core scorer. `r` = five rank values, `suited` = all same suit.
 * Returns category*BASE^5 + packed tiebreak, so a plain number comparison is
 * the full hand comparison.
 */
function score5(r: readonly number[], suited: boolean): number {
  const sorted = r.slice().sort((a, b) => b - a);
  // Group equal ranks: by count desc, then rank desc.
  const groups: [number, number][] = []; // [count, rank]
  for (const v of sorted) {
    const last = groups[groups.length - 1];
    if (last && last[1] === v) last[0]++;
    else groups.push([1, v]);
  }
  groups.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const counts = groups.map((g) => g[0]);
  const ranks = groups.map((g) => g[1]);

  let category: number;
  let tb: number[];
  const distinct = groups.length === 5;
  const hi = sorted[0] as number;
  const isWheel = distinct && hi === 14 && sorted[1] === 5 && sorted[4] === 2;
  const isStraight = distinct && (hi - (sorted[4] as number) === 4 || isWheel);
  const straightHigh = isWheel ? 5 : hi;

  if (isStraight && suited) {
    category = straightHigh === 14 ? HandCategory.RoyalFlush : HandCategory.StraightFlush;
    tb = [straightHigh];
  } else if (counts[0] === 4) {
    category = HandCategory.FourOfAKind;
    tb = ranks;
  } else if (counts[0] === 3 && counts[1] === 2) {
    category = HandCategory.FullHouse;
    tb = ranks;
  } else if (suited) {
    category = HandCategory.Flush;
    tb = sorted;
  } else if (isStraight) {
    category = HandCategory.Straight;
    tb = [straightHigh];
  } else if (counts[0] === 3) {
    category = HandCategory.ThreeOfAKind;
    tb = ranks;
  } else if (counts[0] === 2 && counts[1] === 2) {
    category = HandCategory.TwoPair;
    tb = ranks;
  } else if (counts[0] === 2) {
    category = HandCategory.Pair;
    tb = ranks;
  } else {
    category = HandCategory.HighCard;
    tb = sorted;
  }
  // Pad to 5 digits so scores of different lengths never collide (same category => same length anyway).
  let packed = 0;
  for (let i = 0; i < 5; i++) packed = packed * BASE + (tb[i] ?? 0);
  return category * BASE ** 5 + packed;
}

function decode(score: number): HandRank {
  const category = Math.floor(score / BASE ** 5) as HandCategoryValue;
  let rest = score % BASE ** 5;
  const digits: number[] = [];
  for (let i = 0; i < 5; i++) {
    digits.unshift(rest % BASE);
    rest = Math.floor(rest / BASE);
  }
  const len =
    category === HandCategory.HighCard || category === HandCategory.Flush
      ? 5
      : category === HandCategory.Pair
        ? 4
        : category === HandCategory.TwoPair || category === HandCategory.ThreeOfAKind
          ? 3
          : category === HandCategory.FullHouse || category === HandCategory.FourOfAKind
            ? 2
            : 1;
  return { category, tiebreak: digits.slice(0, len) };
}

/** Evaluates exactly five distinct cards. Throws RangeError on a wrong count, invalid or duplicate card. */
export function evaluate5(cards: readonly Card[]): HandRank {
  validate(cards, 5, 5);
  const suited = cards.every((c) => cardSuit(c) === cardSuit(cards[0] as Card));
  return decode(
    score5(
      cards.map((c) => rankValue(cardRank(c))),
      suited,
    ),
  );
}

// Index combinations of 5 out of n, for n = 5..7.
const COMBOS: Record<number, number[][]> = {};
for (let n = 5; n <= 7; n++) {
  const out: number[][] = [];
  const rec = (start: number, cur: number[]): void => {
    if (cur.length === 5) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  COMBOS[n] = out;
}

/**
 * Best five-card hand from 5 to 7 distinct cards (hole + board). Throws
 * RangeError on a bad count, invalid or duplicate card.
 */
export function bestOf7(cards: readonly Card[]): BestHand {
  validate(cards, 5, 7);
  const vals = cards.map((c) => rankValue(cardRank(c)));
  const suits = cards.map(cardSuit);
  let best = -1;
  let bestIdx: number[] = [];
  for (const idx of COMBOS[cards.length] as number[][]) {
    const [a, b, c, d, e] = idx as [number, number, number, number, number];
    const s = suits[a];
    const suited = s === suits[b] && s === suits[c] && s === suits[d] && s === suits[e];
    const sc = score5(
      [
        vals[a] as number,
        vals[b] as number,
        vals[c] as number,
        vals[d] as number,
        vals[e] as number,
      ],
      suited,
    );
    if (sc > best) {
      best = sc;
      bestIdx = idx;
    }
  }
  return { ...decode(best), cards: bestIdx.map((i) => cards[i] as Card) };
}

/** Negative if a < b, 0 if exactly equal (split), positive if a > b. */
export function compareHands(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  const n = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < n; i++) {
    const d = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const NAMES: Record<Rank, [string, string]> = {
  '2': ['Two', 'Twos'],
  '3': ['Three', 'Threes'],
  '4': ['Four', 'Fours'],
  '5': ['Five', 'Fives'],
  '6': ['Six', 'Sixes'],
  '7': ['Seven', 'Sevens'],
  '8': ['Eight', 'Eights'],
  '9': ['Nine', 'Nines'],
  T: ['Ten', 'Tens'],
  J: ['Jack', 'Jacks'],
  Q: ['Queen', 'Queens'],
  K: ['King', 'Kings'],
  A: ['Ace', 'Aces'],
};
const RANK_BY_VALUE: readonly Rank[] = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'T',
  'J',
  'Q',
  'K',
  'A',
];

function rankName(value: number, plural: boolean): string {
  const r = RANK_BY_VALUE[value - 2];
  if (!r) throw new RangeError(`invalid rank value: ${value}`);
  return NAMES[r][plural ? 1 : 0];
}

/** Natural-language name, e.g. "Full house, Kings over Threes". */
export function handName(hand: HandRank): string {
  const t = hand.tiebreak;
  const s = (i: number): string => rankName(t[i] as number, false);
  const p = (i: number): string => rankName(t[i] as number, true);
  switch (hand.category) {
    case HandCategory.HighCard:
      return `High card, ${s(0)}`;
    case HandCategory.Pair:
      return `Pair of ${p(0)}`;
    case HandCategory.TwoPair:
      return `Two pair, ${p(0)} and ${p(1)}`;
    case HandCategory.ThreeOfAKind:
      return `Three of a kind, ${p(0)}`;
    case HandCategory.Straight:
      return t[0] === 5 ? 'Five-high straight (the wheel)' : `Straight, ${s(0)} high`;
    case HandCategory.Flush:
      return `Flush, ${s(0)} high`;
    case HandCategory.FullHouse:
      return `Full house, ${p(0)} over ${p(1)}`;
    case HandCategory.FourOfAKind:
      return `Four of a kind, ${p(0)}`;
    case HandCategory.StraightFlush:
      return `Straight flush, ${s(0)} high`;
    case HandCategory.RoyalFlush:
      return 'Royal flush';
    default:
      throw new RangeError(`invalid hand category: ${String(hand.category)}`);
  }
}
