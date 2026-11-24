import { RANKS, SUITS } from './types';
import type { Card, Rank, Suit } from './types';

const RANK_SET: ReadonlySet<string> = new Set(RANKS);
const SUIT_SET: ReadonlySet<string> = new Set(SUITS);

/** Type guard: is `s` exactly a valid card string like "Ah"? Case-sensitive. */
export function isCard(s: unknown): s is Card {
  return (
    typeof s === 'string' &&
    s.length === 2 &&
    RANK_SET.has(s.charAt(0)) &&
    SUIT_SET.has(s.charAt(1))
  );
}

/** Returns the card, or null if invalid. Case-sensitive ("ah" and "10h" are invalid). */
export function parseCard(s: string): Card | null {
  return isCard(s) ? s : null;
}

export function formatCard(card: Card): string {
  return card;
}

export function cardRank(card: Card): Rank {
  return card.charAt(0) as Rank;
}

export function cardSuit(card: Card): Suit {
  return card.charAt(1) as Suit;
}

/** 2..14 (Ace high). */
export function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank) + 2;
}
