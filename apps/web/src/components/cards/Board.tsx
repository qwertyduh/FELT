/**
 * The community cards of an online hand (P49): five places, filled street by street. Hybrid tables
 * show `HybridBoard` instead (the real cards are on the real table).
 */
import type { CardString } from '@felt/protocol';
import { PlayingCard } from './PlayingCard';

export function Board({ cards }: { cards: readonly CardString[] }) {
  return (
    <div
      role="group"
      aria-label={cards.length ? 'Community cards' : 'No community cards yet'}
      aria-live="polite"
      data-testid="board"
      className="grid w-full max-w-60 shrink-0 grid-cols-5 gap-0.5"
    >
      {Array.from({ length: 5 }, (_, i) => {
        const card = cards[i];
        return card ? (
          <PlayingCard key={card} card={card} className="w-full" />
        ) : (
          <span
            key={`empty${i}`}
            aria-hidden="true"
            className="aspect-[5/7] w-full rounded-md border border-dashed border-felt-700"
          />
        );
      })}
    </div>
  );
}
