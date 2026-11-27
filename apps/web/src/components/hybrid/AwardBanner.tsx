/**
 * The proposed result, shown to every player while it can be disputed (PRD 5.5). The server pays
 * it when its time is up; the countdown here is only a display. Once disputed, nothing moves until
 * the host picks again, and the banner says so. A disputed one can be put aside to look at the
 * table.
 */
import { useEffect, useState } from 'react';
import { AWARD_CONFIRM_MS, type PublicHand, type PublicRoomState } from '@felt/protocol';
import { OUTLINE, SHEET, SOLID, type Tap } from '../../lib/actionUi';
import { playerName } from '../../lib/hybrid';
import { shortChips } from '../../lib/seating';
import { potName } from '../../lib/table';

/** Whole seconds left. Never more than the time since it was first shown allows (clock skew). */
function useSecondsLeft(confirmAt: number): number {
  const [shown] = useState(() => performance.now());
  const left = () => {
    const bySeen = AWARD_CONFIRM_MS - (performance.now() - shown);
    const byClock = confirmAt - Date.now();
    return Math.max(0, Math.ceil((byClock > 0 ? Math.min(byClock, bySeen) : bySeen) / 1000));
  };
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    const id = setInterval(() => setSeconds(left()), 200);
    return () => clearInterval(id);
  });
  return seconds;
}

export function AwardBanner({
  room,
  hand,
  userId,
  stack,
  turnKey,
  tap,
  notice,
  onDispute,
  onRepick,
  onMinimise,
}: {
  room: PublicRoomState;
  hand: PublicHand;
  userId: string;
  /** Null when the viewer has no seat. */
  stack: number | null;
  turnKey: string;
  tap: Tap;
  notice: React.ReactNode;
  onDispute: () => void;
  onRepick: () => void;
  onMinimise: () => void;
}) {
  const hosting = room.hostId === userId;
  const disputed = hand.pendingAwards.some((a) => a.disputed);
  const seconds = useSecondsLeft(hand.pendingAwards[0]!.confirmAt);
  const host = playerName(room, room.hostId);
  const name = (id: string) => (id === userId ? 'You' : playerName(room, id));
  const money = (n: number) => shortChips(n, 100_000_000);

  const action = disputed
    ? hosting && { id: 'repick', label: 'Pick winners again', run: onRepick }
    : { id: 'dispute', label: hosting ? 'Stop and change' : 'Dispute', run: onDispute };

  return (
    <div data-cover data-testid="award-banner" role="group" aria-label="Award" className={SHEET}>
      {notice}
      <div role="status" className="text-center">
        <p className={`text-lg font-semibold ${disputed ? 'text-chip-red' : 'text-cream'}`}>
          {disputed ? 'Disputed. No chips have moved.' : 'Check the winners'}
        </p>
        {disputed && (
          <p className="text-sm wrap-anywhere text-cream">
            {hosting
              ? 'Check the cards together, then pick the winners again.'
              : `Check the cards together. ${host} picks the winners again.`}
          </p>
        )}
      </div>
      {!disputed && (
        <p role="timer" data-testid="award-countdown" className="text-center text-sm text-brass">
          {seconds > 0 ? `Pays out in ${seconds}s` : 'Paying out…'}
        </p>
      )}
      <ul aria-label="Proposed winners" className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {hand.pots.map((pot, i) => {
          const winners = hand.pendingAwards.find((a) => a.potId === pot.id)?.winners ?? [];
          return (
            <li key={pot.id} className="flex items-start justify-between gap-3 text-base">
              <span className="shrink-0 text-cream/75 tabular-nums">
                {potName(i, hand.pots.length)} {money(pot.amount)}
              </span>
              <span className="min-w-0 text-right font-semibold wrap-anywhere text-cream">
                {winners.map(name).join(', ')}
                {winners.length > 1 && ' (split)'}
              </span>
            </li>
          );
        })}
      </ul>
      {stack !== null && (
        <p className="text-center text-sm text-cream/75 tabular-nums">Your stack {money(stack)}</p>
      )}
      {/* A steady last row, so the list does not drop when the button goes. */}
      <div className="grid min-h-12 shrink-0 grid-cols-3 gap-2">
        {disputed && (
          <button
            type="button"
            className={`${OUTLINE} ${action ? '' : 'col-span-3'}`}
            onClick={onMinimise}
          >
            See table
          </button>
        )}
        {action && (
          <button
            key={`${action.id}:${turnKey}`}
            type="button"
            className={`${SOLID} ${disputed ? 'col-span-2' : 'col-span-3'}`}
            {...tap(`${action.id}:${turnKey}`, action.run)}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
