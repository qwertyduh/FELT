/**
 * The button that opens the hand-rank sheet, and whether it is open. It takes its own place in the
 * layout (a room puts it in its header), never laid over anything.
 */
import { useState, type ReactNode } from 'react';
import { HandRanksSheet } from './HandRanksSheet';
import type { CurrentHand } from './ranks';

export function HandRanksButton({
  current = null,
  indicator,
  dismiss = false,
}: {
  current?: CurrentHand | null;
  indicator?: ReactNode;
  /** Something with a short window has arrived: put the sheet away. */
  dismiss?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [wasDismissed, setWasDismissed] = useState(dismiss);
  if (dismiss !== wasDismissed) {
    setWasDismissed(dismiss);
    if (dismiss) setOpen(false);
  }
  return (
    <>
      <button
        type="button"
        data-testid="hand-ranks-button"
        aria-haspopup="dialog"
        aria-label="Hand ranks"
        className="min-h-11 min-w-11 shrink-0 rounded-full border border-brass bg-felt-950 text-xs font-semibold text-brass shadow-md shadow-black/40 active:brightness-90"
        onClick={() => setOpen(true)}
      >
        Ranks
      </button>
      {open && (
        <HandRanksSheet current={current} indicator={indicator} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
