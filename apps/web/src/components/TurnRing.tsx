/** The turn timer (P49): a ring with the seconds left, and a ring around the seat on turn. */
import { URGENT_MS, useTimeLeft, type TurnTimer } from '../lib/turnClock';

function Ring({ timer, testId }: { timer: TurnTimer; testId: string }) {
  const left = useTimeLeft(timer);
  const seconds = Math.ceil(left / 1000);
  const urgent = left <= URGENT_MS;
  return (
    <span
      role="timer"
      aria-label={`${seconds} seconds left`}
      data-testid={testId}
      data-urgent={urgent || undefined}
      className="relative inline-flex size-9 shrink-0 items-center justify-center"
    >
      <svg viewBox="0 0 36 36" aria-hidden="true" className="absolute inset-0 -rotate-90">
        <circle cx="18" cy="18" r="16" fill="none" strokeWidth="4" className="stroke-felt-950" />
        <circle
          cx="18"
          cy="18"
          r="16"
          fill="none"
          strokeWidth="4"
          pathLength={100}
          strokeDasharray="100 100"
          strokeDashoffset={100 * (1 - left / timer.totalMs)}
          className={urgent ? 'stroke-chip-red' : 'stroke-brass'}
        />
      </svg>
      <span
        aria-hidden="true"
        className={`text-sm font-bold tabular-nums ${urgent ? 'text-chip-red' : 'text-cream'}`}
      >
        {seconds}
      </span>
    </span>
  );
}

function SeatOutline({ timer }: { timer: TurnTimer }) {
  const left = useTimeLeft(timer);
  return (
    <svg
      aria-hidden="true"
      data-testid="seat-ring"
      className="pointer-events-none absolute -top-1 -left-1 h-[calc(100%+0.5rem)] w-[calc(100%+0.5rem)] overflow-visible"
    >
      <rect
        width="100%"
        height="100%"
        rx="15"
        fill="none"
        strokeWidth="3"
        pathLength={100}
        strokeDasharray="100 100"
        strokeDashoffset={100 * (1 - left / timer.totalMs)}
        className={left <= URGENT_MS ? 'stroke-chip-red' : 'stroke-cream'}
      />
    </svg>
  );
}

// Keyed by the deadline: each turn starts its count afresh.
export const TurnRing = ({
  timer,
  testId = 'turn-ring',
}: {
  timer: TurnTimer;
  testId?: string;
}) => <Ring key={timer.deadline} timer={timer} testId={testId} />;
export const SeatRing = ({ timer }: { timer: TurnTimer }) => (
  <SeatOutline key={timer.deadline} timer={timer} />
);
