/**
 * The host's answer to your top-up (P43), over the screen just below the header. It takes no taps and moves
 * nothing.
 */
import { useEffect } from 'react';
import { clearTopUpDecision, useRoomStore } from '../lib/realtime/roomStore';
import { topUpDecisionLine } from '../lib/topUp';

export const TOAST_MS = 5_000;

export function TopUpToast() {
  const decision = useRoomStore((s) => s.topUpDecision);

  useEffect(() => {
    if (!decision) return;
    const id = setTimeout(clearTopUpDecision, TOAST_MS);
    return () => clearTimeout(id);
  }, [decision]);

  return (
    <div
      role="status"
      // Below the header, so Home and the host's button stay in view.
      className="pointer-events-none fixed inset-x-0 top-[calc(max(1rem,env(safe-area-inset-top))+3rem)] z-30 mx-auto w-full max-w-[480px] px-3"
    >
      {decision && (
        <p
          data-testid="topup-toast"
          className="rounded-2xl border-2 border-brass bg-felt-950 px-4 py-3 text-center text-base wrap-anywhere text-cream"
        >
          {topUpDecisionLine(decision)}
        </p>
      )}
    </div>
  );
}
