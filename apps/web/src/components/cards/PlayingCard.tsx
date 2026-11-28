/**
 * One playing card, face up or down (P49). Four colours, one per suit, and always the suit's shape
 * too, so colour is never the only cue. The shapes are drawn (not font characters, which some
 * phones turn into emoji). The card takes its width from `className`; everything on it scales.
 */
import type { CardString } from '@felt/protocol';
import { cardName, rankOf, suitOf, type Suit } from '../../lib/cards';

const SHAPE: Readonly<Record<Suit, string>> = {
  s: 'M12 1.5C9 6.5 2.5 9.5 2.5 14.6a4.7 4.7 0 0 0 8.3 3c-.2 2-.9 3.4-2.3 4.9h7c-1.4-1.5-2.1-2.9-2.3-4.9a4.7 4.7 0 0 0 8.3-3C21.500 9.500 15 6.500 12 1.500z',
  h: 'M12 22C6.500 17.200 2 13.200 2 8.300 2 5.300 4.300 3 7.200 3c2 0 3.800 1.100 4.800 2.800C13 4.100 14.800 3 16.800 3 19.700 3 22 5.300 22 8.300c0 4.900-4.500 8.900-10 13.700z',
  d: 'M12 1 20.500 12 12 23 3.500 12z',
  c: 'M12 1.500a4.800 4.800 0 0 0-3.900 7.600 4.800 4.800 0 1 0 2.700 8.400c-.2 2-.9 3.500-2.3 5h7c-1.400-1.500-2.100-3-2.300-5a4.800 4.800 0 1 0 2.700-8.400A4.800 4.800 0 0 0 12 1.500z',
};
const COLOUR: Readonly<Record<Suit, string>> = {
  s: 'text-suit-spade',
  h: 'text-suit-heart',
  d: 'text-suit-diamond',
  c: 'text-suit-club',
};

const BASE = '@container relative block aspect-[5/7] shrink-0';

export function PlayingCard({ card, className = '' }: { card: CardString; className?: string }) {
  const suit = suitOf(card);
  return (
    <span
      role="img"
      aria-label={cardName(card)}
      data-card-face={card}
      className={`${BASE} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-0 flex flex-col items-center justify-center gap-[4cqw] rounded-[12cqw] bg-card shadow-sm shadow-black/50 ${COLOUR[suit]}`}
      >
        <span className="text-[62cqw] leading-[0.9] font-bold tracking-tighter tabular-nums">
          {rankOf(card)}
        </span>
        <svg viewBox="0 0 24 24" data-suit={suit} className="w-[58cqw] fill-current">
          <path d={SHAPE[suit]} />
        </svg>
      </span>
    </span>
  );
}

/** Decorative: whoever holds it is named by what is around it. */
export function CardBack({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" data-card-back className={`${BASE} ${className}`}>
      <span className="absolute inset-0 rounded-[12cqw] border-[8cqw] border-card bg-[repeating-linear-gradient(45deg,var(--color-chip-back)_0_2px,var(--color-brass-dim)_2px_4px)] shadow-sm shadow-black/50" />
    </span>
  );
}
