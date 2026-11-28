/**
 * The viewer's own two cards (P49), from `hand:private`. Only ever those of the hand on screen:
 * anything held for another hand is shown as face down until this hand's cards arrive.
 */
import { useRoomStore } from '../../lib/realtime/roomStore';
import { CardBack, PlayingCard } from './PlayingCard';

const CARD = 'w-11 min-[360px]:w-13 [@media(max-height:600px)]:w-10';

export function HoleCards({
  handId,
  folded,
  size = CARD,
  testId = 'hole-cards',
}: {
  handId: string;
  folded: boolean;
  /** Width classes of each card. */
  size?: string;
  testId?: string;
}) {
  const own = useRoomStore((s) => s.privateHand);
  const cards = own?.handId === handId ? own.holeCards : null;
  return (
    <div
      role="group"
      aria-label={cards ? `Your cards${folded ? ', folded' : ''}` : 'Your cards are on the way'}
      data-testid={testId}
      className="relative flex shrink-0 gap-1"
    >
      <div className={`flex gap-1 ${folded ? 'opacity-45' : ''}`}>
        {cards
          ? cards.map((card) => <PlayingCard key={card} card={card} className={size} />)
          : [0, 1].map((i) => <CardBack key={i} className={size} />)}
      </div>
      {folded && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-1/2 mx-auto w-fit -translate-y-1/2 rounded-full bg-felt-950 px-2 text-xs font-semibold text-cream"
        >
          Folded
        </span>
      )}
    </div>
  );
}
