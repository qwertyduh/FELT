/**
 * Optional community cards for the street being dealt (PRD 5.5: for the record only). All of the
 * street's cards or none: dealing without them is the bar's own button.
 */
import { useState } from 'react';
import { CARD_RANKS, CARD_SUITS, type CardString } from '@felt/protocol';
import { OUTLINE, SHEET, SOLID, type Tap } from '../../lib/actionUi';

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' } as const;
const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const;
const RANK_NAME: Partial<Record<string, string>> = {
  A: 'Ace',
  K: 'King',
  Q: 'Queen',
  J: 'Jack',
  T: '10',
};
const rankLabel = (r: string) => (r === 'T' ? '10' : r);
const face = (c: CardString) => `${rankLabel(c[0]!)}${SUIT[c[1] as keyof typeof SUIT]}`;
const PICK =
  'min-h-11 rounded-lg border text-lg font-semibold tabular-nums disabled:border-felt-700 disabled:text-cream/30';

export function CardSheet({
  label,
  count,
  board,
  turnKey,
  tap,
  notice,
  onBack,
  onDeal,
}: {
  label: string;
  count: number;
  /** Cards already recorded: they cannot be picked again. */
  board: readonly CardString[];
  turnKey: string;
  tap: Tap;
  notice: React.ReactNode;
  onBack: () => void;
  onDeal: (cards: CardString[]) => void;
}) {
  const [cards, setCards] = useState<CardString[]>([]);
  const [rank, setRank] = useState<string | null>(null);
  const used = new Set<string>([...board, ...cards]);
  const full = cards.length === count;
  const confirm = tap(`deal-cards:${turnKey}`, () => onDeal(cards));
  return (
    <div data-cover data-testid="card-sheet" role="group" aria-label="Cards" className={SHEET}>
      {notice}
      <p className="text-center text-sm text-cream/75">
        Optional, for the record. Pick the rank, then the suit.
      </p>
      <div className="flex items-center justify-center gap-2">
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            data-testid="card-slot"
            className="flex h-11 w-12 items-center justify-center rounded-lg border border-brass-dim text-lg font-semibold text-cream"
          >
            {cards[i] ? face(cards[i]) : ''}
          </span>
        ))}
        <button
          type="button"
          className="min-h-11 px-2 text-sm text-brass disabled:text-cream/30"
          disabled={cards.length === 0}
          onClick={() => setCards(cards.slice(0, -1))}
        >
          Remove
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {[...CARD_RANKS].reverse().map((r) => (
          <button
            key={r}
            type="button"
            aria-label={RANK_NAME[r] ?? r}
            aria-pressed={rank === r}
            disabled={full || CARD_SUITS.every((s) => used.has(`${r}${s}`))}
            className={`${PICK} ${rank === r ? 'border-brass bg-felt-700 text-cream' : 'border-felt-700 text-brass'}`}
            onClick={() => setRank(r)}
          >
            {rankLabel(r)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1">
        {(['s', 'h', 'd', 'c'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-label={SUIT_NAME[s]}
            disabled={full || rank === null || used.has(`${rank}${s}`)}
            className={`${PICK} border-felt-700 text-2xl text-cream`}
            onClick={() => {
              setCards([...cards, `${rank}${s}` as CardString]);
              setRank(null);
            }}
          >
            {SUIT[s]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <button type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button
          key={turnKey}
          type="button"
          className={`${SOLID} col-span-2`}
          {...confirm}
          disabled={confirm.disabled || !full}
        >
          {label}
        </button>
      </div>
    </div>
  );
}
