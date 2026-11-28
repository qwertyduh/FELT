/**
 * A quick reaction at its sender's seat for a few seconds, over their own name: it stays inside the
 * seat's box, so it covers nobody's stack or bet and not the turn ring. Takes no taps.
 */
import { useRoomStore } from '../../lib/realtime/roomStore';

export function ReactionBubble({ userId }: { userId: string }) {
  const reaction = useRoomStore((s) => s.reactions[userId]);
  if (!reaction) return null;
  return (
    <span
      key={reaction.n}
      data-testid="reaction"
      role="img"
      aria-label={`Reaction ${reaction.emoji}`}
      className="pointer-events-none absolute -top-1 left-1/2 z-[6] -ml-3 flex size-6 items-center justify-center rounded-full border border-brass bg-felt-950 text-sm leading-none"
      style={{ animation: 'felt-rise 200ms ease-out both' }}
    >
      {reaction.emoji}
    </span>
  );
}
