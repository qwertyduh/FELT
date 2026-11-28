/**
 * The board of a hybrid hand: five places that only say how far the real board has been dealt, so
 * the street can be seen at a glance. The cards carry no rank and no suit; the real ones are on the
 * real table. Face down is the card back; dealt is a blank face with a plain ring.
 *
 * A card flips only when it is dealt while we are looking: what is already up when the table is
 * first shown (a reload, a late arrival) is simply up, and an undo just turns it back.
 */
import { useState } from 'react';
import { CardBack } from './PlayingCard';

const STREET: Readonly<Record<number, string>> = {
  0: 'no cards dealt',
  3: 'flop dealt',
  4: 'turn dealt',
  5: 'river dealt',
};

export function HybridBoard({ handId, dealt }: { handId: string; dealt: number }) {
  /** Cards from `from` up to `dealt` are the ones turning over now. */
  const [seen, setSeen] = useState({ handId, dealt, from: dealt });
  if (seen.handId !== handId || seen.dealt !== dealt) {
    setSeen({ handId, dealt, from: seen.handId === handId ? seen.dealt : dealt });
  }
  const label = `Board: ${STREET[dealt]}, ${dealt} of 5`;
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="board"
      className="grid w-full max-w-60 shrink-0 grid-cols-5 gap-0.5"
    >
      <span aria-live="polite" className="sr-only">
        {label}
      </span>
      {Array.from({ length: 5 }, (_, i) => {
        if (i >= dealt) {
          return (
            <span key={`down${i}`} data-board="down" className="block">
              <CardBack className="w-full" />
            </span>
          );
        }
        const flipping = i >= seen.from;
        return (
          <span
            key={`up${handId}:${i}`}
            data-board="up"
            data-flipping={flipping || undefined}
            aria-hidden="true"
            className="relative block aspect-[5/7] w-full rounded-md bg-card shadow-sm shadow-black/50"
            style={flipping ? { animation: 'felt-flip 320ms ease-out both' } : undefined}
            // Done once: hiding the table and showing it again must not flip it a second time.
            onAnimationEnd={() => setSeen((s) => ({ ...s, from: s.dealt }))}
          >
            <span className="absolute inset-[12%] flex items-center justify-center rounded-sm border border-brass-dim">
              <span className="aspect-square w-1/2 rounded-full border-2 border-brass-dim" />
            </span>
          </span>
        );
      })}
    </div>
  );
}
