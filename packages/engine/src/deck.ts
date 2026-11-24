import { RANKS, SUITS } from './types';
import type { Card } from './types';

/** Returns a fresh ordered 52-card deck (suit-major, ranks 2..A). */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`);
  }
  return deck;
}

/** Injected RNG: returns an integer in [0, maxExclusive). */
export type RandInt = (maxExclusive: number) => number;

/**
 * Fisher-Yates shuffle with an injected RNG. Pure: returns a new array and
 * never mutates the input. Throws if the RNG breaks its contract (a bad RNG is
 * a programmer/infra error, not a game error).
 */
export function shuffle<T>(items: readonly T[], randInt: RandInt): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) {
      throw new RangeError(
        `randInt(${i + 1}) returned ${String(j)}, expected an integer in [0, ${i}]`,
      );
    }
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
